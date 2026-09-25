/* ==========================================================================
   FallGuard core — tri-axial accelerometer signal synthesis for activities of
   daily living and falls (young "lab" volunteers vs. real-world older adults),
   fall-detection algorithms (impact threshold, impact + posture, full state
   machine, logistic regression) and evaluation in sensitivity and false alarms
   per day. No DOM — unit-testable in Node.
   ========================================================================== */
(function (root, factory) {
  const api = factory(root.LabMath || (typeof require === 'function' ? require('../../shared/js/lab-math.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FallCore = api;
})(typeof self !== 'undefined' ? self : this, function (LM) {
  'use strict';

  const FS = 50; // Hz, waist-worn sensor; axes: x forward, y up (vertical when upright), z lateral
  const D2R = Math.PI / 180;

  /**
   * Population profiles. "lab" = young volunteers simulating falls onto mats (what most papers test on);
   * "real" = older adults' real falls: slower descents, weak or absent free-fall, softer impacts.
   */
  const PROFILES = {
    lab: { name: 'Lab — simulated falls (young volunteers)', ffMin: [0.1, 0.45], ffDur: [0.3, 0.55], ffProb: 0.95, impact: [3.0, 6.5], slowShare: 0.05, gaitAmp: 1, gaitF: 1.9 },
    real: { name: 'Real world — older adults', ffMin: [0.35, 0.85], ffDur: [0.2, 0.6], ffProb: 0.55, impact: [1.5, 3.8], slowShare: 0.3, gaitAmp: 0.7, gaitF: 1.6 },
  };
  const ADL = {
    walk: { name: 'Walking', perDay: 80 },
    stairs: { name: 'Walking downstairs', perDay: 6 },
    sitHard: { name: 'Sitting down heavily', perDay: 25 },
    standUp: { name: 'Standing up', perDay: 25 },
    pickUp: { name: 'Bending to pick up', perDay: 20 },
    lieBed: { name: 'Lying down in bed', perDay: 2 },
    stumble: { name: 'Stumble, recovered', perDay: 3 },
    jog: { name: 'Jogging / hurrying', perDay: 0 },
  };
  const FALLS = {
    fallForward: { name: 'Forward fall', dir: [1, 0, 0], end: [-80, 0] },
    fallBackward: { name: 'Backward fall', dir: [-1, 0, 0], end: [80, 0] },
    fallSide: { name: 'Sideways fall', dir: [0, 0, 1], end: [0, 85] },
    fallSlow: { name: 'Slow collapse (e.g. syncope)', dir: [0.5, 0, 0.5], end: [-60, 30], slow: true },
  };

  /** Specific force of gravity in the sensor frame for body pitch θ (forward +) and roll φ (degrees). */
  const gravity = (pitch, roll) => [Math.sin(pitch * D2R), Math.cos(pitch * D2R) * Math.cos(roll * D2R), Math.cos(pitch * D2R) * Math.sin(roll * D2R)];

  class Signal {
    constructor() { this.x = []; this.y = []; this.z = []; this.pitch = 0; this.roll = 0; }
    get n() { return this.x.length; }
    push(a) { this.x.push(a[0]); this.y.push(a[1]); this.z.push(a[2]); }
    /** Hold a posture for `sec` seconds with sensor noise and optional gait. */
    hold(sec, rng, { noise = 0.015, gait = 0, f = 1.8 } = {}) {
      const N = Math.round(sec * FS);
      const ph = rng.uniform(0, 6.28);
      for (let i = 0; i < N; i++) {
        const t = i / FS;
        const g = gravity(this.pitch, this.roll);
        const w = 2 * Math.PI * f * t + ph;
        this.push([
          g[0] + gait * 0.13 * Math.sin(w + 1) + rng.gauss(0, noise),
          g[1] + gait * (0.28 * Math.sin(w) + 0.1 * Math.sin(2 * w + 0.5)) + rng.gauss(0, noise),
          g[2] + gait * 0.08 * Math.sin(w / 2) + rng.gauss(0, noise),
        ]);
      }
    }
    /** Smoothly rotate to a new posture over `sec` seconds, optionally scaling the gravity magnitude (free-fall). */
    rotate(pitch, roll, sec, rng, { gscale = null, noise = 0.02 } = {}) {
      const N = Math.max(1, Math.round(sec * FS));
      const p0 = this.pitch;
      const r0 = this.roll;
      for (let i = 1; i <= N; i++) {
        const u = i / N;
        const s = u * u * (3 - 2 * u);
        this.pitch = p0 + (pitch - p0) * s;
        this.roll = r0 + (roll - r0) * s;
        const g = gravity(this.pitch, this.roll);
        const k = gscale ? gscale(u) : 1;
        this.push([g[0] * k + rng.gauss(0, noise), g[1] * k + rng.gauss(0, noise), g[2] * k + rng.gauss(0, noise)]);
      }
    }
    /** Impact transient: damped oscillation of peak magnitude ≈ peak (g) along dir, added to the current posture. */
    impact(peak, dir, rng, sec = 0.3) {
      const N = Math.round(sec * FS);
      const n = Math.hypot(...dir) || 1;
      const d = dir.map((v) => v / n);
      const f = rng.uniform(8, 14);
      const g = gravity(this.pitch, this.roll);
      const mix0 = d.map((v, k) => 0.7 * v + (k === 1 ? 0.5 : 0));
      const mn = Math.hypot(...mix0) || 1;
      const mix = mix0.map((v) => v / mn);
      // amplitude so that the first sample's magnitude |g + e·m| equals the requested peak
      const gm = g[0] * mix[0] + g[1] * mix[1] + g[2] * mix[2];
      const e0 = -gm + Math.sqrt(Math.max(0, gm * gm - 1 + peak * peak));
      for (let i = 0; i < N; i++) {
        const t = i / FS;
        const env = e0 * Math.exp(-t / 0.045) * Math.cos(2 * Math.PI * f * t);
        this.push([g[0] + env * mix[0] + rng.gauss(0, 0.04), g[1] + env * mix[1] + rng.gauss(0, 0.04), g[2] + env * mix[2] + rng.gauss(0, 0.04)]);
      }
    }
  }

  /** One labelled recording: 3 s standing context, the activity, then ~6 s aftermath. */
  function makeEvent(kind, rng, profileKey = 'lab') {
    const P = PROFILES[profileKey];
    const s = new Signal();
    const gaitF = P.gaitF * rng.uniform(0.9, 1.1);
    s.hold(3, rng);
    let impactIdx = -1;
    const isFall = !!FALLS[kind];
    if (isFall) {
      const F = FALLS[kind];
      const slow = F.slow || rng.next() < P.slowShare;
      if (rng.next() < 0.5) s.hold(rng.uniform(1, 2.5), rng, { gait: P.gaitAmp, f: gaitF });
      const hasFF = !slow && rng.next() < P.ffProb;
      const ffMin = rng.uniform(P.ffMin[0], P.ffMin[1]);
      const ffDur = slow ? rng.uniform(1.0, 2.0) : rng.uniform(P.ffDur[0], P.ffDur[1]);
      const endP = F.end[0] + rng.gauss(0, 8);
      const endR = F.end[1] + rng.gauss(0, 8);
      s.rotate(endP * 0.7, endR * 0.7, ffDur, rng, { gscale: hasFF ? (u) => 1 - (1 - ffMin) * Math.sin(Math.PI * Math.min(1, u * 1.1)) : (u) => 1 - 0.25 * Math.sin(Math.PI * u) });
      s.pitch = endP;
      s.roll = endR;
      impactIdx = s.n;
      const peak = slow ? rng.uniform(1.25, 2.0) : Math.exp(rng.uniform(Math.log(P.impact[0]), Math.log(P.impact[1])));
      s.impact(peak, F.dir.map((v) => v + rng.gauss(0, 0.2)), rng);
      // aftermath: most people lie still; some move or get up again
      const r = rng.next();
      if (r < 0.7) s.hold(6, rng, { noise: 0.02 });
      else if (r < 0.9) s.hold(6, rng, { noise: 0.09 });
      else { s.hold(2, rng, { noise: 0.05 }); s.rotate(0, 0, 2.5, rng, { noise: 0.08 }); s.hold(1.5, rng); }
    } else {
      switch (kind) {
        case 'walk': s.hold(8, rng, { gait: P.gaitAmp, f: gaitF }); break;
        case 'jog': {
          const N = 6 * FS;
          const f = 2.7;
          const ph = rng.uniform(0, 6.28);
          for (let i = 0; i < N; i++) {
            const w = 2 * Math.PI * f * (i / FS) + ph;
            const strike = Math.max(0, Math.cos(w)) ** 12 * rng.uniform(0.9, 1.5);
            s.push([0.3 * Math.sin(w + 1) + rng.gauss(0, 0.05), 1 + 0.55 * Math.sin(w) + strike + rng.gauss(0, 0.05), 0.15 * Math.sin(w / 2) + rng.gauss(0, 0.05)]);
          }
          break;
        }
        case 'stairs': {
          const N = 6 * FS;
          const f = 1.5;
          for (let i = 0; i < N; i++) {
            const w = 2 * Math.PI * f * (i / FS);
            const strike = Math.max(0, Math.cos(w)) ** 16 * rng.uniform(0.5, 1.05);
            s.push([0.12 * Math.sin(w + 1) + rng.gauss(0, 0.03), 1 + 0.25 * Math.sin(w) + strike + rng.gauss(0, 0.03), 0.08 * Math.sin(w / 2) + rng.gauss(0, 0.03)]);
          }
          break;
        }
        case 'sitHard':
          s.rotate(25, 0, 0.8, rng);
          s.rotate(20, 0, 0.3, rng, { gscale: (u) => 1 - 0.35 * Math.sin(Math.PI * u) });
          impactIdx = s.n;
          s.impact(rng.uniform(1.4, 2.6), [0, -1, 0], rng, 0.25);
          s.hold(5, rng);
          break;
        case 'standUp':
          s.pitch = 20;
          s.hold(1.5, rng);
          s.rotate(35, 0, 0.6, rng);
          s.rotate(0, 0, 0.9, rng, { gscale: (u) => 1 + 0.35 * Math.sin(Math.PI * u) });
          s.hold(4, rng);
          break;
        case 'pickUp':
          s.rotate(rng.uniform(55, 80), 0, 1.3, rng);
          s.hold(1, rng, { noise: 0.04 });
          s.rotate(0, 0, 1.3, rng);
          s.hold(3, rng);
          break;
        case 'lieBed':
          s.pitch = 20;
          s.hold(1, rng);
          s.rotate(-80, rng.uniform(-15, 15), 2.5, rng);
          impactIdx = s.n;
          s.impact(rng.uniform(1.3, 2.9), [-1, 0, 0], rng, 0.2); // flopping onto the bed can hit like a fall
          s.hold(6, rng);
          break;
        case 'stumble':
          s.hold(1.5, rng, { gait: P.gaitAmp, f: gaitF });
          s.rotate(15, rng.uniform(-10, 10), 0.2, rng, { gscale: (u) => 1 - 0.5 * Math.sin(Math.PI * u) });
          impactIdx = s.n;
          s.impact(rng.uniform(1.7, 2.9), [1, 0, 0], rng, 0.25);
          s.rotate(0, 0, 0.5, rng);
          s.hold(4, rng, { gait: P.gaitAmp, f: gaitF });
          break;
        default:
          throw new Error('unknown activity ' + kind);
      }
    }
    s.hold(1, rng, { noise: s.pitch === 0 && s.roll === 0 ? 0.015 : 0.02 });
    const m = new Float32Array(s.n);
    for (let i = 0; i < s.n; i++) m[i] = Math.hypot(s.x[i], s.y[i], s.z[i]);
    return { kind, isFall, x: Float32Array.from(s.x), y: Float32Array.from(s.y), z: Float32Array.from(s.z), m, impactIdx, n: s.n };
  }

  const svm = (ev, i) => (ev.m ? ev.m[i] : Math.hypot(ev.x[i], ev.y[i], ev.z[i]));

  // ------------------------------------------------------------------ detectors
  const DEFAULT_PARAMS = { impact: 2.0, freefall: 0.65, ffWindow: 1.0, posture: 50, stillStd: 0.12, requireFreefall: true, requirePosture: true, requireStill: true };

  /**
   * Streaming rule-based detector. mode: 'threshold' (impact only), 'posture' (impact + posture + stillness),
   * 'fsm' (free-fall → impact → posture → stillness). Returns alarm sample indices and the state trace.
   */
  function detectRules(ev, mode, params = {}) {
    const p = { ...DEFAULT_PARAMS, ...params };
    const alarms = [];
    const states = new Uint8Array(ev.n); // 0 idle, 1 free-fall, 2 impact → checking, 3 alarm
    let lastFF = -1e9;
    let pending = -1;
    let refractory = -1;
    const gWin = Math.round(1 * FS);
    for (let i = 0; i < ev.n; i++) {
      const a = svm(ev, i);
      if (a < p.freefall) lastFF = i;
      if (pending < 0 && i > refractory && a > p.impact) {
        const ffOk = mode !== 'fsm' || !p.requireFreefall || i - lastFF <= p.ffWindow * FS;
        if (mode === 'threshold') { alarms.push(i); refractory = i + 5 * FS; }
        else if (ffOk) pending = i;
      }
      if (pending >= 0) {
        states[i] = 2;
        // decide 2.5 s after the impact: posture from the mean gravity vector, stillness from SVM spread
        if (i - pending >= 2.5 * FS + gWin) {
          let mx = 0, my = 0, mz = 0, s1 = 0, s2 = 0;
          for (let k = i - gWin; k < i; k++) { mx += ev.x[k]; my += ev.y[k]; mz += ev.z[k]; const v = svm(ev, k); s1 += v; s2 += v * v; }
          const angle = Math.acos(Math.max(-1, Math.min(1, my / Math.hypot(mx, my, mz)))) / D2R;
          const std = Math.sqrt(Math.max(0, s2 / gWin - (s1 / gWin) ** 2));
          const postureOk = !p.requirePosture || angle > p.posture;
          const stillOk = !p.requireStill || std < p.stillStd;
          if (postureOk && stillOk) { alarms.push(i); states[i] = 3; refractory = i + 5 * FS; }
          pending = -1;
        }
      } else if (i - lastFF < 3 && a < p.freefall) states[i] = 1;
    }
    return { alarms, states };
  }

  // ------------------------------------------------------------------ learned detector
  const FEATURE_NAMES = ['peak |a|', 'pre-impact min |a|', 'time below 0.8 g', 'orientation change', 'post-impact motion', 'final uprightness'];
  /** Features of a window around a candidate peak at index c (1.5 s before, 4 s after). */
  function features(ev, c) {
    const pre0 = Math.max(0, c - Math.round(1.5 * FS));
    const post0 = Math.min(ev.n - 1, c + Math.round(2 * FS));
    const post1 = Math.min(ev.n, c + Math.round(4 * FS));
    let peak = 0;
    for (let i = c; i < Math.min(ev.n, c + 10); i++) peak = Math.max(peak, svm(ev, i));
    let mn = 9;
    let low = 0;
    for (let i = pre0; i < c; i++) { const v = svm(ev, i); mn = Math.min(mn, v); if (v < 0.8) low++; }
    const mean = (a, b) => {
      let x = 0, y = 0, z = 0;
      for (let i = a; i < b; i++) { x += ev.x[i]; y += ev.y[i]; z += ev.z[i]; }
      const n = Math.hypot(x, y, z) || 1;
      return [x / n, y / n, z / n];
    };
    const g0 = mean(Math.max(0, pre0 - FS), pre0 + 1);
    const g1 = mean(post0, post1);
    const change = Math.acos(Math.max(-1, Math.min(1, g0[0] * g1[0] + g0[1] * g1[1] + g0[2] * g1[2]))) / D2R;
    let s1 = 0, s2 = 0;
    for (let i = post0; i < post1; i++) { const v = svm(ev, i); s1 += v; s2 += v * v; }
    const n = Math.max(1, post1 - post0);
    const std = Math.sqrt(Math.max(0, s2 / n - (s1 / n) ** 2));
    return [peak, mn, low / FS, change / 90, std, g1[1]];
  }
  /** Candidate peaks: local maxima above minPeak, at least 2 s apart. */
  function candidates(ev, minPeak = 1.5) {
    const out = [];
    let last = -1e9;
    for (let i = 1; i < ev.n - 1; i++) {
      const v = svm(ev, i);
      if (v > minPeak && v >= svm(ev, i - 1) && v >= svm(ev, i + 1) && i - last > 2 * FS) { out.push(i); last = i; }
    }
    return out;
  }
  /** L2-regularised logistic regression trained with full-batch gradient descent on z-scored features. */
  function trainLogistic(X, y, { epochs = 600, lr = 0.5, l2 = 1e-3 } = {}) {
    const d = X[0].length;
    const mu = new Array(d).fill(0);
    const sd = new Array(d).fill(0);
    X.forEach((x) => x.forEach((v, j) => (mu[j] += v / X.length)));
    X.forEach((x) => x.forEach((v, j) => (sd[j] += (v - mu[j]) ** 2 / X.length)));
    for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
    const Z = X.map((x) => x.map((v, j) => (v - mu[j]) / sd[j]));
    const w = new Array(d).fill(0);
    let b = 0;
    const pos = y.reduce((s, v) => s + v, 0);
    const wPos = y.length / (2 * Math.max(1, pos));
    const wNeg = y.length / (2 * Math.max(1, y.length - pos));
    for (let e = 0; e < epochs; e++) {
      const gw = new Array(d).fill(0);
      let gb = 0;
      Z.forEach((z, i) => {
        const pr = 1 / (1 + Math.exp(-(b + z.reduce((s, v, j) => s + v * w[j], 0))));
        const err = (pr - y[i]) * (y[i] ? wPos : wNeg);
        gb += err;
        z.forEach((v, j) => (gw[j] += err * v));
      });
      b -= (lr * gb) / Z.length;
      for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / Z.length + l2 * w[j]);
    }
    return { w, b, mu, sd, prob: (x) => 1 / (1 + Math.exp(-(b + x.reduce((s, v, j) => s + ((v - mu[j]) / sd[j]) * w[j], 0)))) };
  }
  function detectML(ev, model, thr = 0.5) {
    const alarms = [];
    const scores = [];
    for (const c of candidates(ev)) {
      const pr = model.prob(features(ev, c));
      scores.push({ i: c, p: pr });
      if (pr > thr) alarms.push(c + Math.round(2.5 * FS));
    }
    return { alarms, scores };
  }

  // ------------------------------------------------------------------ datasets & evaluation
  /** Balanced benchmark: `perFall` recordings of each fall type and `perAdl` of each daily activity. */
  function makeDataset(profileKey, { perFall = 40, perAdl = 40, seed = 1, includeJog = false } = {}) {
    const rng = LM.makeRng(seed);
    const events = [];
    for (const k of Object.keys(FALLS)) for (let i = 0; i < perFall; i++) events.push(makeEvent(k, rng, profileKey));
    for (const k of Object.keys(ADL)) {
      if (k === 'jog' && !includeJog) continue;
      for (let i = 0; i < perAdl; i++) events.push(makeEvent(k, rng, profileKey));
    }
    return events;
  }
  function trainingSet(events) {
    const X = [];
    const y = [];
    for (const ev of events) {
      for (const c of candidates(ev)) {
        X.push(features(ev, c));
        y.push(ev.isFall && Math.abs(c - ev.impactIdx) < FS ? 1 : 0);
      }
    }
    return { X, y };
  }
  /**
   * Sensitivity (share of falls alarmed within 6 s of impact) and false alarms per day
   * (per-activity alarm rate × how often each activity happens in a day of an older adult).
   */
  function evaluate(events, detect) {
    let falls = 0;
    let hits = 0;
    const adlRate = {};
    const adlN = {};
    for (const ev of events) {
      const alarms = detect(ev);
      if (ev.isFall) {
        falls++;
        if (alarms.some((a) => a >= ev.impactIdx - FS && a <= ev.impactIdx + 6 * FS)) hits++;
      } else {
        adlN[ev.kind] = (adlN[ev.kind] || 0) + 1;
        adlRate[ev.kind] = (adlRate[ev.kind] || 0) + (alarms.length ? 1 : 0);
      }
    }
    let faPerDay = 0;
    const perActivity = {};
    for (const k of Object.keys(adlN)) {
      const r = adlRate[k] / adlN[k];
      perActivity[k] = r;
      faPerDay += r * ADL[k].perDay;
    }
    return { sensitivity: hits / Math.max(1, falls), faPerDay, perActivity, falls, hits };
  }

  return { FS, PROFILES, ADL, FALLS, DEFAULT_PARAMS, FEATURE_NAMES, gravity, makeEvent, svm, detectRules, features, candidates, trainLogistic, detectML, makeDataset, trainingSet, evaluate };
});
