/* NeuroPlayground — UI, training loop and visualisations. */
(function () {
  'use strict';
  const NN = window.NNCore;
  const M = window.LabMath;
  Lab.boot();
  const T = Lab.theme();
  const C0 = '#f59e0b';
  const C1 = '#38bdf8';
  const LAYER_COLORS = ['#f472b6', '#818cf8', '#34d399', '#fbbf24', '#38bdf8', '#fb923c', '#a78bfa'];
  const DATASETS = ['circles', 'xor', 'gauss', 'moons', 'spiral', 'checker', 'draw'];
  const DS_LABEL = { circles: 'Circles', xor: 'XOR', gauss: 'Blobs', moons: 'Moons', spiral: 'Spiral', checker: 'Checker', draw: 'Draw' };

  const S = {
    dataset: 'spiral', noise: 0.1, n: 300, ratio: 0.6,
    features: ['x1', 'x2', 'sin1', 'sin2'],
    layers: [8, 6, 4], act: 'tanh', opt: 'adam', lrExp: -1.9, batch: 16, l2Exp: -6,
    running: true, speed: 2, showTest: true, seed: 1,
  };
  const lr = () => Math.pow(10, S.lrExp);
  const l2 = () => (S.l2Exp <= -6 ? 0 : Math.pow(10, S.l2Exp));

  // ------------------------------------------------------------------ data & model
  let points = [];
  let train = [];
  let test = [];
  let customPts = [];
  let net = null;
  let epoch = 0;
  const hist = { train: [], test: [], trainAcc: 0, testAcc: 0, grad: [] };
  const rng = M.makeRng(99);

  function genData() {
    if (S.dataset === 'draw') points = customPts.slice();
    else points = NN.makeDataset(S.dataset, S.n, S.noise, S.seed);
    const idx = points.map((_, i) => i);
    M.makeRng(S.seed + 7).shuffle(idx);
    const nTrain = S.dataset === 'draw' ? points.length : Math.round(points.length * S.ratio);
    train = idx.slice(0, nTrain).map((i) => points[i]);
    test = idx.slice(nTrain).map((i) => points[i]);
    if (S.dataset === 'draw') test = points.filter((p) => p.test);
    if (S.dataset === 'draw') train = points.filter((p) => !p.test);
  }
  const asXY = (set) => ({ X: set.map((p) => NN.featurize(S.features, p.x, p.y)), y: set.map((p) => p.c) });

  function buildNet() {
    net = new NN.Network([S.features.length, ...S.layers, 1], S.act, S.seed * 31 + 5);
    epoch = 0;
    hist.train = [];
    hist.test = [];
    hist.grad = Array.from({ length: net.L }, () => []);
    hist.trainAcc = hist.testAcc = NaN;
    evaluate();
    mapsDirty = true;
    layoutControls();
    updateSubtitles();
  }

  function trainEpoch() {
    if (!train.length) return;
    const { X, y } = asXY(train);
    const idx = X.map((_, i) => i);
    rng.shuffle(idx);
    const gAcc = new Float64Array(net.L);
    let nb = 0;
    for (let s = 0; s < idx.length; s += S.batch) {
      net.trainBatch(X, y, idx.slice(s, s + S.batch), { type: S.opt, lr: lr(), l2: l2() });
      for (let l = 0; l < net.L; l++) gAcc[l] += net.gradNorms[l];
      nb++;
    }
    epoch++;
    for (let l = 0; l < net.L; l++) hist.grad[l].push(Math.max(1e-12, gAcc[l] / nb));
    evaluate();
  }
  function evaluate() {
    const tr = asXY(train);
    const te = asXY(test);
    const a = net.evaluate(tr.X, tr.y);
    const b = net.evaluate(te.X, te.y);
    hist.train.push(a.loss);
    hist.test.push(b.loss);
    hist.trainAcc = a.acc;
    hist.testAcc = b.acc;
  }

  // ------------------------------------------------------------------ activation maps
  const G = 30;
  const GO = 100;
  let mapsDirty = true;
  let neuronMaps = [];
  let featureMaps = [];
  let outCanvas = null;
  const lut = Lab.lut('duo');
  function mapToCanvas(vals, n, norm) {
    const c = document.createElement('canvas');
    c.width = n;
    c.height = n;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(n, n);
    for (let k = 0; k < n * n; k++) {
      const t = Math.max(0, Math.min(255, Math.round(norm(vals[k]) * 255))) * 3;
      img.data[k * 4] = lut[t];
      img.data[k * 4 + 1] = lut[t + 1];
      img.data[k * 4 + 2] = lut[t + 2];
      img.data[k * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
  function computeMaps() {
    const L = net.L;
    const acts = S.layers.map((n) => Array.from({ length: n }, () => new Float32Array(G * G)));
    const feats = S.features.map(() => new Float32Array(G * G));
    const outSmall = new Float32Array(G * G);
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const x = -1 + ((i + 0.5) * 2) / G;
        const y = 1 - ((j + 0.5) * 2) / G;
        const f = NN.featurize(S.features, x, y);
        f.forEach((v, k) => (feats[k][j * G + i] = v));
        const { a } = net.forward(f);
        for (let l = 1; l < L; l++) for (let k = 0; k < S.layers[l - 1]; k++) acts[l - 1][k][j * G + i] = a[l][k];
        outSmall[j * G + i] = a[L][0];
      }
    }
    neuronMaps = acts.map((layer) => layer.map((vals) => {
      let mx = 1e-9;
      for (const v of vals) mx = Math.max(mx, Math.abs(v));
      return mapToCanvas(vals, G, (v) => 0.5 + 0.5 * (v / mx));
    }));
    featureMaps = feats.map((vals) => mapToCanvas(vals, G, (v) => 0.5 + 0.5 * v));
    neuronMaps.push([mapToCanvas(outSmall, G, (v) => v)]);
    const out = new Float32Array(GO * GO);
    for (let j = 0; j < GO; j++) {
      for (let i = 0; i < GO; i++) {
        const x = -1 + ((i + 0.5) * 2) / GO;
        const y = 1 - ((j + 0.5) * 2) / GO;
        out[j * GO + i] = net.predict(NN.featurize(S.features, x, y));
      }
    }
    outCanvas = mapToCanvas(out, GO, (v) => v);
    outValues = out;
    mapsDirty = false;
  }
  let outValues = null;

  // ------------------------------------------------------------------ network diagram
  const cvNet = Lab.canvas('cv-net', () => { layoutControls(); needsDraw = true; });
  let netLayout = null;
  let hovered = null;
  function computeLayout() {
    const { w, h } = cvNet;
    const cols = [S.features.length, ...S.layers, 1];
    const pad = { l: 78, r: 70, t: 64, b: 22 };
    const maxN = Math.max(...cols);
    const node = Math.max(18, Math.min(40, (h - pad.t - pad.b) / maxN - 8));
    const gapY = Math.min(node * 0.45, ((h - pad.t - pad.b) - maxN * node) / Math.max(1, maxN - 1));
    const colX = cols.map((_, c) => pad.l + ((w - pad.l - pad.r) * c) / (cols.length - 1));
    const nodes = cols.map((n, c) => {
      const total = n * node + (n - 1) * gapY;
      const y0 = pad.t + (h - pad.t - pad.b - total) / 2;
      return Array.from({ length: n }, (_, k) => ({ x: colX[c] - node / 2, y: y0 + k * (node + gapY), s: node }));
    });
    netLayout = { cols, colX, nodes, node };
    return netLayout;
  }
  function drawNet() {
    const { ctx } = cvNet;
    cvNet.clear();
    const lay = computeLayout();
    const { nodes } = lay;
    // edges
    for (let l = 0; l < net.L; l++) {
      const nIn = net.sizes[l];
      const W = net.W[l];
      let mx = 1e-9;
      for (const v of W) mx = Math.max(mx, Math.abs(v));
      for (let j = 0; j < net.sizes[l + 1]; j++) {
        const b = nodes[l + 1][j];
        for (let i = 0; i < nIn; i++) {
          const a = nodes[l][i];
          const wv = W[j * nIn + i];
          const m = Math.abs(wv) / mx;
          const x0 = a.x + a.s;
          const y0 = a.y + a.s / 2;
          const x1 = b.x;
          const y1 = b.y + b.s / 2;
          ctx.strokeStyle = Lab.alpha(wv >= 0 ? C1 : C0, 0.12 + 0.6 * m);
          ctx.lineWidth = 0.4 + 3.2 * m;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          const cx = (x0 + x1) / 2;
          ctx.bezierCurveTo(cx, y0, cx, y1, x1, y1);
          ctx.stroke();
        }
      }
    }
    // nodes
    const drawNode = (n, img, highlight) => {
      ctx.save();
      Lab.roundRect(ctx, n.x, n.y, n.s, n.s, 6);
      ctx.clip();
      ctx.imageSmoothingEnabled = true;
      if (img) ctx.drawImage(img, n.x, n.y, n.s, n.s);
      ctx.restore();
      ctx.strokeStyle = highlight ? '#fff' : 'rgba(142,160,216,0.45)';
      ctx.lineWidth = highlight ? 2 : 1;
      Lab.roundRect(ctx, n.x, n.y, n.s, n.s, 6);
      ctx.stroke();
    };
    nodes[0].forEach((n, i) => {
      drawNode(n, featureMaps[i], hovered && hovered.l === 0 && hovered.k === i);
      ctx.font = `600 11px ${T.mono}`;
      ctx.fillStyle = T.text2;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(NN.FEATURES[S.features[i]].label, n.x - 8, n.y + n.s / 2);
    });
    for (let l = 1; l < nodes.length; l++) {
      nodes[l].forEach((n, k) => {
        drawNode(n, neuronMaps[l - 1] && neuronMaps[l - 1][k], hovered && hovered.l === l && hovered.k === k);
        // bias as a small dot
        const bv = net.b[l - 1][k];
        ctx.fillStyle = bv >= 0 ? C1 : C0;
        ctx.globalAlpha = Math.min(1, 0.3 + Math.abs(bv));
        ctx.beginPath();
        ctx.arc(n.x - 4, n.y + n.s - 4, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      });
    }
    const outN = nodes[nodes.length - 1][0];
    ctx.font = `600 11px ${T.sans}`;
    ctx.fillStyle = T.text2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('ŷ', outN.x + outN.s + 8, outN.y + outN.s / 2);
    ctx.font = `600 10.5px ${T.sans}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('INPUTS', lay.colX[0], 12);
    ctx.fillText('OUTPUT', lay.colX[lay.colX.length - 1], 12);
  }
  function layoutControls() {
    const wrap = Lab.$('#net-wrap');
    Lab.$$('.layer-ctrl', wrap).forEach((e) => e.remove());
    if (!cvNet.w) return;
    const lay = computeLayout();
    S.layers.forEach((n, l) => {
      const d = document.createElement('div');
      d.className = 'layer-ctrl';
      d.style.left = `${lay.colX[l + 1]}px`;
      d.style.top = '8px';
      d.innerHTML = `<div class="row"><button data-a="-" aria-label="Remove neuron">−</button><button data-a="+" aria-label="Add neuron">+</button></div><small>${n} neuron${n > 1 ? 's' : ''}</small>`;
      d.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        S.layers[l] = M.clamp(S.layers[l] + (b.dataset.a === '+' ? 1 : -1), 1, 8);
        buildNet();
      }));
      wrap.appendChild(d);
    });
  }
  function nodeAt(p) {
    if (!netLayout) return null;
    for (let l = 0; l < netLayout.nodes.length; l++) {
      for (let k = 0; k < netLayout.nodes[l].length; k++) {
        const n = netLayout.nodes[l][k];
        if (p.x >= n.x && p.x <= n.x + n.s && p.y >= n.y && p.y <= n.y + n.s) return { l, k };
      }
    }
    return null;
  }
  cvNet.canvas.addEventListener('pointermove', (e) => {
    const h = nodeAt(cvNet.pointer(e));
    if (JSON.stringify(h) !== JSON.stringify(hovered)) { hovered = h; needsDraw = true; }
    cvNet.canvas.style.cursor = h && h.l === 0 ? 'pointer' : 'default';
  });
  cvNet.canvas.addEventListener('pointerleave', () => { hovered = null; needsDraw = true; });
  cvNet.canvas.addEventListener('click', (e) => {
    const h = nodeAt(cvNet.pointer(e));
    if (h && h.l === 0) toggleFeature(S.features[h.k]);
  });

  // ------------------------------------------------------------------ output / decision boundary
  const cvOut = Lab.canvas('cv-out', () => (needsDraw = true));
  let outRect = { x: 0, y: 0, s: 1 };
  function drawOutput() {
    const { ctx, w, h } = cvOut;
    cvOut.clear();
    const pad = 26;
    const s = Math.min(w, h) - 2 * pad;
    outRect = { x: (w - s) / 2, y: (h - s) / 2 - 4, s };
    const r = outRect;
    let img = outCanvas;
    let label = null;
    if (hovered && hovered.l > 0) {
      img = neuronMaps[hovered.l - 1] && neuronMaps[hovered.l - 1][hovered.k];
      label = hovered.l === netLayout.nodes.length - 1 ? 'output ŷ' : `neuron ${hovered.l}·${hovered.k + 1}`;
    } else if (hovered && hovered.l === 0) {
      img = featureMaps[hovered.k];
      label = `feature ${NN.FEATURES[S.features[hovered.k]].label}`;
    }
    if (img) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, r.x, r.y, r.s, r.s);
    }
    // 0.5 contour of the output (marching squares on the coarse grid)
    if (!label && outValues) drawContour(ctx, outValues, GO, r);
    ctx.strokeStyle = T.border2;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.s - 1, r.s - 1);
    // axes
    ctx.fillStyle = T.muted;
    ctx.font = `10px ${T.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of [-1, 0, 1]) ctx.fillText(String(v).replace('-', '−'), r.x + ((v + 1) / 2) * r.s, r.y + r.s + 5);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of [-1, 0, 1]) ctx.fillText(String(v).replace('-', '−'), r.x - 5, r.y + ((1 - v) / 2) * r.s);
    // points
    const P = (p) => [r.x + ((p.x + 1) / 2) * r.s, r.y + ((1 - p.y) / 2) * r.s];
    for (const p of train) {
      const [x, y] = P(p);
      ctx.fillStyle = p.c ? C1 : C0;
      ctx.strokeStyle = '#0b1020';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, y, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (S.showTest) {
      for (const p of test) {
        const [x, y] = P(p);
        ctx.strokeStyle = '#e8edfb';
        ctx.lineWidth = 1.2;
        ctx.fillStyle = p.c ? C1 : C0;
        ctx.beginPath();
        ctx.arc(x, y, 3.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    const hov = Lab.$('#out-hover');
    if (label) {
      hov.style.display = '';
      hov.textContent = `showing ${label}`;
    } else hov.style.display = 'none';
  }
  function drawContour(ctx, vals, n, r) {
    ctx.strokeStyle = 'rgba(232,237,251,0.85)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const cell = r.s / n;
    const at = (i, j) => vals[j * n + i] - 0.5;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = at(i, j);
        const b = at(i + 1, j);
        const c = at(i + 1, j + 1);
        const d = at(i, j + 1);
        const pts = [];
        const ex = (v0, v1, x0, y0, x1, y1) => { const t = v0 / (v0 - v1); pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]); };
        const X = (k) => r.x + (k + 0.5) * cell;
        const Y = (k) => r.y + (k + 0.5) * cell;
        if (a * b < 0) ex(a, b, X(i), Y(j), X(i + 1), Y(j));
        if (b * c < 0) ex(b, c, X(i + 1), Y(j), X(i + 1), Y(j + 1));
        if (c * d < 0) ex(c, d, X(i + 1), Y(j + 1), X(i), Y(j + 1));
        if (d * a < 0) ex(d, a, X(i), Y(j + 1), X(i), Y(j));
        if (pts.length >= 2) { ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); }
        if (pts.length === 4) { ctx.moveTo(pts[2][0], pts[2][1]); ctx.lineTo(pts[3][0], pts[3][1]); }
      }
    }
    ctx.stroke();
  }
  cvOut.canvas.addEventListener('pointerdown', (e) => {
    const p = cvOut.pointer(e);
    const x = ((p.x - outRect.x) / outRect.s) * 2 - 1;
    const y = 1 - ((p.y - outRect.y) / outRect.s) * 2;
    if (Math.abs(x) > 1 || Math.abs(y) > 1) return;
    if (S.dataset !== 'draw') {
      selectDataset('draw');
      Lab.toast('Draw mode: click adds blue points, Shift/right-click adds orange');
    }
    customPts.push({ x, y, c: e.shiftKey || e.button === 2 ? 0 : 1, test: Math.random() > S.ratio });
    genData();
    mapsDirty = true;
    needsDraw = true;
  });
  cvOut.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  cvOut.canvas.addEventListener('pointermove', (e) => {
    if (!outValues) return;
    const p = cvOut.pointer(e);
    const i = Math.floor(((p.x - outRect.x) / outRect.s) * GO);
    const j = Math.floor(((p.y - outRect.y) / outRect.s) * GO);
    if (i < 0 || j < 0 || i >= GO || j >= GO || hovered) return;
    const hov = Lab.$('#out-hover');
    hov.style.display = '';
    hov.textContent = `x₁ ${(((i + 0.5) * 2) / GO - 1).toFixed(2)} · x₂ ${(1 - ((j + 0.5) * 2) / GO).toFixed(2)} · ŷ = ${outValues[j * GO + i].toFixed(3)}`;
  });
  cvOut.canvas.addEventListener('pointerleave', () => { if (!hovered) Lab.$('#out-hover').style.display = 'none'; });

  // ------------------------------------------------------------------ plots
  const lossPlot = new Lab.Plot('cv-loss', { xLabel: 'epoch', yLabel: 'cross-entropy', yMin: 0, pad: { t: 10 } });
  const gradPlot = new Lab.Plot('cv-grad', { xLabel: 'epoch', yLabel: 'RMS ∂L/∂W', yLog: true, pad: { t: 10, l: 54 } });
  function drawPlots() {
    const ep = hist.train.map((_, i) => i);
    lossPlot.opts.xMin = 0;
    lossPlot.opts.xMax = Math.max(10, ep.length - 1);
    const mx = Math.max(0.1, ...hist.train.slice(-400), ...hist.test.slice(-400).filter(Number.isFinite));
    lossPlot.opts.yMax = Math.min(1.2, mx * 1.08);
    lossPlot.series = [
      { name: 'train', color: '#f472b6', data: { x: ep, y: hist.train }, width: 2 },
      { name: 'test', color: '#818cf8', data: { x: ep, y: hist.test }, width: 2 },
    ];
    lossPlot.draw();
    const ge = (hist.grad[0] || []).map((_, i) => i + 1);
    let lo = Infinity;
    let hi = -Infinity;
    hist.grad.forEach((g) => g.forEach((v) => { lo = Math.min(lo, v); hi = Math.max(hi, v); }));
    Object.assign(gradPlot.opts, {
      xMin: 1, xMax: Math.max(10, ge.length),
      yMin: Number.isFinite(lo) ? Math.pow(10, Math.floor(Math.log10(lo))) : 1e-4,
      yMax: Number.isFinite(hi) ? Math.pow(10, Math.ceil(Math.log10(hi) + 0.01)) : 1,
    });
    gradPlot.series = hist.grad.map((g, l) => ({ name: `W${l + 1}`, color: LAYER_COLORS[l % LAYER_COLORS.length], data: { x: ge, y: g }, width: 1.6 }));
    gradPlot.draw();
    Lab.$('#grad-legend').innerHTML = hist.grad.map((_, l) => `<span><i style="background:${LAYER_COLORS[l % LAYER_COLORS.length]}"></i>W${l + 1}</span>`).join('');
  }

  function updateStats() {
    Lab.text('st-epoch', String(epoch));
    const fa = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}<span class="u">%</span>` : '—');
    const tr = Lab.$('#st-train');
    tr.innerHTML = fa(hist.trainAcc);
    tr.parentElement.className = 'stat ' + (hist.trainAcc > 0.95 ? 'good' : hist.trainAcc > 0.8 ? 'warn' : '');
    const te = Lab.$('#st-test');
    te.innerHTML = fa(hist.testAcc);
    te.parentElement.className = 'stat ' + (hist.testAcc > 0.95 ? 'good' : hist.testAcc > 0.8 ? 'warn' : '');
    const trl = hist.train[hist.train.length - 1];
    const tel = hist.test[hist.test.length - 1];
    Lab.text('out-sub', `epoch ${epoch} · train loss ${Number.isFinite(trl) ? trl.toFixed(3) : '—'} · test loss ${Number.isFinite(tel) ? tel.toFixed(3) : '—'}`);
  }
  function updateSubtitles() {
    const arch = [S.features.length, ...S.layers, 1].join('–');
    const actName = { relu: 'ReLU', leaky: 'Leaky ReLU', tanh: 'tanh', sigmoid: 'sigmoid', gelu: 'GELU' }[S.act];
    const optName = { sgd: 'SGD', momentum: 'Momentum', adam: 'Adam' }[S.opt];
    Lab.text('net-sub', `${arch} · ${net.paramCount} parameters · ${actName} · ${optName}`);
  }

  // ------------------------------------------------------------------ sidebar
  function dsPreview(name) {
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 96;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#060a14';
    ctx.fillRect(0, 0, 96, 96);
    const pts = name === 'draw' ? [] : NN.makeDataset(name, 160, 0.05, 3);
    for (const p of pts) {
      ctx.fillStyle = p.c ? C1 : C0;
      ctx.beginPath();
      ctx.arc(((p.x + 1) / 2) * 96, ((1 - p.y) / 2) * 96, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (name === 'draw') {
      ctx.strokeStyle = '#6b779f';
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(14, 14, 68, 42);
      ctx.fillStyle = '#a9b4d6';
      ctx.font = '600 22px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('+', 48, 44);
    }
    return c;
  }
  Lab.$('#ds-grid').innerHTML = '';
  DATASETS.forEach((d) => {
    const b = document.createElement('button');
    b.className = 'ds' + (d === S.dataset ? ' active' : '');
    b.dataset.ds = d;
    b.title = DS_LABEL[d];
    b.appendChild(dsPreview(d));
    const sp = document.createElement('span');
    sp.textContent = DS_LABEL[d];
    b.appendChild(sp);
    b.addEventListener('click', () => selectDataset(d));
    Lab.$('#ds-grid').appendChild(b);
  });
  function selectDataset(d) {
    S.dataset = d;
    Lab.$$('#ds-grid .ds').forEach((b) => b.classList.toggle('active', b.dataset.ds === d));
    Lab.$('#draw-help').textContent = d === 'draw' ? 'Click the decision-boundary plot to add blue points, Shift+click (or right-click) for orange.' : '';
    genData();
    buildNet();
  }

  function renderFeatureChips() {
    Lab.$('#feat-chips').innerHTML = Object.entries(NN.FEATURES).map(([k, f]) => `<button class="${S.features.includes(k) ? 'on' : ''}" data-f="${k}">${f.label}</button>`).join('');
    Lab.$$('#feat-chips button').forEach((b) => b.addEventListener('click', () => toggleFeature(b.dataset.f)));
  }
  function toggleFeature(k) {
    if (S.features.includes(k)) {
      if (S.features.length === 1) return Lab.toast('At least one input feature is needed');
      S.features = S.features.filter((f) => f !== k);
    } else S.features = Object.keys(NN.FEATURES).filter((f) => f === k || S.features.includes(f));
    renderFeatureChips();
    buildNet();
  }

  const playBtn = Lab.$('#btn-play');
  function setRunning(on) {
    S.running = on;
    playBtn.innerHTML = on ? `${Lab.icon('pause')}<span>Pause</span>` : `${Lab.icon('play')}<span>Train</span>`;
  }
  playBtn.addEventListener('click', () => setRunning(!S.running));
  Lab.$('#btn-step').addEventListener('click', () => { setRunning(false); trainEpoch(); mapsDirty = true; needsDraw = true; });
  Lab.$('#btn-reset').addEventListener('click', () => { S.seed++; buildNet(); needsDraw = true; });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); setRunning(!S.running); }
    if (e.key === 's' || e.key === 'S') { setRunning(false); trainEpoch(); mapsDirty = true; needsDraw = true; }
  });
  const ui = {};
  ui.speed = Lab.range('sl-speed', { format: (v) => `${v}`, onInput: (v) => (S.speed = v) });
  ui.noise = Lab.range('sl-noise', { format: (v) => v.toFixed(2), onInput: (v) => { S.noise = v; genData(); buildNet(); } });
  ui.n = Lab.range('sl-n', { format: (v) => `${v}`, onInput: (v) => { S.n = v; genData(); buildNet(); } });
  ui.ratio = Lab.range('sl-ratio', { format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => { S.ratio = v; genData(); buildNet(); } });
  const actSeg = Lab.seg('seg-act', (v) => { S.act = v; buildNet(); });
  const optSeg = Lab.seg('seg-opt', (v) => { S.opt = v; updateSubtitles(); });
  ui.lrExp = Lab.range('sl-lr', { format: (v) => Math.pow(10, v).toPrecision(2), onInput: (v) => (S.lrExp = v) });
  ui.batch = Lab.range('sl-batch', { format: (v) => `${v}`, onInput: (v) => (S.batch = v) });
  ui.l2Exp = Lab.range('sl-l2', { format: (v) => (v <= -6 ? 'off' : Math.pow(10, v).toExponential(0)), onInput: (v) => (S.l2Exp = v) });
  Lab.toggle('tg-test', (v) => { S.showTest = v; needsDraw = true; });
  Lab.$('#btn-add-layer').addEventListener('click', () => { if (S.layers.length >= 6) return; S.layers.push(S.layers[S.layers.length - 1] || 4); buildNet(); });
  Lab.$('#btn-rm-layer').addEventListener('click', () => { if (!S.layers.length) return; S.layers.pop(); buildNet(); });

  const PRESETS = {
    vanish: { dataset: 'circles', features: ['x1', 'x2'], layers: [6, 6, 6, 6, 6, 6], act: 'sigmoid', opt: 'sgd', lrExp: -0.7, batch: 16, noise: 0.1, msg: 'Deep sigmoid + SGD: the early layers’ gradients (W1, W2 …) are orders of magnitude smaller — they barely learn.' },
    features: { dataset: 'circles', features: ['x1sq', 'x2sq'], layers: [], act: 'tanh', opt: 'adam', lrExp: -1.3, batch: 16, noise: 0.1, msg: 'With x₁² and x₂² as inputs, a network with no hidden layer (logistic regression) separates the circles.' },
    overfit: { dataset: 'xor', features: ['x1', 'x2'], layers: [8, 8, 8, 8], act: 'relu', opt: 'adam', lrExp: -1.5, batch: 8, noise: 0.55, n: 80, ratio: 0.35, msg: 'Few noisy points and a big network: training loss keeps falling while test loss turns upward.' },
    spiral: { dataset: 'spiral', features: ['x1', 'x2'], layers: [8, 8, 8, 6], act: 'gelu', opt: 'adam', lrExp: -1.8, batch: 16, noise: 0.1, msg: 'A deep GELU network carves the spiral from raw coordinates.' },
  };
  function applyPreset(name) {
    const p = PRESETS[name];
    Object.assign(S, { n: 300, ratio: 0.6 }, p);
    ui.noise.set(S.noise);
    ui.n.set(S.n);
    ui.ratio.set(S.ratio);
    ui.lrExp.set(S.lrExp);
    ui.batch.set(S.batch);
    actSeg.set(S.act);
    optSeg.set(S.opt);
    Lab.$$('#ds-grid .ds').forEach((b) => b.classList.toggle('active', b.dataset.ds === S.dataset));
    renderFeatureChips();
    genData();
    buildNet();
    setRunning(true);
    Lab.toast(p.msg, 5200);
  }
  Lab.$$('[data-preset]').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));

  // ------------------------------------------------------------------ main loop
  let needsDraw = true;
  let frame = 0;
  Lab.loop(() => {
    frame++;
    if (S.running && train.length) {
      for (let k = 0; k < S.speed; k++) trainEpoch();
      if (frame % 2 === 0) mapsDirty = true;
      needsDraw = true;
    }
    if (mapsDirty) computeMaps();
    if (needsDraw) {
      drawNet();
      drawOutput();
      drawPlots();
      updateStats();
      needsDraw = false;
    }
  });

  // ------------------------------------------------------------------ init
  renderFeatureChips();
  genData();
  buildNet();

  window.NeuroPlayground = {
    state: S,
    preset: applyPreset,
    dataset: selectDataset,
    run: setRunning,
    get epoch() { return epoch; },
    get acc() { return { train: hist.trainAcc, test: hist.testAcc }; },
    hover: (l, k) => { hovered = l === null ? null : { l, k }; needsDraw = true; },
  };
})();
