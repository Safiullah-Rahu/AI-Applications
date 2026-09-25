/* AgentFlow — graph editor, replay animation, Gantt trace and Monte Carlo analytics. */
(function () {
  'use strict';
  const A = window.AgentCore;
  const M = window.LabMath;
  Lab.boot();
  const T = Lab.theme();
  const COLORS = { start: '#8b93b8', end: '#8b93b8', llm: '#22d3ee', tool: '#a3e635', human: '#fbbf24', map: '#818cf8', loop: '#f472b6', router: '#fb923c' };
  const TYPE_NAME = { start: 'Start', end: 'End', llm: 'LLM call', tool: 'Tool call', human: 'Human step', map: 'Parallel map', loop: 'Reflection loop', router: 'Router' };
  const KIND_COLOR = { call: null, cache: '#a3e635', queue: '#8b93b8', backoff: '#fbbf24', fail: '#fb7185', timeout: '#fb7185', human: '#fbbf24' };
  const RED = '#fb7185';

  const S = { preset: 'research', policy: { ...A.DEFAULT_POLICY }, runs: 2000, seed: 1, selected: 'critic', tab: 'latency' };
  let wf = A.preset(S.preset);
  let mc = null;
  let baseline = null;
  let trace = null;
  let replaySeed = 7;
  const replay = { on: false, t: 0, dur: 6 };

  const fmtS = (s) => (!Number.isFinite(s) ? '—' : s < 1 ? `${(s * 1000).toFixed(0)} ms` : s < 120 ? `${s.toFixed(1)} s` : `${(s / 60).toFixed(1)} min`);
  const fmtUSD = (v) => (!Number.isFinite(v) ? '—' : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`);
  const fmtK = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0));
  const nodeById = (id) => wf.nodes.find((n) => n.id === id);

  // ------------------------------------------------------------------ simulation
  let mcTimer = 0;
  function recompute(delay = 120) {
    clearTimeout(mcTimer);
    mcTimer = setTimeout(() => {
      const errs = A.validate(wf);
      if (errs.length) { Lab.toast(errs[0], 4000); return; }
      const t0 = performance.now();
      mc = A.monteCarlo(wf, S.policy, S.runs, S.seed);
      mc.ms = performance.now() - t0;
      updateStats();
      drawAnalytics();
      renderInspector();
      drawGraph();
    }, delay);
  }
  function runOnce(animate = true) {
    const rng = M.makeRng(replaySeed++);
    trace = A.runWorkflow(wf, S.policy, rng, { trace: true });
    replay.on = animate;
    replay.t = 0;
    replay.dur = Math.min(9, Math.max(4, 2 + trace.latency / 25));
    if (!animate) replay.t = replay.dur;
    Lab.text('gantt-sub', `${trace.ok ? 'completed' : `failed at “${nodeById(trace.failedNode).label}”`} in ${fmtS(trace.latency)} · ${fmtUSD(trace.cost)} · ${trace.llmCalls} LLM calls`);
    if (S.tab === 'trace') drawAnalytics();
  }

  // ------------------------------------------------------------------ graph view
  const gv = Lab.canvas('cv-graph', () => drawGraph());
  const G = { nw: 150, nh: 58, pad: 22 };
  const isTerminal = (n) => n.type === 'start' || n.type === 'end';
  function layout() {
    const xmax = Math.max(1, ...wf.nodes.map((n) => n.x));
    const ymax = Math.max(1, ...wf.nodes.map((n) => n.y));
    // terminals are compact pills; the remaining columns share the width
    G.tw = 84;
    G.nw = Math.max(96, Math.min(172, (gv.w - 2 * G.pad - 2 * G.tw) / Math.max(1, xmax - 1) - 18));
    G.nh = Math.max(46, Math.min(60, (gv.h - 2 * G.pad) / 3.6));
    G.sx = (gv.w - 2 * G.pad - G.tw) / xmax;
    G.sy = (gv.h - 2 * G.pad - G.nh) / Math.max(2, ymax);
  }
  const nodeW = (n) => (isTerminal(n) ? G.tw : G.nw);
  const pos = (n) => {
    const cx = G.pad + G.tw / 2 + n.x * G.sx; // column centre
    return { x: Math.max(4, Math.min(gv.w - nodeW(n) - 4, cx - nodeW(n) / 2)), y: G.pad + n.y * G.sy };
  };
  function nodeSub(n) {
    const m = A.MODELS;
    switch (n.type) {
      case 'llm': return `${m[n.model].name} · ${fmtK(n.tokIn)}→${fmtK(n.tokOut)} tok`;
      case 'tool': return `~${fmtS(n.latency)} · ${(n.fail * 100).toFixed(0)}% fail`;
      case 'human': return `~${fmtS(n.latency)} wait`;
      case 'map': return `×${n.items} items · ${n.concurrency} parallel`;
      case 'loop': return `pass ${Math.round(n.passP * 100)}%+${Math.round(n.gain * 100)} · ≤${n.maxIter}`;
      case 'router': return `${wf.edges.filter((e) => e.from === n.id).length} branches`;
      default: return '';
    }
  }
  function nodeState(n) {
    if (!trace) return 'idle';
    const t = (replay.t / replay.dur) * trace.latency;
    if (trace.skipped[n.id]) return trace.nodeEnd[n.id] != null || t >= trace.latency ? 'skipped' : 'idle';
    if (trace.failedNode === n.id && t >= trace.nodeEnd[n.id]) return 'failed';
    if (trace.nodeStart[n.id] == null || t < trace.nodeStart[n.id]) return 'idle';
    if (trace.nodeEnd[n.id] == null || t < trace.nodeEnd[n.id]) return 'active';
    return 'done';
  }
  function drawGraph() {
    if (!gv.w) return;
    layout();
    const { ctx } = gv;
    gv.clear();
    const simT = trace ? (replay.t / replay.dur) * trace.latency : 0;
    // edges
    const labels = [];
    for (const e of wf.edges) {
      const a = nodeById(e.from);
      const b = nodeById(e.to);
      const pa = pos(a);
      const pb = pos(b);
      const x0 = pa.x + nodeW(a);
      const y0 = pa.y + G.nh / 2;
      const x1 = pb.x;
      const y1 = pb.y + G.nh / 2;
      const mx = (x0 + x1) / 2;
      const done = trace && trace.nodeEnd[e.from] != null && simT >= trace.nodeEnd[e.from] && !trace.skipped[e.to] && !trace.skipped[e.from];
      const taken = done && (trace.nodeStart[e.to] != null);
      ctx.strokeStyle = taken ? Lab.alpha(COLORS[a.type] === '#8b93b8' ? '#22d3ee' : COLORS[a.type], 0.85) : 'rgba(142,160,216,0.28)';
      ctx.lineWidth = taken ? 2 : 1.4;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(mx, y0, mx, y1, x1 - 6, y1);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - 7, y1 - 4); ctx.lineTo(x1 - 7, y1 + 4); ctx.fill();
      // travelling pulse right after the source finished
      if (taken && replay.on) {
        const since = ((simT - trace.nodeEnd[e.from]) / trace.latency) * replay.dur;
        if (since >= 0 && since < 0.5) {
          const u = since / 0.5;
          const bx = (1 - u) ** 3 * x0 + 3 * (1 - u) ** 2 * u * mx + 3 * (1 - u) * u * u * mx + u ** 3 * x1;
          const by = (1 - u) ** 3 * y0 + 3 * (1 - u) ** 2 * u * y0 + 3 * (1 - u) * u * u * y1 + u ** 3 * y1;
          ctx.fillStyle = '#e8edfb';
          ctx.beginPath(); ctx.arc(bx, by, 3.5, 0, Math.PI * 2); ctx.fill();
        }
      }
      if (e.p != null) labels.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, p: e.p });
    }
    // nodes
    for (const n of wf.nodes) {
      const p = pos(n);
      const NW = nodeW(n);
      const col = COLORS[n.type];
      const st = nodeState(n);
      const sel = n.id === S.selected;
      ctx.save();
      if (st === 'active') { ctx.shadowColor = col; ctx.shadowBlur = 18 + 8 * Math.sin(performance.now() / 150); }
      ctx.fillStyle = st === 'skipped' ? 'rgba(14,21,40,0.55)' : '#0e1528';
      Lab.roundRect(ctx, p.x, p.y, NW, G.nh, 10);
      ctx.fill();
      ctx.restore();
      ctx.lineWidth = sel ? 2.2 : 1.2;
      ctx.strokeStyle = st === 'failed' ? RED : sel ? '#e8edfb' : st === 'active' || st === 'done' ? col : Lab.alpha(col, st === 'skipped' ? 0.2 : 0.55);
      Lab.roundRect(ctx, p.x, p.y, NW, G.nh, 10);
      ctx.stroke();
      // type stripe
      ctx.fillStyle = Lab.alpha(col, st === 'skipped' ? 0.25 : 0.9);
      Lab.roundRect(ctx, p.x + 1, p.y + 1, 5, G.nh - 2, 4);
      ctx.fill();
      ctx.globalAlpha = st === 'skipped' ? 0.4 : 1;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `600 9.5px ${T.sans}`;
      ctx.fillStyle = col;
      ctx.fillText(TYPE_NAME[n.type].toUpperCase(), p.x + 13, p.y + 15);
      ctx.font = `600 12.5px ${T.sans}`;
      ctx.fillStyle = T.text;
      let lab = n.label;
      while (ctx.measureText(lab).width > NW - 20 && lab.length > 3) lab = lab.slice(0, -1);
      ctx.fillText(lab === n.label ? lab : lab + '…', p.x + 13, p.y + 32);
      ctx.font = `10.5px ${T.mono}`;
      ctx.fillStyle = T.muted;
      let sub = nodeSub(n);
      while (sub && ctx.measureText(sub).width > NW - 20 && sub.length > 3) sub = sub.slice(0, -1);
      if (sub) ctx.fillText(sub, p.x + 13, p.y + 47);
      // critical-path share badge
      if (mc && mc.critShare[n.id] > 0.005 && n.type !== 'start' && n.type !== 'end') {
        const share = mc.critShare[n.id];
        const s = `${Math.round(share * 100)}%`;
        ctx.font = `700 10px ${T.mono}`;
        const tw = ctx.measureText(s).width + 10;
        const bx = p.x + NW - tw - 6;
        const by = p.y + 6;
        ctx.fillStyle = share > 0.3 ? Lab.alpha(RED, 0.2) : 'rgba(142,160,216,0.12)';
        Lab.roundRect(ctx, bx, by, tw, 15, 5);
        ctx.fill();
        ctx.fillStyle = share > 0.3 ? RED : T.text2;
        ctx.textAlign = 'center';
        ctx.fillText(s, bx + tw / 2, by + 11);
      }
      // live activity count (parallel items / active calls)
      if (st === 'active' && trace) {
        const simNow = simT;
        const act = trace.spans.filter((s) => s.node === n.id && s.t0 <= simNow && s.t1 > simNow && s.kind !== 'backoff').length;
        if (act > 1) {
          ctx.font = `700 10px ${T.mono}`;
          ctx.fillStyle = col;
          ctx.textAlign = 'right';
          ctx.fillText(`${act} in flight`, p.x + NW - 8, p.y + G.nh - 8);
        }
      }
      ctx.globalAlpha = 1;
    }
    for (const L of labels) {
      ctx.font = `600 10.5px ${T.mono}`;
      const s = `${Math.round(L.p * 100)}%`;
      const tw = ctx.measureText(s).width + 8;
      ctx.fillStyle = 'rgba(6,10,20,0.92)';
      Lab.roundRect(ctx, L.x - tw / 2, L.y - 8, tw, 16, 5);
      ctx.fill();
      ctx.fillStyle = COLORS.router;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s, L.x, L.y);
    }
    Lab.text('graph-sub', `${wf.name} · ${wf.nodes.length} nodes · ${wf.edges.length} edges`);
  }
  // drag & select
  let drag = null;
  gv.canvas.addEventListener('pointerdown', (e) => {
    const p = gv.pointer(e);
    for (const n of wf.nodes.slice().reverse()) {
      const q = pos(n);
      if (p.x >= q.x && p.x <= q.x + nodeW(n) && p.y >= q.y && p.y <= q.y + G.nh) {
        drag = { id: n.id, dx: p.x - q.x, dy: p.y - q.y, moved: false };
        gv.canvas.setPointerCapture(e.pointerId);
        select(n.id);
        return;
      }
    }
  });
  gv.canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = gv.pointer(e);
    const n = nodeById(drag.id);
    n.x = Math.max(0, Math.min(6, (p.x - drag.dx + nodeW(n) / 2 - G.pad - G.tw / 2) / G.sx));
    n.y = Math.max(0, Math.min(2, (p.y - drag.dy - G.pad) / G.sy));
    drag.moved = true;
    drawGraph();
  });
  gv.canvas.addEventListener('pointerup', () => { drag = null; });

  function select(id) {
    S.selected = id;
    renderInspector();
    drawGraph();
  }

  // ------------------------------------------------------------------ inspector
  const insp = Lab.$('#inspector');
  function num(label, key, obj, { step = 1, min = 0, max = 1e9, scale = 1, full = false, suffix = '' } = {}) {
    return `<label class="${full ? 'full' : ''}">${label}${suffix ? ` <span class="muted">(${suffix})</span>` : ''}<input type="number" data-k="${key}" data-scale="${scale}" step="${step}" min="${min}" max="${max}" value="${+(obj[key] * scale).toFixed(4)}" /></label>`;
  }
  function modelSel(key, obj) {
    return `<label>Model tier<select data-k="${key}">${Object.entries(A.MODELS).map(([k, m]) => `<option value="${k}"${obj[key] === k ? ' selected' : ''}>${m.name}</option>`).join('')}</select></label>`;
  }
  function opsEditor(title, list, path) {
    const rows = list.map((op, i) => {
      if (op.kind === 'llm') {
        return `<div class="op-row" data-path="${path}.${i}"><span class="nm" title="${op.label}">🧠 ${op.label}</span><select data-k="model">${Object.entries(A.MODELS).map(([k, m]) => `<option value="${k}"${op.model === k ? ' selected' : ''}>${m.name}</option>`).join('')}</select><input type="number" data-k="tokIn" data-scale="1" step="100" min="1" value="${op.tokIn}" title="prompt tokens" /><input type="number" data-k="tokOut" data-scale="1" step="50" min="1" value="${op.tokOut}" title="completion tokens" /></div>`;
      }
      return `<div class="op-row" data-path="${path}.${i}"><span class="nm" title="${op.label}">🔧 ${op.label}</span><input type="number" data-k="latency" data-scale="1" step="0.1" min="0.01" value="${op.latency}" title="median latency (s)" /><input type="number" data-k="fail" data-scale="100" step="1" min="0" max="100" value="${+(op.fail * 100).toFixed(2)}" title="failure %" /><span></span></div>`;
    });
    return `<div class="ops-title">${title}</div><div class="op-row op-head"><span>step</span><span>model / latency s</span><span>in tok / fail %</span><span>out tok</span></div>${rows.join('')}`;
  }
  function renderInspector() {
    const n = nodeById(S.selected) || wf.nodes[0];
    const col = COLORS[n.type];
    let html = `<div><span class="insp-type" style="color:${col};border-color:${Lab.alpha(col, 0.45)}">${TYPE_NAME[n.type]}</span></div>`;
    html += `<div class="insp-grid"><label class="full">Label<input type="text" data-k="label" value="${n.label.replace(/"/g, '&quot;')}" /></label>`;
    if (n.type === 'llm') html += modelSel('model', n) + num('Prompt tokens', 'tokIn', n, { step: 100, min: 1 }) + num('Completion tokens', 'tokOut', n, { step: 50, min: 1 });
    if (n.type === 'tool' || n.type === 'human') html += num('Median latency', 'latency', n, { step: n.type === 'human' ? 10 : 0.1, min: 0.01, suffix: 's' }) + num('Variability σ', 'spread', n, { step: 0.05, min: 0 });
    if (n.type === 'tool') html += num('Failure rate', 'fail', n, { step: 1, min: 0, max: 100, scale: 100, suffix: '%' });
    if (n.type === 'map') html += num('Items', 'items', n, { min: 1, max: 100 }) + num('Concurrency', 'concurrency', n, { min: 1, max: 100 }) + num('Min. successful', 'minOk', n, { step: 5, min: 0, max: 100, scale: 100, suffix: '%' });
    if (n.type === 'loop') html += num('Pass probability', 'passP', n, { step: 5, min: 0, max: 100, scale: 100, suffix: '%' }) + num('Gain / iteration', 'gain', n, { step: 5, min: 0, max: 100, scale: 100, suffix: '%' }) + num('Max iterations', 'maxIter', n, { min: 1, max: 20 }) + `<label>If never passes<select data-k="onExhaust"><option value="continue"${n.onExhaust !== 'fail' ? ' selected' : ''}>continue</option><option value="fail"${n.onExhaust === 'fail' ? ' selected' : ''}>fail the run</option></select></label>`;
    if (n.type === 'router') {
      wf.edges.filter((e) => e.from === n.id).forEach((e, i) => { html += `<label>→ ${nodeById(e.to).label}<input type="number" data-edge="${i}" step="5" min="0" max="100" value="${Math.round(e.p * 100)}" /></label>`; });
    }
    html += '</div>';
    if (n.type === 'map') html += opsEditor('Per-item pipeline', n.ops, 'ops');
    if (n.type === 'loop') html += opsEditor('Check (each iteration)', n.check, 'check') + opsEditor('Fix (when the check fails)', n.fix, 'fix');
    if (mc && n.type !== 'start' && n.type !== 'end') {
      const share = mc.critShare[n.id] || 0;
      const cost = (mc.costShare[n.id] || 0) / mc.runs;
      const fails = mc.fails[n.id] || 0;
      html += `<div class="node-stats"><div class="stat ${share > 0.3 ? 'bad' : ''}"><div class="k">Latency share</div><div class="v">${(share * 100).toFixed(1)}<span class="u">%</span></div></div>
        <div class="stat"><div class="k">Cost / run</div><div class="v">${fmtUSD(cost)}</div></div>
        <div class="stat ${fails ? 'warn' : ''}"><div class="k">Run failures</div><div class="v">${fails}<span class="u">/ ${mc.runs}</span></div></div></div>`;
    }
    insp.innerHTML = html;
    Lab.text('insp-sub', n.label);
    // bindings
    insp.querySelectorAll('.insp-grid [data-k]').forEach((el) => el.addEventListener('change', () => { setField(n, el); }));
    insp.querySelectorAll('.insp-grid [data-edge]').forEach((el) => el.addEventListener('change', () => {
      const edges = wf.edges.filter((e) => e.from === n.id);
      edges[+el.dataset.edge].p = Math.max(0, parseFloat(el.value) || 0) / 100;
      const s = edges.reduce((a, e) => a + e.p, 0) || 1;
      edges.forEach((e) => (e.p /= s));
      renderInspector();
      drawGraph();
      recompute();
    }));
    insp.querySelectorAll('.op-row[data-path] [data-k]').forEach((el) => el.addEventListener('change', () => {
      const [list, i] = el.closest('.op-row').dataset.path.split('.');
      setField(n[list][+i], el, n);
    }));
  }
  function setField(obj, el, owner) {
    const k = el.dataset.k;
    if (el.tagName === 'SELECT' || el.type === 'text') obj[k] = el.value;
    else {
      const v = parseFloat(el.value);
      if (!Number.isFinite(v)) return;
      obj[k] = v / parseFloat(el.dataset.scale || 1);
      if (['items', 'concurrency', 'maxIter', 'tokIn', 'tokOut'].includes(k)) obj[k] = Math.max(1, Math.round(obj[k]));
    }
    drawGraph();
    recompute();
    if (owner) Lab.text('insp-sub', owner.label);
  }

  // ------------------------------------------------------------------ Gantt
  const gt = Lab.canvas('cv-gantt', () => drawGantt());
  function drawGantt() {
    const { ctx, w, h } = gt;
    gt.clear();
    if (!trace) return;
    const order = A.topoOrder(wf).filter((id) => { const n = nodeById(id); return n.type !== 'start' && n.type !== 'end'; });
    const pad = { l: 150, r: 14, t: 34, b: 26 };
    // legend
    ctx.font = `10.5px ${T.sans}`;
    ctx.textBaseline = 'middle';
    let lx = w - 12;
    for (const [lab, col] of [['error', '#fb7185'], ['backoff / human', '#fbbf24'], ['queued', '#8b93b8'], ['tool', COLORS.tool], ['LLM', COLORS.llm]]) {
      ctx.textAlign = 'right';
      ctx.fillStyle = T.text2;
      ctx.fillText(lab, lx, 46 - 30);
      lx -= ctx.measureText(lab).width + 5;
      ctx.fillStyle = col;
      ctx.fillRect(lx - 9, 16 - 4.5, 9, 9);
      lx -= 20;
    }
    const W = w - pad.l - pad.r;
    const rows = order.length;
    const rh = (h - pad.t - pad.b) / rows;
    const tMax = trace.latency || 1;
    const X = (t) => pad.l + (t / tMax) * W;
    const simT = (replay.t / replay.dur) * tMax;
    order.forEach((id, r) => {
      const n = nodeById(id);
      const y0 = pad.t + r * rh;
      if (r % 2 === 0) { ctx.fillStyle = 'rgba(142,160,216,0.035)'; ctx.fillRect(0, y0, w, rh); }
      ctx.font = `12px ${T.sans}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = trace.skipped[id] ? Lab.alpha('#6b779f', 0.6) : T.text2;
      let lab = n.label;
      while (ctx.measureText(lab).width > pad.l - 20 && lab.length > 3) lab = lab.slice(0, -1);
      ctx.fillText(lab === n.label ? lab : lab + '…', pad.l - 10, y0 + rh / 2);
      ctx.fillStyle = COLORS[n.type];
      ctx.fillRect(pad.l - 6, y0 + rh * 0.3, 3, rh * 0.4);
      // lanes: greedy interval assignment so parallel items don't overlap
      const spans = trace.spans.filter((s) => s.node === id && s.t0 <= simT).sort((a, b) => a.t0 - b.t0);
      const laneEnd = [];
      const laneOf = spans.map((s) => {
        let l = laneEnd.findIndex((e) => e <= s.t0 + 1e-9);
        if (l < 0) { l = laneEnd.length; laneEnd.push(0); }
        laneEnd[l] = s.t1;
        return l;
      });
      const lanes = Math.max(1, laneEnd.length);
      const lh = Math.min(14, (rh - 4) / lanes);
      spans.forEach((s, i) => {
        const x0 = X(s.t0);
        const x1 = Math.max(x0 + 1.5, X(Math.min(s.t1, simT)));
        const y = y0 + (rh - lanes * lh) / 2 + laneOf[i] * lh;
        let col = KIND_COLOR[s.kind] || (s.model ? COLORS.llm : COLORS.tool);
        if (s.kind === 'call' && s.fallback) col = '#38bdf8';
        ctx.fillStyle = Lab.alpha(col, s.kind === 'queue' ? 0.45 : s.kind === 'backoff' ? 0.35 : 0.85);
        ctx.fillRect(x0, y + 1, x1 - x0, lh - 2);
      });
    });
    // axis & playhead
    ctx.strokeStyle = T.border2;
    ctx.beginPath(); ctx.moveTo(pad.l, h - pad.b + 0.5); ctx.lineTo(pad.l + W, h - pad.b + 0.5); ctx.stroke();
    ctx.font = `10.5px ${T.mono}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const t of M.niceTicks(0, tMax, 7).ticks) {
      ctx.fillText(fmtS(t).replace(' ', ''), X(t), h - pad.b + 5);
      ctx.strokeStyle = 'rgba(142,160,216,0.07)';
      ctx.beginPath(); ctx.moveTo(X(t), pad.t); ctx.lineTo(X(t), h - pad.b); ctx.stroke();
    }
    if (replay.t < replay.dur) {
      ctx.strokeStyle = '#e8edfb';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(X(simT), pad.t); ctx.lineTo(X(simT), h - pad.b); ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  // ------------------------------------------------------------------ analytics
  const anPlot = new Lab.Plot('cv-an', { pad: { l: 50, r: 16, t: 14, b: 30 }, yLabel: 'runs', yMin: 0, legend: 'tr' });
  function histogram(values, lo, hi, nb = 45) {
    const bw = (hi - lo) / nb || 1;
    const c = new Array(nb).fill(0);
    for (const v of values) { if (v < lo || v > hi) continue; c[Math.min(nb - 1, Math.floor((v - lo) / bw))]++; }
    const x = [];
    const y = [];
    c.forEach((k, i) => { x.push(lo + i * bw, lo + (i + 1) * bw); y.push(k, k); });
    return { x, y };
  }
  function drawAnalytics() {
    if (!mc) return;
    const tab = S.tab;
    Lab.$('#an-plot').classList.toggle('hidden', !(tab === 'latency' || tab === 'cost'));
    Lab.$('#an-bars').classList.toggle('hidden', tab !== 'bottleneck');
    Lab.$('#an-trace').classList.toggle('hidden', tab !== 'trace');
    if (tab === 'latency' || tab === 'cost') {
      anPlot.c.resize();
      const key = tab === 'latency' ? 'lat' : 'cost';
      const q = (arr, p) => A.quantile(arr.slice().sort((a, b) => a - b), p);
      const all = baseline ? mc[key].concat(baseline[key]) : mc[key];
      const lo = Math.min(...all);
      const hi = q(all, 0.995);
      const series = [];
      if (baseline) series.push({ name: 'baseline', color: '#a9b4d6', width: 1.4, dash: [5, 4], data: histogram(baseline[key], lo, hi) });
      series.push({ name: 'current', color: '#22d3ee', width: 1.6, fill: 'rgba(34,211,238,0.22)', data: histogram(mc[key], lo, hi) });
      anPlot.series = series;
      Object.assign(anPlot.opts, { xMin: lo, xMax: hi, xLabel: tab === 'latency' ? 'end-to-end latency (s), successful runs' : 'cost per run ($)', legend: baseline ? 'tr' : null });
      anPlot.vlines = tab === 'latency'
        ? [{ x: mc.p50, color: '#a3e635', label: `p50 ${fmtS(mc.p50)}`, align: 'right' }, { x: mc.p95, color: '#fbbf24', label: `p95 ${fmtS(mc.p95)}`, align: 'left' }]
        : [{ x: mc.meanCost, color: '#a3e635', label: `mean ${fmtUSD(mc.meanCost)}` }];
      anPlot.draw();
    } else if (tab === 'bottleneck') {
      const ids = wf.nodes.filter((n) => !['start', 'end', 'router'].includes(n.type)).map((n) => n.id);
      const totCost = Object.values(mc.costShare).reduce((a, v) => a + v, 0) || 1;
      ids.sort((a, b) => (mc.critShare[b] || 0) - (mc.critShare[a] || 0));
      Lab.$('#an-bars').innerHTML = `<div class="bar-row" style="color:var(--muted);font-size:11px;grid-template-columns:1fr"><span style="display:none"></span><span><span style="color:#22d3ee">■</span> latency (critical path) · <span style="color:#a3e635">■</span> cost</span><span></span></div>` + ids.map((id) => {
        const n = nodeById(id);
        const cs = mc.critShare[id] || 0;
        const co = (mc.costShare[id] || 0) / totCost;
        return `<div class="bar-row"><span class="nm" title="${n.label}">${n.label}</span><span class="tr"><span class="b" style="width:${Math.max(0.5, cs * 100)}%;background:#22d3ee"></span><span class="b" style="width:${Math.max(0.5, co * 100)}%;background:#a3e635"></span></span><span class="v">${(cs * 100).toFixed(0)}% · ${(co * 100).toFixed(0)}%</span></div>`;
      }).join('');
    } else if (tab === 'trace') {
      if (!trace) { Lab.$('#an-trace').innerHTML = '<div class="note" style="margin:12px">Replay one execution to see its spans.</div>'; return; }
      const rows = trace.spans.slice().sort((a, b) => a.t0 - b.t0).slice(0, 300);
      Lab.$('#an-trace').innerHTML = `<table class="table"><thead><tr><th>node / step</th><th>kind</th><th>start</th><th>duration</th><th>model</th><th>tokens</th><th>cost</th></tr></thead><tbody>${rows.map((s) => {
        const n = nodeById(s.node);
        const nm = s.op && s.op !== n.label ? `${n.label} › ${s.op}${s.item != null ? ` #${s.item + 1}` : ''}${s.iter != null ? ` (iter ${s.iter + 1})` : ''}` : n.label;
        return `<tr><td class="k">${nm}</td><td class="k k-${s.kind}">${s.kind}${s.fallback ? ' (fallback)' : ''}</td><td>${s.t0.toFixed(2)}</td><td>${(s.t1 - s.t0).toFixed(2)}</td><td>${s.model ? A.MODELS[s.model].name : ''}</td><td>${s.tokIn ? `${s.tokIn}/${s.tokOut}` : ''}</td><td>${s.cost ? fmtUSD(s.cost) : ''}</td></tr>`;
      }).join('')}</tbody></table>`;
    }
  }
  function delta(cur, base, lowerIsBetter = true) {
    if (!baseline || !Number.isFinite(base) || !base) return '';
    const d = (cur - base) / base;
    if (Math.abs(d) < 0.005) return '<span class="d">±0%</span>';
    const good = lowerIsBetter ? d < 0 : d > 0;
    return `<span class="d ${good ? 'down' : 'up'}">${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(0)}%</span>`;
  }
  function updateStats() {
    const b = baseline || {};
    const succ = Lab.$('#st-succ');
    succ.innerHTML = `${(mc.success * 100).toFixed(1)}<span class="u">%</span>${delta(mc.success, b.success, false)}`;
    succ.parentElement.className = 'stat ' + (mc.success > 0.99 ? 'good' : mc.success > 0.9 ? 'warn' : 'bad');
    Lab.$('#st-p50').innerHTML = `${fmtS(mc.p50)}${delta(mc.p50, b.p50)}`;
    Lab.$('#st-p95').innerHTML = `${fmtS(mc.p95)}${delta(mc.p95, b.p95)}`;
    Lab.$('#st-cost').innerHTML = `${fmtUSD(mc.meanCost)}${delta(mc.meanCost, b.meanCost)}`;
    Lab.$('#st-tok').innerHTML = `${fmtK(mc.tokensPerRun)}${delta(mc.tokensPerRun, b.tokensPerRun)}`;
    Lab.$('#st-calls').innerHTML = `${mc.callsPerRun.toFixed(1)}${delta(mc.callsPerRun, b.callsPerRun)}`;
  }

  // ------------------------------------------------------------------ sidebar
  const presetBox = Lab.$('#presets');
  presetBox.innerHTML = Object.entries(A.PRESETS).map(([k, p]) => `<button class="btn${k === S.preset ? ' active' : ''}" data-preset="${k}">${p.name}</button>`).join('');
  function loadPreset(name) {
    S.preset = name;
    wf = A.preset(name);
    presetBox.querySelectorAll('.btn').forEach((b) => b.classList.toggle('active', b.dataset.preset === name));
    Lab.text('wf-desc', wf.description);
    S.selected = (wf.nodes.find((n) => n.type === 'loop' || n.type === 'map' || n.type === 'router') || wf.nodes[1]).id;
    trace = null;
    runOnce(true);
    recompute(0);
    renderInspector();
  }
  presetBox.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => loadPreset(b.dataset.preset)));
  const pol = (k, f = (v) => v) => (v) => { S.policy[k] = f(v); recompute(); };
  const ui = {};
  ui.retries = Lab.range('sl-retries', { format: (v) => `${v}`, onInput: pol('retries') });
  ui.backoff = Lab.range('sl-backoff', { format: (v) => `${v.toFixed(2)} s`, onInput: pol('backoff') });
  ui.timeout = Lab.range('sl-timeout', { format: (v) => `${v} s`, onInput: pol('timeout') });
  ui.jitter = Lab.toggle('tg-jitter', pol('jitter'));
  ui.fallback = Lab.toggle('tg-fallback', pol('fallback'));
  ui.concurrency = Lab.range('sl-conc', { format: (v) => `${v}`, onInput: pol('concurrency') });
  ui.cacheHit = Lab.range('sl-cache', { format: (v) => `${Math.round(v * 100)}%`, onInput: pol('cacheHit') });
  Lab.seg('seg-runs', (v) => { S.runs = parseInt(v, 10); recompute(0); });
  const tabSeg = Lab.seg('seg-tab', (v) => { S.tab = v; drawAnalytics(); });
  Lab.$('#btn-replay').addEventListener('click', () => runOnce(true));
  Lab.$('#btn-pin').addEventListener('click', () => {
    if (!mc) return;
    baseline = { ...mc };
    updateStats();
    drawAnalytics();
    Lab.toast('Baseline pinned — change the design and compare');
  });
  Lab.$('#btn-unpin').addEventListener('click', () => { baseline = null; updateStats(); drawAnalytics(); });
  Lab.$('#btn-export').addEventListener('click', () => {
    Lab.downloadText(JSON.stringify({ app: 'AgentFlow', version: 1, workflow: wf, policy: S.policy }, null, 2), `agentflow-${S.preset}.json`);
  });
  Lab.$('#btn-import').addEventListener('click', () => Lab.$('#file-wf').click());
  Lab.$('#file-wf').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const next = data.workflow || data;
      if (!Array.isArray(next.nodes) || !Array.isArray(next.edges)) throw new Error('missing nodes / edges');
      const errs = A.validate(next);
      if (errs.length) throw new Error(errs[0]);
      wf = next;
      if (data.policy) Object.assign(S.policy, data.policy);
      Object.entries(ui).forEach(([k, c]) => S.policy[k] != null && c.set(S.policy[k]));
      S.selected = wf.nodes[0].id;
      Lab.text('wf-desc', wf.description || '');
      runOnce(true);
      recompute(0);
      Lab.toast(`Imported “${wf.name || f.name}”`);
    } catch (err) {
      Lab.toast(`Could not import: ${err.message}`, 4000);
    }
  });
  Lab.$('#type-legend').innerHTML = ['llm', 'tool', 'human', 'map', 'loop', 'router'].map((t) => `<span><i class="box" style="background:${COLORS[t]}"></i>${TYPE_NAME[t].toLowerCase()}</span>`).join('');
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); runOnce(true); }
  });

  // ------------------------------------------------------------------ loop
  Lab.loop((dt) => {
    if (replay.on) {
      replay.t = Math.min(replay.dur, replay.t + dt);
      if (replay.t >= replay.dur) replay.on = false;
      drawGraph();
      drawGantt();
    }
  });

  loadPreset(S.preset);

  window.AgentFlow = {
    state: S,
    preset: loadPreset,
    set(p) { Object.assign(S.policy, p); Object.entries(p).forEach(([k, v]) => ui[k] && ui[k].set(v)); recompute(0); },
    replay: (animate = true) => runOnce(animate),
    finishReplay() { replay.t = replay.dur; replay.on = false; drawGraph(); drawGantt(); },
    pin: () => Lab.$('#btn-pin').click(),
    select,
    tab: (t) => tabSeg.set(t, true),
    get mc() { return mc; },
    get trace() { return trace; },
    get workflow() { return wf; },
  };
})();
