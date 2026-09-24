/* k-Space Explorer — UI, staged pipeline (object → k-space → sampling → reconstruction) and rendering. */
(function () {
  'use strict';
  const MR = window.MRICore;
  const M = window.LabMath;
  Lab.boot();
  const T = Lab.theme();
  const N = 256;

  const PRESETS = {
    t1: { type: 'SE', TR: 500, TE: 15 },
    t2: { type: 'SE', TR: 4000, TE: 100 },
    pd: { type: 'SE', TR: 3000, TE: 15 },
    flair: { type: 'IR', TR: 9000, TE: 120, TI: 2370 },
    stir: { type: 'IR', TR: 3000, TE: 30, TI: 170 },
  };
  const MASKS = {
    full: null,
    lowpass: { label: 'Fraction of k-space kept', min: 0.04, max: 1, step: 0.01, value: 0.22, fmt: (v) => `${(v * 100).toFixed(0)}%`, key: 'frac' },
    highpass: { label: 'Removed centre radius', min: 0.01, max: 0.4, step: 0.01, value: 0.05, fmt: (v) => `${(v * 100).toFixed(0)}% k_max`, key: 'radius' },
    parallel: { label: 'Acceleration factor R', min: 2, max: 6, step: 1, value: 3, fmt: (v) => `R = ${v}`, key: 'R' },
    random: { label: 'Phase-encode lines acquired', min: 0.12, max: 0.8, step: 0.01, value: 0.3, fmt: (v) => `${(v * 100).toFixed(0)}%`, key: 'frac' },
    radial: { label: 'Radial spokes', min: 8, max: 402, step: 2, value: 64, fmt: (v) => `${v}`, key: 'spokes' },
    pf: { label: 'Partial-Fourier fraction', min: 0.5, max: 1, step: 0.0625, value: 0.625, fmt: (v) => `${(v * 8).toFixed(1)}/8`, key: 'pf' },
  };
  const SHOWN = ['csf', 'gm', 'wm', 'fat', 'tumor', 'edema'];

  const S = {
    seq: { type: 'SE', TR: 4000, TE: 100, TI: 2370, flip: 30 },
    lesion: true,
    phase: true,
    mask: 'full',
    params: Object.fromEntries(Object.entries(MASKS).filter(([, v]) => v).map(([k, v]) => [k, v.value])),
    acs: true,
    noise: 0.4,
    spike: false,
    motion: false,
    recon: 'zf',
    lambda: 0.006,
    iters: 40,
    brush: 'off',
    brushR: 10,
    kview: 'mag',
    phys: 'relax',
  };

  // ------------------------------------------------------------------ pipeline state
  let brain = null;
  let truth = null;
  let truthMag = null;
  let norm = 1;
  let kFull = null;
  let kCorr = null;
  let base = null;
  let edits = new Int8Array(N * N);
  let mask = null;
  let kMeas = null;
  let recon = null;
  let job = null;
  let scan = null;
  let metrics = null;
  let stage = 0; // 0: brain, 1: synth, 2: corrupt, 3: mask, 4: measure, 5: recon, 6: done
  const invalidate = (s) => { stage = Math.min(stage, s); };

  function runPipeline() {
    if (stage <= 0) { brain = MR.makeBrain(N, { lesion: S.lesion }); stage = 1; }
    if (stage <= 1) {
      truth = MR.synthesize(brain, S.seq, { phase: S.phase });
      truthMag = MR.magnitude(truth);
      const sorted = Float64Array.from(truthMag).sort();
      norm = sorted[Math.floor(sorted.length * 0.997)] || 1;
      kFull = MR.fftc(truth.re, truth.im, N);
      imageCanvas = null;
      stage = 2;
    }
    if (stage <= 2) {
      kCorr = MR.corrupt(kFull, N, { noise: (S.noise / 100) * norm, spike: S.spike, motion: S.motion }, M.makeRng(99));
      stage = 3;
    }
    if (stage <= 3) {
      base = MR.makeMask(N, S.mask, { ...paramObj(), acs: S.acs }, M.makeRng(7));
      stage = 4;
    }
    if (stage <= 4) {
      mask = new Uint8Array(N * N);
      for (let p = 0; p < N * N; p++) mask[p] = edits[p] === -1 ? 0 : edits[p] === 1 ? 1 : base.mask[p];
      kMeas = MR.applyMask(kCorr, mask);
      kCanvas = null;
      stage = 5;
    }
    if (stage <= 5) {
      startRecon();
      stage = 6;
    }
    updateInfo();
  }
  function paramObj() {
    const m = MASKS[S.mask];
    return m ? { [m.key]: S.params[S.mask] } : {};
  }

  function startRecon() {
    job = null;
    if (S.recon === 'zf' || scan) {
      recon = MR.magnitude(MR.ifftc(kMeas.re, kMeas.im, N));
      reconCanvas = null;
      computeMetrics();
      return;
    }
    job = { it: 0, iters: S.iters, solver: S.recon === 'cs' ? MR.fistaCS(kMeas, mask, N, S.lambda) : MR.pocsPF(kMeas, mask, N), t0: performance.now() };
    recon = MR.magnitude(job.solver.x);
    reconCanvas = null;
  }
  function stepRecon() {
    if (!job) return;
    const per = 2;
    for (let k = 0; k < per && job.it < job.iters; k++, job.it++) job.solver.step();
    recon = MR.magnitude(job.solver.x);
    reconCanvas = null;
    setProgress(job.it / job.iters);
    computeMetrics();
    if (job.it >= job.iters) {
      job.ms = performance.now() - job.t0;
      job = null;
      setProgress(-1);
    }
    updateInfo();
  }

  function computeMetrics() {
    const a = new Float64Array(N * N);
    const b = new Float64Array(N * N);
    let num = 0;
    let den = 0;
    for (let p = 0; p < N * N; p++) {
      a[p] = truthMag[p] / norm;
      b[p] = recon[p] / norm;
      num += (a[p] - b[p]) ** 2;
      den += a[p] * a[p];
    }
    metrics = { nrmse: Math.sqrt(num / den), psnr: M.psnr(a, b), ssim: M.ssim(a, b, N, N) };
    diffCanvas = null;
  }

  // ------------------------------------------------------------------ scan animation
  function startScan() {
    job = null;
    const order = base.lines;
    scan = { order, i: 0, perFrame: Math.max(1, Math.ceil(order.length / 170)), acquired: new Uint8Array(N * N) };
    Lab.$('#btn-scan').disabled = true;
  }
  function stepScan() {
    if (!scan) return;
    for (let k = 0; k < scan.perFrame && scan.i < scan.order.length; k++, scan.i++) {
      const l = scan.order[scan.i];
      if (l.pts) l.pts.forEach((p) => (scan.acquired[p] = 1));
      else for (let x = 0; x < N; x++) scan.acquired[l.row * N + x] = 1;
    }
    const m = new Uint8Array(N * N);
    for (let p = 0; p < N * N; p++) m[p] = scan.acquired[p] && mask[p] ? 1 : 0;
    const km = MR.applyMask(kCorr, m);
    recon = MR.magnitude(MR.ifftc(km.re, km.im, N));
    reconCanvas = null;
    kCanvas = null;
    scan.view = m;
    computeMetrics();
    setProgress(scan.i / scan.order.length);
    const total = scanSeconds();
    Lab.text('scan-clock', `${fmtTime((scan.i / scan.order.length) * total)} / ${fmtTime(total)}`);
    if (scan.i >= scan.order.length) {
      scan = null;
      Lab.$('#btn-scan').disabled = false;
      setProgress(-1);
      invalidate(5);
      setTimeout(() => Lab.text('scan-clock', ''), 2500);
    }
  }
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  function scanSeconds() {
    return (base.lines.length * S.seq.TR) / 1000;
  }

  // ------------------------------------------------------------------ canvases
  const cvImage = Lab.canvas('cv-image', () => (needsDraw = true));
  const cvK = Lab.canvas('cv-kspace', () => (needsDraw = true));
  const cvRecon = Lab.canvas('cv-recon', () => (needsDraw = true));
  const cvDiff = Lab.canvas('cv-diff', () => (needsDraw = true));
  const mzPlot = new Lab.Plot('cv-mz', { xLabel: 'time (ms)', yLabel: 'Mz / M₀', pad: { t: 24 } });
  const mxyPlot = new Lab.Plot('cv-mxy', { xLabel: 'echo time (ms)', yLabel: 'signal |Mxy|', pad: { t: 24 } });
  const cvBars = Lab.canvas('cv-bars', () => (needsDraw = true));
  let imageCanvas = null;
  let kCanvas = null;
  let reconCanvas = null;
  let diffCanvas = null;
  let needsDraw = true;
  let brushPos = null;

  function squareRect(c) {
    const s = Math.min(c.w, c.h) - 14;
    return { x: (c.w - s) / 2, y: (c.h - s) / 2, s };
  }
  function drawSquare(c, off, smooth = true) {
    c.clear();
    if (!off) return;
    const r = squareRect(c);
    c.ctx.imageSmoothingEnabled = smooth;
    c.ctx.drawImage(off, r.x, r.y, r.s, r.s);
    c.ctx.strokeStyle = T.border;
    c.ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.s - 1, r.s - 1);
    return r;
  }

  function renderK() {
    const k = kCorr;
    const view = scan ? scan.view : mask;
    const c = document.createElement('canvas');
    c.width = N;
    c.height = N;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    let max = 0;
    for (let p = 0; p < N * N; p++) max = Math.max(max, Math.hypot(k.re[p], k.im[p]));
    const s = max * 2e-5;
    const Lmax = Math.log(1 + max / s);
    const lutM = Lab.lut('inferno');
    const lutP = Lab.lut('twilight');
    for (let p = 0; p < N * N; p++) {
      let r, g, b;
      if (S.kview === 'mag') {
        const t = Math.min(255, Math.max(0, Math.round((Math.log(1 + Math.hypot(k.re[p], k.im[p]) / s) / Lmax) * 255))) * 3;
        r = lutM[t]; g = lutM[t + 1]; b = lutM[t + 2];
      } else {
        const t = Math.round(((Math.atan2(k.im[p], k.re[p]) + Math.PI) / (2 * Math.PI)) * 255) * 3;
        r = lutP[t]; g = lutP[t + 1]; b = lutP[t + 2];
      }
      if (!view[p]) { r = r * 0.16 + 6; g = g * 0.16 + 10; b = b * 0.16 + 22; }
      const o = p * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    kCanvas = c;
  }

  function drawK() {
    if (!kCanvas) renderK();
    const r = drawSquare(cvK, kCanvas, false);
    if (!r) return;
    const ctx = cvK.ctx;
    // axes through the centre
    ctx.strokeStyle = 'rgba(232,237,251,0.12)';
    ctx.beginPath();
    ctx.moveTo(r.x + r.s / 2, r.y);
    ctx.lineTo(r.x + r.s / 2, r.y + r.s);
    ctx.moveTo(r.x, r.y + r.s / 2);
    ctx.lineTo(r.x + r.s, r.y + r.s / 2);
    ctx.stroke();
    ctx.font = `10px ${T.mono}`;
    ctx.fillStyle = 'rgba(232,237,251,0.5)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('kx (readout) →', r.x + r.s - 6, r.y + r.s / 2 + 4);
    ctx.save();
    ctx.translate(r.x + r.s / 2 - 5, r.y + 8);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('← ky (phase encode)', 0, 0);
    ctx.restore();
    if (brushPos && S.brush !== 'off') {
      ctx.strokeStyle = S.brush === 'erase' ? '#fb7185' : '#34d399';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(brushPos.x, brushPos.y, (S.brushR / N) * r.s, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawImage() {
    if (!imageCanvas) imageCanvas = Lab.renderField(truthMag, N, N, { lut: 'gray', min: 0, max: norm });
    drawSquare(cvImage, imageCanvas);
  }
  function drawRecon() {
    if (!reconCanvas && recon) reconCanvas = Lab.renderField(recon, N, N, { lut: 'gray', min: 0, max: norm });
    drawSquare(cvRecon, reconCanvas);
  }
  function drawDiff() {
    if (!diffCanvas && recon) {
      const d = new Float64Array(N * N);
      for (let p = 0; p < N * N; p++) d[p] = recon[p] - truthMag[p];
      diffCanvas = Lab.renderField(d, N, N, { lut: 'diverge', min: -0.15 * norm, max: 0.15 * norm });
    }
    drawSquare(cvDiff, diffCanvas);
  }

  function drawPhysics() {
    const seq = S.seq;
    const tissues = MR.TISSUES.filter((t) => SHOWN.includes(t.key) && (S.lesion || (t.key !== 'tumor' && t.key !== 'edema')));
    Lab.$('#tissue-legend').innerHTML = tissues.map((t) => `<span><i style="background:${t.color}"></i>${t.name}</span>`).join('');
    if (S.phys === 'relax') {
      const ir = seq.type === 'IR';
      const tmax = Math.min(12000, Math.max(1200, seq.TR * 1.2, ir ? seq.TI * 1.6 : 0));
      const ts = Array.from({ length: 240 }, (_, i) => (i / 239) * tmax);
      mzPlot.series = tissues.map((t) => ({
        name: t.name, color: t.color, width: 1.8,
        data: { x: ts, y: ts.map((x) => t.PD * (ir ? 1 - 2 * Math.exp(-x / t.T1) : 1 - Math.exp(-x / t.T1))) },
      }));
      Object.assign(mzPlot.opts, { xMin: 0, xMax: tmax, yMin: ir ? -1.05 : 0, yMax: 1.05 });
      mzPlot.vlines = [{ x: seq.TR, color: 'rgba(232,237,251,0.7)', label: `TR ${seq.TR} ms`, align: 'right' }];
      if (ir) mzPlot.vlines.push({ x: seq.TI, color: 'rgba(45,212,191,0.8)', label: `TI ${seq.TI}` });
      mzPlot.hlines = ir ? [{ y: 0, color: 'rgba(232,237,251,0.25)', dash: [2, 3] }] : [];
      mzPlot.opts.title = ir ? 'Longitudinal recovery after 180° inversion' : 'Longitudinal (T1) recovery';
      mzPlot.draw();
      const te = seq.TE;
      const tmax2 = Math.max(250, te * 1.6);
      const ts2 = Array.from({ length: 200 }, (_, i) => (i / 199) * tmax2);
      const t2eff = (t) => (seq.type === 'GRE' ? 0.6 * t.T2 : t.T2);
      const amp = (t) => MR.signal(t, { ...seq, TE: 0 });
      mxyPlot.series = tissues.map((t) => ({ name: t.name, color: t.color, width: 1.8, data: { x: ts2, y: ts2.map((x) => amp(t) * Math.exp(-x / t2eff(t))) } }));
      mxyPlot.markers = tissues.map((t) => ({ x: te, y: MR.signal(t, seq), color: t.color, r: 4 }));
      Object.assign(mxyPlot.opts, { xMin: 0, xMax: tmax2, yMin: 0, yMax: null, title: seq.type === 'GRE' ? 'Transverse (T2*) decay' : 'Transverse (T2) decay' });
      mxyPlot.vlines = [{ x: te, color: 'rgba(232,237,251,0.7)', label: `TE ${te} ms` }];
      mxyPlot.draw();
    } else {
      const c = cvBars;
      const { ctx, w, h } = c;
      c.clear();
      const vals = tissues.map((t) => MR.signal(t, seq));
      const vmax = Math.max(...vals, 1e-9);
      const pad = { l: 110, r: 70, t: 18, b: 38 };
      const bh = Math.min(26, (h - pad.t - pad.b) / tissues.length - 8);
      tissues.forEach((t, i) => {
        const y = pad.t + i * (bh + 8);
        const bw = ((w - pad.l - pad.r) * vals[i]) / vmax;
        ctx.fillStyle = 'rgba(142,160,216,0.08)';
        Lab.roundRect(ctx, pad.l, y, w - pad.l - pad.r, bh, 5);
        ctx.fill();
        ctx.fillStyle = t.color;
        Lab.roundRect(ctx, pad.l, y, Math.max(2, bw), bh, 5);
        ctx.fill();
        ctx.font = `600 12px ${T.sans}`;
        ctx.fillStyle = T.text2;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(t.name, pad.l - 10, y + bh / 2);
        ctx.font = `11px ${T.mono}`;
        ctx.textAlign = 'left';
        ctx.fillText(vals[i].toFixed(3), pad.l + Math.max(2, bw) + 8, y + bh / 2);
      });
      const idx = Object.fromEntries(tissues.map((t, i) => [t.key, vals[i]]));
      const parts = [`GM : WM = ${(idx.gm / idx.wm).toFixed(2)}`, `CSF : WM = ${(idx.csf / idx.wm).toFixed(2)}`];
      if (S.lesion) parts.push(`oedema : WM = ${(idx.edema / idx.wm).toFixed(2)}`);
      ctx.font = `11px ${T.mono}`;
      ctx.fillStyle = T.muted;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('contrast ratios  ' + parts.join('   ·   '), pad.l, h - 12);
    }
  }

  function setProgress(f) {
    const el = Lab.$('#progress');
    el.classList.toggle('on', f >= 0 && f <= 1);
    el.firstElementChild.style.width = `${Math.max(0, Math.min(1, f)) * 100}%`;
  }

  // ------------------------------------------------------------------ info text
  function seqName() {
    const s = S.seq;
    if (s.type === 'IR') return s.TI < 400 ? 'STIR (fat-suppressed IR)' : s.TI > 1800 ? 'FLAIR (fluid-attenuated IR)' : 'Inversion recovery';
    if (s.type === 'GRE') return `Spoiled gradient echo · α ${s.flip}°`;
    if (s.TR < 1000 && s.TE < 30) return 'T1-weighted spin echo';
    if (s.TR >= 2000 && s.TE >= 60) return 'T2-weighted spin echo';
    if (s.TR >= 2000 && s.TE < 30) return 'PD-weighted spin echo';
    return 'Mixed-weighting spin echo';
  }
  function updateInfo() {
    const s = S.seq;
    Lab.text('image-sub', `${seqName()} · TR ${s.TR} · TE ${s.TE}${s.type === 'IR' ? ` · TI ${s.TI}` : ''}`);
    if (!base || !mask) return;
    let sampled = 0;
    for (let p = 0; p < N * N; p++) sampled += mask[p];
    const lines = base.lines.length;
    const R = S.mask === 'radial' ? (Math.PI / 2) * N / lines : N / Math.max(1, lines);
    const pname = { full: 'Cartesian', lowpass: 'Low-pass', highpass: 'High-pass', parallel: `Uniform R=${S.params.parallel}`, random: 'Variable-density random', radial: 'Radial', pf: 'Partial Fourier' }[S.mask];
    Lab.text('kspace-sub', `${pname} · ${S.mask === 'radial' ? `${lines} spokes` : `${lines} PE lines`}`);
    Lab.$('#kspace-stats').innerHTML = `sampled ${((100 * sampled) / (N * N)).toFixed(1)}% · R ≈ ${R.toFixed(1)} · scan ${fmtTime(scanSeconds())}`;
    const rname = { zf: 'Zero-filled IFFT', cs: 'Compressed sensing (FISTA, Haar)', pocs: 'POCS partial Fourier' }[S.recon];
    const status = job ? ` · iteration ${job.it}/${job.iters}` : scan ? ' · acquiring…' : '';
    Lab.text('recon-sub', rname + status);
    if (metrics) Lab.$('#recon-stats').innerHTML = `NRMSE ${metrics.nrmse.toFixed(3)} · PSNR ${metrics.psnr.toFixed(1)} dB · SSIM ${metrics.ssim.toFixed(3)}`;
  }

  // ------------------------------------------------------------------ interaction
  function kIndex(e) {
    const p = cvK.pointer(e);
    const r = squareRect(cvK);
    brushPos = p;
    return { i: Math.floor(((p.x - r.x) / r.s) * N), j: Math.floor(((p.y - r.y) / r.s) * N) };
  }
  let painting = false;
  function paint(e) {
    const { i, j } = kIndex(e);
    const R = S.brushR;
    const v = S.brush === 'erase' ? -1 : 1;
    for (let y = Math.max(0, j - R); y <= Math.min(N - 1, j + R); y++) {
      for (let x = Math.max(0, i - R); x <= Math.min(N - 1, i + R); x++) if ((x - i) ** 2 + (y - j) ** 2 <= R * R) edits[y * N + x] = v;
    }
    invalidate(4);
  }
  cvK.canvas.addEventListener('pointerdown', (e) => {
    if (S.brush === 'off') return Lab.toast('Choose Erase or Restore in “k-space brush” to paint on k-space');
    painting = true;
    cvK.canvas.setPointerCapture(e.pointerId);
    paint(e);
  });
  cvK.canvas.addEventListener('pointermove', (e) => {
    kIndex(e);
    needsDraw = true;
    if (painting) paint(e);
  });
  cvK.canvas.addEventListener('pointerup', () => (painting = false));
  cvK.canvas.addEventListener('pointerleave', () => { brushPos = null; needsDraw = true; });

  cvImage.canvas.addEventListener('pointermove', (e) => {
    const p = cvImage.pointer(e);
    const r = squareRect(cvImage);
    const i = Math.floor(((p.x - r.x) / r.s) * N);
    const j = Math.floor(((p.y - r.y) / r.s) * N);
    const el = Lab.$('#tissue-readout');
    if (!brain || i < 0 || j < 0 || i >= N || j >= N) return (el.style.display = 'none');
    const q = j * N + i;
    let best = -1;
    let bf = 0;
    brain.frac.forEach((f, t) => { if (f[q] > bf) { bf = f[q]; best = t; } });
    el.style.display = '';
    el.textContent = best < 0 ? 'air' : `${MR.TISSUES[best].name}${bf < 0.99 ? ` (${Math.round(bf * 100)}%)` : ''} · S = ${(truthMag[q] / norm).toFixed(2)}`;
  });
  cvImage.canvas.addEventListener('pointerleave', () => (Lab.$('#tissue-readout').style.display = 'none'));

  // ------------------------------------------------------------------ controls
  const trSlider = Lab.range('sl-tr', {
    format: () => `${S.seq.TR} ms`,
    onInput: (v) => { S.seq.TR = Math.round(20 * Math.pow(10000 / 20, v / 1000)); trSlider.refresh(); seqChanged(); },
  });
  const trToSlider = (tr) => (1000 * Math.log(tr / 20)) / Math.log(10000 / 20);
  const teSlider = Lab.range('sl-te', { format: (v) => `${v} ms`, onInput: (v) => { S.seq.TE = v; seqChanged(); } });
  const tiSlider = Lab.range('sl-ti', { format: (v) => `${v} ms`, onInput: (v) => { S.seq.TI = v; seqChanged(); } });
  const flipSlider = Lab.range('sl-flip', { format: (v) => `${v}°`, onInput: (v) => { S.seq.flip = v; seqChanged(); } });
  const seqSeg = Lab.seg('seg-seq', (v) => {
    S.seq.type = v;
    if (v === 'GRE') { S.seq.TR = 30; S.seq.TE = 5; }
    else if (S.seq.TR < 300) { S.seq.TR = 500; S.seq.TE = 15; }
    syncSeqUi();
    seqChanged();
  });
  function syncSeqUi() {
    seqSeg.set(S.seq.type);
    trSlider.set(trToSlider(S.seq.TR));
    teSlider.set(S.seq.TE);
    tiSlider.set(S.seq.TI);
    flipSlider.set(S.seq.flip);
    Lab.$$('.only-ir').forEach((el) => el.classList.toggle('hidden', S.seq.type !== 'IR'));
    Lab.$$('.only-gre').forEach((el) => el.classList.toggle('hidden', S.seq.type !== 'GRE'));
    Lab.$$('#presets button').forEach((b) => {
      const p = PRESETS[b.dataset.preset];
      b.classList.toggle('active', Object.entries(p).every(([k, v]) => S.seq[k] === v));
    });
  }
  function seqChanged() {
    Lab.$$('#presets button').forEach((b) => {
      const p = PRESETS[b.dataset.preset];
      b.classList.toggle('active', Object.entries(p).every(([k, v]) => S.seq[k] === v));
    });
    invalidate(1);
    needsDraw = true;
  }
  Lab.$$('#presets button').forEach((b) =>
    b.addEventListener('click', () => {
      Object.assign(S.seq, PRESETS[b.dataset.preset]);
      syncSeqUi();
      seqChanged();
    })
  );
  Lab.toggle('tg-lesion', (v) => { S.lesion = v; invalidate(0); needsDraw = true; });
  Lab.toggle('tg-phase', (v) => { S.phase = v; invalidate(1); });

  const maskSel = Lab.select('sel-mask', (v) => { S.mask = v; edits = new Int8Array(N * N); syncMaskUi(); invalidate(3); });
  const maskSlider = Lab.range('sl-mask', {
    format: (v) => (MASKS[S.mask] ? MASKS[S.mask].fmt(v) : ''),
    onInput: (v) => { S.params[S.mask] = v; invalidate(3); },
  });
  function syncMaskUi() {
    const m = MASKS[S.mask];
    Lab.$('#mask-param-field').classList.toggle('hidden', !m);
    Lab.$$('.only-parallel').forEach((el) => el.classList.toggle('hidden', S.mask !== 'parallel'));
    if (m) {
      Lab.text('lbl-mask', m.label);
      Object.assign(maskSlider.el, { min: m.min, max: m.max, step: m.step });
      maskSlider.set(S.params[S.mask]);
    }
    // sensible reconstruction defaults per pattern
    if (S.mask === 'random' && S.recon === 'zf') reconSeg.set('cs', true);
    else if (S.mask === 'pf' && S.recon !== 'pocs') reconSeg.set('pocs', true);
    else if (!['random', 'pf'].includes(S.mask) && S.recon !== 'zf') reconSeg.set('zf', true);
  }
  Lab.toggle('tg-acs', (v) => { S.acs = v; invalidate(3); });
  Lab.range('sl-noise', { format: (v) => `${v.toFixed(1)}%`, onInput: (v) => { S.noise = v; invalidate(2); } });
  Lab.toggle('tg-spike', (v) => { S.spike = v; invalidate(2); });
  Lab.toggle('tg-motion', (v) => { S.motion = v; invalidate(2); });
  const reconSeg = Lab.seg('seg-recon', (v) => {
    S.recon = v;
    Lab.$$('.only-cs').forEach((el) => el.classList.toggle('hidden', v !== 'cs'));
    Lab.$$('.only-iter').forEach((el) => el.classList.toggle('hidden', v === 'zf'));
    invalidate(5);
  });
  Lab.range('sl-lambda', { format: (v) => v.toFixed(3), onInput: (v) => { S.lambda = v; invalidate(5); } });
  Lab.range('sl-iters', { format: (v) => `${v}`, onInput: (v) => { S.iters = v; invalidate(5); } });
  Lab.seg('seg-brush', (v) => { S.brush = v; cvK.canvas.style.cursor = v === 'off' ? 'default' : 'none'; });
  Lab.range('sl-brush', { format: (v) => `${v} px`, onInput: (v) => (S.brushR = v) });
  Lab.$('#btn-clear-edits').addEventListener('click', () => { edits = new Int8Array(N * N); invalidate(4); });
  Lab.$('#btn-scan').addEventListener('click', () => { if (!scan) startScan(); });
  Lab.seg('seg-kview', (v) => { S.kview = v; kCanvas = null; needsDraw = true; });
  Lab.seg('seg-phys', (v) => {
    S.phys = v;
    Lab.$$('.p-physics .tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.tab === v));
    needsDraw = true;
  });

  // ------------------------------------------------------------------ main loop
  Lab.loop(() => {
    const busy = stage < 6 || !!job || !!scan;
    if (stage < 6 && !scan) { runPipeline(); needsDraw = true; }
    if (scan) stepScan();
    else if (job) stepRecon();
    if (busy || needsDraw) {
      drawImage();
      drawK();
      drawRecon();
      drawDiff();
      drawPhysics();
      updateInfo();
      needsDraw = false;
    }
  });

  // ------------------------------------------------------------------ init
  Lab.$('#colorbar').style.background = Lab.cmapGradient('diverge');
  cvK.canvas.style.cursor = 'default';
  syncSeqUi();
  syncMaskUi();

  window.KSpace = {
    state: S,
    preset: (p) => Lab.$(`#presets button[data-preset="${p}"]`).click(),
    mask: (m, v) => { maskSel.set(m); S.mask = m; if (v !== undefined) S.params[m] = v; edits = new Int8Array(N * N); syncMaskUi(); invalidate(3); },
    recon: (r) => reconSeg.set(r, true),
    scan: () => startScan(),
    phys: (t) => Lab.$(`#seg-phys button[data-value="${t}"]`).click(),
    toggle: (id, v) => { const el = document.getElementById(id); el.checked = v; el.dispatchEvent(new Event('change')); },
    get busy() { return stage < 6 || !!job || !!scan; },
    get metrics() { return metrics; },
  };
})();
