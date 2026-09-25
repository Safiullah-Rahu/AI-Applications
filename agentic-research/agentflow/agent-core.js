/* ==========================================================================
   AgentFlow core — a discrete-event simulator for LLM agent workflows.
   Workflows are DAGs of LLM calls, tools, human steps, parallel maps,
   reflection loops and routers; runs model latency, token cost, failures,
   retries with exponential backoff, timeouts, model fallback, a global
   concurrency limit and response caching. No DOM — unit-testable in Node.
   ========================================================================== */
(function (root, factory) {
  const api = factory(root.LabMath || (typeof require === 'function' ? require('../../shared/js/lab-math.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentCore = api;
})(typeof self !== 'undefined' ? self : this, function (LM) {
  'use strict';

  /** Illustrative model tiers (latency in s, throughput in tokens/s, price in $ per million tokens). */
  const MODELS = {
    small: { name: 'Small', ttft: 0.35, tps: 180, inPrice: 0.15, outPrice: 0.6, err: 0.01 },
    medium: { name: 'Medium', ttft: 0.6, tps: 90, inPrice: 3, outPrice: 15, err: 0.015 },
    large: { name: 'Large', ttft: 1.1, tps: 45, inPrice: 15, outPrice: 75, err: 0.02 },
  };
  const DEFAULT_POLICY = { retries: 2, backoff: 1, jitter: true, timeout: 60, fallback: true, concurrency: 4, cacheHit: 0 };

  // ------------------------------------------------------------------ event queue
  class EventQueue {
    constructor() { this.h = []; this.seq = 0; }
    get size() { return this.h.length; }
    push(t, fn) {
      const h = this.h;
      const e = { t, s: this.seq++, fn };
      h.push(e);
      let i = h.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (h[p].t < t || (h[p].t === t && h[p].s < e.s)) break;
        h[i] = h[p];
        i = p;
      }
      h[i] = e;
    }
    pop() {
      const h = this.h;
      const top = h[0];
      const last = h.pop();
      if (h.length) {
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          const lt = (a, b) => a.t < b.t || (a.t === b.t && a.s < b.s);
          if (l < h.length && lt(h[l], m === i ? last : h[m])) m = l;
          if (r < h.length && lt(h[r], m === i ? last : h[m])) m = r;
          if (m === i) break;
          h[i] = h[m];
          i = m;
        }
        h[i] = last;
      }
      return top;
    }
  }

  // ------------------------------------------------------------------ graph helpers
  function index(wf) {
    const byId = new Map(wf.nodes.map((n) => [n.id, n]));
    const out = new Map(wf.nodes.map((n) => [n.id, []]));
    const inc = new Map(wf.nodes.map((n) => [n.id, []]));
    for (const e of wf.edges) { out.get(e.from).push(e); inc.get(e.to).push(e); }
    return { byId, out, inc };
  }
  /** Topological order (Kahn); throws on cycles — loops are modelled inside loop nodes. */
  function topoOrder(wf) {
    const { out, inc } = index(wf);
    const deg = new Map(wf.nodes.map((n) => [n.id, inc.get(n.id).length]));
    const q = wf.nodes.filter((n) => deg.get(n.id) === 0).map((n) => n.id);
    const order = [];
    while (q.length) {
      const id = q.shift();
      order.push(id);
      for (const e of out.get(id)) { deg.set(e.to, deg.get(e.to) - 1); if (deg.get(e.to) === 0) q.push(e.to); }
    }
    if (order.length !== wf.nodes.length) throw new Error('workflow graph contains a cycle');
    return order;
  }
  /** Structural checks: one start, one end, everything reachable, router probabilities sum to 1. */
  function validate(wf) {
    const errors = [];
    const starts = wf.nodes.filter((n) => n.type === 'start');
    const ends = wf.nodes.filter((n) => n.type === 'end');
    if (starts.length !== 1) errors.push('exactly one start node required');
    if (ends.length !== 1) errors.push('exactly one end node required');
    try { topoOrder(wf); } catch (e) { errors.push(e.message); }
    const { out } = index(wf);
    for (const n of wf.nodes) {
      if (n.type === 'router') {
        const s = out.get(n.id).reduce((a, e) => a + (e.p || 0), 0);
        if (Math.abs(s - 1) > 1e-6) errors.push(`router “${n.label}” branch probabilities sum to ${s.toFixed(2)}`);
      }
      if (n.type !== 'end' && !out.get(n.id).length) errors.push(`“${n.label}” has no outgoing edge`);
    }
    return errors;
  }

  // ------------------------------------------------------------------ one run
  /**
   * Simulate one execution. Returns {ok, latency, cost, tokIn, tokOut, llmCalls, spans, nodeStart,
   * nodeEnd, skipped, critical, failedNode}. Span kinds: call, cache, queue, backoff, fail, timeout, human.
   */
  function runWorkflow(wf, policy, rng, { trace = true } = {}) {
    const P = Object.assign({}, DEFAULT_POLICY, policy);
    const { byId, out, inc } = index(wf);
    const q = new EventQueue();
    let now = 0;
    let halted = false;
    const at = (t, fn) => q.push(t, fn);
    const spans = [];
    const tot = { cost: 0, tokIn: 0, tokOut: 0, llmCalls: 0 };
    const nodeCost = {};
    const span = (s) => {
      if (s.cost) { tot.cost += s.cost; nodeCost[s.node] = (nodeCost[s.node] || 0) + s.cost; }
      if (trace) spans.push(s);
    };
    // global LLM concurrency (rate limit) semaphore
    const sem = { active: 0, waiting: [] };
    const acquire = (ctx, cb) => {
      const t0 = now;
      const go = () => {
        if (now > t0 + 1e-9) span({ ...ctx, kind: 'queue', t0, t1: now });
        cb();
      };
      if (sem.active < P.concurrency) { sem.active++; go(); } else sem.waiting.push(go);
    };
    const release = () => {
      sem.active--;
      if (sem.waiting.length) { sem.active++; sem.waiting.shift()(); }
    };
    const lognorm = (median, sigma) => median * Math.exp(rng.gauss(0, sigma));

    function llmAttempt(op, modelKey, ctx, cb) {
      if (P.cacheHit > 0 && rng.next() < P.cacheHit) {
        const t1 = now + 0.05;
        at(t1, () => { span({ ...ctx, kind: 'cache', t0: t1 - 0.05, t1, model: modelKey }); cb(true); });
        return;
      }
      acquire(ctx, () => {
        const m = MODELS[modelKey];
        const t0 = now;
        const tokIn = Math.round(op.tokIn * Math.exp(rng.gauss(0, 0.1)));
        const tokOut = Math.max(1, Math.round(op.tokOut * Math.exp(rng.gauss(0, 0.3))));
        const dur = lognorm(m.ttft, 0.35) + (tokOut / m.tps) * Math.exp(rng.gauss(0, 0.15));
        const fails = rng.next() < m.err;
        let end;
        let kind;
        if (fails) { end = t0 + dur * rng.uniform(0.05, 0.5); kind = 'fail'; }
        else if (dur > P.timeout) { end = t0 + P.timeout; kind = 'timeout'; }
        else { end = t0 + dur; kind = 'call'; }
        at(end, () => {
          release();
          tot.llmCalls++;
          if (kind === 'call') {
            const cost = (tokIn * m.inPrice + tokOut * m.outPrice) / 1e6;
            tot.tokIn += tokIn;
            tot.tokOut += tokOut;
            span({ ...ctx, kind, t0, t1: end, model: modelKey, tokIn, tokOut, cost });
            cb(true);
          } else {
            // a timed-out request still consumed (and is billed for) its input tokens
            const cost = kind === 'timeout' ? (tokIn * m.inPrice) / 1e6 : 0;
            span({ ...ctx, kind, t0, t1: end, model: modelKey, cost });
            cb(false);
          }
        });
      });
    }
    function toolAttempt(op, ctx, cb) {
      const t0 = now;
      const dur = lognorm(op.latency, op.spread ?? 0.4);
      const fails = rng.next() < (op.fail || 0);
      let end;
      let kind;
      if (op.kind === 'human') { end = t0 + dur; kind = 'human'; }
      else if (fails) { end = t0 + dur * rng.uniform(0.1, 1); kind = 'fail'; }
      else if (dur > P.timeout) { end = t0 + P.timeout; kind = 'timeout'; }
      else { end = t0 + dur; kind = 'call'; }
      at(end, () => {
        span({ ...ctx, kind, t0, t1: end, cost: kind === 'call' || kind === 'human' ? op.cost || 0 : 0 });
        cb(kind === 'call' || kind === 'human');
      });
    }
    /** One operation with retries, exponential backoff (+ jitter) and, for LLMs, a final fallback to the small model. */
    function execOp(op, ctx, done) {
      const c = { ...ctx, op: op.label };
      let attempt = 0;
      const tryOnce = (model, cb) => (op.kind === 'llm' ? llmAttempt(op, model, { ...c, fallback: model !== op.model }, cb) : toolAttempt(op, c, cb));
      const go = () => tryOnce(op.model, (ok) => {
        if (ok) return done(true);
        if (attempt < P.retries && op.kind !== 'human') {
          const wait = P.backoff * 2 ** attempt * (P.jitter ? rng.uniform(0.5, 1.5) : 1);
          attempt++;
          span({ ...c, kind: 'backoff', t0: now, t1: now + wait });
          at(now + wait, go);
        } else if (op.kind === 'llm' && P.fallback && op.model !== 'small') {
          tryOnce('small', (ok2) => done(ok2));
        } else done(false);
      });
      go();
    }
    function execSeq(ops, ctx, done) {
      let i = 0;
      const next = (ok) => {
        if (!ok) return done(false);
        if (i >= ops.length) return done(true);
        execOp(ops[i++], ctx, next);
      };
      next(true);
    }
    const nodeStart = {};
    const nodeEnd = {};
    const skipped = {};
    const pending = {};
    const activeIn = {};
    for (const n of wf.nodes) { pending[n.id] = inc.get(n.id).length; activeIn[n.id] = false; }
    let endId = null;
    let failedNode = null;

    function execNode(n, done) {
      const ctx = { node: n.id };
      switch (n.type) {
        case 'start':
        case 'end':
          return done(true);
        case 'llm':
        case 'tool':
        case 'human':
          return execOp({ ...n, kind: n.type }, ctx, done);
        case 'router': {
          const edges = out.get(n.id);
          let r = rng.next();
          let chosen = edges[edges.length - 1].to;
          for (const e of edges) { r -= e.p || 0; if (r < 0) { chosen = e.to; break; } }
          return done(true, chosen);
        }
        case 'map': {
          const N = n.items;
          let launched = 0;
          let running = 0;
          let finished = 0;
          let okCount = 0;
          const launch = () => {
            while (running < n.concurrency && launched < N) {
              const item = launched++;
              running++;
              execSeq(n.ops, { ...ctx, item }, (ok) => {
                running--;
                finished++;
                if (ok) okCount++;
                if (finished === N) done(okCount >= Math.ceil((n.minOk ?? 1) * N - 1e-9));
                else launch();
              });
            }
          };
          return launch();
        }
        case 'loop': {
          let iter = 0;
          const step = () => execSeq(n.check, { ...ctx, iter }, (ok) => {
            if (!ok) return done(false);
            const pass = Math.min(0.98, n.passP + n.gain * iter);
            if (rng.next() < pass) return done(true);
            if (iter + 1 >= n.maxIter) return done(n.onExhaust !== 'fail');
            execSeq(n.fix, { ...ctx, iter }, (ok2) => {
              if (!ok2) return done(false);
              iter++;
              step();
            });
          });
          return step();
        }
        default:
          throw new Error('unknown node type ' + n.type);
      }
    }
    function signal(to, active) {
      pending[to]--;
      if (active) activeIn[to] = true;
      if (pending[to] === 0) {
        if (activeIn[to]) start(to);
        else skip(to);
      }
    }
    function skip(id) {
      skipped[id] = true;
      for (const e of out.get(id)) signal(e.to, false);
    }
    function start(id) {
      const n = byId.get(id);
      nodeStart[id] = now;
      execNode(n, (ok, chosen) => {
        if (halted) return;
        nodeEnd[id] = now;
        if (!ok) { failedNode = id; halted = true; return; }
        if (n.type === 'end') { endId = id; halted = true; return; }
        for (const e of out.get(id)) signal(e.to, n.type !== 'router' || e.to === chosen);
      });
    }
    const startNode = wf.nodes.find((n) => n.type === 'start');
    start(startNode.id);
    while (q.size && !halted) {
      const ev = q.pop();
      now = ev.t;
      ev.fn();
    }
    const ok = endId !== null;
    // critical path: walk back from the end through the predecessor that finished last
    const critical = [];
    if (ok) {
      let cur = endId;
      critical.push(cur);
      while (inc.get(cur).length) {
        let best = null;
        for (const e of inc.get(cur)) if (!skipped[e.from] && nodeEnd[e.from] != null && (best === null || nodeEnd[e.from] > nodeEnd[best])) best = e.from;
        if (best === null) break;
        critical.push(best);
        cur = best;
      }
      critical.reverse();
    }
    return { ok, latency: now, cost: tot.cost, tokIn: tot.tokIn, tokOut: tot.tokOut, llmCalls: tot.llmCalls, spans, nodeStart, nodeEnd, skipped, critical, failedNode, nodeCost };
  }

  // ------------------------------------------------------------------ Monte Carlo
  const quantile = (sorted, p) => {
    if (!sorted.length) return NaN;
    const x = (sorted.length - 1) * p;
    const i = Math.floor(x);
    return sorted[i] + (sorted[Math.min(sorted.length - 1, i + 1)] - sorted[i]) * (x - i);
  };
  /** Run many independent executions and aggregate latency, cost, reliability and critical-path attribution. */
  function monteCarlo(wf, policy, runs = 2000, seed = 1) {
    const rng = LM.makeRng(seed);
    const lat = [];
    const cost = [];
    let ok = 0;
    let tokens = 0;
    let calls = 0;
    const crit = {};
    const nodeCost = {};
    const fails = {};
    for (let r = 0; r < runs; r++) {
      const res = runWorkflow(wf, policy, rng, { trace: false });
      cost.push(res.cost);
      tokens += res.tokIn + res.tokOut;
      calls += res.llmCalls;
      for (const [k, v] of Object.entries(res.nodeCost)) nodeCost[k] = (nodeCost[k] || 0) + v;
      if (res.ok) {
        ok++;
        lat.push(res.latency);
        for (const id of res.critical) crit[id] = (crit[id] || 0) + (res.nodeEnd[id] - res.nodeStart[id]);
      } else fails[res.failedNode] = (fails[res.failedNode] || 0) + 1;
    }
    const ls = lat.slice().sort((a, b) => a - b);
    const totalCrit = ls.reduce((a, v) => a + v, 0) || 1;
    return {
      runs, success: ok / runs, lat, cost,
      p50: quantile(ls, 0.5), p90: quantile(ls, 0.9), p95: quantile(ls, 0.95), p99: quantile(ls, 0.99),
      meanLat: totalCrit / Math.max(1, ok), meanCost: cost.reduce((a, v) => a + v, 0) / runs,
      tokensPerRun: tokens / runs, callsPerRun: calls / runs,
      critShare: Object.fromEntries(Object.entries(crit).map(([k, v]) => [k, v / totalCrit])),
      costShare: nodeCost, fails,
    };
  }

  // ------------------------------------------------------------------ presets
  const llm = (label, model, tokIn, tokOut) => ({ kind: 'llm', label, model, tokIn, tokOut });
  const tool = (label, latency, spread, fail) => ({ kind: 'tool', label, latency, spread, fail });
  const PRESETS = {
    research: {
      name: 'Deep-research agent',
      description: 'Plans sub-questions, searches and reads sources in parallel, drafts a report, iterates with a critic, then verifies citations.',
      nodes: [
        { id: 'start', type: 'start', label: 'User question', x: 0, y: 1 },
        { id: 'plan', type: 'llm', label: 'Plan sub-questions', model: 'large', tokIn: 1500, tokOut: 500, x: 1, y: 1 },
        { id: 'kb', type: 'tool', label: 'Internal knowledge base', latency: 0.4, spread: 0.3, fail: 0.01, x: 2, y: 0 },
        { id: 'search', type: 'map', label: 'Search & read sources', items: 6, concurrency: 3, minOk: 0.67, ops: [tool('Web search', 0.9, 0.5, 0.04), tool('Fetch & parse page', 1.6, 0.6, 0.08), llm('Extract evidence', 'small', 3000, 300)], x: 2, y: 1.6 },
        { id: 'synth', type: 'llm', label: 'Synthesise draft', model: 'large', tokIn: 6000, tokOut: 1500, x: 3, y: 1 },
        { id: 'critic', type: 'loop', label: 'Critic ↔ revise', passP: 0.45, gain: 0.25, maxIter: 3, onExhaust: 'continue', check: [llm('Critique vs rubric', 'medium', 5000, 400)], fix: [llm('Revise report', 'large', 7000, 1500)], x: 4, y: 1 },
        { id: 'cite', type: 'tool', label: 'Verify citations', latency: 2, spread: 0.4, fail: 0.03, x: 5, y: 1 },
        { id: 'end', type: 'end', label: 'Report', x: 6, y: 1 },
      ],
      edges: [['start', 'plan'], ['plan', 'kb'], ['plan', 'search'], ['kb', 'synth'], ['search', 'synth'], ['synth', 'critic'], ['critic', 'cite'], ['cite', 'end']],
    },
    support: {
      name: 'Customer-support triage',
      description: 'Classifies a ticket, routes it to billing, technical or human-escalation branches, then runs a safety check before replying.',
      nodes: [
        { id: 'start', type: 'start', label: 'Ticket', x: 0, y: 1 },
        { id: 'classify', type: 'llm', label: 'Classify intent', model: 'small', tokIn: 800, tokOut: 60, x: 1, y: 1 },
        { id: 'route', type: 'router', label: 'Route', x: 2, y: 1 },
        { id: 'billing', type: 'tool', label: 'Billing API lookup', latency: 0.6, spread: 0.4, fail: 0.02, x: 3, y: 0 },
        { id: 'kbs', type: 'tool', label: 'KB vector search', latency: 0.3, spread: 0.3, fail: 0.01, x: 3, y: 1 },
        { id: 'human', type: 'human', label: 'Human agent review', latency: 180, spread: 0.7, x: 3, y: 2 },
        { id: 'draftB', type: 'llm', label: 'Draft billing reply', model: 'medium', tokIn: 2500, tokOut: 350, x: 4, y: 0 },
        { id: 'draftT', type: 'llm', label: 'Draft technical reply', model: 'medium', tokIn: 4000, tokOut: 500, x: 4, y: 1 },
        { id: 'draftH', type: 'llm', label: 'Polish agent reply', model: 'small', tokIn: 1500, tokOut: 300, x: 4, y: 2 },
        { id: 'guard', type: 'llm', label: 'Safety & PII check', model: 'small', tokIn: 1200, tokOut: 40, x: 5, y: 1 },
        { id: 'end', type: 'end', label: 'Reply sent', x: 6, y: 1 },
      ],
      edges: [['start', 'classify'], ['classify', 'route'], ['route', 'billing', 0.45], ['route', 'kbs', 0.35], ['route', 'human', 0.2], ['billing', 'draftB'], ['kbs', 'draftT'], ['human', 'draftH'], ['draftB', 'guard'], ['draftT', 'guard'], ['draftH', 'guard'], ['guard', 'end']],
    },
    coding: {
      name: 'Coding agent',
      description: 'Plans a change, gathers context in parallel, writes a patch and loops test → diagnose → fix until the suite passes.',
      nodes: [
        { id: 'start', type: 'start', label: 'Issue', x: 0, y: 1 },
        { id: 'plan', type: 'llm', label: 'Plan the change', model: 'large', tokIn: 2000, tokOut: 600, x: 1, y: 1 },
        { id: 'grep', type: 'tool', label: 'Search codebase', latency: 0.6, spread: 0.4, fail: 0.01, x: 2, y: 0.4 },
        { id: 'logs', type: 'tool', label: 'Read CI logs', latency: 1.2, spread: 0.5, fail: 0.03, x: 2, y: 1.6 },
        { id: 'write', type: 'llm', label: 'Write patch', model: 'large', tokIn: 8000, tokOut: 1800, x: 3, y: 1 },
        { id: 'tests', type: 'loop', label: 'Test ↔ fix', passP: 0.35, gain: 0.2, maxIter: 5, onExhaust: 'fail', check: [tool('Run test suite', 25, 0.3, 0.02)], fix: [llm('Diagnose & patch', 'large', 12000, 1200)], x: 4, y: 1 },
        { id: 'review', type: 'llm', label: 'Self-review diff', model: 'medium', tokIn: 6000, tokOut: 400, x: 5, y: 1 },
        { id: 'end', type: 'end', label: 'Pull request', x: 6, y: 1 },
      ],
      edges: [['start', 'plan'], ['plan', 'grep'], ['plan', 'logs'], ['grep', 'write'], ['logs', 'write'], ['write', 'tests'], ['tests', 'review'], ['review', 'end']],
    },
    debate: {
      name: 'Multi-agent debate',
      description: 'Three agents argue in parallel from different perspectives; a judge model weighs the arguments and writes the verdict.',
      nodes: [
        { id: 'start', type: 'start', label: 'Claim', x: 0, y: 1 },
        { id: 'pro', type: 'llm', label: 'Agent A · argue for', model: 'medium', tokIn: 1500, tokOut: 700, x: 2, y: 0 },
        { id: 'con', type: 'llm', label: 'Agent B · argue against', model: 'medium', tokIn: 1500, tokOut: 700, x: 2, y: 1 },
        { id: 'facts', type: 'map', label: 'Agent C · fact-check', items: 4, concurrency: 4, minOk: 0.75, ops: [tool('Retrieve source', 0.8, 0.5, 0.05), llm('Check claim', 'small', 2000, 150)], x: 2, y: 2 },
        { id: 'judge', type: 'llm', label: 'Judge verdict', model: 'large', tokIn: 5000, tokOut: 800, x: 4, y: 1 },
        { id: 'end', type: 'end', label: 'Verdict', x: 6, y: 1 },
      ],
      edges: [['start', 'pro'], ['start', 'con'], ['start', 'facts'], ['pro', 'judge'], ['con', 'judge'], ['facts', 'judge'], ['judge', 'end']],
    },
  };
  /** Deep copy of a preset in runtime form (edges as objects). */
  function preset(name) {
    const p = PRESETS[name];
    return {
      name: p.name,
      description: p.description,
      nodes: JSON.parse(JSON.stringify(p.nodes)),
      edges: p.edges.map(([from, to, pr]) => (pr != null ? { from, to, p: pr } : { from, to })),
    };
  }

  return { MODELS, DEFAULT_POLICY, EventQueue, index, topoOrder, validate, runWorkflow, monteCarlo, quantile, PRESETS, preset };
});
