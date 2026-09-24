/* TomoLab — UI, acquisition / reconstruction pipeline and rendering. */
(function () {
  'use strict';
  const CT = window.CTCore;
  const M = window.LabMath;
  Lab.boot();
  const T = Lab.theme();
  const N = 256;
  const ND = 256;
  const PS = CT.FOV / N; // pixel size [cm]
  const rng = M.makeRng(11);
  const mask = CT.fovMask(N);
  const maskAlpha = new Uint8Array(N * N).map((_, i) => (mask[i] ? 255 : 0));
  const PROFILE_ROW = { thorax: 108, shepplogan: 115, hip: 134, bars: 79, custom: 128 };

  const S = {
    phantom: 'thorax',
    views: 180,
    range: 180,
    doseExp: 5,
    noiseless: false,
    rings: false,
    motion: false,
    method: 'fbp',
    filter: 'shepplogan',
    cutoff: 1,
    iters: 15,
    lambda: 0.9,
    tv: 0.35,
    animate: true,
    W: 400,
    L: 40,
    sinoView: 'raw',
    tab: 'profile',
    row: PROFILE_ROW.thorax,
  };

  let shapes = null;
  let customImg = null;
  let truth = null;
  let truthHU = null;
  let angles = null;
  let sino = null;
  let filtered = null;
  let recon = null; // μ (may be a partial accumulation during animation)
  let reconHU = null;
  let errorHU = null;
  let job = null;
  let metrics = null;
  let conv = [];
  let fbpRef = null;
  let sartCache = { key: '', setup: null };
  let lastMs = 0;
  let hoverPix = null;

  // ------------------------------------------------------------------ pipeline
  function loadPhantom() {
    if (S.phantom === 'custom') {
      shapes = null;
      truth = customImg.slice();
    } else {
      shapes = CT.PHANTOMS[S.phantom].shapes();
      truth = CT.rasterize(shapes, N);
      for (let i = 0; i < N * N; i++) if (!mask[i]) truth[i] = 0;
    }
    truthHU = toHUMasked(truth);
    S.row = PROFILE_ROW[S.phantom];
    const w = S.phantom === 'custom' ? [2000, 0] : CT.PHANTOMS[S.phantom].window;
    setWindow(w[0], w[1]);
    const name = S.phantom === 'custom' ? 'uploaded image' : CT.PHANTOMS[S.phantom].name;
    Lab.text('phantom-sub', `${name} · 256² · 1 mm pixels`);
    phantomCanvas = null;
  }

  function toHUMasked(mu) {
    const out = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) out[i] = mask[i] ? CT.toHU(mu[i]) : -1000;
    return out;
  }

  function acquire() {
    const K = S.views;
    angles = CT.makeAngles(K, S.range);
    let clean;
    const motion = S.motion ? { dx: 0.035, dy: 0.022, fromView: Math.floor(K / 2) } : null;
    if (shapes) clean = CT.projectAnalytic(shapes, angles, ND, { motion });
    else {
      clean = CT.projectNumeric(customImg, N, angles, ND);
      if (motion) {
        const shifted = new Float32Array(N * N);
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
          const si = i - 4;
          const sj = j + 3;
          if (si >= 0 && sj < N) shifted[j * N + i] = customImg[sj * N + si];
        }
        const views = [];
        for (let k = motion.fromView; k < K; k++) views.push(k);
        CT.projectNumeric(shifted, N, angles, ND, clean, views);
      }
    }
    const I0 = S.noiseless ? Infinity : Math.pow(10, S.doseExp);
    const bad = S.rings ? [{ bin: ND / 2 + 23, gain: 0.96 }, { bin: ND / 2 - 47, gain: 1.05 }, { bin: ND / 2 + 71, gain: 0.97 }].map((b) => ({ ...b, nd: ND })) : [];
    sino = CT.addNoise(clean, I0, rng, bad);
    filtered = null;
    sinoCanvas = null;
    // FBP reference for the convergence plot
    const filt = CT.makeFilter(ND, CT.FOV / ND, 'ramlak', 1, M.fft);
    const ref = CT.fbp(sino, angles, ND, N, filt, M.fft, (S.range * Math.PI) / 180);
    fbpRef = M.rmse(truthHU, toHUMasked(ref), mask);
    const doseTxt = S.noiseless ? '∞' : `10^${S.doseExp.toFixed(1)}`;
    Lab.text('sino-sub', `${K} × ${ND} · ${S.range}° · I₀ ${S.noiseless ? '∞' : fmtPow(S.doseExp)}`);
    void doseTxt;
  }
  const fmtPow = (e) => {
    const m = Math.pow(10, e - Math.floor(e));
    return `${m.toFixed(1)}×10${sup(Math.floor(e))}`;
  };
  const sup = (n) => String(n).split('').map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+c] || c).join('');

  function getFilter() {
    return CT.makeFilter(ND, CT.FOV / ND, S.filter, S.cutoff, M.fft);
  }
  function getFiltered() {
    if (!filtered) filtered = CT.filterSinogram(sino, angles.length, ND, getFilter(), M.fft);
    return filtered;
  }

  function reconstruct(animate) {
    job = null;
    conv = [];
    const K = angles.length;
    const t0 = performance.now();
    if (S.method === 'bp' || S.method === 'fbp') {
      const fbpMode = S.method === 'fbp';
      const q = fbpMode ? getFiltered() : sino;
      const weight = fbpMode ? ((S.range * Math.PI) / 180) / K : 1;
      const out = new Float32Array(N * N);
      if (!animate) {
        CT.backproject(q, angles, ND, N, out, 0, K, weight);
        recon = fbpMode ? out : normaliseBP(out);
        lastMs = performance.now() - t0;
        finish();
      } else {
        job = { kind: 'bp', fbp: fbpMode, q, out, k: 0, K, weight, perFrame: Math.max(1, Math.round(K / 45)), t0, ms: 0 };
      }
      updateReconSub();
      return;
    }
    // iterative
    const key = `${S.views}-${S.range}`;
    if (sartCache.key !== key) sartCache = { key, setup: CT.sartSetup(angles, ND, N, 10) };
    job = { kind: 'sart', x: new Float32Array(N * N), it: 0, iters: S.iters, tv: S.method === 'sarttv', t0, ms: 0 };
    recon = job.x;
    updateReconSub();
    if (S.tab !== 'conv') tabSeg.set('conv', true);
  }

  /** Plain BP is not quantitative: scale it so its mean matches the attenuation mass implied by the data. */
  function normaliseBP(img) {
    const K = angles.length;
    let mass = 0;
    for (let i = 0; i < K * ND; i++) mass += sino[i];
    mass = (mass / K) * (CT.FOV / ND); // ∫∫ μ dx dy  [cm]
    const target = mass / (Math.PI * (CT.FOV / 2) ** 2);
    let s = 0;
    let n = 0;
    for (let i = 0; i < N * N; i++) if (mask[i]) { s += img[i]; n++; }
    const f = s > 0 ? target / (s / n) : 1;
    const out = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) out[i] = img[i] * f;
    return out;
  }

  function stepJob() {
    if (!job) return;
    if (job.kind === 'bp') {
      const t = performance.now();
      const k1 = Math.min(job.K, job.k + job.perFrame);
      CT.backproject(job.q, angles, ND, N, job.out, job.k, k1, job.weight);
      job.ms += performance.now() - t;
      job.k = k1;
      const partial = new Float32Array(N * N);
      const f = job.K / job.k;
      for (let i = 0; i < N * N; i++) partial[i] = job.out[i] * f;
      recon = job.fbp ? partial : normaliseBP(partial);
      reconHU = toHUMasked(recon);
      reconCanvas = null;
      setProgress(job.k / job.K);
      if (job.k >= job.K) {
        lastMs = job.ms;
        job = null;
        finish();
      }
    } else if (job.kind === 'sart') {
      const t = performance.now();
      const before = job.tv ? job.x.slice() : null;
      CT.sartIteration(job.x, sino, angles, sartCache.setup, S.lambda);
      if (job.tv) {
        let d = 0;
        for (let i = 0; i < N * N; i++) d += (job.x[i] - before[i]) ** 2;
        CT.tvSteps(job.x, N, mask, 10, S.tv * Math.sqrt(d));
      }
      job.ms += performance.now() - t;
      job.it++;
      recon = job.x;
      reconHU = toHUMasked(recon);
      reconCanvas = null;
      conv.push(M.rmse(truthHU, reconHU, mask));
      setProgress(job.it / job.iters);
      computeMetrics(job.ms);
      if (job.it >= job.iters) {
        lastMs = job.ms;
        job = null;
        finish();
      }
    }
    updateReconSub();
  }

  function finish() {
    reconHU = toHUMasked(recon);
    reconCanvas = null;
    computeMetrics(lastMs);
    setProgress(1);
    setTimeout(() => { if (!job) setProgress(-1); }, 400);
    updateReconSub();
  }

  function computeMetrics(ms) {
    errorHU = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) errorHU[i] = mask[i] ? reconHU[i] - truthHU[i] : 0;
    errorCanvas = null;
    const lo = S.L - S.W / 2;
    const hi = S.L + S.W / 2;
    const clipT = new Float32Array(N * N);
    const clipR = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      clipT[i] = Math.min(hi, Math.max(lo, truthHU[i]));
      clipR[i] = Math.min(hi, Math.max(lo, reconHU[i]));
    }
    metrics = {
      rmse: M.rmse(truthHU, reconHU, mask),
      psnr: M.psnr(clipT, clipR, mask),
      ssim: M.ssim(clipT, clipR, N, N),
      ms,
    };
    const rm = Lab.$('#st-rmse');
    rm.innerHTML = `${metrics.rmse.toFixed(1)}<span class="u">HU</span>`;
    rm.parentElement.className = 'stat ' + (metrics.rmse < 40 ? 'good' : metrics.rmse < 90 ? 'warn' : 'bad');
    Lab.$('#st-psnr').innerHTML = `${metrics.psnr.toFixed(1)}<span class="u">dB</span>`;
    Lab.$('#st-ssim').innerHTML = metrics.ssim.toFixed(3);
    Lab.$('#st-time').innerHTML = `${ms.toFixed(0)}<span class="u">ms</span>`;
  }

  function updateReconSub() {
    const names = { bp: 'Back-projection (unfiltered)', fbp: `FBP · ${CT.FILTERS[S.filter].name}`, sart: 'OS-SART', sarttv: 'OS-SART + TV' };
    let status = '';
    if (job && job.kind === 'bp') status = ` · view ${job.k}/${job.K}`;
    else if (job && job.kind === 'sart') status = ` · iteration ${job.it}/${job.iters}`;
    else if (S.method === 'sart' || S.method === 'sarttv') status = ` · ${S.iters} iterations`;
    Lab.text('recon-sub', names[S.method] + status);
  }
  function setProgress(f) {
    const el = Lab.$('#progress');
    el.classList.toggle('on', f >= 0 && f < 1.0001 && !!job);
    el.firstElementChild.style.width = `${Math.max(0, Math.min(1, f)) * 100}%`;
  }

  // ------------------------------------------------------------------ rendering helpers
  const cvPhantom = Lab.canvas('cv-phantom', () => (needsDraw = true));
  const cvSino = Lab.canvas('cv-sino', () => (needsDraw = true));
  const cvRecon = Lab.canvas('cv-recon', () => (needsDraw = true));
  const cvError = Lab.canvas('cv-error', () => (needsDraw = true));
  const plot = new Lab.Plot('cv-analysis', { pad: { t: 14 } });
  let phantomCanvas = null;
  let reconCanvas = null;
  let errorCanvas = null;
  let sinoCanvas = null;
  let needsDraw = true;

  function imageRect(c) {
    const s = Math.min(c.w, c.h) - 16;
    return { x: (c.w - s) / 2, y: (c.h - s) / 2, s };
  }
  function drawImagePanel(c, off, { beam = false } = {}) {
    const { ctx } = c;
    c.clear();
    if (!off) return;
    const r = imageRect(c);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, r.x, r.y, r.s, r.s);
    // FOV circle
    ctx.strokeStyle = 'rgba(45,212,191,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(r.x + r.s / 2, r.y + r.s / 2, r.s / 2, 0, Math.PI * 2);
    ctx.stroke();
    // profile row
    const py = r.y + ((S.row + 0.5) / N) * r.s;
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(251,191,36,0.75)';
    ctx.beginPath();
    ctx.moveTo(r.x, py);
    ctx.lineTo(r.x + r.s, py);
    ctx.stroke();
    ctx.setLineDash([]);
    if (beam && job && job.kind === 'bp' && job.k < job.K) drawBeam(ctx, r, angles[job.k]);
  }
  function drawBeam(ctx, r, th) {
    const cx = r.x + r.s / 2;
    const cy = r.y + r.s / 2;
    const R = r.s / 2;
    // screen coords: +x right, +y up → screen y inverted
    const n = [Math.cos(th), -Math.sin(th)]; // detector axis (t direction)
    const d = [-Math.sin(th), -Math.cos(th)]; // ray direction
    ctx.strokeStyle = 'rgba(45,212,191,0.35)';
    ctx.lineWidth = 1;
    for (let k = -8; k <= 8; k++) {
      const t = (k / 8.5) * R;
      const px = cx + n[0] * t;
      const py = cy + n[1] * t;
      ctx.beginPath();
      ctx.moveTo(px - d[0] * R * 1.08, py - d[1] * R * 1.08);
      ctx.lineTo(px + d[0] * R * 1.08, py + d[1] * R * 1.08);
      ctx.stroke();
    }
    // detector bar & source
    ctx.strokeStyle = '#2dd4bf';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(cx + d[0] * R * 1.1 - n[0] * R, cy + d[1] * R * 1.1 - n[1] * R);
    ctx.lineTo(cx + d[0] * R * 1.1 + n[0] * R, cy + d[1] * R * 1.1 + n[1] * R);
    ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(cx - d[0] * R * 1.1, cy - d[1] * R * 1.1, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  function renderPhantomCanvas() {
    phantomCanvas = Lab.renderField(truthHU, N, N, { lut: 'gray', min: S.L - S.W / 2, max: S.L + S.W / 2, alphaField: maskAlpha });
  }
  function renderReconCanvas() {
    reconCanvas = reconHU ? Lab.renderField(reconHU, N, N, { lut: 'gray', min: S.L - S.W / 2, max: S.L + S.W / 2, alphaField: maskAlpha }) : null;
  }
  function renderErrorCanvas() {
    const E = Math.max(10, S.W / 4);
    errorCanvas = errorHU ? Lab.renderField(errorHU, N, N, { lut: 'diverge', min: -E, max: E, alphaField: maskAlpha }) : null;
    Lab.text('cb-lo', `−${E.toFixed(0)}`);
    Lab.text('cb-hi', `+${E.toFixed(0)} HU`);
  }
  function renderSinoCanvas() {
    const K = angles.length;
    const data = S.sinoView === 'raw' ? sino : getFiltered();
    const vals = Array.from(data).map(Math.abs).sort((a, b) => a - b);
    const p995 = vals[Math.floor(vals.length * 0.995)] || 1;
    sinoCanvas = S.sinoView === 'raw'
      ? Lab.renderField(data, ND, K, { lut: 'magma', min: 0, max: p995 })
      : Lab.renderField(data, ND, K, { lut: 'diverge', min: -p995 * 0.6, max: p995 * 0.6 });
  }

  function drawSino() {
    const c = cvSino;
    const { ctx, w, h } = c;
    c.clear();
    if (!sinoCanvas) renderSinoCanvas();
    const pad = { l: 44, r: 18, t: 10, b: 28 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sinoCanvas, pad.l, pad.t, pw, ph);
    ctx.strokeStyle = T.border2;
    ctx.strokeRect(pad.l + 0.5, pad.t + 0.5, pw - 1, ph - 1);
    ctx.font = `10.5px ${T.mono}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const K = angles.length;
    for (const f of [0, 0.25, 0.5, 0.75, 1]) ctx.fillText(`${(f * S.range).toFixed(0)}°`, pad.l - 6, pad.t + f * ph);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const f of [0, 0.25, 0.5, 0.75, 1]) ctx.fillText(`${((f - 0.5) * CT.FOV).toFixed(1)}`.replace('-', '−'), pad.l + f * pw, pad.t + ph + 5);
    ctx.font = `600 10.5px ${T.sans}`;
    ctx.fillStyle = T.text2;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('detector position t (cm)', pad.l + pw, h - 1);
    ctx.save();
    ctx.translate(11, pad.t + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('projection angle θ', 0, 0);
    ctx.restore();
    if (job && job.kind === 'bp' && job.k < K) {
      const y = pad.t + ((job.k + 0.5) / K) * ph;
      ctx.strokeStyle = '#2dd4bf';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + pw, y);
      ctx.stroke();
    }
  }

  function drawAnalysis() {
    const legend = Lab.$('#tab-legend');
    plot.bands = [];
    plot.hlines = [];
    plot.vlines = [];
    plot.markers = [];
    if (S.tab === 'profile') {
      const xs = Array.from({ length: N }, (_, i) => (i - N / 2 + 0.5) * PS);
      const tr = Array.from({ length: N }, (_, i) => (mask[S.row * N + i] ? truthHU[S.row * N + i] : NaN));
      const rc = reconHU ? Array.from({ length: N }, (_, i) => (mask[S.row * N + i] ? reconHU[S.row * N + i] : NaN)) : [];
      Object.assign(plot.opts, { xMin: -CT.FOV / 2, xMax: CT.FOV / 2, yMin: S.L - S.W * 0.8, yMax: S.L + S.W * 0.8, xLabel: 'x (cm)', yLabel: 'HU', xLog: false });
      plot.bands = [{ y0: S.L - S.W / 2, y1: S.L + S.W / 2, color: 'rgba(45,212,191,0.05)' }];
      plot.series = [
        { name: 'truth', color: 'rgba(232,237,251,0.85)', data: { x: xs, y: tr }, width: 1.4 },
        { name: 'reconstruction', color: T.accent, data: { x: xs, y: rc }, width: 1.8 },
      ];
      legend.innerHTML = `<span><i style="background:#e8edfb"></i>truth</span><span><i style="background:${T.accent}"></i>reconstruction</span><span class="muted">row ${S.row} · y = ${((N / 2 - 0.5 - S.row) * PS).toFixed(1)} cm</span>`;
    } else if (S.tab === 'filter') {
      const f = Array.from({ length: 201 }, (_, k) => k / 200);
      plot.series = Object.entries(CT.FILTERS).map(([key, F]) => ({
        name: F.name,
        color: key === S.filter ? T.accent : 'rgba(169,180,214,0.4)',
        width: key === S.filter ? 2.4 : 1.2,
        data: { x: f, y: f.map((u) => (u > S.cutoff && key === S.filter ? 0 : u * F.w(Math.min(1, u / (key === S.filter ? S.cutoff : 1))))) },
      }));
      // selected filter last so it is drawn on top
      plot.series.sort((a, b) => (a.color === T.accent) - (b.color === T.accent));
      Object.assign(plot.opts, { xMin: 0, xMax: 1, yMin: 0, yMax: 1.05, xLabel: 'spatial frequency (× Nyquist)', yLabel: '|H(f)| (normalised)' });
      plot.vlines = [{ x: S.cutoff, color: 'rgba(251,191,36,0.7)', label: `cut-off ${S.cutoff.toFixed(2)}` }];
      legend.innerHTML = `<span><i style="background:${T.accent}"></i>${CT.FILTERS[S.filter].name}</span><span><i style="background:rgba(169,180,214,.5)"></i>other windows</span>`;
    } else {
      const it = conv.map((_, i) => i + 1);
      Object.assign(plot.opts, { xMin: 0, xMax: Math.max(S.iters, conv.length, 2), yMin: 0, yMax: null, xLabel: 'iteration', yLabel: 'RMSE (HU)' });
      plot.series = [{ name: 'SART', color: T.accent, data: { x: it, y: conv }, width: 2.2, points: 0 }];
      plot.series.push({ name: '', color: T.accent, data: { x: it, y: conv }, points: 3, noLegend: true });
      if (fbpRef !== null) plot.hlines = [{ y: fbpRef, color: 'rgba(251,191,36,0.8)', label: `FBP (Ram-Lak) ${fbpRef.toFixed(1)} HU`, fit: true }];
      legend.innerHTML = conv.length
        ? `<span><i style="background:${T.accent}"></i>${S.method === 'sarttv' ? 'SART-TV' : 'SART'} RMSE</span><span><i style="background:#fbbf24"></i>FBP reference</span>`
        : '<span class="muted">run SART or SART-TV to see convergence</span>';
    }
    plot.draw();
  }

  // ------------------------------------------------------------------ interaction on images
  function pixelAt(c, e) {
    const p = c.pointer(e);
    const r = imageRect(c);
    const i = Math.floor(((p.x - r.x) / r.s) * N);
    const j = Math.floor(((p.y - r.y) / r.s) * N);
    return i >= 0 && j >= 0 && i < N && j < N ? { i, j } : null;
  }
  for (const [c, readId, src] of [[cvPhantom, 'hu-phantom', () => truthHU], [cvRecon, 'hu-recon', () => reconHU], [cvError, null, () => errorHU]]) {
    c.canvas.addEventListener('pointerdown', (e) => {
      const px = pixelAt(c, e);
      if (px) { S.row = px.j; needsDraw = true; }
      c.canvas.setPointerCapture(e.pointerId);
      c.dragging = true;
    });
    c.canvas.addEventListener('pointermove', (e) => {
      const px = pixelAt(c, e);
      if (c.dragging && px) { S.row = px.j; needsDraw = true; }
      if (!readId) return;
      const el = document.getElementById(readId);
      const arr = src();
      if (px && arr && mask[px.j * N + px.i]) {
        el.style.display = '';
        el.textContent = `${arr[px.j * N + px.i].toFixed(0)} HU  (${px.i}, ${px.j})`;
      } else el.style.display = 'none';
    });
    c.canvas.addEventListener('pointerup', () => (c.dragging = false));
    c.canvas.addEventListener('pointerleave', () => { if (readId) document.getElementById(readId).style.display = 'none'; });
  }
  void hoverPix;

  // ------------------------------------------------------------------ controls
  let pending = 0;
  function schedule(kind) {
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (kind === 'acquire') acquire();
      if (kind !== 'display') reconstruct(false);
      needsDraw = true;
    }, 120);
  }
  const phantomSel = Lab.select('sel-phantom', (v) => {
    S.phantom = v;
    loadPhantom();
    acquire();
    reconstruct(S.animate);
  });
  const ui = {};
  ui.views = Lab.range('sl-views', { format: (v) => `${v}`, onInput: (v) => { S.views = v; schedule('acquire'); } });
  ui.range = Lab.range('sl-range', { format: (v) => `${v}°`, onInput: (v) => { S.range = v; schedule('acquire'); } });
  ui.doseExp = Lab.range('sl-dose', { format: (v) => fmtPow(v), onInput: (v) => { S.doseExp = v; schedule('acquire'); } });
  ui.noiseless = Lab.toggle('tg-noiseless', (v) => { S.noiseless = v; schedule('acquire'); });
  ui.rings = Lab.toggle('tg-rings', (v) => { S.rings = v; schedule('acquire'); });
  ui.motion = Lab.toggle('tg-motion', (v) => { S.motion = v; schedule('acquire'); });
  const methodSeg = Lab.seg('seg-method', (v) => { S.method = v; updateMethodUi(); schedule('recon'); });
  function updateMethodUi() {
    const iter = S.method === 'sart' || S.method === 'sarttv';
    Lab.$$('.only-fbp').forEach((el) => el.classList.toggle('hidden', S.method !== 'fbp'));
    Lab.$$('.only-sart').forEach((el) => el.classList.toggle('hidden', !iter));
    Lab.$$('.only-tv').forEach((el) => el.classList.toggle('hidden', S.method !== 'sarttv'));
    const notes = {
      bp: 'Unfiltered back-projection smears every projection back across the image — the 1/r blur shows why CT needs a ramp filter.',
      fbp: 'Filtered back-projection: the clinical workhorse. One pass, exact for complete noise-free data; the window trades resolution for noise.',
      sart: 'Ordered-subset SART: algebraic iterative reconstruction with non-negativity. More robust to sparse or limited-angle data.',
      sarttv: 'SART with total-variation regularisation (compressed sensing) — suppresses streaks and noise when few views are available.',
    };
    Lab.$('#method-note').textContent = notes[S.method];
    updateReconSub();
  }
  ui.filter = Lab.select('sel-filter', (v) => { S.filter = v; filtered = null; sinoCanvas = null; schedule('recon'); });
  ui.cutoff = Lab.range('sl-cutoff', { format: (v) => v.toFixed(2), onInput: (v) => { S.cutoff = v; filtered = null; sinoCanvas = null; schedule('recon'); } });
  ui.iters = Lab.range('sl-iters', { format: (v) => `${v}`, onInput: (v) => { S.iters = v; schedule('recon'); } });
  ui.lambda = Lab.range('sl-lambda', { format: (v) => v.toFixed(2), onInput: (v) => { S.lambda = v; schedule('recon'); } });
  ui.tv = Lab.range('sl-tv', { format: (v) => v.toFixed(2), onInput: (v) => { S.tv = v; schedule('recon'); } });
  Lab.toggle('tg-animate', (v) => (S.animate = v));
  Lab.$('#btn-recon').addEventListener('click', () => reconstruct(S.animate));

  const winSeg = Lab.seg('seg-window', (v) => {
    const [w, l] = v.split(',').map(Number);
    setWindow(w, l);
  });
  const wwSlider = Lab.range('sl-ww', { format: (v) => `${v} HU`, onInput: (v) => { S.W = v; windowChanged(); } });
  const wlSlider = Lab.range('sl-wl', { format: (v) => `${v} HU`, onInput: (v) => { S.L = v; windowChanged(); } });
  function setWindow(w, l) {
    S.W = w;
    S.L = l;
    wwSlider.set(w);
    wlSlider.set(l);
    windowChanged();
  }
  function windowChanged() {
    Lab.$$('#seg-window button').forEach((b) => b.classList.toggle('active', b.dataset.value === `${S.W},${S.L}`));
    Lab.text('wl-label', `W ${S.W} · L ${S.L}`);
    phantomCanvas = null;
    reconCanvas = null;
    if (reconHU) computeMetrics(lastMs);
    needsDraw = true;
  }
  void winSeg;
  Lab.seg('seg-sino', (v) => { S.sinoView = v; sinoCanvas = null; needsDraw = true; });
  const tabSeg = Lab.seg('seg-tab', (v) => { S.tab = v; needsDraw = true; });

  Lab.$('#file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = N;
      c.height = N;
      const ctx = c.getContext('2d');
      const s = Math.max(N / img.width, N / img.height);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, N, N);
      ctx.drawImage(img, (N - img.width * s) / 2, (N - img.height * s) / 2, img.width * s, img.height * s);
      const d = ctx.getImageData(0, 0, N, N).data;
      customImg = new Float32Array(N * N);
      for (let i = 0; i < N * N; i++) {
        const g = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
        customImg[i] = mask[i] ? 2 * g * CT.MU_WATER : 0;
      }
      const opt = Lab.$('#sel-phantom option[value="custom"]');
      opt.disabled = false;
      phantomSel.set('custom');
      S.phantom = 'custom';
      loadPhantom();
      acquire();
      reconstruct(S.animate);
      Lab.toast('Image loaded — grey levels mapped from air (black) to bone (white)');
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(f);
  });

  // ------------------------------------------------------------------ main loop
  Lab.loop(() => {
    const busy = !!job;
    if (busy) stepJob();
    if (busy || needsDraw) {
      if (!phantomCanvas) renderPhantomCanvas();
      if (!reconCanvas) renderReconCanvas();
      if (!errorCanvas) renderErrorCanvas();
      drawImagePanel(cvPhantom, phantomCanvas, { beam: true });
      drawSino();
      drawImagePanel(cvRecon, reconCanvas);
      drawImagePanel(cvError, job && job.kind === 'bp' ? null : errorCanvas);
      drawAnalysis();
      needsDraw = false;
    }
  });

  // ------------------------------------------------------------------ init
  Lab.$('#colorbar').style.background = Lab.cmapGradient('diverge');
  updateMethodUi();
  loadPhantom();
  acquire();
  reconstruct(true);

  window.TomoLab = {
    state: S,
    set(opts) {
      Object.assign(S, opts);
      if (opts.method) methodSeg.set(opts.method);
      if (opts.phantom) phantomSel.set(opts.phantom);
      for (const [k, v] of Object.entries(opts)) if (ui[k]) ui[k].set(v);
      updateMethodUi();
      if (opts.phantom) loadPhantom();
      acquire();
      reconstruct(false);
      needsDraw = true;
    },
    tab: (t) => tabSeg.set(t, true),
    get busy() { return !!job; },
    get metrics() { return metrics; },
  };
})();
