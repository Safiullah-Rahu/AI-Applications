/* MyoHand — live EMG streaming, calibration, classification and a 3-D robotic hand. */
(function () {
  'use strict';
  const E = window.EMGCore;
  const M = window.LabMath;
  Lab.boot();
  const T = Lab.theme();
  const { FS, NCH, GESTURES } = E;
  const K = GESTURES.length;
  const WIN_STEP = 50;
  const CLASS_COLORS = ['#94a3b8', '#f472b6', '#34d399', '#fbbf24', '#60a5fa', '#fb923c', '#a78bfa'];
  const SHORT = ['Rest', 'Grip', 'Open', 'Pinch', 'Point', 'Flex', 'Ext'];
  const CH_LABELS = ['FCR', 'FDS', 'FDP', 'FCU', 'ECU', 'EDC', 'ECRB', 'APL'];
  const CH_COLORS = ['#f472b6', '#fb7185', '#fb923c', '#fbbf24', '#34d399', '#2dd4bf', '#60a5fa', '#a78bfa'];

  const S = {
    intent: 0, demo: true, effort: 0.7, reps: 3, hold: 1.5, clf: 'lda', vote: 5, reject: 0.5,
    shift: 0, fatigue: 0, noise: 0.02, power: 0, notch: true, motion: false, sig: 'filtered', tab: 'space', win: 200,
  };

  // ------------------------------------------------------------------ live signal chain
  const sim = new E.EMGSimulator(7);
  const cond = new E.Conditioner();
  const BUF = 3000;
  const raw = Array.from({ length: NCH }, () => new Float32Array(BUF));
  const filt = Array.from({ length: NCH }, () => new Float32Array(BUF));
  let head = 0;
  let totalSamples = 0;
  let sinceWin = 0;
  function syncSim() {
    Object.assign(sim.cfg, { effort: S.effort, shift: S.shift, fatigue: S.fatigue, noise: S.noise, powerline: S.power, motion: S.motion });
    cond.useNotch = S.notch;
  }
  function pushSamples(n) {
    if (n <= 0) return;
    const r = sim.generate(n);
    const f = cond.process(r);
    for (let s = 0; s < n; s++) {
      for (let c = 0; c < NCH; c++) {
        raw[c][head] = r[c][s];
        filt[c][head] = f[c][s];
      }
      head = (head + 1) % BUF;
      totalSamples++;
      sinceWin++;
      if (sinceWin >= WIN_STEP) {
        sinceWin = 0;
        onWindow();
      }
    }
  }
  function lastWindow(len) {
    const w = Array.from({ length: NCH }, () => new Float32Array(len));
    for (let c = 0; c < NCH; c++) for (let i = 0; i < len; i++) w[c][i] = filt[c][(head - len + i + BUF) % BUF];
    return w;
  }

  // ------------------------------------------------------------------ model state
  let calibData = null; // {X, y, rep}
  let model = null; // {clf, scaler, proj, projPts, acc, confusion, ms, maxMav}
  let lastFeat = null;
  let lastZ = null;
  let proba = new Array(K).fill(0);
  const votes = [];
  let decision = 0;
  let level = 0;
  const trailPts = [];
  const history = []; // {t, intent, pred, conf}
  let intentChangedAt = 0;
  const latencies = [];
  let awaitingCorrect = null;

  function makeClf() {
    return S.clf === 'knn' ? new E.KNN(5) : S.clf === 'mlp' ? new E.MLP({ epochs: 60 }) : new E.LDA();
  }
  function train() {
    if (!calibData) return;
    const t0 = performance.now();
    const { X, y, rep } = calibData;
    const R = Math.max(...rep) + 1;
    const tr = [];
    const te = [];
    rep.forEach((r, i) => (r < R - 1 ? tr : te).push(i));
    const sc = E.fitScaler(tr.map((i) => X[i]));
    const clf = makeClf().fit(tr.map((i) => sc.apply(X[i])), tr.map((i) => y[i]), K);
    const pred = te.map((i) => E.argmax(clf.predictProba(sc.apply(X[i]))));
    const yt = te.map((i) => y[i]);
    const acc = pred.filter((p, i) => p === yt[i]).length / Math.max(1, pred.length);
    const confusion = E.confusion(yt, pred, K);
    // final model on every repetition
    const scaler = E.fitScaler(X);
    const Z = X.map((x) => scaler.apply(x));
    const final = makeClf().fit(Z, y, K);
    const proj = E.fisherProjection(Z, y, K);
    const projPts = Z.map((z, i) => ({ p: proj(z), c: y[i] }));
    let maxMav = 1e-6;
    X.forEach((x) => {
      let m = 0;
      for (let c = 0; c < NCH; c++) m += x[c * 4];
      maxMav = Math.max(maxMav, m / NCH);
    });
    model = { clf: final, scaler, proj, projPts, acc, confusion, ms: performance.now() - t0, maxMav, n: X.length };
    votes.length = 0;
    updateCalibStatus();
    updateStats();
  }
  function updateCalibStatus() {
    const el = Lab.$('#calib-status');
    if (!model) { el.textContent = 'Not calibrated.'; return; }
    el.innerHTML = `Trained on <b>${model.n}</b> windows (${calibData ? Math.max(...calibData.rep) + 1 : 0} reps × ${K} gestures). ` +
      `Hold-out accuracy on the last repetition: <b>${(model.acc * 100).toFixed(1)}%</b>`;
  }

  // ------------------------------------------------------------------ calibration
  let calib = null;
  function startGuided() {
    const steps = [];
    for (let r = 0; r < S.reps; r++) for (let g = 0; g < K; g++) steps.push({ g, r });
    calib = { steps, i: 0, phase: 'rest', t: 0, data: { X: [], y: [], rep: [] } };
    S.demo = false;
    Lab.$('#tg-demo').checked = false;
    Lab.$('#calib-overlay').classList.add('on');
    setIntent(0, true);
  }
  function stepGuided(dt) {
    if (!calib) return;
    calib.t += dt;
    const st = calib.steps[calib.i];
    const restDur = 0.7;
    if (calib.phase === 'rest' && calib.t >= restDur) {
      calib.phase = 'hold';
      calib.t = 0;
      setIntent(st.g, true);
    } else if (calib.phase === 'hold' && calib.t >= S.hold) {
      calib.i++;
      calib.t = 0;
      calib.phase = 'rest';
      setIntent(0, true);
      if (calib.i >= calib.steps.length) {
        calibData = calib.data;
        calib = null;
        Lab.$('#calib-overlay').classList.remove('on');
        train();
        Lab.toast(`Calibrated — hold-out accuracy ${(model.acc * 100).toFixed(1)}%`);
        return;
      }
    }
    const cur = calib.steps[calib.i];
    Lab.text('calib-step', `Calibration · ${calib.i + 1} / ${calib.steps.length} · repetition ${cur.r + 1}`);
    Lab.text('calib-prompt', calib.phase === 'rest' ? `Relax… next: ${GESTURES[cur.g].name}` : `Hold: ${GESTURES[cur.g].name}`);
    const frac = calib.phase === 'rest' ? calib.t / 0.7 : calib.t / S.hold;
    Lab.$('#calib-bar').style.width = `${Math.min(1, frac) * 100}%`;
  }
  let calibSeed = 11; // first calibration is deterministic so the demo always starts the same way
  function instantCalibrate() {
    const s2 = new E.EMGSimulator(calibSeed);
    calibSeed = 1000 + Math.floor(Math.random() * 100000);
    Object.assign(s2.cfg, sim.cfg);
    const c2 = new E.Conditioner();
    c2.useNotch = S.notch;
    const data = { X: [], y: [], rep: [] };
    for (let r = 0; r < S.reps; r++) {
      for (let g = 0; g < K; g++) {
        s2.setIntent(g);
        c2.process(s2.generate(500));
        const n = Math.round(S.hold * 1000);
        const f = c2.process(s2.generate(n));
        for (let s = Math.max(S.win, 300); s <= n; s += WIN_STEP) {
          data.X.push(Array.from(E.features(f.map((ch) => ch.subarray(s - S.win, s)))));
          data.y.push(g);
          data.rep.push(r);
        }
      }
    }
    calibData = data;
    train();
  }

  // ------------------------------------------------------------------ per-window decision
  function onWindow() {
    const win = lastWindow(S.win);
    lastFeat = E.features(win);
    let m = 0;
    for (let c = 0; c < NCH; c++) m += lastFeat[c * 4];
    m /= NCH;
    if (calib && calib.phase === 'hold' && calib.t > 0.3) {
      calib.data.X.push(Array.from(lastFeat));
      calib.data.y.push(calib.steps[calib.i].g);
      calib.data.rep.push(calib.steps[calib.i].r);
    }
    if (!model) return;
    level = Math.min(1, m / model.maxMav);
    lastZ = model.scaler.apply(lastFeat);
    proba = model.clf.predictProba(lastZ);
    let d = E.argmax(proba);
    if (proba[d] < S.reject) d = 0;
    votes.push(d);
    while (votes.length > S.vote) votes.shift();
    const counts = new Array(K).fill(0);
    votes.forEach((v) => counts[v]++);
    decision = E.argmax(counts);
    const p2 = model.proj(lastZ);
    trailPts.push(p2);
    if (trailPts.length > 16) trailPts.shift();
    const now = totalSamples / FS;
    history.push({ t: now, intent: S.intent, pred: decision, conf: proba[E.argmax(proba)] });
    while (history.length && history[0].t < now - 15) history.shift();
    if (awaitingCorrect !== null && decision === S.intent) {
      latencies.push((now - awaitingCorrect) * 1000);
      if (latencies.length > 12) latencies.shift();
      awaitingCorrect = null;
    }
  }

  function setIntent(g, fromCalib = false) {
    if (g === S.intent && !fromCalib) return;
    S.intent = g;
    sim.setIntent(g);
    intentChangedAt = totalSamples / FS;
    awaitingCorrect = model ? intentChangedAt : null;
    Lab.$$('#gestures button').forEach((b) => b.classList.toggle('active', +b.dataset.g === g));
  }

  // ------------------------------------------------------------------ hand model & renderer
  const FINGERS = [
    { base: [-2.9, 9.0], len: [4.3, 2.5, 2.0], r: 0.8, spread: -1 },
    { base: [-0.95, 9.45], len: [4.7, 2.9, 2.1], r: 0.84, spread: -0.2 },
    { base: [0.95, 9.05], len: [4.4, 2.7, 2.0], r: 0.8, spread: 1 },
    { base: [2.75, 8.2], len: [3.5, 2.1, 1.8], r: 0.7, spread: 1.6 },
  ];
  const THUMB = { base: [-3.3, 2.6], len: [4.1, 3.0, 2.5], r: 0.92 };
  const R_ = Math.PI / 180;
  const restPose = { f: [[2, 18, 24, 12], [0, 20, 26, 14], [2, 22, 28, 16], [3, 26, 30, 18]], t: [22, 18, 12, 14], w: 0 };
  const POSES = [
    restPose,
    { f: [[0, 88, 102, 62], [0, 90, 104, 64], [0, 90, 102, 62], [0, 88, 100, 60]], t: [62, 8, 42, 55], w: 0 },
    { f: [[10, -8, -2, 0], [2, -8, -2, 0], [8, -8, -2, 0], [14, -10, -2, 0]], t: [0, 45, -8, -4], w: -8 },
    { f: [[2, 48, 52, 26], [0, 52, 56, 28], [2, 86, 96, 56], [3, 86, 96, 56]], t: [80, 12, 30, 24], w: 0 },
    { f: [[4, 0, 0, 0], [0, 90, 104, 64], [0, 90, 102, 62], [0, 88, 100, 60]], t: [58, 8, 38, 44], w: 0 },
    { f: restPose.f, t: restPose.t, w: 55 },
    { f: [[2, 8, 12, 6], [0, 10, 14, 8], [2, 12, 16, 8], [3, 14, 18, 10]], t: [12, 25, 6, 6], w: -48 },
  ];
  const clonePose = (p) => ({ f: p.f.map((a) => a.slice()), t: p.t.slice(), w: p.w });
  let pose = clonePose(restPose);
  function blendPose(target, k) {
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) pose.f[i][j] += (target.f[i][j] - pose.f[i][j]) * k;
    for (let j = 0; j < 4; j++) pose.t[j] += (target.t[j] - pose.t[j]) * k;
    pose.w += (target.w - pose.w) * k;
  }

  const v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  };
  function fingerChain(F, a) {
    const abd = F.spread * a[0] * R_;
    const u = [Math.sin(abd), Math.cos(abd), 0];
    const pts = [[F.base[0], F.base[1], 0]];
    let phi = 0;
    for (let k = 0; k < 3; k++) {
      phi += a[k + 1] * R_;
      const d = [u[0] * Math.cos(phi), u[1] * Math.cos(phi), -Math.sin(phi)];
      pts.push(v3.add(pts[k], v3.mul(d, F.len[k])));
    }
    return pts;
  }
  function thumbChain(a) {
    const o = Math.max(0, Math.min(1, a[0] / 90));
    let dm = v3.norm(v3.lerp([-0.66, 0.74, -0.1], [0.3, 0.7, -0.66], o));
    dm = v3.norm(v3.add(dm, [(-a[1] / 90) * 0.5, 0, (-a[1] / 90) * 0.2]));
    let b = [0.72, 0.12, -0.68];
    b = v3.norm(v3.sub(b, v3.mul(dm, v3.dot(b, dm))));
    const p0 = [THUMB.base[0], THUMB.base[1], 0];
    const p1 = v3.add(p0, v3.mul(dm, THUMB.len[0]));
    let phi = a[2] * R_;
    const d1 = v3.add(v3.mul(dm, Math.cos(phi)), v3.mul(b, Math.sin(phi)));
    const p2 = v3.add(p1, v3.mul(d1, THUMB.len[1]));
    phi += a[3] * R_;
    const d2 = v3.add(v3.mul(dm, Math.cos(phi)), v3.mul(b, Math.sin(phi)));
    const p3 = v3.add(p2, v3.mul(d2, THUMB.len[2]));
    return [p0, p1, p2, p3];
  }
  const PALM = [[-3.9, 0.4], [-4.35, 3.9], [-4.0, 8.2], [-2.9, 9.7], [-0.95, 10.1], [0.95, 9.75], [2.75, 8.9], [3.75, 7.4], [3.95, 0.4], [2.6, -0.5], [-2.6, -0.5]];

  const cvHand = Lab.canvas('cv-hand');
  function drawHand() {
    const { ctx, w, h } = cvHand;
    cvHand.clear();
    const wrist = pose.w * R_;
    const rotW = (p) => [p[0], p[1] * Math.cos(wrist) + p[2] * Math.sin(wrist), -p[1] * Math.sin(wrist) + p[2] * Math.cos(wrist)];
    const yaw = 24 * R_;
    const pitch = 14 * R_;
    const s = Math.min((h - 24) / 30.5, (w - 250) / 15);
    const cx = (w - 230) / 2 + 58;
    const cy = h - 14 - 9.5 * s;
    const proj = (p) => {
      const x1 = p[0] * Math.cos(yaw) + p[2] * Math.sin(yaw);
      const z1 = -p[0] * Math.sin(yaw) + p[2] * Math.cos(yaw);
      const y2 = p[1] * Math.cos(pitch) - z1 * Math.sin(pitch);
      const z2 = p[1] * Math.sin(pitch) + z1 * Math.cos(pitch);
      return { x: cx + x1 * s, y: cy - y2 * s, z: z2 };
    };
    // glow floor
    const g = ctx.createRadialGradient(cx, cy - 4 * s, 10, cx, cy - 4 * s, 16 * s);
    g.addColorStop(0, Lab.alpha(CLASS_COLORS[decision], 0.16));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // forearm socket with the EMG armband
    const fa = [[-3.3, -0.4, 0], [3.3, -0.4, 0], [3.0, -9.5, 0], [-3.0, -9.5, 0]].map(proj);
    ctx.fillStyle = '#131b33';
    ctx.strokeStyle = '#3b4a78';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    fa.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    const band = [-3.25, -5.6];
    const b0 = proj([-3.2, band[1], 0]);
    const b1 = proj([3.2, band[1], 0]);
    ctx.strokeStyle = '#0b1020';
    ctx.lineWidth = 1.3 * s;
    ctx.beginPath();
    ctx.moveTo(b0.x, b0.y);
    ctx.lineTo(b1.x, b1.y);
    ctx.stroke();
    const rms = channelLevels();
    for (let c = 0; c < 5; c++) {
      const x = -2.6 + c * 1.3;
      const p = proj([x, band[1], 0.1]);
      const a = Math.min(1, rms[c + 3] * 1.3);
      ctx.fillStyle = Lab.alpha(CH_COLORS[c + 3], 0.25 + 0.75 * a);
      ctx.shadowColor = CH_COLORS[c + 3];
      ctx.shadowBlur = 12 * a;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 0.32 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // collect drawables
    const items = [];
    const palm = PALM.map(([x, y]) => proj(rotW([x, y, 0])));
    items.push({ z: -0.4, draw: () => drawPalm(ctx, palm, s) });
    const chains = FINGERS.map((F, i) => ({ pts: fingerChain(F, pose.f[i]).map((p) => proj(rotW(p))), r: F.r }));
    chains.push({ pts: thumbChain(pose.t).map((p) => proj(rotW(p))), r: THUMB.r, thumb: true });
    for (const ch of chains) {
      for (let k = 0; k < 3; k++) {
        const a = ch.pts[k];
        const b = ch.pts[k + 1];
        const rr = ch.r * (1 - k * 0.1);
        items.push({ z: (a.z + b.z) / 2 + (ch.thumb && k === 0 ? -0.5 : 0), draw: () => drawSeg(ctx, a, b, rr * s, k === 2) });
      }
      for (let k = 1; k < 3; k++) {
        const p = ch.pts[k];
        items.push({ z: p.z + 0.01, draw: () => drawJoint(ctx, p, ch.r * s * 0.62) });
      }
    }
    items.sort((a, b) => a.z - b.z);
    items.forEach((it) => it.draw());
  }
  function shade(z) {
    const t = M.clamp((z + 7) / 9, 0, 1);
    const c0 = [71, 85, 120];
    const c1 = [214, 222, 240];
    return `rgb(${c0.map((v, i) => Math.round(v + (c1[i] - v) * t)).join(',')})`;
  }
  function drawSeg(ctx, a, b, r, tip) {
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0b1020';
    ctx.lineWidth = 2 * r + 2.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.strokeStyle = shade((a.z + b.z) / 2);
    ctx.lineWidth = 2 * r;
    ctx.stroke();
    // accent inlay
    ctx.strokeStyle = 'rgba(167,139,250,0.55)';
    ctx.lineWidth = Math.max(1.5, r * 0.35);
    ctx.stroke();
    if (tip) {
      ctx.fillStyle = '#c4b5fd';
      ctx.beginPath();
      ctx.arc(b.x, b.y, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.lineCap = 'butt';
  }
  function drawJoint(ctx, p, r) {
    ctx.fillStyle = '#111827';
    ctx.strokeStyle = shade(p.z);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  function drawPalm(ctx, pts, s) {
    const grd = ctx.createLinearGradient(pts[0].x, pts[0].y, pts[4].x, pts[4].y);
    grd.addColorStop(0, '#1b2442');
    grd.addColorStop(1, '#2a3761');
    ctx.fillStyle = grd;
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // dorsal cover detail
    const c = { x: (pts[1].x + pts[7].x) / 2, y: (pts[1].y + pts[7].y) / 2 };
    ctx.strokeStyle = 'rgba(167,139,250,0.35)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, 1.7 * s, 2.2 * s, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = Lab.alpha(CLASS_COLORS[decision], 0.9);
    ctx.shadowColor = CLASS_COLORS[decision];
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 0.45 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // ------------------------------------------------------------------ EMG traces, armband ring, feature map
  const cvEmg = Lab.canvas('cv-emg');
  function channelLevels() {
    const n = 150;
    const lv = new Array(NCH).fill(0);
    for (let c = 0; c < NCH; c++) {
      let s = 0;
      for (let i = 0; i < n; i++) { const v = filt[c][(head - 1 - i + BUF) % BUF]; s += v * v; }
      lv[c] = Math.sqrt(s / n) / 0.9;
    }
    return lv;
  }
  function drawEmg() {
    const { ctx, w, h } = cvEmg;
    cvEmg.clear();
    const src = S.sig === 'raw' ? raw : filt;
    const pad = { l: 58, r: 12, t: 10, b: 22 };
    const rowH = (h - pad.t - pad.b) / NCH;
    const pw = w - pad.l - pad.r;
    const nShow = 2500;
    const scaleY = rowH * 0.42;
    ctx.font = `600 10.5px ${T.mono}`;
    for (let c = 0; c < NCH; c++) {
      const y0 = pad.t + rowH * (c + 0.5);
      ctx.strokeStyle = 'rgba(142,160,216,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l, Math.round(y0) + 0.5);
      ctx.lineTo(pad.l + pw, Math.round(y0) + 0.5);
      ctx.stroke();
      ctx.fillStyle = CH_COLORS[c];
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${c + 1}`, 8, y0);
      ctx.fillStyle = T.muted;
      ctx.fillText(CH_LABELS[c], 22, y0);
      // min/max decimated trace + RMS envelope
      const cols = Math.floor(pw);
      const per = nShow / cols;
      ctx.beginPath();
      const env = [];
      for (let x = 0; x < cols; x++) {
        let mn = Infinity;
        let mx = -Infinity;
        let ss = 0;
        const i0 = Math.floor(x * per);
        const i1 = Math.floor((x + 1) * per);
        for (let i = i0; i < i1; i++) {
          const v = src[c][(head - nShow + i + BUF * 2) % BUF];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          ss += v * v;
        }
        env.push(Math.sqrt(ss / Math.max(1, i1 - i0)));
        const px = pad.l + x;
        ctx.moveTo(px + 0.5, y0 - M.clamp(mx, -2.2, 2.2) * scaleY);
        ctx.lineTo(px + 0.5, y0 - M.clamp(mn, -2.2, 2.2) * scaleY + 0.5);
      }
      ctx.strokeStyle = Lab.alpha(CH_COLORS[c], 0.8);
      ctx.lineWidth = 1;
      ctx.stroke();
      // smoothed envelope
      ctx.beginPath();
      let e = env[0] || 0;
      env.forEach((v, x) => { e += (v - e) * 0.08; const y = y0 - Math.min(2.2, e * 1.6) * scaleY; x ? ctx.lineTo(pad.l + x, y) : ctx.moveTo(pad.l + x, y); });
      ctx.strokeStyle = 'rgba(232,237,251,0.8)';
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
    // time axis
    ctx.fillStyle = T.muted;
    ctx.font = `10px ${T.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let k = 0; k <= 5; k++) ctx.fillText(`${(-2.5 + k * 0.5).toFixed(1)} s`, pad.l + (k / 5) * pw, h - pad.b + 6);
    // gesture band along the top of the traces
    const now = totalSamples / FS;
    for (const hh of history) {
      const x = pad.l + ((hh.t - (now - 2.5)) / 2.5) * pw;
      if (x < pad.l) continue;
      ctx.fillStyle = Lab.alpha(CLASS_COLORS[hh.intent], 0.9);
      ctx.fillRect(x, 2, (0.05 / 2.5) * pw + 1, 4);
    }
  }

  const cvRing = Lab.canvas('cv-ring');
  function drawRing() {
    const { ctx, w, h } = cvRing;
    cvRing.clear();
    const cx = w / 2;
    const cy = h / 2 + 8;
    const R = Math.min(w, h) / 2 - 22;
    const lv = channelLevels();
    // forearm cross-section: skin, muscle compartments, radius & ulna
    ctx.fillStyle = '#131b33';
    ctx.beginPath();
    ctx.ellipse(cx, cy, R, R * 0.86, 0, 0, Math.PI * 2);
    ctx.fill();
    for (let c = 0; c < NCH; c++) {
      const a0 = (c / NCH) * Math.PI * 2 - Math.PI / 2 - Math.PI / NCH;
      const a1 = a0 + (2 * Math.PI) / NCH;
      const a = Math.min(1, lv[c]);
      ctx.fillStyle = Lab.alpha(CH_COLORS[c], 0.08 + 0.55 * a);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.ellipse(cx, cy, R * 0.93, R * 0.8, 0, a0, a1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.ellipse(cx - R * 0.28, cy + R * 0.05, R * 0.14, R * 0.11, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + R * 0.3, cy + R * 0.12, R * 0.12, R * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3b4a78';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, R, R * 0.86, 0, 0, Math.PI * 2);
    ctx.stroke();
    // electrodes
    for (let c = 0; c < NCH; c++) {
      const a = (c / NCH) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(a) * (R + 8);
      const y = cy + Math.sin(a) * (R * 0.86 + 8);
      const l = Math.min(1, lv[c]);
      ctx.fillStyle = CH_COLORS[c];
      ctx.shadowColor = CH_COLORS[c];
      ctx.shadowBlur = 16 * l;
      ctx.globalAlpha = 0.35 + 0.65 * l;
      ctx.beginPath();
      ctx.arc(x, y, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0b1020';
      ctx.font = `700 8px ${T.mono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(c + 1), x, y + 0.5);
    }
    ctx.font = `9px ${T.sans}`;
    ctx.fillStyle = T.muted;
    ctx.fillText('flexors', cx, cy - R * 0.45);
    ctx.fillText('extensors', cx, cy + R * 0.5);
  }

  const cvFeat = Lab.canvas('cv-feat');
  function drawFeat() {
    const { ctx, w, h } = cvFeat;
    cvFeat.clear();
    const pad = { l: 64, r: 10, t: 44, b: 10 };
    const cw = (w - pad.l - pad.r) / 4;
    const ch = (h - pad.t - pad.b) / NCH;
    const lut = Lab.lut('diverge');
    ctx.font = `600 10px ${T.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    E.FEATURE_NAMES.forEach((n, j) => { ctx.fillStyle = T.text2; ctx.fillText(n, pad.l + cw * (j + 0.5), pad.t - 4); });
    for (let c = 0; c < NCH; c++) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = CH_COLORS[c];
      ctx.fillText(`${c + 1} ${CH_LABELS[c]}`, pad.l - 8, pad.t + ch * (c + 0.5));
      for (let j = 0; j < 4; j++) {
        const z = lastZ ? lastZ[c * 4 + j] : 0;
        const t = Math.round(M.clamp((z + 3) / 6, 0, 1) * 255) * 3;
        ctx.fillStyle = `rgb(${lut[t]},${lut[t + 1]},${lut[t + 2]})`;
        Lab.roundRect(ctx, pad.l + cw * j + 2, pad.t + ch * c + 2, cw - 4, ch - 4, 4);
        ctx.fill();
        if (ch > 16) {
          ctx.fillStyle = Math.abs(z) > 1.5 ? '#0b1020' : 'rgba(232,237,251,0.75)';
          ctx.textAlign = 'center';
          ctx.font = `10px ${T.mono}`;
          ctx.fillText(z.toFixed(1).replace('-', '−'), pad.l + cw * (j + 0.5), pad.t + ch * (c + 0.5));
          ctx.font = `600 10px ${T.mono}`;
        }
      }
    }
  }

  // ------------------------------------------------------------------ analysis tabs
  const cvAn = Lab.canvas('cv-analysis');
  function drawAnalysis() {
    const { ctx, w, h } = cvAn;
    cvAn.clear();
    const legend = Lab.$('#tab-legend');
    if (!model) {
      ctx.fillStyle = T.muted;
      ctx.font = `13px ${T.sans}`;
      ctx.textAlign = 'center';
      ctx.fillText('Calibrate to train a classifier', w / 2, h / 2);
      return;
    }
    if (S.tab === 'space') {
      legend.innerHTML = SHORT.map((n, i) => `<span><i class="box" style="background:${CLASS_COLORS[i]}"></i>${n}</span>`).join('');
      const pts = model.projPts;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const { p } of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      const pad = 26;
      const mx = (x1 - x0) * 0.12;
      const my = (y1 - y0) * 0.12;
      x0 -= mx; x1 += mx; y0 -= my; y1 += my;
      const X = (v) => pad + ((v - x0) / (x1 - x0)) * (w - 2 * pad);
      const Y = (v) => h - pad - ((v - y0) / (y1 - y0)) * (h - 2 * pad);
      ctx.strokeStyle = 'rgba(142,160,216,0.1)';
      ctx.strokeRect(pad + 0.5, pad + 0.5, w - 2 * pad, h - 2 * pad);
      for (const { p, c } of pts) {
        ctx.fillStyle = Lab.alpha(CLASS_COLORS[c], 0.45);
        ctx.beginPath();
        ctx.arc(X(p[0]), Y(p[1]), 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      const cents = Array.from({ length: K }, () => [0, 0, 0]);
      for (const { p, c } of pts) { cents[c][0] += p[0]; cents[c][1] += p[1]; cents[c][2]++; }
      ctx.font = `700 11px ${T.sans}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      cents.forEach(([sx, sy, n], c) => {
        if (!n) return;
        ctx.fillStyle = CLASS_COLORS[c];
        ctx.fillText(SHORT[c], X(sx / n), Y(sy / n) - 14);
      });
      // live trail
      trailPts.forEach((p, i) => {
        const a = (i + 1) / trailPts.length;
        ctx.fillStyle = `rgba(232,237,251,${0.15 + 0.6 * a})`;
        ctx.beginPath();
        ctx.arc(X(M.clamp(p[0], x0, x1)), Y(M.clamp(p[1], y0, y1)), 2 + 3 * a, 0, Math.PI * 2);
        ctx.fill();
      });
      const last = trailPts[trailPts.length - 1];
      if (last) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.shadowColor = '#fff';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(X(M.clamp(last[0], x0, x1)), Y(M.clamp(last[1], y0, y1)), 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      ctx.fillStyle = T.muted;
      ctx.font = `10px ${T.mono}`;
      ctx.textAlign = 'right';
      ctx.fillText('LD1 →', w - pad, h - 10);
      ctx.save();
      ctx.translate(12, pad + 30);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText('LD2 →', 0, 0);
      ctx.restore();
    } else if (S.tab === 'confusion') {
      legend.innerHTML = '<span class="muted">rows: true gesture · columns: decoded (last repetition)</span>';
      const C = model.confusion;
      const pad = { l: 60, t: 34, r: 16, b: 12 };
      const size = Math.min(w - pad.l - pad.r, h - pad.t - pad.b);
      const cs = size / K;
      const ox = pad.l + (w - pad.l - pad.r - size) / 2;
      ctx.font = `600 10.5px ${T.sans}`;
      for (let i = 0; i < K; i++) {
        const rowSum = C[i].reduce((a, b) => a + b, 0) || 1;
        ctx.fillStyle = CLASS_COLORS[i];
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(SHORT[i], ox - 8, pad.t + cs * (i + 0.5));
        ctx.save();
        ctx.translate(ox + cs * (i + 0.5), pad.t - 6);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(SHORT[i], 0, 0);
        ctx.restore();
        for (let j = 0; j < K; j++) {
          const f = C[i][j] / rowSum;
          ctx.fillStyle = i === j ? `rgba(52,211,153,${0.1 + 0.75 * f})` : `rgba(251,113,133,${f > 0 ? 0.15 + 0.8 * f : 0.04})`;
          Lab.roundRect(ctx, ox + cs * j + 2, pad.t + cs * i + 2, cs - 4, cs - 4, 5);
          ctx.fill();
          if (C[i][j]) {
            ctx.fillStyle = '#e8edfb';
            ctx.font = `${cs > 34 ? 11 : 9}px ${T.mono}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${Math.round(f * 100)}`, ox + cs * (j + 0.5), pad.t + cs * (i + 0.5));
            ctx.font = `600 10.5px ${T.sans}`;
          }
        }
      }
    } else {
      legend.innerHTML = '<span><i style="background:#e8edfb"></i>confidence</span><span class="muted">top: intended · bottom: decoded</span>';
      const now = totalSamples / FS;
      const pad = { l: 70, r: 14, t: 16, b: 26 };
      const pw = w - pad.l - pad.r;
      const X = (t) => pad.l + ((t - (now - 15)) / 15) * pw;
      const laneH = Math.min(34, (h - pad.t - pad.b) / 3.2);
      const yI = pad.t + laneH * 0.4;
      const yP = yI + laneH * 1.3;
      ctx.font = `600 11px ${T.sans}`;
      ctx.fillStyle = T.text2;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText('intended', pad.l - 8, yI + laneH / 2);
      ctx.fillText('decoded', pad.l - 8, yP + laneH / 2);
      for (let i = 0; i < history.length; i++) {
        const a = history[i];
        const b = history[i + 1];
        const x0 = X(a.t);
        const x1 = b ? X(b.t) : X(now);
        ctx.fillStyle = CLASS_COLORS[a.intent];
        ctx.fillRect(x0, yI, x1 - x0 + 0.5, laneH);
        ctx.fillStyle = CLASS_COLORS[a.pred];
        ctx.fillRect(x0, yP, x1 - x0 + 0.5, laneH);
        if (a.pred !== a.intent) {
          ctx.fillStyle = 'rgba(251,113,133,0.9)';
          ctx.fillRect(x0, yP + laneH + 3, x1 - x0 + 0.5, 3);
        }
      }
      const yc0 = yP + laneH + 14;
      const yc1 = h - pad.b;
      ctx.strokeStyle = '#e8edfb';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      history.forEach((a, i) => { const y = yc1 - a.conf * (yc1 - yc0); i ? ctx.lineTo(X(a.t), y) : ctx.moveTo(X(a.t), y); });
      ctx.stroke();
      ctx.fillStyle = T.muted;
      ctx.font = `10px ${T.mono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let k = 0; k <= 5; k++) ctx.fillText(`${-15 + k * 3} s`, pad.l + (k / 5) * pw, h - pad.b + 8);
    }
  }

  // ------------------------------------------------------------------ DOM stats
  function updateStats() {
    const acc = Lab.$('#st-acc');
    acc.innerHTML = model ? `${(model.acc * 100).toFixed(1)}<span class="u">%</span>` : '—';
    acc.parentElement.className = 'stat ' + (!model ? '' : model.acc > 0.9 ? 'good' : model.acc > 0.75 ? 'warn' : 'bad');
    const now = totalSamples / FS;
    const rel = history.filter((hh) => hh.t > now - 10 && !transitionAt(hh.t));
    const live = rel.length ? rel.filter((hh) => hh.pred === hh.intent).length / rel.length : NaN;
    const le = Lab.$('#st-live');
    le.innerHTML = Number.isFinite(live) ? `${(live * 100).toFixed(0)}<span class="u">%</span>` : '—';
    le.parentElement.className = 'stat ' + (!Number.isFinite(live) ? '' : live > 0.9 ? 'good' : live > 0.7 ? 'warn' : 'bad');
    const lat = latencies.length ? latencies.slice().sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : NaN;
    Lab.$('#st-lat').innerHTML = Number.isFinite(lat) ? `${lat.toFixed(0)}<span class="u">ms</span>` : '—';
    Lab.$('#st-train').innerHTML = model ? `${model.ms.toFixed(0)}<span class="u">ms</span>` : '—';
    // hand overlay
    Lab.text('pred-label', GESTURES[decision].name);
    Lab.$('#pred-label').style.color = CLASS_COLORS[decision];
    Lab.text('pred-sub', `intended: ${GESTURES[S.intent].name} · effort ${Math.round(level * 100)}%`);
    const chip = Lab.$('#match-chip');
    if (!model) { chip.className = 'chip neutral'; chip.textContent = 'not calibrated'; }
    else if (transitionAt(now)) { chip.className = 'chip neutral'; chip.textContent = 'transition…'; }
    else if (decision === S.intent) { chip.className = 'chip good'; chip.textContent = '✓ decoded correctly'; }
    else { chip.className = 'chip bad'; chip.textContent = '✗ misclassified'; }
    Lab.$('#prob-bars').innerHTML = GESTURES.map((g, i) => `<div class="prob-row"><span style="color:${i === E.argmax(proba) ? CLASS_COLORS[i] : ''}">${g.name}</span><div class="bar"><span style="width:${(proba[i] * 100).toFixed(1)}%;background:${CLASS_COLORS[i]}"></span></div><b>${Math.round(proba[i] * 100)}</b></div>`).join('');
  }
  const transitionAt = (t) => {
    // decisions within 0.4 s after an intent change are not scored
    for (let i = history.length - 1; i > 0; i--) {
      if (history[i].t > t) continue;
      if (history[i].intent !== history[i - 1].intent) return t - history[i].t < 0.4;
      if (t - history[i].t > 0.4) break;
    }
    return t - intentChangedAt < 0.4;
  };

  // ------------------------------------------------------------------ controls
  Lab.$('#gestures').innerHTML = GESTURES.map((g, i) => `<button class="btn${i === 0 ? ' active' : ''}" data-g="${i}" title="${g.name}"><span class="sw" style="background:${CLASS_COLORS[i]}"></span><span class="nm">${g.name}</span><kbd>${i + 1}</kbd></button>`).join('');
  Lab.$$('#gestures button').forEach((b) => b.addEventListener('click', () => { stopDemo(); setIntent(+b.dataset.g); }));
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const k = parseInt(e.key, 10);
    if (k >= 1 && k <= K) { stopDemo(); setIntent(k - 1); }
  });
  function stopDemo() {
    if (!S.demo) return;
    S.demo = false;
    Lab.$('#tg-demo').checked = false;
  }
  Lab.toggle('tg-demo', (v) => { S.demo = v; demoT = 0; });
  Lab.range('sl-effort', { format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => { S.effort = v; syncSim(); } });
  Lab.range('sl-reps', { format: (v) => `${v}`, onInput: (v) => (S.reps = v) });
  Lab.range('sl-hold', { format: (v) => `${v.toFixed(1)} s`, onInput: (v) => (S.hold = v) });
  Lab.$('#btn-calib').addEventListener('click', startGuided);
  Lab.$('#btn-quick').addEventListener('click', () => { instantCalibrate(); Lab.toast(`Calibrated — hold-out accuracy ${(model.acc * 100).toFixed(1)}%`); });
  Lab.seg('seg-clf', (v) => { S.clf = v; train(); });
  Lab.range('sl-vote', { format: (v) => `${v}`, onInput: (v) => (S.vote = v) });
  Lab.range('sl-reject', { format: (v) => v.toFixed(2), onInput: (v) => (S.reject = v) });
  Lab.range('sl-shift', { format: (v) => `${v.toFixed(2)} ch`, onInput: (v) => { S.shift = v; syncSim(); } });
  Lab.range('sl-fatigue', { format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => { S.fatigue = v; syncSim(); } });
  Lab.range('sl-noise', { format: (v) => v.toFixed(3), onInput: (v) => { S.noise = v; syncSim(); } });
  Lab.range('sl-power', { format: (v) => v.toFixed(2), onInput: (v) => { S.power = v; syncSim(); } });
  Lab.toggle('tg-notch', (v) => { S.notch = v; syncSim(); });
  Lab.toggle('tg-motion', (v) => { S.motion = v; syncSim(); });
  Lab.seg('seg-sig', (v) => (S.sig = v));
  const tabSeg = Lab.seg('seg-tab', (v) => (S.tab = v));

  // ------------------------------------------------------------------ main loop
  const DEMO_SEQ = [1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0];
  let demoT = 0;
  let demoI = 0;
  let statT = 0;
  Lab.loop((dt) => {
    const n = Math.max(0, Math.min(100, Math.round(dt * FS)));
    if (S.demo && !calib) {
      demoT += dt;
      if (demoT > (S.intent === 0 ? 0.9 : 1.8)) {
        demoT = 0;
        demoI = (demoI + 1) % DEMO_SEQ.length;
        setIntent(DEMO_SEQ[demoI], true);
      }
    }
    stepGuided(dt);
    pushSamples(n);
    const target = calib && calib.phase === 'hold' ? POSES[calib.steps[calib.i].g] : POSES[decision];
    blendPose(target, Math.min(1, dt * (calib ? 6 : 2.5 + 7 * level)));
    drawEmg();
    drawRing();
    drawFeat();
    drawHand();
    statT += dt;
    if (statT > 0.12) {
      statT = 0;
      updateStats();
      drawAnalysis();
    }
  });

  // ------------------------------------------------------------------ init
  syncSim();
  instantCalibrate();
  updateStats();

  window.MyoHand = {
    state: S,
    setIntent: (g) => { stopDemo(); setIntent(g); },
    tab: (t) => tabSeg.set(t, true),
    calibrate: () => instantCalibrate(),
    set(k, v) { S[k] = v; syncSim(); },
    get model() { return model; },
  };
})();
