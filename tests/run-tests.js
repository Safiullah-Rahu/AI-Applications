#!/usr/bin/env node
/* ==========================================================================
   Zero-dependency test suite for the portfolio's numerical cores.
   Every app keeps its maths in a DOM-free *-core.js module; this file checks
   them against analytic results, brute-force references and finite differences.

   Run:  node tests/run-tests.js            (all)
         node tests/run-tests.js ct mri     (only suites whose name matches)
   ========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const req = (p) => require(path.join(ROOT, p));
global.LabMath = req('shared/js/lab-math.js');
const LM = global.LabMath;

// ------------------------------------------------------------------ tiny harness
const suites = [];
const suite = (name, fn) => suites.push({ name, fn });
class AssertionError extends Error {}
function ok(cond, msg) {
  if (!cond) throw new AssertionError(msg || 'assertion failed');
}
function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new AssertionError(`${msg || 'values differ'}: ${a} vs ${b} (tol ${tol})`);
}
const maxAbsDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

// ================================================================== shared maths
suite('lab-math', (t) => {
  const rng = LM.makeRng(7);
  t('FFT matches a naive DFT', () => {
    const n = 32;
    const re = Float64Array.from({ length: n }, () => rng.gauss());
    const im = Float64Array.from({ length: n }, () => rng.gauss());
    const R = re.slice();
    const I = im.slice();
    LM.fft(R, I);
    let err = 0;
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let j = 0; j < n; j++) {
        const a = (-2 * Math.PI * j * k) / n;
        sr += re[j] * Math.cos(a) - im[j] * Math.sin(a);
        si += re[j] * Math.sin(a) + im[j] * Math.cos(a);
      }
      err = Math.max(err, Math.abs(sr - R[k]), Math.abs(si - I[k]));
    }
    ok(err < 1e-10, `max DFT error ${err}`);
  });
  t('FFT round trip and Parseval', () => {
    const n = 256;
    const re = Float64Array.from({ length: n }, () => rng.gauss());
    const im = new Float64Array(n);
    const R = re.slice();
    const I = im.slice();
    LM.fft(R, I);
    let e1 = 0;
    let e2 = 0;
    for (let k = 0; k < n; k++) { e1 += re[k] ** 2; e2 += R[k] ** 2 + I[k] ** 2; }
    near(e2 / n, e1, 1e-9 * e1, 'Parseval');
    LM.fft(R, I, true);
    ok(maxAbsDiff(R, re) < 1e-12, 'inverse FFT restores the signal');
  });
  t('2-D FFT round trip', () => {
    const w = 16;
    const h = 8;
    const a = Float64Array.from({ length: w * h }, () => rng.gauss());
    const R = a.slice();
    const I = new Float64Array(w * h);
    LM.fft2d(R, I, w, h);
    LM.fft2d(R, I, w, h, true);
    ok(maxAbsDiff(R, a) < 1e-12);
  });
  t('linear solve, inverse and symmetric eigen-decomposition', () => {
    const A = [[3, 2, -1], [2, -2, 4], [-1, 0.5, -1]];
    const x = LM.solve(A, [1, -2, 0]);
    near(x[0], 1, 1e-12); near(x[1], -2, 1e-12); near(x[2], -2, 1e-12);
    const inv = LM.invert([[4, 7], [2, 6]]);
    near(inv[0][0], 0.6, 1e-12); near(inv[0][1], -0.7, 1e-12); near(inv[1][0], -0.2, 1e-12); near(inv[1][1], 0.4, 1e-12);
    const S = [[4, 1, 0.5], [1, 3, 0.2], [0.5, 0.2, 1]];
    const { values, vectors } = LM.eigSym(S);
    for (let k = 0; k < 3; k++) {
      const v = [0, 1, 2].map((i) => vectors[i][k]);
      for (let i = 0; i < 3; i++) near(S[i].reduce((s, sij, j) => s + sij * v[j], 0), values[k] * v[i], 1e-9, 'A v = λ v');
    }
  });
  t('nice axis ticks cover the range', () => {
    const { ticks } = LM.niceTicks(-0.37, 2.9, 6);
    ok(ticks[0] >= -0.37 - 1e-12 && ticks[ticks.length - 1] <= 2.9 + 1e-12, 'ticks inside range');
    const step = ticks[1] - ticks[0];
    ok([0.1, 0.2, 0.25, 0.5, 1, 2, 5].some((s) => Math.abs(step - s) < 1e-12), `step ${step} is a nice number`);
  });
  t('seeded RNG: Gaussian and Poisson moments', () => {
    const r = LM.makeRng(1);
    const g = Array.from({ length: 100000 }, () => r.gauss());
    near(LM.mean(g), 0, 0.02, 'Gaussian mean');
    near(LM.std(g), 1, 0.02, 'Gaussian std');
    const p = Array.from({ length: 20000 }, () => r.poisson(4.5));
    near(LM.mean(p), 4.5, 0.08, 'Poisson mean');
    near(LM.std(p) ** 2, 4.5, 0.25, 'Poisson variance');
    const a = LM.makeRng(42).next();
    ok(a === LM.makeRng(42).next(), 'same seed, same stream');
  });
});

// ================================================================== mechatronics
suite('motor-lab', (t) => {
  const C = req('mechatronics/pid-motor-lab/motor-core.js');
  function sim(mode, g, ref, T = 1.5) {
    const m = new C.DCMotor();
    const pid = new C.PID({ ...g, umax: m.p.Vmax });
    const h = 1e-4;
    const Ts = 0.001;
    let t0 = 0;
    let next = 0;
    let u = 0;
    const ts = [];
    const ys = [];
    while (t0 < T) {
      if (t0 >= next - 1e-12) { u = pid.update(ref, mode === 'position' ? m.th : m.w, Ts); next += Ts; }
      m.step(u, 0, h);
      t0 += h;
      if (Math.round(t0 / h) % 20 === 0) { ts.push(t0); ys.push(mode === 'position' ? m.th : m.w); }
    }
    return { ts, ys, metrics: C.stepMetrics(ts, ys, 0, ref) };
  }
  t('polynomial roots', () => {
    const r = C.polyRoots([1, 6, 11, 6]).map((z) => z[0]).sort((a, b) => b - a);
    near(r[0], -1, 1e-9); near(r[1], -2, 1e-9); near(r[2], -3, 1e-9);
  });
  t('well-tuned PID position loop: fast, little overshoot, integral removes friction offset', () => {
    const { metrics } = sim('position', { kp: 120, ki: 400, kd: 7, tf: 0.0016 }, Math.PI / 2);
    ok(Math.abs(metrics.sse) < 1e-3, `steady-state error ${metrics.sse}`);
    ok(metrics.overshoot < 10, `overshoot ${metrics.overshoot}%`);
    ok(metrics.settle < 0.8, `settling time ${metrics.settle}`);
  });
  t('PI velocity loop tracks a speed step', () => {
    const ref = (250 * 2 * Math.PI) / 60;
    const { ys } = sim('velocity', { kp: 1, ki: 5, kd: 0, tf: 0.0016 }, ref, 2);
    near(ys[ys.length - 1], ref, 0.01 * ref, 'final speed');
  });
  t('stable gains: positive margins and left-half-plane poles', () => {
    const m = new C.DCMotor();
    const g = { kp: 40, ki: 20, kd: 2, tf: 0.0016 };
    const f = C.frequencyResponse(m.p, g, 'position', 0.001);
    ok(f.pm > 30 && f.pm < 90, `phase margin ${f.pm}`);
    ok(f.gm > 6, `gain margin ${f.gm} dB`);
    for (const [re] of C.closedLoopPoles(m.p, g, 'position', 0.001)) ok(re < 0, `pole at ${re}`);
  });
});

suite('arm-studio', (t) => {
  const A = req('mechatronics/robot-arm-studio/arm-core.js');
  const rng = LM.makeRng(3);
  const arm2 = new A.PlanarArm([0.42, 0.34], [[-180, 180], [-170, 170]]);
  const arm3 = new A.PlanarArm([0.36, 0.3, 0.16], [[-180, 180], [-170, 170], [-170, 170]]);
  t('analytic IK inverts forward kinematics (both elbows, 2R and 3R)', () => {
    for (let k = 0; k < 200; k++) {
      const q = [rng.uniform(-Math.PI, Math.PI), rng.uniform(-2.8, 2.8)];
      const ee = arm2.fk(q).pts[2];
      for (const elbow of [1, -1]) {
        const s = arm2.ikAnalytic(ee[0], ee[1], elbow);
        const e2 = arm2.fk(s).pts[2];
        ok(Math.hypot(e2[0] - ee[0], e2[1] - ee[1]) < 1e-9, 'IK solution reaches the target');
      }
      const q3 = [q[0], q[1], rng.uniform(-2, 2)];
      const f3 = arm3.fk(q3);
      const s3 = arm3.ikAnalytic(f3.pts[3][0], f3.pts[3][1], 1, f3.phi);
      const g3 = arm3.fk(s3);
      ok(Math.hypot(g3.pts[3][0] - f3.pts[3][0], g3.pts[3][1] - f3.pts[3][1]) < 1e-9, '3R position');
      near(Math.cos(g3.phi - f3.phi), 1, 1e-9, '3R tool angle');
    }
  });
  t('Jacobian matches finite differences', () => {
    const q = [0.3, -0.8, 0.5];
    const J = arm3.jacobian(q);
    const h = 1e-6;
    for (let i = 0; i < 3; i++) {
      const qp = q.slice(); qp[i] += h;
      const qm = q.slice(); qm[i] -= h;
      const a = arm3.fk(qp).pts[3];
      const b = arm3.fk(qm).pts[3];
      near(J[0][i], (a[0] - b[0]) / (2 * h), 1e-7);
      near(J[1][i], (a[1] - b[1]) / (2 * h), 1e-7);
    }
  });
  t('damped-least-squares IK converges', () => {
    let worst = 0;
    for (let k = 0; k < 50; k++) {
      const q = [rng.uniform(-2, 2), rng.uniform(-2, 2), rng.uniform(-2, 2)];
      const ee = arm3.fk(q).pts[3];
      const { err } = arm3.ikDLS(ee[0], ee[1], [0.1, 0.2, 0.1], { iters: 300 });
      worst = Math.max(worst, err);
    }
    ok(worst < 2e-3, `worst DLS error ${worst}`);
  });
  t('C-space planner returns a collision-free path around an obstacle', () => {
    const world = new A.World([{ type: 'circle', x: 0.42, y: 0.78, r: 0.09 }]);
    const qs = [0.3, 0.9];
    const qg = [1.9, -0.9];
    ok(world.config(arm2, qs) === A.FREE && world.config(arm2, qg) === A.FREE, 'start and goal are free');
    ok(!A.segmentFree(arm2, world, qs, qg), 'the straight joint-space move would collide');
    const plan = A.planPath(arm2, world, qs, qg);
    ok(plan.ok, plan.reason);
    for (let k = 1; k < plan.path.length; k++) ok(A.segmentFree(arm2, world, plan.path[k - 1], plan.path[k]), `segment ${k} is free`);
    near(plan.path[0][0], qs[0], 1e-12);
    near(plan.path[plan.path.length - 1][1], qg[1], 1e-12);
    const traj = A.timeParam(plan.path, 1.5);
    const end = traj.at(traj.T);
    near(end[0], qg[0], 1e-9, 'trajectory ends at the goal');
  });
});

// ================================================================== medical imaging
suite('ct-lab', (t) => {
  const CT = req('medical-imaging/ct-reconstruction-lab/ct-core.js');
  const N = 128;
  const nd = 128;
  const angles = CT.makeAngles(120, 180);
  const disk = [{ type: 'ellipse', v: 1, a: 0.5, b: 0.5, x: 0.1, y: -0.05, rot: 0 }];
  t('analytic projection of a water disk equals the chord length × μ', () => {
    const p = CT.projectAnalytic(disk, angles, nd);
    const expected = 2 * 0.5 * (CT.FOV / 2) * CT.MU_WATER;
    near(Math.max(...p), expected, 0.01 * expected, 'peak line integral');
  });
  t('analytic and ray-driven numeric projectors agree', () => {
    const p = CT.projectAnalytic(disk, angles, nd);
    const pn = CT.projectNumeric(CT.rasterize(disk, 256), 256, angles, nd);
    ok(maxAbsDiff(p, pn) < 0.06, `max difference ${maxAbsDiff(p, pn)}`);
  });
  t('filtered back-projection recovers μ inside and zero outside', () => {
    const p = CT.projectAnalytic(disk, angles, nd);
    const filt = CT.makeFilter(nd, CT.FOV / nd, 'ramlak', 1, LM.fft);
    const rec = CT.fbp(p, angles, nd, N, filt, LM.fft, Math.PI);
    const cx = Math.round(((0.1 + 1) / 2) * N);
    const cy = Math.round(((1 + 0.05) / 2) * N);
    let s = 0;
    let n = 0;
    for (let j = cy - 5; j < cy + 5; j++) for (let i = cx - 5; i < cx + 5; i++) { s += rec[j * N + i]; n++; }
    near(s / n, CT.MU_WATER, 0.03 * CT.MU_WATER, 'μ at the disk centre');
    let so = 0;
    n = 0;
    for (let j = 8; j < 18; j++) for (let i = 58; i < 70; i++) { so += rec[j * N + i]; n++; }
    near(so / n, 0, 0.01, 'μ outside the object');
  });
  t('SART iterations reduce the error on sparse views', () => {
    const shapes = CT.PHANTOMS.thorax.shapes();
    const truth = CT.rasterize(shapes, N);
    const mask = CT.fovMask(N);
    const a2 = CT.makeAngles(30, 180);
    const ps = CT.projectAnalytic(shapes, a2, nd);
    const setup = CT.sartSetup(a2, nd, N, 10);
    const x = new Float32Array(N * N);
    const hu = (arr) => Array.from(arr, CT.toHU);
    CT.sartIteration(x, ps, a2, setup, 0.9);
    const e1 = LM.rmse(hu(truth), hu(x), mask);
    for (let it = 0; it < 9; it++) CT.sartIteration(x, ps, a2, setup, 0.9);
    const e10 = LM.rmse(hu(truth), hu(x), mask);
    ok(e10 < 0.7 * e1, `RMSE ${e1.toFixed(1)} → ${e10.toFixed(1)} HU`);
  });
});

suite('mri-explorer', (t) => {
  const MR = req('medical-imaging/mri-kspace-explorer/mri-core.js');
  const N = 256; // the app's matrix size
  const brain = MR.makeBrain(N, { lesion: true });
  const img = MR.synthesize(brain, { type: 'SE', TR: 4000, TE: 100 });
  const truth = MR.magnitude(img);
  const k = MR.fftc(img.re, img.im, N);
  const nrmse = (a) => {
    let num = 0;
    let den = 0;
    for (let p = 0; p < N * N; p++) { num += (a[p] - truth[p]) ** 2; den += truth[p] ** 2; }
    return Math.sqrt(num / den);
  };
  t('centred FFT round trip', () => {
    const back = MR.ifftc(k.re, k.im, N);
    ok(maxAbsDiff(back.re, img.re) < 1e-9 && maxAbsDiff(back.im, img.im) < 1e-9);
  });
  t('tissue contrast follows the signal equations', () => {
    const t1 = MR.synthesize(brain, { type: 'SE', TR: 500, TE: 15 }).signals;
    const t2 = MR.synthesize(brain, { type: 'SE', TR: 4000, TE: 100 }).signals;
    const I = MR.IDX;
    ok(t1[I.wm] > t1[I.csf], 'T1-weighted: white matter brighter than CSF');
    ok(t2[I.csf] > t2[I.wm], 'T2-weighted: CSF brighter than white matter');
    const flair = MR.synthesize(brain, { type: 'IR', TR: 9000, TE: 120, TI: 2370 }).signals;
    ok(Math.abs(flair[I.csf]) < 0.2 * Math.abs(flair[I.gm]), 'FLAIR nulls CSF');
  });
  t('Haar wavelet transform is perfectly invertible', () => {
    const y = Float64Array.from(truth);
    MR.haar2(y, N, 4, false);
    MR.haar2(y, N, 4, true);
    ok(maxAbsDiff(y, truth) < 1e-9);
  });
  t('compressed sensing beats zero-filling at 30 % sampling', () => {
    const { mask } = MR.makeMask(N, 'random', { frac: 0.3 }, LM.makeRng(5));
    const km = MR.applyMask(k, mask);
    const zf = nrmse(MR.magnitude(MR.ifftc(km.re, km.im, N)));
    const f = MR.fistaCS(km, mask, N, 0.002);
    for (let it = 0; it < 40; it++) f.step();
    const cs = nrmse(MR.magnitude(f.x));
    ok(cs < 0.8 * zf, `NRMSE zero-filled ${zf.toFixed(3)} vs CS ${cs.toFixed(3)}`);
  });
  t('POCS partial-Fourier improves on zero-filling', () => {
    const { mask } = MR.makeMask(N, 'pf', { pf: 0.625 }, LM.makeRng(1));
    const kp = MR.applyMask(k, mask);
    const zf = nrmse(MR.magnitude(MR.ifftc(kp.re, kp.im, N)));
    const po = MR.pocsPF(kp, mask, N);
    for (let it = 0; it < 10; it++) po.step();
    ok(nrmse(MR.magnitude(po.x)) < zf, 'POCS error below zero-filled error');
  });
});

// ================================================================== assistive robotics
suite('navichair', (t) => {
  const NV = req('assistive-robotics/smart-wheelchair-navigator/nav-core.js');
  const rng = LM.makeRng(11);
  t('Euclidean distance transform equals brute force', () => {
    const w = 37;
    const h = 23;
    const occ = Uint8Array.from({ length: w * h }, () => (rng.next() < 0.06 ? 1 : 0));
    const d = NV.distanceTransform(occ, w, h);
    const pts = [];
    occ.forEach((v, k) => v && pts.push([k % w, Math.floor(k / w)]));
    let err = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        let b = Infinity;
        for (const [x, y] of pts) b = Math.min(b, Math.hypot(i - x, j - y));
        err = Math.max(err, Math.abs(b - d[j * w + i]));
      }
    }
    ok(err < 1e-5, `max EDT error ${err}`);
  });
  t('LIDAR ray cast hits a wall at the right range', () => {
    const g = NV.GridMap.fromRects(10, 6, 0.05, [{ x0: 7, y0: 0, x1: 7.2, y1: 6 }]);
    near(g.raycast(2, 3, 0, 20), 5, 0.051, 'range to the wall');
    near(g.raycast(2, 3, Math.PI, 20), 2, 0.051, 'range to the map edge');
  });
  t('A* routes around a wall through the gap', () => {
    const g = NV.GridMap.fromRects(8, 6, 0.1, [{ x0: 3.9, y0: 0, x1: 4.1, y1: 4.8 }]);
    const dist = NV.distanceTransform(g.data, g.w, g.h);
    const cost = NV.buildCostmap(dist, g.res, 0.3);
    const res = NV.astar(cost, g.w, g.h, [10, 10], [70, 10]);
    ok(res.path, 'a path exists');
    for (const [i, j] of res.path) ok(Number.isFinite(cost[j * g.w + i]), 'path stays in free space');
    const maxY = Math.max(...res.path.map(([, j]) => j));
    ok(maxY * g.res > 4.8, 'path goes through the gap above the wall');
  });
});

suite('myohand', (t) => {
  const E = req('assistive-robotics/emg-prosthetic-hand/emg-core.js');
  t('biquad low-pass: unity DC gain, strong stop-band attenuation', () => {
    const gain = (f) => {
      const bq = new E.Biquad('lowpass', 50);
      let peak = 0;
      for (let n = 0; n < 4000; n++) {
        const y = bq.process(Math.sin((2 * Math.PI * f * n) / E.FS));
        if (n > 3000) peak = Math.max(peak, Math.abs(y));
      }
      return peak;
    };
    near(gain(1), 1, 0.01, 'pass band');
    ok(gain(400) < 0.03, 'stop band');
  });
  t('gesture classifiers generalise to held-out EMG windows', () => {
    const sim = new E.EMGSimulator(4);
    const cond = new E.Conditioner();
    const X = [];
    const y = [];
    const tt = [];
    for (let g = 0; g < E.GESTURES.length; g++) {
      sim.setIntent(g);
      cond.process(sim.generate(400));
      const total = 3000;
      const f = cond.process(sim.generate(total));
      for (let s = 200; s <= total; s += 50) {
        X.push(Array.from(E.features(f.map((ch) => ch.subarray(s - 200, s)))));
        y.push(g);
        tt.push(s / total);
      }
    }
    const tr = [];
    const te = [];
    X.forEach((_, i) => (tt[i] > 0.75 ? te : tr).push(i));
    const sc = E.fitScaler(tr.map((i) => X[i]));
    const K = E.GESTURES.length;
    const Xtr = tr.map((i) => sc.apply(X[i]));
    const ytr = tr.map((i) => y[i]);
    for (const [name, model, min] of [['LDA', new E.LDA(), 0.85], ['k-NN', new E.KNN(5), 0.75]]) {
      model.fit(Xtr, ytr, K);
      const acc = te.filter((i) => E.argmax(model.predictProba(sc.apply(X[i]))) === y[i]).length / te.length;
      ok(acc > min, `${name} accuracy ${(acc * 100).toFixed(1)} %`);
    }
  });
});

// ================================================================== AI
suite('neuro-playground', (t) => {
  const NN = req('ai/neural-network-playground/nn-core.js');
  t('back-propagation matches finite-difference gradients', () => {
    for (const act of ['tanh', 'sigmoid', 'gelu']) {
      const net = new NN.Network([3, 5, 4, 1], act, 5);
      const X = [[0.3, -0.7, 0.2], [-0.5, 0.1, 0.9], [0.8, 0.4, -0.3]];
      const y = [1, 0, 1];
      const loss = () => X.reduce((s, x, n) => { const p = net.predict(x); return s - (y[n] * Math.log(p) + (1 - y[n]) * Math.log(1 - p)); }, 0) / X.length;
      // analytic gradient recovered from one plain SGD step with lr = 1, then restore every parameter
      const W0 = net.W.map((w) => Float64Array.from(w));
      const b0 = net.b.map((b) => Float64Array.from(b));
      net.trainBatch(X, y, [0, 1, 2], { type: 'sgd', lr: 1, l2: 0 });
      const grad = net.W.map((w, l) => Float64Array.from(w, (v, k) => W0[l][k] - v));
      net.W.forEach((w, l) => w.set(W0[l]));
      net.b.forEach((b, l) => b.set(b0[l]));
      let worst = 0;
      for (let l = 0; l < net.L; l++) {
        for (let k = 0; k < net.W[l].length; k += 3) {
          const h = 1e-6;
          const v = net.W[l][k];
          net.W[l][k] = v + h;
          const lp = loss();
          net.W[l][k] = v - h;
          const lm = loss();
          net.W[l][k] = v;
          const fd = (lp - lm) / (2 * h);
          worst = Math.max(worst, Math.abs(fd - grad[l][k]) / Math.max(1e-6, Math.abs(fd) + Math.abs(grad[l][k])));
        }
      }
      ok(worst < 1e-5, `${act}: worst relative gradient error ${worst.toExponential(2)}`);
    }
  });
  t('a small MLP learns XOR', () => {
    const pts = NN.makeDataset('xor', 200, 0.05, 3);
    const X = pts.map((p) => [p.x, p.y]);
    const y = pts.map((p) => p.c);
    const net = new NN.Network([2, 8, 8, 1], 'tanh', 2);
    const rng = LM.makeRng(4);
    const idx = X.map((_, i) => i);
    for (let e = 0; e < 150; e++) {
      rng.shuffle(idx);
      for (let s = 0; s < idx.length; s += 16) net.trainBatch(X, y, idx.slice(s, s + 16), { type: 'adam', lr: 0.02, l2: 0 });
    }
    const { acc } = net.evaluate(X, y);
    ok(acc > 0.95, `XOR accuracy ${(acc * 100).toFixed(1)} %`);
  });
});

suite('evodrive', (t) => {
  const E = req('ai/neuroevolution-cars/evo-core.js');
  const topo = E.topology(8);
  const opts = { topo, maxLaps: 3, timeLimit: 60, stallTime: 2.5 };
  t('grid ray casting equals brute force over every wall segment', () => {
    const track = E.makeTrack(3);
    const rng = LM.makeRng(9);
    const S = track.segs;
    let worst = 0;
    for (let q = 0; q < 3000; q++) {
      const i = rng.int(track.n);
      const off = rng.uniform(-0.9, 0.9) * track.halfWidth;
      const x = track.pts[i][0] + track.nor[i][0] * off;
      const y = track.pts[i][1] + track.nor[i][1] * off;
      const a = rng.uniform(0, 2 * Math.PI);
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      let brute = 170;
      for (let k = 0; k < S.length / 4; k++) {
        const o = k * 4;
        const ex = S[o + 2] - S[o];
        const ey = S[o + 3] - S[o + 1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const wx = S[o] - x;
        const wy = S[o + 1] - y;
        const tt = (wx * ey - wy * ex) / den;
        const u = (wx * dy - wy * dx) / den;
        if (tt >= 0 && tt < brute && u >= 0 && u <= 1) brute = tt;
      }
      worst = Math.max(worst, Math.abs(E.castRay(track, x, y, dx, dy, 170) - brute));
    }
    ok(worst < 1e-9, `max ray error ${worst}`);
  });
  t('generated tracks are deterministic and always drivable', () => {
    const a = E.makeTrack(21, { halfWidth: 28, wiggle: 0.6 });
    const b = E.makeTrack(21, { halfWidth: 28, wiggle: 0.6 });
    ok(maxAbsDiff(a.segs, b.segs) === 0, 'same seed, same track');
    for (const [hw, wig] of [[22, 0.7], [30, 0.45], [40, 0.7], [36, 0.1]]) {
      for (let seed = 1; seed <= 25; seed++) {
        const tr = E.makeTrack(seed, { halfWidth: hw, wiggle: wig });
        let maxK = 0;
        for (const k of tr.curv) maxK = Math.max(maxK, Math.abs(k));
        ok(1 / maxK >= 1.29 * hw, `seed ${seed}: corner radius ${(1 / maxK).toFixed(1)} too tight for width ${hw}`);
        for (const p of [...tr.left, ...tr.right]) ok(p[0] > 0 && p[1] > 0 && p[0] < E.WORLD.w && p[1] < E.WORLD.h, 'inside the world');
      }
    }
  });
  t('the genetic algorithm improves the population', () => {
    const track = E.makeTrack(14);
    const rng = LM.makeRng(8 * 7919);
    let genomes = Array.from({ length: 40 }, () => E.randomGenome(rng, topo));
    let first = 0;
    let last = 0;
    for (let gen = 1; gen <= 20; gen++) {
      const cars = E.runGeneration(track, genomes, opts);
      const best = Math.max(...cars.map((c) => c.fitness));
      if (gen === 1) first = best;
      last = best;
      genomes = E.nextGeneration(cars, rng, { elite: 4, mutRate: 0.08, mutSigma: 0.25 });
    }
    ok(last > first + 100, `best fitness ${first.toFixed(0)} → ${last.toFixed(0)}`);
  });
  t('the shipped pre-trained driver laps unseen tracks', () => {
    const ctx = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'ai/neuroevolution-cars/pretrained.js'), 'utf8'), ctx);
    const P = ctx.window.EVO_PRETRAINED;
    ok(P.genome.length === E.genomeLength(E.topology(P.hidden)), 'genome size matches the topology');
    let finished = 0;
    for (let seed = 700; seed < 710; seed++) {
      const [car] = E.runGeneration(E.makeTrack(seed), [Float64Array.from(P.genome)], { ...opts, topo: E.topology(P.hidden) });
      if (car.finished) finished++;
    }
    ok(finished >= 9, `finished ${finished}/10 unseen tracks`);
  });
});

// ================================================================== agentic systems & research methods
suite('metalab', (t) => {
  const MC = req('agentic-research/metalab/meta-core.js');
  t('distribution functions match reference values', () => {
    near(MC.normCdf(1.959963984540054), 0.975, 1e-13);
    near(MC.normCdf(-1), 0.15865525393145707, 1e-13);
    near(MC.normInv(0.975), 1.959963984540054, 1e-12);
    near(MC.tInv(0.975, 10), 2.228138851986273, 1e-9);
    near(MC.tCdf(2.228138851986273, 10), 0.975, 1e-10);
    near(MC.chi2Cdf(18.307038053275146, 10), 0.95, 1e-10);
    near(MC.nctCdf(1.5, 10, 0), MC.tCdf(1.5, 10), 1e-8, 'non-central t with δ = 0 equals central t');
  });
  t('BCG meta-analysis reproduces metafor (FE, DL, REML)', () => {
    const y = MC.BCG.map((s) => s.yi);
    const v = MC.BCG.map((s) => s.vi);
    const fe = MC.metaAnalyze(y, v, { method: 'FE' });
    near(fe.mu, -0.4303, 5e-4, 'fixed-effect estimate');
    near(fe.Q, 152.233, 1e-2, 'Cochran Q');
    const dl = MC.metaAnalyze(y, v, { method: 'DL' });
    near(dl.tau2, 0.3088, 5e-4, 'DL τ²');
    const re = MC.metaAnalyze(y, v, { method: 'REML' });
    near(re.mu, -0.7145, 5e-4, 'REML estimate');
    near(re.tau2, 0.3132, 5e-4, 'REML τ²');
    near(re.I2 * 100, 92.22, 0.05, 'I²');
    near(re.se, 0.1798, 5e-4, 'SE');
  });
  t('power and sample size match G*Power', () => {
    near(MC.power('two', 0.5, 64), 0.8015, 1e-3);
    near(MC.power('two', 0.8, 20), 0.6934, 1e-3);
    ok(MC.requiredN('two', 0.5) === 64, 'd = .5 → 64 per group');
    ok(MC.requiredN('one', 0.5) === 34, 'paired d = .5 → 34');
    ok(MC.requiredN('corr', 0.3) === 85, 'r = .3 → 85');
  });
  t('Monte Carlo power agrees with the analytic value', () => {
    const sims = MC.simulateExperiments(0.5, 40, 4000, LM.makeRng(21));
    const emp = sims.filter((s) => s.p < 0.05).length / sims.length;
    near(emp, MC.power('two', 0.5, 40), 0.03, 'empirical power');
  });
  t('publication bias inflates estimates; trim-and-fill and PET correct towards the truth', () => {
    const lit = MC.simulateLiterature({ delta: 0.15, tau: 0.05, attempts: 300, pubNonSig: 0.05, hacking: 1, seed: 4 });
    const pub = lit.filter((s) => s.published);
    const y = pub.map((s) => s.yi);
    const v = pub.map((s) => s.vi);
    const naive = MC.metaAnalyze(y, v).mu;
    ok(naive > 0.25, `naive estimate ${naive.toFixed(3)} is inflated`);
    const tf = MC.trimAndFill(y, v, { side: 'left' });
    ok(tf.k0 > 0 && tf.adjusted.mu < naive, `trim-and-fill adds ${tf.k0} studies and lowers the estimate`);
    ok(MC.eggerTest(y, v).p < 0.05, "Egger's test detects the asymmetry");
    ok(Math.abs(MC.petEstimate(y, v).estimate - 0.15) < Math.abs(naive - 0.15), 'PET is closer to the truth');
  });
});

suite('agentflow', (t) => {
  const AF = req('agentic-research/agentflow/agent-core.js');
  t('event queue pops in time order (FIFO on ties)', () => {
    const q = new AF.EventQueue();
    const out = [];
    const rng = LM.makeRng(2);
    for (let i = 0; i < 500; i++) { const tt = Math.floor(rng.next() * 50); q.push(tt, () => out.push([tt, i])); }
    let prev = [-1, -1];
    while (q.size) { q.pop().fn(); const cur = out[out.length - 1]; ok(cur[0] > prev[0] || (cur[0] === prev[0] && cur[1] > prev[1]), 'ordered'); prev = cur; }
  });
  t('presets are valid DAGs; cycles are rejected', () => {
    for (const k of Object.keys(AF.PRESETS)) ok(AF.validate(AF.preset(k)).length === 0, `${k} is valid`);
    const wf = AF.preset('debate');
    wf.edges.push({ from: 'judge', to: 'pro' });
    ok(AF.validate(wf).some((e) => /cycle/.test(e)), 'cycle detected');
  });
  t('retry policy matches the analytic success probability', () => {
    const wf = {
      nodes: [{ id: 's', type: 'start', label: 's', x: 0, y: 0 }, { id: 'a', type: 'tool', label: 'flaky', latency: 1, spread: 0.2, fail: 0.3, x: 1, y: 0 }, { id: 'e', type: 'end', label: 'e', x: 2, y: 0 }],
      edges: [{ from: 's', to: 'a' }, { from: 'a', to: 'e' }],
    };
    for (const r of [0, 1, 3]) {
      const mc = AF.monteCarlo(wf, { retries: r, fallback: false }, 6000, 5);
      near(mc.success, 1 - 0.3 ** (r + 1), 0.015, `success with ${r} retries`);
    }
  });
  t('simulation is deterministic per seed and critical-path shares sum to 1', () => {
    const a = AF.monteCarlo(AF.preset('research'), {}, 300, 9);
    const b = AF.monteCarlo(AF.preset('research'), {}, 300, 9);
    ok(a.p50 === b.p50 && a.meanCost === b.meanCost, 'same seed, same result');
    near(Object.values(a.critShare).reduce((s, x) => s + x, 0), 1, 1e-9, 'shares');
  });
  t('a concurrency limit of 1 serialises parallel agents', () => {
    const wide = AF.monteCarlo(AF.preset('debate'), { concurrency: 8 }, 800, 3);
    const one = AF.monteCarlo(AF.preset('debate'), { concurrency: 1 }, 800, 3);
    ok(one.p50 > wide.p50 * 1.3, `p50 ${wide.p50.toFixed(1)} s → ${one.p50.toFixed(1)} s`);
  });
  t('routers skip untaken branches and joins still complete', () => {
    const rng = LM.makeRng(4);
    for (let i = 0; i < 200; i++) {
      const r = AF.runWorkflow(AF.preset('support'), { retries: 3 }, rng);
      if (!r.ok) continue;
      const taken = ['billing', 'kbs', 'human'].filter((id) => r.nodeStart[id] != null);
      ok(taken.length === 1, 'exactly one branch runs');
      ok(r.nodeEnd.guard != null, 'the join after the router runs');
    }
  });
});

// ================================================================== health & energy
suite('voltwise', (t) => {
  const B = req('health-energy/battery-bms/bms-core.js');
  t('OCV curve: monotone PCHIP through the data points, invertible', () => {
    B.OCV_SOC.forEach((z, i) => near(B.OCV.f(z), B.OCV_V[i], 1e-12, 'interpolates nodes'));
    for (let z = 0; z < 1; z += 0.001) ok(B.OCV.f(z + 0.001) > B.OCV.f(z), 'monotone');
    for (const z of [0.07, 0.33, 0.61, 0.94]) near(B.socFromOcv(B.OCV.f(z)), z, 1e-9, 'inverse');
    near(B.OCV.df(0.5), (B.OCV.f(0.5 + 1e-6) - B.OCV.f(0.5 - 1e-6)) / 2e-6, 1e-5, 'derivative');
  });
  t('coulomb counting with ideal sensors tracks true SOC exactly', () => {
    const c = B.makeCell({ ...B.CELL }, 0.8, 25);
    const cc = new B.CoulombCounter(0.8, B.CELL.Q);
    for (let k = 0; k < 1800; k++) { const I = 60 * Math.sin(k / 40) + 40; B.stepCell(c, I, 1, 25); cc.update(I, 1); }
    near(cc.z, c.z, 1e-12);
  });
  t('EKF recovers from a 20-point wrong start; coulomb counting cannot', () => {
    const r = B.simulateDrive({ cycle: 'city', seconds: 2400, soc0: 0.8, socGuess: 0.6, seed: 4 });
    const ekf = B.rmse(r.ekf, r.trueSoc, 600);
    const cc = B.rmse(r.cc, r.trueSoc, 600);
    ok(ekf < 0.02, `EKF RMSE ${(ekf * 100).toFixed(2)} %`);
    ok(cc > 0.15, `coulomb counting RMSE ${(cc * 100).toFixed(1)} %`);
  });
  t('bias-augmented EKF learns the current-sensor offset', () => {
    const r = B.simulateDrive({ cycle: 'highway', seconds: 3600, soc0: 0.9, socGuess: 0.9, seed: 5, sensor: { offset: 2, gainErr: 0 } });
    near(r.ekfBias, 2, 0.8, 'estimated offset (A)');
  });
  t('passive balancing shrinks the cell SOC spread', () => {
    const run = (balance) => {
      const pack = B.makePack({ nSeries: 12, socSpread: 0.03, seed: 2 });
      for (let k = 0; k < 4 * 3600; k++) B.stepPack(pack, 0, 1, 25, { balance, bleedA: 1 });
      const z = pack.cells.map((c) => c.z);
      return Math.max(...z) - Math.min(...z);
    };
    const off = run(false);
    const on = run(true);
    ok(on < off * 0.6, `spread ${(off * 100).toFixed(2)} % → ${(on * 100).toFixed(2)} %`);
  });
});

suite('fallguard', (t) => {
  const Fg = req('health-energy/fallguard/fall-core.js');
  const lab = Fg.makeDataset('lab', { seed: 1, perFall: 30, perAdl: 30 });
  const real = Fg.makeDataset('real', { seed: 2, perFall: 30, perAdl: 30 });
  const ev = (ds, mode, p) => Fg.evaluate(ds, (e) => Fg.detectRules(e, mode, p).alarms);
  t('simulated falls have a hard impact and end lying down; daily activities stay upright', () => {
    const rng = LM.makeRng(3);
    const f = Fg.makeEvent('fallForward', rng, 'lab');
    let peak = 0;
    for (let i = 0; i < f.n; i++) peak = Math.max(peak, f.m[i]);
    ok(peak > 2.5, `impact peak ${peak.toFixed(2)} g`);
    ok(Math.abs(f.y[f.n - 1]) < 0.6, 'final posture is horizontal');
    const w = Fg.makeEvent('walk', rng, 'lab');
    ok(w.y[w.n - 1] > 0.9, 'walking ends upright');
  });
  t('real-world falls are harder to detect than lab falls (every rule algorithm)', () => {
    for (const mode of ['threshold', 'posture', 'fsm']) {
      const a = ev(lab, mode).sensitivity;
      const b = ev(real, mode).sensitivity;
      ok(b < a, `${mode}: lab ${(a * 100).toFixed(0)} % vs real ${(b * 100).toFixed(0)} %`);
    }
  });
  t('posture and stillness checks cut false alarms of a bare impact threshold', () => {
    const thr = ev(real, 'threshold').faPerDay;
    const pos = ev(real, 'posture').faPerDay;
    ok(thr > 3 && pos < thr / 4, `false alarms/day ${thr.toFixed(1)} → ${pos.toFixed(1)}`);
  });
  t('lowering the impact threshold trades false alarms for sensitivity', () => {
    const hi = ev(real, 'threshold', { impact: 3 });
    const lo = ev(real, 'threshold', { impact: 1.6 });
    ok(lo.sensitivity > hi.sensitivity && lo.faPerDay > hi.faPerDay, 'monotone trade-off');
  });
  t('the learned detector beats the state machine on real-world falls', () => {
    const tr = Fg.trainingSet(Fg.makeDataset('real', { seed: 10, perFall: 30, perAdl: 30 }));
    const model = Fg.trainLogistic(tr.X, tr.y);
    const ml = Fg.evaluate(real, (e) => Fg.detectML(e, model).alarms);
    const fsm = ev(real, 'fsm');
    ok(ml.sensitivity > fsm.sensitivity + 0.3 && ml.faPerDay < 2, `ML ${(ml.sensitivity * 100).toFixed(0)} % @ ${ml.faPerDay.toFixed(2)}/day vs FSM ${(fsm.sensitivity * 100).toFixed(0)} %`);
  });
});

// ------------------------------------------------------------------ runner
(async () => {
  const filters = process.argv.slice(2);
  let pass = 0;
  let fail = 0;
  const t0 = Date.now();
  for (const s of suites) {
    if (filters.length && !filters.some((f) => s.name.includes(f))) continue;
    const tests = [];
    s.fn((name, fn) => tests.push({ name, fn }));
    console.log(`\n${s.name}`);
    for (const tc of tests) {
      const ts = Date.now();
      try {
        await tc.fn();
        pass++;
        console.log(`  ✓ ${tc.name} \x1b[2m(${Date.now() - ts} ms)\x1b[0m`);
      } catch (e) {
        fail++;
        console.log(`  ✗ ${tc.name}\n      ${e instanceof AssertionError ? e.message : e.stack}`);
      }
    }
  }
  console.log(`\n${pass} passed, ${fail} failed \x1b[2m(${((Date.now() - t0) / 1000).toFixed(1)} s)\x1b[0m`);
  process.exit(fail ? 1 : 0);
})();
