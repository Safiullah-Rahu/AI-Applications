/* MetaLab — meta-analysis, power analysis and publication-bias lab. */
(function () {
  'use strict';
  const MC = window.MetaCore;
  const M = window.LabMath;
  Lab.boot();
  const T = Lab.theme();
  const CYAN = '#22d3ee';
  const LIME = '#a3e635';
  const RED = '#fb7185';
  const AMBER = '#fbbf24';
  const GREY = '#475177';

  const S = {
    module: 'meta',
    dataset: 'bcg', measure: 'RR', method: 'REML', test: 'z', sort: 'input', forest: 'studies', contour: true, tf: true,
    design: 'two', d: 0.5, p1: 0.65, p2: 0.5, r: 0.3, n: 40, alpha: 0.05, tails: 2, target: 0.8,
    bd: 0.2, btau: 0.05, bk: 120, bn: 150, bpub: 0.2, bhack: 1, bseed: 3,
  };

  const fmt = (v, dg = 2) => Lab.fmt(v, dg);
  const fmtP = (p) => (!Number.isFinite(p) ? '—' : p < 0.001 ? '< .001' : '= ' + p.toFixed(3).replace(/^0/, ''));
  const fmtPshort = (p) => (!Number.isFinite(p) ? '—' : p < 0.001 ? '<.001' : p.toFixed(3).replace(/^0/, ''));

  // ================================================================== data
  let rows = []; // {label, year, yi, vi}
  let ratio = true; // effect is a log ratio → display exponentiated
  let res = null;
  let egger = null;
  let tf = null;

  function genSMD(seed = 11) {
    const rng = M.makeRng(seed);
    const out = [];
    let i = 0;
    while (out.length < 18 && i < 400) {
      i++;
      const n1 = 10 + rng.int(110);
      const n2 = n1 + rng.int(9) - 4;
      const theta = rng.gauss(0.32, 0.12);
      const sd1 = 10 * Math.sqrt(rng.gauss(1, Math.sqrt(2 / n1)) ** 2);
      const sd2 = 10 * Math.sqrt(rng.gauss(1, Math.sqrt(2 / n2)) ** 2);
      const m2 = 50 + rng.gauss(0, 10 / Math.sqrt(n2));
      const m1 = 50 + 10 * theta + rng.gauss(0, 10 / Math.sqrt(n1));
      const g = MC.hedgesG(m1, sd1, n1, m2, sd2, n2);
      const sig = g.yi / Math.sqrt(g.vi) > 1.96;
      if (!sig && rng.next() > 0.35) continue; // mild selective publication → small-study effect
      out.push({ study: `Study ${String.fromCharCode(65 + out.length)}`, year: 2004 + out.length, m1: +m1.toFixed(2), sd1: +sd1.toFixed(2), n1, m2: +m2.toFixed(2), sd2: +sd2.toFixed(2), n2 });
    }
    return out;
  }
  const SMD = genSMD();

  function datasetCSV() {
    if (S.dataset === 'bcg') {
      return ['study,year,tpos,tneg,cpos,cneg', ...MC.BCG.map((s) => `${s.study},${s.year},${s.tpos},${s.tneg},${s.cpos},${s.cneg}`)].join('\n');
    }
    return ['study,year,m1,sd1,n1,m2,sd2,n2', ...SMD.map((s) => `${s.study},${s.year},${s.m1},${s.sd1},${s.n1},${s.m2},${s.sd2},${s.n2}`)].join('\n');
  }

  /** Parse CSV into effect sizes. Returns {rows, ratio, error}. */
  function parseCSV(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (lines.length < 2) return { error: 'Need a header row and at least one study.' };
    const head = lines[0].split(/[,;\t]/).map((h) => h.trim().toLowerCase());
    const col = (n) => head.indexOf(n);
    const has = (...ns) => ns.every((n) => col(n) >= 0);
    let kind;
    if (has('tpos', 'tneg', 'cpos', 'cneg')) kind = 'counts';
    else if (has('m1', 'sd1', 'n1', 'm2', 'sd2', 'n2')) kind = 'means';
    else if (has('yi') && (has('vi') || has('sei'))) kind = 'direct';
    else return { error: 'Columns not recognised — see “CSV format” in How it works.' };
    const out = [];
    for (let li = 1; li < lines.length; li++) {
      const c = lines[li].split(/[,;\t]/).map((x) => x.trim());
      const num = (n) => parseFloat(c[col(n)]);
      const label = col('study') >= 0 ? c[col('study')] || `Study ${li}` : `Study ${li}`;
      const year = col('year') >= 0 ? parseInt(c[col('year')], 10) : NaN;
      let e;
      if (kind === 'counts') e = (S.measure === 'OR' ? MC.logOR : MC.logRR)(num('tpos'), num('tneg'), num('cpos'), num('cneg'));
      else if (kind === 'means') e = MC.hedgesG(num('m1'), num('sd1'), num('n1'), num('m2'), num('sd2'), num('n2'));
      else e = { yi: num('yi'), vi: has('vi') ? num('vi') : num('sei') ** 2 };
      if (!Number.isFinite(e.yi) || !(e.vi > 0)) return { error: `Row ${li + 1}: could not compute an effect size.` };
      out.push({ label, year, ...e, idx: out.length });
    }
    return { rows: out, ratio: kind === 'counts', kind };
  }

  function analyse() {
    const p = parseCSV(Lab.$('#ta-data').value);
    const msg = Lab.$('#parse-msg');
    if (p.error) {
      msg.textContent = p.error;
      msg.classList.add('bad');
      return;
    }
    msg.classList.remove('bad');
    msg.textContent = `${p.rows.length} studies · ${p.kind === 'counts' ? (S.measure === 'OR' ? 'log odds ratios' : 'log risk ratios') : p.kind === 'means' ? "Hedges' g" : 'effects as given'}`;
    Lab.$('#field-measure').classList.toggle('hidden', p.kind !== 'counts');
    rows = p.rows;
    ratio = p.ratio;
    const y = rows.map((r) => r.yi);
    const v = rows.map((r) => r.vi);
    const opts = { method: S.method, test: S.test };
    res = MC.metaAnalyze(y, v, opts);
    egger = MC.eggerTest(y, v);
    tf = MC.trimAndFill(y, v, { method: S.method });
    drawForest();
    drawFunnel();
    updateMetaStats();
  }

  // effect display helpers
  const disp = (x) => (ratio ? Math.exp(x) : x);
  const measureName = () => (ratio ? (S.measure === 'OR' ? 'Odds ratio' : 'Risk ratio') : "Hedges' g");
  const measureShort = () => (ratio ? S.measure : 'g');
  const methodName = () => ({ FE: 'fixed-effect', DL: 'random-effects (DerSimonian–Laird)', REML: 'random-effects (REML)' }[S.method]);

  // ================================================================== forest plot
  const fv = Lab.canvas('cv-forest', () => drawForest());
  function forestRows() {
    const v = rows.map((r) => r.vi);
    const y = rows.map((r) => r.yi);
    const opts = { method: S.method, test: S.test };
    if (S.forest === 'loo') {
      const loo = MC.leaveOneOut(y, v, opts);
      return rows.map((r, i) => ({ label: `omit ${r.label}${Number.isFinite(r.year) ? ` (${r.year})` : ''}`, est: loo[i].mu, lo: loo[i].lo, hi: loo[i].hi, w: null, pooled: true }));
    }
    if (S.forest === 'cum') {
      const order = rows.map((_, i) => i).sort((a, b) => (rows[a].year || 0) - (rows[b].year || 0) || a - b);
      const cum = MC.cumulative(y, v, order, opts);
      return order.map((i, n) => ({ label: `+ ${rows[i].label}${Number.isFinite(rows[i].year) ? ` (${rows[i].year})` : ''}`, est: cum[n].mu, lo: cum[n].lo, hi: cum[n].hi, w: null, pooled: true, k: n + 1 }));
    }
    const list = rows.map((r, i) => ({ label: r.label + (Number.isFinite(r.year) ? ` ${r.year}` : ''), year: r.year, est: r.yi, lo: r.yi - 1.96 * Math.sqrt(r.vi), hi: r.yi + 1.96 * Math.sqrt(r.vi), w: res.weights[i] }));
    if (S.sort === 'year') list.sort((a, b) => (a.year || 0) - (b.year || 0));
    if (S.sort === 'effect') list.sort((a, b) => a.est - b.est);
    if (S.sort === 'weight') list.sort((a, b) => b.w - a.w);
    return list;
  }
  function niceRatioTicks(lo, hi) {
    const cands = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 4, 5, 10, 20, 50, 100];
    let t = cands.filter((c) => Math.log(c) >= lo - 1e-9 && Math.log(c) <= hi + 1e-9);
    if (t.length > 7) t = t.filter((c) => [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 100].includes(c));
    return t.map(Math.log);
  }
  function drawForest() {
    if (!res) return;
    const { ctx, w, h } = fv;
    fv.clear();
    const list = forestRows();
    const n = list.length;
    const showPooled = S.forest === 'studies';
    const extra = showPooled ? 3 : 1;
    const top = 30;
    const bottom = S.dataset === 'bcg' && ratio ? 60 : 46;
    const rh = Math.max(9, Math.min(24, (h - top - bottom) / (n + extra)));
    const labW = Math.min(230, Math.max(120, w * 0.3));
    const rightW = Math.min(190, Math.max(150, w * 0.25));
    const wCol = showPooled ? 52 : 0;
    const x0 = labW + 10;
    const x1 = w - rightW - wCol - 10;
    const wx = w - rightW - 4;
    // x range
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of list) { lo = Math.min(lo, r.lo); hi = Math.max(hi, r.hi); }
    lo = Math.min(lo, res.piLo, 0);
    hi = Math.max(hi, res.piHi, 0);
    const pad = (hi - lo) * 0.06;
    lo -= pad;
    hi += pad;
    const X = (v) => x0 + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (x1 - x0);
    const fs = Math.max(9.5, Math.min(12, rh * 0.62));
    ctx.textBaseline = 'middle';
    // header
    ctx.font = `600 10.5px ${T.sans}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'left';
    ctx.fillText(S.forest === 'studies' ? 'STUDY' : S.forest === 'loo' ? 'SENSITIVITY: LEAVE ONE OUT' : 'CUMULATIVE BY YEAR', 12, 15);
    ctx.textAlign = 'right';
    ctx.fillText(`${measureShort()} [95% CI]`, w - 12, 15);
    if (showPooled) ctx.fillText('WEIGHT', wx, 15);
    // grid + null line
    const yEnd = top + (n + extra) * rh;
    const ticks = ratio ? niceRatioTicks(lo, hi) : M.niceTicks(lo, hi, 6).ticks;
    ctx.strokeStyle = 'rgba(142,160,216,0.08)';
    ctx.lineWidth = 1;
    for (const t of ticks) { const px = Math.round(X(t)) + 0.5; ctx.beginPath(); ctx.moveTo(px, top - 4); ctx.lineTo(px, yEnd); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(226,232,240,0.45)';
    ctx.beginPath(); ctx.moveTo(Math.round(X(0)) + 0.5, top - 4); ctx.lineTo(Math.round(X(0)) + 0.5, yEnd); ctx.stroke();
    // pooled reference line
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = Lab.alpha(LIME, 0.55);
    ctx.beginPath(); ctx.moveTo(X(res.mu), top - 4); ctx.lineTo(X(res.mu), yEnd); ctx.stroke();
    ctx.setLineDash([]);
    const wmax = showPooled ? Math.max(...list.map((r) => r.w)) : 1;
    list.forEach((r, i) => {
      const y = top + (i + 0.5) * rh;
      if (i % 2 === 0) { ctx.fillStyle = 'rgba(142,160,216,0.035)'; ctx.fillRect(8, y - rh / 2, w - 16, rh); }
      ctx.font = `${fs}px ${T.sans}`;
      ctx.fillStyle = T.text2;
      ctx.textAlign = 'left';
      let lab = r.label;
      while (ctx.measureText(lab).width > labW - 8 && lab.length > 4) lab = lab.slice(0, -2);
      ctx.fillText(lab === r.label ? lab : lab + '…', 12, y);
      ctx.strokeStyle = T.text2;
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(X(r.lo), y); ctx.lineTo(X(r.hi), y); ctx.stroke();
      if (r.lo < lo) { ctx.fillStyle = T.text2; ctx.fillText('‹', X(lo) - 2, y); }
      if (r.hi > hi) { ctx.fillStyle = T.text2; ctx.textAlign = 'left'; ctx.fillText('›', X(hi) + 1, y); }
      const sz = r.w != null ? 3 + 7 * Math.sqrt(r.w / wmax) * Math.min(1, rh / 18) : 3.5;
      ctx.fillStyle = r.pooled ? LIME : CYAN;
      if (r.pooled) { ctx.beginPath(); ctx.moveTo(X(r.est), y - sz); ctx.lineTo(X(r.est) + sz, y); ctx.lineTo(X(r.est), y + sz); ctx.lineTo(X(r.est) - sz, y); ctx.fill(); }
      else ctx.fillRect(X(r.est) - sz, y - sz, 2 * sz, 2 * sz);
      ctx.font = `${fs}px ${T.mono}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = T.text;
      ctx.fillText(`${fmt(disp(r.est))} [${fmt(disp(r.lo))}, ${fmt(disp(r.hi))}]`, w - 12, y);
      if (r.w != null) { ctx.fillStyle = T.muted; ctx.fillText(`${(r.w * 100).toFixed(1)}%`, wx, y); }
    });
    if (showPooled) {
      const y = top + (n + 1) * rh;
      ctx.strokeStyle = T.border2;
      ctx.beginPath(); ctx.moveTo(8, y - rh * 0.9); ctx.lineTo(w - 8, y - rh * 0.9); ctx.stroke();
      const dh = Math.max(5, rh * 0.42);
      ctx.fillStyle = LIME;
      ctx.beginPath(); ctx.moveTo(X(res.lo), y); ctx.lineTo(X(res.mu), y - dh); ctx.lineTo(X(res.hi), y); ctx.lineTo(X(res.mu), y + dh); ctx.closePath(); ctx.fill();
      ctx.font = `600 ${fs}px ${T.sans}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = T.text;
      ctx.fillText(S.method === 'FE' ? 'Fixed-effect model' : `Random-effects model (${S.method})`, 12, y);
      ctx.font = `600 ${fs}px ${T.mono}`;
      ctx.textAlign = 'right';
      ctx.fillText(`${fmt(disp(res.mu))} [${fmt(disp(res.lo))}, ${fmt(disp(res.hi))}]`, w - 12, y);
      ctx.fillStyle = T.muted;
      ctx.fillText('100%', wx, y);
      if (S.method !== 'FE') {
        const y2 = y + rh;
        ctx.strokeStyle = LIME;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(X(res.piLo), y2); ctx.lineTo(X(res.piHi), y2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = `${fs}px ${T.sans}`;
        ctx.textAlign = 'left';
        ctx.fillStyle = T.text2;
        ctx.fillText('Prediction interval', 12, y2);
        ctx.font = `${fs}px ${T.mono}`;
        ctx.textAlign = 'right';
        ctx.fillText(`[${fmt(disp(res.piLo))}, ${fmt(disp(res.piHi))}]`, w - 12, y2);
      }
    }
    // axis
    const ay = yEnd + 6;
    ctx.strokeStyle = T.border2;
    ctx.beginPath(); ctx.moveTo(x0, ay + 0.5); ctx.lineTo(x1, ay + 0.5); ctx.stroke();
    ctx.font = `10.5px ${T.mono}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const t of ticks) ctx.fillText(ratio ? String(+Math.exp(t).toPrecision(2)) : String(+t.toPrecision(3)), X(t), ay + 5);
    ctx.font = `600 10.5px ${T.sans}`;
    ctx.fillStyle = T.text2;
    ctx.fillText(`${measureName()}${ratio ? ' (log scale)' : ''}`, (x0 + x1) / 2, ay + 21);
    if (S.dataset === 'bcg' && ratio) {
      ctx.font = `10px ${T.sans}`;
      ctx.fillStyle = T.muted;
      ctx.textAlign = 'right';
      ctx.fillText('← favours vaccine', X(0) - 6, ay + 37);
      ctx.textAlign = 'left';
      ctx.fillText('favours control →', X(0) + 6, ay + 37);
      ctx.textAlign = 'center';
    }
    Lab.text('forest-sub', `k = ${rows.length} · ${measureName()} · ${methodName()}`);
  }

  // ================================================================== funnel plot (shared by meta & bias)
  /** pts: [{yi, vi, kind: 'study'|'filled'|'ghost'}], refs: [{x, color, dash, label}] */
  function drawFunnelOn(cv, pts, { mu, refs = [], contour = true, ratioAxis = false }) {
    const { ctx, w, h } = cv;
    cv.clear();
    const pad = { l: 50, r: 16, t: 14, b: 36 };
    const W = w - pad.l - pad.r;
    const H = h - pad.t - pad.b;
    if (W < 40 || H < 40 || !pts.length) return;
    const seMax = Math.max(...pts.map((p) => Math.sqrt(p.vi))) * 1.08;
    let lo = Math.min(...pts.map((p) => p.yi), mu - 1.96 * seMax, -1.96 * seMax * (contour ? 1.35 : 0));
    let hi = Math.max(...pts.map((p) => p.yi), mu + 1.96 * seMax, 1.96 * seMax * (contour ? 1.35 : 0));
    const padX = (hi - lo) * 0.05;
    lo -= padX;
    hi += padX;
    const X = (v) => pad.l + ((v - lo) / (hi - lo)) * W;
    const Y = (se) => pad.t + (se / seMax) * H;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, W, H);
    ctx.clip();
    if (contour) {
      // significance contours around the null: p < .01 darkest … p > .10 lightest
      const bands = [[Infinity, 'rgba(142,160,216,0.16)'], [2.576, 'rgba(142,160,216,0.10)'], [1.96, 'rgba(142,160,216,0.05)'], [1.645, 'rgba(7,11,21,0.9)']];
      for (const [z, col] of bands) {
        ctx.fillStyle = col;
        ctx.beginPath();
        if (!Number.isFinite(z)) ctx.rect(pad.l, pad.t, W, H);
        else { ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(z * seMax), Y(seMax)); ctx.lineTo(X(-z * seMax), Y(seMax)); ctx.closePath(); }
        ctx.fill();
      }
    }
    // pseudo confidence funnel around the pooled estimate
    ctx.strokeStyle = 'rgba(226,232,240,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(X(mu - 1.96 * seMax), Y(seMax)); ctx.lineTo(X(mu), Y(0)); ctx.lineTo(X(mu + 1.96 * seMax), Y(seMax));
    ctx.stroke();
    ctx.setLineDash([]);
    for (const r of refs) {
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 1.6;
      ctx.setLineDash(r.dash || []);
      ctx.beginPath(); ctx.moveTo(X(r.x), pad.t); ctx.lineTo(X(r.x), pad.t + H); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.lineWidth = 1.4;
    for (const p of pts) {
      const x = X(p.yi);
      const y = Y(Math.sqrt(p.vi));
      ctx.beginPath();
      ctx.arc(x, y, p.kind === 'ghost' ? 2.6 : 3.6, 0, Math.PI * 2);
      if (p.kind === 'filled') { ctx.strokeStyle = LIME; ctx.stroke(); }
      else if (p.kind === 'ghost') { ctx.fillStyle = 'rgba(90,100,140,0.55)'; ctx.fill(); }
      else { ctx.fillStyle = CYAN; ctx.fill(); ctx.strokeStyle = 'rgba(6,10,20,0.8)'; ctx.stroke(); }
    }
    ctx.restore();
    // axes
    ctx.strokeStyle = T.border2;
    ctx.strokeRect(pad.l + 0.5, pad.t + 0.5, W - 1, H - 1);
    ctx.font = `10.5px ${T.mono}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xt = ratioAxis ? niceRatioTicks(lo, hi) : M.niceTicks(lo, hi, 6).ticks;
    for (const t of xt) ctx.fillText(ratioAxis ? String(+Math.exp(t).toPrecision(2)) : String(+t.toPrecision(3)), X(t), pad.t + H + 5);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of M.niceTicks(0, seMax, 5).ticks) ctx.fillText(String(+t.toPrecision(3)), pad.l - 6, Y(t));
    ctx.font = `600 10.5px ${T.sans}`;
    ctx.fillStyle = T.text2;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(ratioAxis ? `${measureName()} (log scale)` : 'effect size', pad.l + W, h - 2);
    ctx.save();
    ctx.translate(12, pad.t + H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('standard error', 0, 0);
    ctx.restore();
    // legend
    let lx = pad.l + 10;
    const ly = pad.t + 12;
    ctx.font = `10.5px ${T.sans}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const r of refs.filter((r) => r.label)) {
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(r.dash || []);
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 16, ly); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = T.text2;
      ctx.fillText(r.label, lx + 21, ly);
      lx += 30 + ctx.measureText(r.label).width;
    }
    if (contour) {
      ctx.fillStyle = T.muted;
      ctx.textAlign = 'right';
      ctx.fillText('shading: p < .10 / .05 / .01 vs null', pad.l + W - 8, pad.t + H - 10);
    }
  }

  const fnv = Lab.canvas('cv-funnel', () => drawFunnel());
  function drawFunnel() {
    if (!res) return;
    const pts = rows.map((r) => ({ yi: r.yi, vi: r.vi, kind: 'study' }));
    const refs = [{ x: res.mu, color: LIME, label: 'pooled' }];
    if (S.tf && tf && tf.k0 > 0) {
      tf.filled.forEach((f) => pts.push({ yi: f.yi, vi: f.vi, kind: 'filled' }));
      refs.push({ x: tf.adjusted.mu, color: AMBER, dash: [5, 4], label: 'trim-and-fill' });
    }
    drawFunnelOn(fnv, pts, { mu: res.mu, refs, contour: S.contour, ratioAxis: ratio });
    Lab.text('funnel-sub', egger ? `Egger intercept ${fmt(egger.intercept)} (p ${fmtP(egger.p)})` : '');
  }

  function updateMetaStats() {
    const ci = `CI ${fmt(disp(res.lo))} – ${fmt(disp(res.hi))}`;
    Lab.$('#st-mu').innerHTML = `${fmt(disp(res.mu))}<span class="u">${measureShort()}</span>`;
    Lab.text('st-ci', ci);
    Lab.$('#st-i2').innerHTML = `${(res.I2 * 100).toFixed(1)}<span class="u">%</span>`;
    Lab.text('st-tau', `τ² = ${res.tau2.toFixed(3)}`);
    Lab.text('st-q', res.Q.toFixed(2));
    Lab.text('st-qp', `df = ${res.dfQ}, p ${fmtP(res.QP)}`);
    Lab.text('st-pi', S.method === 'FE' ? '—' : `${fmt(disp(res.piLo))} – ${fmt(disp(res.piHi))}`);
    Lab.text('st-egger', egger ? `p ${fmtPshort(egger.p) === '<.001' ? '< .001' : '= ' + fmtPshort(egger.p)}` : '—');
    Lab.text('st-egger2', egger ? `intercept ${fmt(egger.intercept)}` : 'needs ≥ 3 studies');
    Lab.text('st-tf', tf ? `${tf.k0} imputed` : '—');
    Lab.text('st-tf2', tf ? `adjusted ${fmt(disp(tf.adjusted.mu))} ${measureShort()}` : '');
    Lab.text('diag-sub', `${S.test === 'knha' ? 'Knapp–Hartung t' : 'Wald z'} intervals`);
    // plain-language methods & results paragraph
    const statName = S.test === 'knha' ? `t(${res.dfQ})` : 'z';
    const het = res.I2 < 0.25 ? 'low' : res.I2 < 0.5 ? 'moderate' : res.I2 < 0.75 ? 'substantial' : 'considerable';
    let txt = `A <b>${methodName()}</b> meta-analysis of <b>k = ${res.k}</b> studies estimated a pooled ${ratio ? measureName().toLowerCase() : "Hedges' g"} of <b>${fmt(disp(res.mu))}</b> (95% CI ${fmt(disp(res.lo))} to ${fmt(disp(res.hi))}; ${statName} = ${res.stat.toFixed(2)}, p ${fmtP(res.p)}). `;
    txt += `Heterogeneity was ${het} (τ² = ${res.tau2.toFixed(3)}, I² = ${(res.I2 * 100).toFixed(1)}%, Q(${res.dfQ}) = ${res.Q.toFixed(1)}, p ${fmtP(res.QP)})`;
    txt += S.method === 'FE' ? '. ' : `; the 95% prediction interval ranged from ${fmt(disp(res.piLo))} to ${fmt(disp(res.piHi))}. `;
    if (egger) txt += `Egger's regression test ${egger.p < 0.1 ? 'suggested' : 'did not indicate'} funnel-plot asymmetry (p ${fmtP(egger.p)}); `;
    if (tf) txt += tf.k0 ? `trim-and-fill imputed ${tf.k0} ${tf.k0 === 1 ? 'study' : 'studies'} (adjusted estimate ${fmt(disp(tf.adjusted.mu))}, 95% CI ${fmt(disp(tf.adjusted.lo))} to ${fmt(disp(tf.adjusted.hi))}).` : 'trim-and-fill imputed no studies.';
    Lab.$('#report-text').innerHTML = txt;
  }
  Lab.$('#btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(Lab.$('#report-text').textContent);
      Lab.toast('Report copied');
    } catch (e) {
      Lab.toast('Clipboard not available');
    }
  });

  // ================================================================== power module
  const curvePlot = new Lab.Plot('cv-curve', { pad: { l: 48, r: 16, t: 14, b: 30 }, xLabel: 'sample size', yLabel: 'power', yMin: 0, yMax: 1, legend: 'tl' });
  const distPlot = new Lab.Plot('cv-dist', { pad: { l: 48, r: 16, t: 14, b: 30 }, xLabel: 'test statistic', yLabel: 'density', yMin: 0, legend: 'tr' });
  const simPlot = new Lab.Plot('cv-sim', { pad: { l: 48, r: 16, t: 14, b: 30 }, xLabel: "observed Cohen's d", yLabel: 'experiments', yMin: 0 });
  const es = () => (S.design === 'prop' ? [S.p1, S.p2] : S.design === 'corr' ? S.r : S.d);
  const nLabel = () => ({ two: 'per group', one: 'pairs', prop: 'per group', corr: 'observations' }[S.design]);
  let simResult = null;

  function powerView() {
    const e = es();
    const pw = MC.power(S.design, e, S.n, S.alpha, S.tails);
    const req = MC.requiredN(S.design, e, S.target, S.alpha, S.tails);
    const pc = Lab.$('#st-power');
    pc.innerHTML = `${(pw * 100).toFixed(1)}<span class="u">%</span>`;
    pc.parentElement.className = 'stat ' + (pw >= S.target ? 'good' : pw < 0.5 ? 'bad' : 'warn');
    Lab.$('#st-req').innerHTML = Number.isFinite(req) ? `${req}<span class="u">${nLabel()}</span>` : '∞';
    // critical value
    let crit;
    if (S.design === 'two' || S.design === 'one') crit = MC.tInv(1 - S.alpha / S.tails, S.design === 'two' ? 2 * S.n - 2 : S.n - 1);
    else crit = MC.normInv(1 - S.alpha / S.tails);
    Lab.text('st-crit', `${S.tails === 2 ? '±' : ''}${crit.toFixed(3)}`);
    // --- power curve
    const nMax = Math.min(3000, Math.max(60, Math.ceil(Math.max(Number.isFinite(req) ? req * 1.6 : 0, S.n * 1.4))));
    const nMin = S.design === 'corr' ? 5 : 3;
    const ns = [];
    const steps = 110;
    for (let k = 0; k <= steps; k++) ns.push(Math.round(nMin + ((nMax - nMin) * k) / steps));
    const uniq = [...new Set(ns)];
    const bench = { two: [0.2, 0.5, 0.8], one: [0.2, 0.5, 0.8], corr: [0.1, 0.3, 0.5], prop: null }[S.design];
    const series = [];
    if (bench) {
      const names = ['small', 'medium', 'large'];
      bench.forEach((b, i) => series.push({ name: `${names[i]} (${b})`, color: Lab.alpha('#a9b4d6', 0.45), width: 1.2, dash: [4, 4], data: { x: uniq, y: uniq.map((n) => MC.power(S.design, b, n, S.alpha, S.tails)) }, noLegend: true }));
    }
    series.push({ name: S.design === 'prop' ? `p₁ = ${S.p1}, p₂ = ${S.p2}` : S.design === 'corr' ? `r = ${S.r}` : `d = ${S.d}`, color: CYAN, width: 2.4, data: { x: uniq, y: uniq.map((n) => MC.power(S.design, e, n, S.alpha, S.tails)) } });
    curvePlot.series = series;
    Object.assign(curvePlot.opts, { xMin: nMin, xMax: nMax });
    curvePlot.hlines = [{ y: S.target, color: Lab.alpha(LIME, 0.8), label: `target ${Math.round(S.target * 100)}%` }];
    curvePlot.vlines = Number.isFinite(req) && req <= nMax ? [{ x: req, color: Lab.alpha(LIME, 0.6), label: `n = ${req}`, align: req > nMax * 0.75 ? 'right' : 'left' }] : [];
    curvePlot.markers = [{ x: S.n, y: pw, color: CYAN, label: `${(pw * 100).toFixed(0)}%`, align: S.n > nMax * 0.8 ? 'right' : 'left' }];
    curvePlot.draw();
    Lab.text('curve-sub', bench ? `dashed: Cohen's small / medium / large benchmarks · α = ${S.alpha}` : `α = ${S.alpha}`);
    // --- null vs alternative
    drawDist(crit);
    Lab.$('#btn-sim').disabled = S.design !== 'two';
    Lab.$('#lbl-n').textContent = `Sample size (${nLabel()})`;
  }

  function drawDist(crit) {
    const tDesign = S.design === 'two' || S.design === 'one';
    const df = S.design === 'two' ? 2 * S.n - 2 : S.n - 1;
    let ncp;
    if (S.design === 'two') ncp = S.d * Math.sqrt(S.n / 2);
    else if (S.design === 'one') ncp = S.d * Math.sqrt(S.n);
    else if (S.design === 'corr') ncp = Math.atanh(S.r) * Math.sqrt(S.n - 3);
    else {
      const pb = (S.p1 + S.p2) / 2;
      ncp = (Math.abs(S.p1 - S.p2) * Math.sqrt(S.n)) / Math.sqrt(2 * pb * (1 - pb));
    }
    const lo = Math.min(-4.5, -crit - 1);
    const hi = Math.max(4.5, ncp + 4);
    const N = 220;
    const xs = [];
    for (let i = 0; i <= N; i++) xs.push(lo + ((hi - lo) * i) / N);
    const nullPdf = (x) => (tDesign ? Math.exp(MC.lgamma((df + 1) / 2) - MC.lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (x * x) / df)) : MC.normPdf(x));
    const hStep = 1e-3;
    const altPdf = (x) => (tDesign ? (MC.nctCdf(x + hStep, df, ncp) - MC.nctCdf(x - hStep, df, ncp)) / (2 * hStep) : MC.normPdf(x - ncp));
    const y0 = xs.map(nullPdf);
    const y1 = xs.map((x) => Math.max(0, altPdf(x)));
    const region = (ys, from, to) => {
      const X = [];
      const Y = [];
      xs.forEach((x, i) => { if (x >= from && x <= to) { X.push(x); Y.push(ys[i]); } });
      return { x: X, y: Y };
    };
    const series = [];
    const upper = region(y1, crit, hi);
    series.push({ name: `power ${(MC.power(S.design, es(), S.n, S.alpha, S.tails) * 100).toFixed(0)}%`, color: Lab.alpha(CYAN, 0.0), fill: Lab.alpha(CYAN, 0.28), data: upper });
    series.push({ name: `α = ${S.alpha}`, color: Lab.alpha(RED, 0.0), fill: Lab.alpha(RED, 0.45), data: region(y0, crit, hi) });
    if (S.tails === 2) {
      series.push({ name: '', color: Lab.alpha(RED, 0.0), fill: Lab.alpha(RED, 0.45), data: region(y0, lo, -crit), noLegend: true });
      series.push({ name: '', color: Lab.alpha(CYAN, 0.0), fill: Lab.alpha(CYAN, 0.28), data: region(y1, lo, -crit), noLegend: true });
    }
    series.push({ name: 'H₀ (no effect)', color: '#a9b4d6', width: 1.8, data: { x: xs, y: y0 } });
    series.push({ name: 'H₁ (true effect)', color: CYAN, width: 2.2, data: { x: xs, y: y1 } });
    distPlot.series = series;
    Object.assign(distPlot.opts, { xMin: lo, xMax: hi });
    distPlot.vlines = [{ x: crit, color: Lab.alpha(RED, 0.8), label: `crit ${crit.toFixed(2)}` }].concat(S.tails === 2 ? [{ x: -crit, color: Lab.alpha(RED, 0.8), align: 'right' }] : []);
    distPlot.opts.xLabel = tDesign ? `t statistic (df = ${df}, non-centrality ${ncp.toFixed(2)})` : `z statistic (non-centrality ${ncp.toFixed(2)})`;
    distPlot.draw();
    Lab.text('dist-sub', 'red: false-positive rate α · cyan: power 1 − β');
  }

  function runSim() {
    if (S.design !== 'two') return;
    const rng = M.makeRng(Math.floor(Math.random() * 1e9));
    const t0 = performance.now();
    const sims = MC.simulateExperiments(S.d, S.n, 2000, rng);
    const ms = performance.now() - t0;
    const sig = sims.filter((s) => s.p < S.alpha / (S.tails === 2 ? 1 : 2) && (S.tails === 2 || s.t > 0));
    const emp = sig.length / sims.length;
    const sigPos = sig.filter((s) => s.d > 0);
    const winner = sigPos.reduce((a, s) => a + s.d, 0) / Math.max(1, sigPos.length);
    const signErr = sig.filter((s) => s.d < 0).length;
    simResult = { sims, emp, winner, signErr, ms };
    drawSim();
  }
  function drawSim() {
    if (!simResult) { simPlot.series = []; simPlot.draw(); return; }
    const { sims, emp, winner, signErr } = simResult;
    const ds = sims.map((s) => s.d);
    const lo = Math.min(...ds);
    const hi = Math.max(...ds);
    const nb = 50;
    const bw = (hi - lo) / nb || 1;
    const all = new Array(nb).fill(0);
    const sg = new Array(nb).fill(0);
    sims.forEach((s) => {
      const b = Math.min(nb - 1, Math.floor((s.d - lo) / bw));
      all[b]++;
      if (s.p < S.alpha) sg[b]++;
    });
    const step = (counts) => {
      const x = [];
      const y = [];
      counts.forEach((c, i) => { x.push(lo + i * bw, lo + (i + 1) * bw); y.push(c, c); });
      return { x, y };
    };
    simPlot.series = [
      { name: 'all', color: GREY, fill: Lab.alpha(GREY, 0.75), width: 1, data: step(all) },
      { name: 'significant', color: CYAN, fill: Lab.alpha(CYAN, 0.55), width: 1, data: step(sg) },
    ];
    simPlot.vlines = [{ x: S.d, color: LIME, label: `true d ${S.d}`, dash: [] }, { x: winner, color: AMBER, label: `mean significant ${winner.toFixed(2)}`, align: 'left' }];
    Object.assign(simPlot.opts, { xMin: lo, xMax: hi });
    simPlot.draw();
    Lab.$('#st-emp').innerHTML = `${(emp * 100).toFixed(1)}<span class="u">%</span>`;
    Lab.$('#st-winner').innerHTML = `${winner.toFixed(2)}<span class="u">×${(winner / S.d).toFixed(1)}</span>`;
    Lab.text('st-sign', `${signErr} / 2000`);
    Lab.text('sim-sub', `2,000 simulated experiments · d = ${S.d}, n = ${S.n} per group · ${simResult.ms.toFixed(0)} ms`);
  }

  // ================================================================== bias lab
  const bfv = Lab.canvas('cv-bfunnel', () => biasView());
  const estv = Lab.canvas('cv-est', () => biasView());
  const pcv = Lab.canvas('cv-pcurve', () => biasView());
  let bias = null;
  function simulateBias() {
    const studies = MC.simulateLiterature({ delta: S.bd, tau: S.btau, attempts: S.bk, nMin: 10, nMax: S.bn, pubNonSig: S.bpub, hacking: S.bhack, seed: S.bseed });
    const pub = studies.filter((s) => s.published);
    const all = MC.metaAnalyze(studies.map((s) => s.yi), studies.map((s) => s.vi));
    const naive = pub.length ? MC.metaAnalyze(pub.map((s) => s.yi), pub.map((s) => s.vi)) : null;
    const tfb = pub.length >= 3 ? MC.trimAndFill(pub.map((s) => s.yi), pub.map((s) => s.vi), { side: 'left' }) : null;
    const pet = pub.length >= 3 ? MC.petEstimate(pub.map((s) => s.yi), pub.map((s) => s.vi)) : null;
    const eg = pub.length >= 3 ? MC.eggerTest(pub.map((s) => s.yi), pub.map((s) => s.vi)) : null;
    bias = { studies, pub, all, naive, tfb, pet, eg };
    biasView();
  }
  function biasView() {
    if (!bias || S.module !== 'bias') return;
    const { studies, pub, all, naive, tfb, pet, eg } = bias;
    // funnel
    const pts = studies.filter((s) => !s.published).map((s) => ({ yi: s.yi, vi: s.vi, kind: 'ghost' }));
    pub.forEach((s) => pts.push({ yi: s.yi, vi: s.vi, kind: 'study' }));
    if (tfb) tfb.filled.forEach((f) => pts.push({ yi: f.yi, vi: f.vi, kind: 'filled' }));
    const refs = [{ x: S.bd, color: LIME, label: 'true δ' }];
    if (naive) refs.push({ x: naive.mu, color: RED, dash: [5, 4], label: 'published estimate' });
    drawFunnelOn(bfv, pts, { mu: naive ? naive.mu : S.bd, refs, contour: true });
    Lab.text('bfunnel-sub', `${studies.length} studies run · ${pub.length} published`);
    // estimates chart
    const rowsE = [
      { label: 'True mean effect δ', est: S.bd, color: LIME },
      { label: 'All studies (no selection)', est: all.mu, lo: all.lo, hi: all.hi, color: '#a9b4d6' },
      naive && { label: 'Published only (naive)', est: naive.mu, lo: naive.lo, hi: naive.hi, color: RED },
      tfb && { label: `Trim-and-fill (+${tfb.k0})`, est: tfb.adjusted.mu, lo: tfb.adjusted.lo, hi: tfb.adjusted.hi, color: AMBER },
      pet && { label: 'PET (precision-effect test)', est: pet.estimate, color: CYAN },
    ].filter(Boolean);
    drawEstimates(rowsE);
    // p-curve
    drawPcurve(pub.filter((s) => s.sig).map((s) => s.p));
    // stats
    Lab.$('#bs-pub').innerHTML = `${pub.length}<span class="u">/ ${studies.length}</span>`;
    const nsig = pub.filter((s) => s.sig).length;
    Lab.$('#bs-sig').innerHTML = `${pub.length ? Math.round((nsig / pub.length) * 100) : 0}<span class="u">%</span>`;
    Lab.text('bs-bias', naive ? `${naive.mu - S.bd >= 0 ? '+' : '−'}${Math.abs(naive.mu - S.bd).toFixed(2)}` : '—');
    Lab.text('bs-egger', eg ? `p ${fmtP(eg.p)}` : '—');
    const powerAvg = studies.reduce((a, s) => a + MC.power('two', Math.max(0.01, S.bd), s.n), 0) / studies.length;
    let txt = `With a true effect of <b>δ = ${S.bd.toFixed(2)}</b> and typical studies of ~${Math.round(studies.reduce((a, s) => a + s.n, 0) / studies.length)} participants per group (average power ${(powerAvg * 100).toFixed(0)}%), `;
    txt += naive ? `a meta-analysis of the <b>${pub.length} published</b> studies estimates <b>${naive.mu.toFixed(2)}</b> [${naive.lo.toFixed(2)}, ${naive.hi.toFixed(2)}]` : 'nothing was published';
    txt += `, whereas all ${studies.length} studies together give ${all.mu.toFixed(2)}. `;
    if (naive) txt += Math.abs(naive.mu - S.bd) > 0.05 ? `Selective publication${S.bhack > 1 ? ' and p-hacking' : ''} inflate the literature by <b>${(naive.mu - S.bd).toFixed(2)}</b>. ` : 'The published record is close to the truth. ';
    if (eg) txt += `Egger's test ${eg.p < 0.1 ? 'flags' : 'does not flag'} the asymmetry (p ${fmtP(eg.p)}); corrections move the estimate to ${tfb ? tfb.adjusted.mu.toFixed(2) : '—'} (trim-and-fill) and ${pet ? pet.estimate.toFixed(2) : '—'} (PET).`;
    Lab.$('#bias-report').innerHTML = txt;
  }
  function drawEstimates(list) {
    const { ctx, w, h } = estv;
    estv.clear();
    const labW = Math.min(210, w * 0.42);
    const x0 = labW + 10;
    const x1 = w - 70;
    let lo = 0;
    let hi = 0;
    list.forEach((r) => { lo = Math.min(lo, r.lo ?? r.est); hi = Math.max(hi, r.hi ?? r.est); });
    const pad = (hi - lo) * 0.1 + 0.02;
    lo -= pad;
    hi += pad;
    const X = (v) => x0 + ((v - lo) / (hi - lo)) * (x1 - x0);
    const top = 18;
    const rh = Math.min(46, (h - top - 36) / list.length);
    const ticks = M.niceTicks(lo, hi, 6).ticks;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(142,160,216,0.1)';
    for (const t of ticks) { ctx.beginPath(); ctx.moveTo(X(t), top); ctx.lineTo(X(t), top + rh * list.length); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(226,232,240,0.4)';
    ctx.beginPath(); ctx.moveTo(X(0), top); ctx.lineTo(X(0), top + rh * list.length); ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = Lab.alpha(LIME, 0.6);
    ctx.beginPath(); ctx.moveTo(X(S.bd), top); ctx.lineTo(X(S.bd), top + rh * list.length); ctx.stroke();
    ctx.setLineDash([]);
    list.forEach((r, i) => {
      const y = top + (i + 0.5) * rh;
      ctx.font = `12px ${T.sans}`;
      ctx.fillStyle = T.text2;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(r.label, 12, y);
      if (r.lo != null) {
        ctx.strokeStyle = r.color;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(X(r.lo), y); ctx.lineTo(X(r.hi), y); ctx.stroke();
      }
      ctx.fillStyle = r.color;
      ctx.beginPath(); ctx.arc(X(r.est), y, 5.5, 0, Math.PI * 2); ctx.fill();
      ctx.font = `600 12px ${T.mono}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = T.text;
      ctx.fillText(r.est.toFixed(2), w - 12, y);
    });
    ctx.font = `10.5px ${T.mono}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const ay = top + rh * list.length + 6;
    for (const t of ticks) ctx.fillText(String(+t.toPrecision(3)), X(t), ay);
    ctx.font = `600 10.5px ${T.sans}`;
    ctx.fillStyle = T.text2;
    ctx.fillText("effect size (Hedges' g) with 95% CI", (x0 + x1) / 2, ay + 15);
  }
  function drawPcurve(ps) {
    const { ctx, w, h } = pcv;
    pcv.clear();
    const pad = { l: 46, r: 14, t: 16, b: 34 };
    const W = w - pad.l - pad.r;
    const H = h - pad.t - pad.b;
    const bins = [0, 0, 0, 0, 0];
    ps.forEach((p) => { bins[Math.min(4, Math.floor(p / 0.01))]++; });
    const tot = Math.max(1, ps.length);
    const pct = bins.map((b) => (b / tot) * 100);
    const ymax = Math.max(60, ...pct) * 1.1;
    const Y = (v) => pad.t + H - (v / ymax) * H;
    ctx.strokeStyle = T.border2;
    ctx.strokeRect(pad.l + 0.5, pad.t + 0.5, W - 1, H - 1);
    ctx.font = `10.5px ${T.mono}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of M.niceTicks(0, ymax, 5).ticks) {
      ctx.fillText(`${t}%`, pad.l - 6, Y(t));
      ctx.strokeStyle = 'rgba(142,160,216,0.08)';
      ctx.beginPath(); ctx.moveTo(pad.l, Y(t)); ctx.lineTo(pad.l + W, Y(t)); ctx.stroke();
    }
    const bw = W / 5;
    pct.forEach((v, i) => {
      ctx.fillStyle = Lab.alpha(CYAN, 0.75);
      ctx.fillRect(pad.l + i * bw + bw * 0.14, Y(v), bw * 0.72, pad.t + H - Y(v));
      ctx.fillStyle = T.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`.0${i}–.0${i + 1}`, pad.l + (i + 0.5) * bw, pad.t + H + 5);
      ctx.fillStyle = T.text;
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${v.toFixed(0)}%`, pad.l + (i + 0.5) * bw, Y(v) - 3);
    });
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = Lab.alpha(RED, 0.8);
    ctx.beginPath(); ctx.moveTo(pad.l, Y(20)); ctx.lineTo(pad.l + W, Y(20)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `10.5px ${T.sans}`;
    ctx.fillStyle = RED;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('flat = no true effect', pad.l + W - 6, Y(20) - 3);
    ctx.fillStyle = T.text2;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.font = `600 10.5px ${T.sans}`;
    ctx.fillText(`p-value bin · n = ${ps.length} significant results`, pad.l + W, h - 2);
    ctx.textAlign = 'left';
    ctx.font = `10.5px ${T.sans}`;
    ctx.fillStyle = T.muted;
    ctx.textBaseline = 'top';
    ctx.fillText('right-skewed (many p < .01) = evidential value · left-skewed = p-hacking', pad.l + 8, pad.t + 6);
  }

  // ================================================================== sidebar wiring
  function setModule(m) {
    S.module = m;
    modSeg.set(m);
    ['meta', 'power', 'bias'].forEach((k) => {
      Lab.$(`#mod-${k}`).classList.toggle('on', k === m);
      Lab.$(`.side-${k}`).classList.toggle('hidden', k !== m);
    });
    requestAnimationFrame(() => {
      [fv, fnv, bfv, estv, pcv].forEach((c) => c.resize());
      [curvePlot, distPlot, simPlot].forEach((p) => p.c.resize());
      if (m === 'meta') analyse();
      if (m === 'power') { powerView(); drawSim(); }
      if (m === 'bias') { if (!bias) simulateBias(); else biasView(); }
    });
  }
  const modSeg = Lab.seg('seg-module', setModule);
  const taData = Lab.$('#ta-data');
  const dsSel = Lab.select('sel-dataset', (v) => {
    S.dataset = v;
    if (v !== 'custom') taData.value = datasetCSV();
    analyse();
  });
  let taTimer = 0;
  taData.addEventListener('input', () => {
    if (S.dataset !== 'custom') { S.dataset = 'custom'; dsSel.set('custom'); }
    clearTimeout(taTimer);
    taTimer = setTimeout(analyse, 250);
  });
  Lab.seg('seg-measure', (v) => { S.measure = v; analyse(); });
  const methodSeg = Lab.seg('seg-method', (v) => { S.method = v; analyse(); });
  Lab.seg('seg-test', (v) => { S.test = v; analyse(); });
  Lab.seg('seg-sort', (v) => { S.sort = v; drawForest(); });
  const forestSeg = Lab.seg('seg-forest', (v) => { S.forest = v; drawForest(); });
  Lab.toggle('tg-contour', (v) => { S.contour = v; drawFunnel(); });
  Lab.toggle('tg-tf', (v) => { S.tf = v; drawFunnel(); });

  const ui = {};
  const pv = () => { simResult = null; powerView(); drawSim(); resetSimStats(); };
  function resetSimStats() {
    ['st-emp', 'st-winner', 'st-sign'].forEach((id) => Lab.text(id, '—'));
    Lab.text('sim-sub', S.design === 'two' ? 'Press “Simulate” to run 2,000 experiments at the current design' : 'Simulation is available for the two-group design');
  }
  Lab.seg('seg-design', (v) => {
    S.design = v;
    Lab.$('#f-d').classList.toggle('hidden', !(v === 'two' || v === 'one'));
    Lab.$('#f-p').classList.toggle('hidden', v !== 'prop');
    Lab.$('#f-r').classList.toggle('hidden', v !== 'corr');
    pv();
  });
  ui.d = Lab.range('sl-d', { format: (v) => v.toFixed(2), onInput: (v) => { S.d = v; pv(); } });
  ui.p1 = Lab.range('sl-p1', { format: (v) => v.toFixed(2), onInput: (v) => { S.p1 = v; pv(); } });
  ui.p2 = Lab.range('sl-p2', { format: (v) => v.toFixed(2), onInput: (v) => { S.p2 = v; pv(); } });
  ui.r = Lab.range('sl-r', { format: (v) => v.toFixed(2), onInput: (v) => { S.r = v; pv(); } });
  ui.n = Lab.range('sl-n', { format: (v) => `${v}`, onInput: (v) => { S.n = v; pv(); } });
  Lab.seg('seg-alpha', (v) => { S.alpha = parseFloat(v); pv(); });
  Lab.seg('seg-tails', (v) => { S.tails = parseInt(v, 10); pv(); });
  ui.target = Lab.range('sl-target', { format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => { S.target = v; pv(); } });
  Lab.$('#btn-use-n').addEventListener('click', () => {
    const req = MC.requiredN(S.design, es(), S.target, S.alpha, S.tails);
    if (!Number.isFinite(req)) return Lab.toast('Target power is not reachable');
    if (req > 400) ui.n.el.max = String(Math.min(3000, Math.ceil(req * 1.5)));
    ui.n.set(req);
    S.n = req;
    pv();
    Lab.toast(`n = ${req} ${nLabel()} gives ≥ ${Math.round(S.target * 100)}% power`);
  });
  Lab.$('#btn-sim').addEventListener('click', runSim);

  const bset = (k) => (v) => { S[k] = v; simulateBias(); };
  ui.bd = Lab.range('sl-bd', { format: (v) => v.toFixed(2), onInput: bset('bd') });
  ui.btau = Lab.range('sl-btau', { format: (v) => v.toFixed(2), onInput: bset('btau') });
  ui.bk = Lab.range('sl-bk', { format: (v) => `${v}`, onInput: bset('bk') });
  ui.bn = Lab.range('sl-bn', { format: (v) => `${v}`, onInput: bset('bn') });
  ui.bpub = Lab.range('sl-bpub', { format: (v) => `${Math.round(v * 100)}%`, onInput: bset('bpub') });
  ui.bhack = Lab.range('sl-bhack', { format: (v) => `${v}`, onInput: bset('bhack') });
  Lab.$('#btn-resample').addEventListener('click', () => { S.bseed++; simulateBias(); });
  const BIAS = {
    honest: { bd: 0.2, btau: 0.05, bpub: 1, bhack: 1, msg: 'Every study is published: the literature is an unbiased sample.' },
    drawer: { bd: 0.2, btau: 0.05, bpub: 0.1, bhack: 1, msg: '90% of non-significant results stay in the file drawer.' },
    hacked: { bd: 0, btau: 0, bpub: 0.1, bhack: 6, msg: 'No true effect — but each study tries 6 outcomes and publishes the best.' },
    small: { bd: 0.1, btau: 0.05, bpub: 0.05, bhack: 2, msg: 'A small real effect, strong selection and mild p-hacking.' },
  };
  function applyBias(name) {
    const p = BIAS[name];
    Object.assign(S, p);
    ['bd', 'btau', 'bpub', 'bhack'].forEach((k) => ui[k].set(p[k]));
    simulateBias();
    Lab.toast(p.msg, 4200);
  }
  Lab.$$('[data-bias]').forEach((b) => b.addEventListener('click', () => applyBias(b.dataset.bias)));

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const m = { 1: 'meta', 2: 'power', 3: 'bias' }[e.key];
    if (m) setModule(m);
  });

  // ================================================================== init
  taData.value = datasetCSV();
  analyse();
  powerView();
  resetSimStats();

  window.MetaLab = {
    state: S,
    module: setModule,
    dataset: (d) => dsSel.set(d, true),
    method: (m) => methodSeg.set(m, true),
    forest: (m) => forestSeg.set(m, true),
    get result() { return { res, egger, tf }; },
    set(o) { Object.assign(S, o); Object.entries(o).forEach(([k, v]) => ui[k] && ui[k].set(v)); if (S.module === 'power') pv(); if (S.module === 'bias') simulateBias(); },
    simulate: runSim,
    bias: applyBias,
    get biasResult() { return bias; },
  };
})();
