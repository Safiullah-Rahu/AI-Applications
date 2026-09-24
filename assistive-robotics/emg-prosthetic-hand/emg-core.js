/* ==========================================================================
   MyoHand core — surface-EMG simulation, filtering, time-domain features and
   pattern-recognition classifiers (LDA, k-NN, MLP). No DOM — unit-testable.
   ========================================================================== */
(function (root, factory) {
  const api = factory(root.LabMath || (typeof require === 'function' ? require('../../shared/js/lab-math.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EMGCore = api;
})(typeof self !== 'undefined' ? self : this, function (LM) {
  'use strict';

  const FS = 1000; // sampling rate [Hz]
  const NCH = 8; // electrodes around the forearm

  /**
   * Gesture → muscle-synergy activation of the 8 electrode sites (0 = anterior/radial flexors … 4 = ulnar,
   * 4–6 = posterior extensors, 7 = radial / thumb muscles). Values are fractions of maximal contraction.
   */
  const GESTURES = [
    { key: 'rest', name: 'Rest', pattern: [0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03] },
    { key: 'fist', name: 'Power grip', pattern: [0.75, 0.9, 0.8, 0.55, 0.35, 0.3, 0.3, 0.45] },
    { key: 'open', name: 'Hand open', pattern: [0.22, 0.18, 0.2, 0.2, 0.9, 0.95, 0.55, 0.45] },
    { key: 'pinch', name: 'Tripod pinch', pattern: [0.6, 0.45, 0.3, 0.15, 0.3, 0.2, 0.25, 0.75] },
    { key: 'point', name: 'Point', pattern: [0.35, 0.65, 0.7, 0.45, 0.3, 0.6, 0.2, 0.25] },
    { key: 'flex', name: 'Wrist flexion', pattern: [0.85, 0.6, 0.5, 0.85, 0.15, 0.1, 0.1, 0.35] },
    { key: 'ext', name: 'Wrist extension', pattern: [0.12, 0.08, 0.12, 0.35, 0.45, 0.7, 1.0, 0.85] },
  ];

  // ------------------------------------------------------------------ biquad filters (RBJ cookbook)
  class Biquad {
    constructor(type, f0, Q = Math.SQRT1_2, fs = FS) {
      this.set(type, f0, Q, fs);
      this.x1 = this.x2 = this.y1 = this.y2 = 0;
    }
    set(type, f0, Q = Math.SQRT1_2, fs = FS) {
      const w0 = (2 * Math.PI * f0) / fs;
      const c = Math.cos(w0);
      const s = Math.sin(w0);
      const alpha = s / (2 * Q);
      let b0, b1, b2, a0, a1, a2;
      if (type === 'lowpass') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
      else if (type === 'highpass') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
      else if (type === 'notch') { b0 = 1; b1 = -2 * c; b2 = 1; }
      else throw new Error('unknown filter ' + type);
      a0 = 1 + alpha;
      a1 = -2 * c;
      a2 = 1 - alpha;
      this.b0 = b0 / a0;
      this.b1 = b1 / a0;
      this.b2 = b2 / a0;
      this.a1 = a1 / a0;
      this.a2 = a2 / a0;
    }
    process(x) {
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      return y;
    }
  }

  // ------------------------------------------------------------------ EMG simulator
  /**
   * Band-limited Gaussian noise amplitude-modulated by smooth muscle activation per channel, plus
   * electrode noise, 50 Hz powerline interference and optional motion artefacts. Fatigue shifts the
   * spectrum to lower frequencies (a known EMG fatigue signature) and raises amplitude; electrode shift
   * rotates the armband relative to the muscles.
   */
  class EMGSimulator {
    constructor(seed = 1) {
      this.rng = LM.makeRng(seed);
      this.cfg = { noise: 0.02, powerline: 0, fatigue: 0, shift: 0, effort: 0.7, motion: false, variability: 0.28, repVar: 0.14, effortVar: 0.3 };
      this.intent = 0;
      this.perturb = new Float64Array(NCH).fill(1);
      this.act = new Float64Array(NCH).fill(0.03);
      this.gain = Array.from({ length: NCH }, () => 0.85 + 0.3 * this.rng.next());
      this.slow = new Float64Array(NCH);
      this.hp = Array.from({ length: NCH }, () => new Biquad('highpass', 30));
      this.lp = Array.from({ length: NCH }, () => new Biquad('lowpass', 150));
      this.lp2 = Array.from({ length: NCH }, () => new Biquad('lowpass', 150));
      this.t = 0;
      this.artefact = 0;
      this._fc = 150;
    }
    /** Start a new contraction; every repetition recruits the muscles slightly differently. */
    setIntent(g) {
      this.intent = g;
      // overall contraction strength also differs between repetitions
      const global = Math.exp(this.rng.gauss(0, this.cfg.effortVar));
      for (let c = 0; c < NCH; c++) this.perturb[c] = global * Math.exp(this.rng.gauss(0, this.cfg.repVar));
    }
    /** Target activation at each electrode after armband rotation (circular linear interpolation). */
    target() {
      const p = GESTURES[this.intent].pattern;
      const out = new Float64Array(NCH);
      const lvl = this.intent === 0 ? 1 : this.cfg.effort / 0.7;
      for (let c = 0; c < NCH; c++) {
        const pos = (((c - this.cfg.shift) % NCH) + NCH) % NCH;
        const i0 = Math.floor(pos);
        const f = pos - i0;
        out[c] = (p[i0] * (1 - f) + p[(i0 + 1) % NCH] * f) * lvl * this.perturb[c];
      }
      return out;
    }
    generate(n) {
      const out = Array.from({ length: NCH }, () => new Float32Array(n));
      const fc = 150 - 70 * this.cfg.fatigue;
      if (Math.abs(fc - this._fc) > 0.5) {
        this._fc = fc;
        for (let c = 0; c < NCH; c++) { this.lp[c].set('lowpass', fc); this.lp2[c].set('lowpass', fc); }
      }
      const tgt = this.target();
      const kAct = 1 - Math.exp(-1 / (FS * 0.07)); // ~70 ms activation dynamics
      const kSlow = 1 - Math.exp(-1 / (FS * 0.35));
      const amp = 1 + 0.35 * this.cfg.fatigue;
      for (let s = 0; s < n; s++) {
        this.t += 1 / FS;
        if (this.cfg.motion && this.rng.next() < 0.0006) this.artefact = this.rng.uniform(-1, 1) * 0.6;
        this.artefact *= 0.995;
        for (let c = 0; c < NCH; c++) {
          this.slow[c] += (this.rng.gauss(0, 1) - this.slow[c]) * kSlow;
          const a = Math.max(0, tgt[c] * (1 + this.cfg.variability * 2.2 * this.slow[c]));
          this.act[c] += (a - this.act[c]) * kAct;
          // shape white noise into an EMG-like spectrum (≈ 30 – fc Hz)
          let v = this.hp[c].process(this.rng.gauss(0, 1));
          v = this.lp2[c].process(this.lp[c].process(v));
          let x = v * this.act[c] * this.gain[c] * amp * 1.6;
          x += this.rng.gauss(0, this.cfg.noise);
          x += this.cfg.powerline * Math.sin(2 * Math.PI * 50 * this.t + c * 0.4);
          x += this.artefact * (c % 2 ? 1 : 0.7);
          out[c][s] = x;
        }
      }
      return out;
    }
  }

  // ------------------------------------------------------------------ processing chain
  /** Per-channel conditioning: 20 Hz high-pass (removes drift / motion) + optional 50 Hz notch. */
  class Conditioner {
    constructor() {
      this.hp = Array.from({ length: NCH }, () => new Biquad('highpass', 20));
      this.notch = Array.from({ length: NCH }, () => new Biquad('notch', 50, 8));
      this.useNotch = true;
    }
    process(block) {
      const n = block[0].length;
      const out = Array.from({ length: NCH }, () => new Float32Array(n));
      for (let c = 0; c < NCH; c++) {
        for (let s = 0; s < n; s++) {
          let v = this.hp[c].process(block[c][s]);
          const vn = this.notch[c].process(v);
          if (this.useNotch) v = vn;
          out[c][s] = v;
        }
      }
      return out;
    }
  }

  const FEATURE_NAMES = ['MAV', 'WL', 'ZC', 'SSC'];
  /**
   * Hudgins time-domain features per channel: mean absolute value, waveform length,
   * zero crossings and slope-sign changes (with a small dead-band threshold).
   * win: array of per-channel Float32Array windows. Returns Float64Array(NCH × 4).
   */
  function features(win, thr = 0.01) {
    const f = new Float64Array(NCH * 4);
    for (let c = 0; c < NCH; c++) {
      const x = win[c];
      const n = x.length;
      let mav = 0;
      let wl = 0;
      let zc = 0;
      let ssc = 0;
      for (let i = 0; i < n; i++) {
        mav += Math.abs(x[i]);
        if (i > 0) {
          wl += Math.abs(x[i] - x[i - 1]);
          if (x[i] * x[i - 1] < 0 && Math.abs(x[i] - x[i - 1]) >= thr) zc++;
        }
        if (i > 0 && i < n - 1) {
          const d1 = x[i] - x[i - 1];
          const d2 = x[i] - x[i + 1];
          if (d1 * d2 > 0 && (Math.abs(d1) >= thr || Math.abs(d2) >= thr)) ssc++;
        }
      }
      f[c * 4] = mav / n;
      f[c * 4 + 1] = wl / n;
      f[c * 4 + 2] = zc / n;
      f[c * 4 + 3] = ssc / n;
    }
    return f;
  }

  // ------------------------------------------------------------------ standardisation
  function fitScaler(X) {
    const d = X[0].length;
    const mu = new Float64Array(d);
    const sd = new Float64Array(d);
    for (const x of X) for (let j = 0; j < d; j++) mu[j] += x[j] / X.length;
    for (const x of X) for (let j = 0; j < d; j++) sd[j] += (x[j] - mu[j]) ** 2 / X.length;
    for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
    return { mu, sd, apply: (x) => Float64Array.from(x, (v, j) => (v - mu[j]) / sd[j]) };
  }
  const softmax = (z) => {
    const m = Math.max(...z);
    const e = z.map((v) => Math.exp(v - m));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((v) => v / s);
  };

  // ------------------------------------------------------------------ classifiers
  /** Linear discriminant analysis with pooled, shrinkage-regularised covariance. */
  class LDA {
    fit(X, y, K) {
      const d = X[0].length;
      const mu = Array.from({ length: K }, () => new Float64Array(d));
      const cnt = new Array(K).fill(0);
      X.forEach((x, i) => { cnt[y[i]]++; for (let j = 0; j < d; j++) mu[y[i]][j] += x[j]; });
      mu.forEach((m, k) => { for (let j = 0; j < d; j++) m[j] /= Math.max(1, cnt[k]); });
      const S = Array.from({ length: d }, () => new Float64Array(d));
      X.forEach((x, i) => {
        const m = mu[y[i]];
        for (let a = 0; a < d; a++) {
          const da = x[a] - m[a];
          for (let b = a; b < d; b++) S[a][b] += da * (x[b] - m[b]);
        }
      });
      let tr = 0;
      for (let a = 0; a < d; a++) {
        for (let b = a; b < d; b++) { S[a][b] /= X.length - K; S[b][a] = S[a][b]; }
        tr += S[a][a];
      }
      const lam = 0.05 * (tr / d);
      for (let a = 0; a < d; a++) S[a][a] += lam;
      const Si = LM.invert(S.map((r) => Array.from(r)));
      this.W = mu.map((m) => Si.map((row) => row.reduce((s, v, j) => s + v * m[j], 0)));
      this.b = mu.map((m, k) => -0.5 * this.W[k].reduce((s, v, j) => s + v * m[j], 0) + Math.log(Math.max(1, cnt[k]) / X.length));
      this.mu = mu;
      this.S = S;
      return this;
    }
    predictProba(x) {
      return softmax(this.W.map((w, k) => w.reduce((s, v, j) => s + v * x[j], this.b[k])));
    }
  }

  /** k-nearest neighbours (Euclidean, standardised features). */
  class KNN {
    constructor(k = 5) { this.k = k; }
    fit(X, y, K) { this.X = X; this.y = y; this.K = K; return this; }
    predictProba(x) {
      const best = [];
      for (let i = 0; i < this.X.length; i++) {
        let d = 0;
        const xi = this.X[i];
        for (let j = 0; j < x.length; j++) d += (xi[j] - x[j]) ** 2;
        if (best.length < this.k) { best.push([d, this.y[i]]); best.sort((a, b) => a[0] - b[0]); }
        else if (d < best[this.k - 1][0]) { best[this.k - 1] = [d, this.y[i]]; best.sort((a, b) => a[0] - b[0]); }
      }
      const p = new Array(this.K).fill(0);
      for (const [, c] of best) p[c] += 1 / best.length;
      return p;
    }
  }

  /** One-hidden-layer perceptron (tanh), softmax output, cross-entropy, Adam + L2. */
  class MLP {
    constructor({ hidden = 24, epochs = 70, lr = 0.01, l2 = 1e-4, seed = 3 } = {}) {
      Object.assign(this, { hidden, epochs, lr, l2 });
      this.rng = LM.makeRng(seed);
    }
    fit(X, y, K) {
      const d = X[0].length;
      const H = this.hidden;
      const rng = this.rng;
      const init = (n, fan) => Float64Array.from({ length: n }, () => rng.gauss(0, Math.sqrt(1 / fan)));
      this.W1 = init(H * d, d);
      this.b1 = new Float64Array(H);
      this.W2 = init(K * H, H);
      this.b2 = new Float64Array(K);
      this.K = K;
      this.d = d;
      const params = [this.W1, this.b1, this.W2, this.b2];
      const m = params.map((p) => new Float64Array(p.length));
      const v = params.map((p) => new Float64Array(p.length));
      const grads = params.map((p) => new Float64Array(p.length));
      let step = 0;
      const idx = Array.from({ length: X.length }, (_, i) => i);
      const h = new Float64Array(H);
      const bs = 32;
      this.loss = [];
      for (let ep = 0; ep < this.epochs; ep++) {
        rng.shuffle(idx);
        let L = 0;
        for (let s = 0; s < idx.length; s += bs) {
          grads.forEach((g) => g.fill(0));
          const batch = idx.slice(s, s + bs);
          for (const i of batch) {
            const x = X[i];
            for (let a = 0; a < H; a++) {
              let z = this.b1[a];
              for (let j = 0; j < d; j++) z += this.W1[a * d + j] * x[j];
              h[a] = Math.tanh(z);
            }
            const zo = new Array(K);
            for (let k = 0; k < K; k++) {
              let z = this.b2[k];
              for (let a = 0; a < H; a++) z += this.W2[k * H + a] * h[a];
              zo[k] = z;
            }
            const p = softmax(zo);
            L -= Math.log(Math.max(1e-12, p[y[i]]));
            const dz = p.map((pk, k) => pk - (k === y[i] ? 1 : 0));
            for (let k = 0; k < K; k++) {
              grads[3][k] += dz[k];
              for (let a = 0; a < H; a++) grads[2][k * H + a] += dz[k] * h[a];
            }
            for (let a = 0; a < H; a++) {
              let g = 0;
              for (let k = 0; k < K; k++) g += dz[k] * this.W2[k * H + a];
              g *= 1 - h[a] * h[a];
              grads[1][a] += g;
              for (let j = 0; j < d; j++) grads[0][a * d + j] += g * x[j];
            }
          }
          step++;
          const b1c = 1 - 0.9 ** step;
          const b2c = 1 - 0.999 ** step;
          params.forEach((P, pi) => {
            const G = grads[pi];
            for (let q = 0; q < P.length; q++) {
              const g = G[q] / batch.length + (pi % 2 === 0 ? this.l2 * P[q] : 0);
              m[pi][q] = 0.9 * m[pi][q] + 0.1 * g;
              v[pi][q] = 0.999 * v[pi][q] + 0.001 * g * g;
              P[q] -= (this.lr * (m[pi][q] / b1c)) / (Math.sqrt(v[pi][q] / b2c) + 1e-8);
            }
          });
        }
        this.loss.push(L / X.length);
      }
      return this;
    }
    predictProba(x) {
      const { d, K } = this;
      const H = this.hidden;
      const h = new Float64Array(H);
      for (let a = 0; a < H; a++) {
        let z = this.b1[a];
        for (let j = 0; j < d; j++) z += this.W1[a * d + j] * x[j];
        h[a] = Math.tanh(z);
      }
      const zo = new Array(K);
      for (let k = 0; k < K; k++) {
        let z = this.b2[k];
        for (let a = 0; a < H; a++) z += this.W2[k * H + a] * h[a];
        zo[k] = z;
      }
      return softmax(zo);
    }
  }

  function argmax(p) {
    let b = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[b]) b = i;
    return b;
  }
  function confusion(yTrue, yPred, K) {
    const C = Array.from({ length: K }, () => new Array(K).fill(0));
    yTrue.forEach((t, i) => C[t][yPred[i]]++);
    return C;
  }

  /**
   * Two most discriminant directions (Fisher LDA): solve S_b v = λ S_w v via Cholesky whitening.
   * Returns a function projecting a standardised feature vector to 2-D.
   */
  function fisherProjection(X, y, K) {
    const d = X[0].length;
    const mean = new Float64Array(d);
    X.forEach((x) => { for (let j = 0; j < d; j++) mean[j] += x[j] / X.length; });
    const lda = new LDA().fit(X, y, K);
    const Sw = lda.S.map((r) => Array.from(r));
    const Sb = Array.from({ length: d }, () => new Array(d).fill(0));
    const cnt = new Array(K).fill(0);
    y.forEach((c) => cnt[c]++);
    lda.mu.forEach((m, k) => {
      for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) Sb[a][b] += cnt[k] * (m[a] - mean[a]) * (m[b] - mean[b]);
    });
    // Cholesky Sw = L Lᵀ
    const L = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < d; i++) {
      for (let j = 0; j <= i; j++) {
        let s = Sw[i][j];
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
      }
    }
    const Li = LM.invert(L);
    const A = LM.matmul(LM.matmul(Li, Sb), LM.transpose(Li));
    for (let a = 0; a < d; a++) for (let b = a + 1; b < d; b++) { const s = (A[a][b] + A[b][a]) / 2; A[a][b] = A[b][a] = s; }
    const { vectors } = LM.eigSym(A);
    const LiT = LM.transpose(Li);
    const dirs = [0, 1].map((c) => LiT.map((row) => row.reduce((s, v, j) => s + v * vectors[j][c], 0)));
    return (x) => dirs.map((v) => v.reduce((s, vj, j) => s + vj * (x[j] - mean[j]), 0));
  }

  return { FS, NCH, GESTURES, FEATURE_NAMES, Biquad, EMGSimulator, Conditioner, features, fitScaler, softmax, LDA, KNN, MLP, argmax, confusion, fisherProjection };
});
