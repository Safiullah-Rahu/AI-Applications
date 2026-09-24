/* ==========================================================================
   NeuroPlayground core — a small, dependency-free multilayer perceptron with
   back-propagation, several activations and optimisers, plus 2-D datasets.
   No DOM — unit-testable.
   ========================================================================== */
(function (root, factory) {
  const api = factory(root.LabMath || (typeof require === 'function' ? require('../../shared/js/lab-math.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NNCore = api;
})(typeof self !== 'undefined' ? self : this, function (LM) {
  'use strict';

  // ------------------------------------------------------------------ activations (value, derivative wrt pre-activation)
  const SQ2PI = Math.sqrt(2 / Math.PI);
  const ACT = {
    relu: { f: (z) => (z > 0 ? z : 0), d: (z) => (z > 0 ? 1 : 0), init: 'he' },
    leaky: { f: (z) => (z > 0 ? z : 0.05 * z), d: (z) => (z > 0 ? 1 : 0.05), init: 'he' },
    tanh: { f: Math.tanh, d: (z) => 1 - Math.tanh(z) ** 2, init: 'xavier' },
    sigmoid: { f: (z) => 1 / (1 + Math.exp(-z)), d: (z) => { const s = 1 / (1 + Math.exp(-z)); return s * (1 - s); }, init: 'xavier' },
    gelu: {
      f: (z) => 0.5 * z * (1 + Math.tanh(SQ2PI * (z + 0.044715 * z * z * z))),
      d: (z) => {
        const u = SQ2PI * (z + 0.044715 * z * z * z);
        const t = Math.tanh(u);
        return 0.5 * (1 + t) + 0.5 * z * (1 - t * t) * SQ2PI * (1 + 3 * 0.044715 * z * z);
      },
      init: 'he',
    },
  };
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));

  // ------------------------------------------------------------------ network
  class Network {
    /**
     * sizes: [nIn, h1, …, hk, 1] — binary classifier with a sigmoid output unit.
     */
    constructor(sizes, act = 'tanh', seed = 1) {
      this.sizes = sizes.slice();
      this.act = act;
      this.rng = LM.makeRng(seed);
      this.L = sizes.length - 1; // number of weight layers
      this.W = [];
      this.b = [];
      for (let l = 0; l < this.L; l++) {
        const nIn = sizes[l];
        const nOut = sizes[l + 1];
        const isOut = l === this.L - 1;
        const scheme = isOut ? 'xavier' : ACT[act].init;
        const sd = scheme === 'he' ? Math.sqrt(2 / nIn) : Math.sqrt(1 / nIn);
        this.W.push(Float64Array.from({ length: nIn * nOut }, () => this.rng.gauss(0, sd)));
        this.b.push(new Float64Array(nOut).fill(isOut ? 0 : 0.01));
      }
      this.opt = null;
      this.gradNorms = new Float64Array(this.L);
    }
    get paramCount() {
      return this.W.reduce((s, w) => s + w.length, 0) + this.b.reduce((s, b) => s + b.length, 0);
    }
    /** Forward pass for one sample; returns {z, a} per layer (a[0] = input). */
    forward(x) {
      const a = [Float64Array.from(x)];
      const z = [null];
      const f = ACT[this.act].f;
      for (let l = 0; l < this.L; l++) {
        const nIn = this.sizes[l];
        const nOut = this.sizes[l + 1];
        const W = this.W[l];
        const zl = new Float64Array(nOut);
        const al = new Float64Array(nOut);
        const prev = a[l];
        for (let j = 0; j < nOut; j++) {
          let s = this.b[l][j];
          const o = j * nIn;
          for (let i = 0; i < nIn; i++) s += W[o + i] * prev[i];
          zl[j] = s;
          al[j] = l === this.L - 1 ? sigmoid(s) : f(s);
        }
        z.push(zl);
        a.push(al);
      }
      return { z, a };
    }
    predict(x) {
      const { a } = this.forward(x);
      return a[this.L][0];
    }
    /**
     * One optimisation step on a mini-batch with binary cross-entropy (+ L2).
     * opt: {type: 'sgd'|'momentum'|'adam', lr, l2}
     */
    trainBatch(X, y, idx, opt) {
      const L = this.L;
      const gW = this.W.map((w) => new Float64Array(w.length));
      const gb = this.b.map((b) => new Float64Array(b.length));
      const d = ACT[this.act].d;
      let loss = 0;
      for (const n of idx) {
        const { z, a } = this.forward(X[n]);
        const p = a[L][0];
        const t = y[n];
        loss -= t * Math.log(Math.max(p, 1e-12)) + (1 - t) * Math.log(Math.max(1 - p, 1e-12));
        let delta = new Float64Array([p - t]); // dL/dz for sigmoid + BCE
        for (let l = L - 1; l >= 0; l--) {
          const nIn = this.sizes[l];
          const nOut = this.sizes[l + 1];
          const prev = a[l];
          for (let j = 0; j < nOut; j++) {
            gb[l][j] += delta[j];
            const o = j * nIn;
            for (let i = 0; i < nIn; i++) gW[l][o + i] += delta[j] * prev[i];
          }
          if (l > 0) {
            const nd = new Float64Array(nIn);
            for (let i = 0; i < nIn; i++) {
              let s = 0;
              for (let j = 0; j < nOut; j++) s += this.W[l][j * nIn + i] * delta[j];
              nd[i] = s * d(z[l][i]);
            }
            delta = nd;
          }
        }
      }
      const m = idx.length;
      for (let l = 0; l < L; l++) {
        let s = 0;
        for (let k = 0; k < gW[l].length; k++) {
          gW[l][k] = gW[l][k] / m + opt.l2 * this.W[l][k];
          s += gW[l][k] * gW[l][k];
        }
        for (let k = 0; k < gb[l].length; k++) gb[l][k] /= m;
        this.gradNorms[l] = Math.sqrt(s / gW[l].length);
      }
      this._update(gW, gb, opt);
      let reg = 0;
      if (opt.l2) for (const w of this.W) for (const v of w) reg += 0.5 * opt.l2 * v * v;
      return loss / m + reg;
    }
    _update(gW, gb, opt) {
      if (!this.opt || this.opt.type !== opt.type) {
        this.opt = { type: opt.type, t: 0, mW: this.W.map((w) => new Float64Array(w.length)), vW: this.W.map((w) => new Float64Array(w.length)), mb: this.b.map((b) => new Float64Array(b.length)), vb: this.b.map((b) => new Float64Array(b.length)) };
      }
      const S = this.opt;
      S.t++;
      const lr = opt.lr;
      const upd = (P, G, Mm, Vv) => {
        for (let k = 0; k < P.length; k++) {
          const g = G[k];
          if (opt.type === 'sgd') P[k] -= lr * g;
          else if (opt.type === 'momentum') {
            Mm[k] = 0.9 * Mm[k] - lr * g;
            P[k] += Mm[k];
          } else {
            Mm[k] = 0.9 * Mm[k] + 0.1 * g;
            Vv[k] = 0.999 * Vv[k] + 0.001 * g * g;
            const mh = Mm[k] / (1 - 0.9 ** S.t);
            const vh = Vv[k] / (1 - 0.999 ** S.t);
            P[k] -= (lr * mh) / (Math.sqrt(vh) + 1e-8);
          }
        }
      };
      for (let l = 0; l < this.L; l++) {
        upd(this.W[l], gW[l], S.mW[l], S.vW[l]);
        upd(this.b[l], gb[l], S.mb[l], S.vb[l]);
      }
    }
    /** Mean BCE loss and accuracy on a set. */
    evaluate(X, y) {
      if (!X.length) return { loss: NaN, acc: NaN };
      let loss = 0;
      let correct = 0;
      for (let n = 0; n < X.length; n++) {
        const p = this.predict(X[n]);
        loss -= y[n] * Math.log(Math.max(p, 1e-12)) + (1 - y[n]) * Math.log(Math.max(1 - p, 1e-12));
        if ((p > 0.5 ? 1 : 0) === y[n]) correct++;
      }
      return { loss: loss / X.length, acc: correct / X.length };
    }
  }

  // ------------------------------------------------------------------ input features
  const FEATURES = {
    x1: { label: 'x₁', f: (x, y) => x },
    x2: { label: 'x₂', f: (x, y) => y },
    x1sq: { label: 'x₁²', f: (x) => x * x },
    x2sq: { label: 'x₂²', f: (x, y) => y * y },
    x1x2: { label: 'x₁x₂', f: (x, y) => x * y },
    sin1: { label: 'sin x₁', f: (x) => Math.sin(Math.PI * x) },
    sin2: { label: 'sin x₂', f: (x, y) => Math.sin(Math.PI * y) },
  };
  const featurize = (keys, x, y) => keys.map((k) => FEATURES[k].f(x, y));

  // ------------------------------------------------------------------ datasets on [−1, 1]²
  function makeDataset(name, n, noise, seed) {
    const rng = LM.makeRng(seed);
    const pts = [];
    const jitter = () => rng.gauss(0, noise * 0.35);
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    const push = (x, y, c) => pts.push({ x: clamp(x + jitter()), y: clamp(y + jitter()), c });
    if (name === 'circles') {
      for (let i = 0; i < n; i++) {
        const inner = i % 2 === 0;
        const r = inner ? rng.uniform(0, 0.45) : rng.uniform(0.68, 0.95);
        const a = rng.uniform(0, 2 * Math.PI);
        push(r * Math.cos(a), r * Math.sin(a), inner ? 1 : 0);
      }
    } else if (name === 'xor') {
      for (let i = 0; i < n; i++) {
        let x = rng.uniform(-0.95, 0.95);
        let y = rng.uniform(-0.95, 0.95);
        x += x > 0 ? 0.04 : -0.04;
        y += y > 0 ? 0.04 : -0.04;
        push(x, y, x * y > 0 ? 1 : 0);
      }
    } else if (name === 'spiral') {
      for (let i = 0; i < n; i++) {
        const c = i % 2;
        const t = (Math.floor(i / 2) / (n / 2)) * 1.75 * Math.PI + 0.35;
        const r = 0.9 * (t / (1.75 * Math.PI + 0.35));
        const a = t + c * Math.PI;
        push(r * Math.cos(a), r * Math.sin(a), c);
      }
    } else if (name === 'gauss') {
      for (let i = 0; i < n; i++) {
        const c = i % 2;
        const m = c ? 0.42 : -0.42;
        push(m + rng.gauss(0, 0.22), m + rng.gauss(0, 0.22), c);
      }
    } else if (name === 'moons') {
      for (let i = 0; i < n; i++) {
        const c = i % 2;
        const a = rng.uniform(0, Math.PI);
        const x = c ? 1 - Math.cos(a) : Math.cos(a);
        const y = c ? 0.45 - Math.sin(a) : Math.sin(a);
        push((x - 0.5) * 0.78, (y - 0.25) * 0.95, c);
      }
    } else if (name === 'checker') {
      for (let i = 0; i < n; i++) {
        const x = rng.uniform(-0.98, 0.98);
        const y = rng.uniform(-0.98, 0.98);
        const cx = Math.floor((x + 1) * 1.5);
        const cy = Math.floor((y + 1) * 1.5);
        push(x, y, (cx + cy) % 2);
      }
    }
    return pts;
  }

  return { ACT, Network, FEATURES, featurize, makeDataset, sigmoid };
});
