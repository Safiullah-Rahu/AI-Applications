/* ==========================================================================
   MotorLab core — DC servo physics, discrete PID, auto-tuning and loop analysis.
   Pure functions/classes (no DOM) so they can be unit-tested in Node.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MotorCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /**
   * Geared permanent-magnet DC motor, all quantities referred to the output shaft.
   *   L di/dt = V − R i − K ω
   *   J dω/dt = K i − b ω − τc·tanh(ω/ωs) − τload
   *   dθ/dt  = ω
   */
  const DEFAULT_PARAMS = Object.freeze({
    R: 2.0, // armature resistance [Ω]
    L: 5e-3, // armature inductance [H]
    K: 0.5, // torque / back-EMF constant at output [N·m/A] = [V·s/rad]
    J: 0.05, // rotor + gearbox + load inertia [kg·m²]
    b: 0.01, // viscous friction [N·m·s/rad]
    tauC: 0.05, // Coulomb friction [N·m]
    Vmax: 24, // supply voltage [V]
  });

  class DCMotor {
    constructor(params = {}) {
      this.p = Object.assign({}, DEFAULT_PARAMS, params);
      this.reset();
    }
    reset(theta = 0, omega = 0) {
      this.i = 0;
      this.w = omega;
      this.th = theta;
    }
    _f(i, w, u, tl, out) {
      const p = this.p;
      out[0] = (u - p.R * i - p.K * w) / p.L;
      out[1] = (p.K * i - p.b * w - p.tauC * Math.tanh(w / 0.02) - tl) / p.J;
      out[2] = w;
    }
    /** One classic Runge–Kutta 4 step of length h with voltage u and load torque tl held constant. */
    step(u, tl, h) {
      const k1 = this._k1 || (this._k1 = new Float64Array(3));
      const k2 = this._k2 || (this._k2 = new Float64Array(3));
      const k3 = this._k3 || (this._k3 = new Float64Array(3));
      const k4 = this._k4 || (this._k4 = new Float64Array(3));
      const { i, w, th } = this;
      this._f(i, w, u, tl, k1);
      this._f(i + 0.5 * h * k1[0], w + 0.5 * h * k1[1], u, tl, k2);
      this._f(i + 0.5 * h * k2[0], w + 0.5 * h * k2[1], u, tl, k3);
      this._f(i + h * k3[0], w + h * k3[1], u, tl, k4);
      this.i = i + (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      this.w = w + (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
      this.th = th + (h / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
    }
    get torque() {
      return this.p.K * this.i;
    }
    /** Mechanical time constant and DC gain of ω/V (linearised, no Coulomb friction). */
    get timeConstant() {
      const p = this.p;
      return (p.J * p.R) / (p.K * p.K + p.R * p.b);
    }
    get speedGain() {
      const p = this.p;
      return p.K / (p.K * p.K + p.R * p.b);
    }
  }

  /**
   * Discrete PID with first-order filtered derivative, optional derivative-on-measurement
   * (no setpoint kick) and conditional-integration anti-windup.
   *   C(s) = Kp + Ki/s + Kd·s/(Tf·s + 1)
   */
  class PID {
    constructor(opts = {}) {
      Object.assign(this, { kp: 1, ki: 0, kd: 0, tf: 0.002, umax: 24, antiWindup: true, dOnMeas: true }, opts);
      this.reset();
    }
    reset() {
      this.I = 0;
      this.D = 0;
      this.prevY = null;
      this.prevE = null;
      this.last = { e: 0, P: 0, I: 0, D: 0, u: 0, out: 0, saturated: false };
    }
    update(r, y, Ts) {
      const e = r - y;
      const P = this.kp * e;
      let dRaw = 0;
      if (this.dOnMeas) dRaw = this.prevY === null ? 0 : -(y - this.prevY) / Ts;
      else dRaw = this.prevE === null ? 0 : (e - this.prevE) / Ts;
      const a = this.tf / (this.tf + Ts);
      this.D = a * this.D + (1 - a) * this.kd * dRaw;
      let I = this.I + this.ki * e * Ts;
      let u = P + I + this.D;
      let out = clamp(u, -this.umax, this.umax);
      const saturated = out !== u;
      if (this.antiWindup && saturated && Math.sign(e) === Math.sign(u)) {
        // conditional integration: freeze the integrator while it would push further into saturation
        I = this.I;
        u = P + I + this.D;
        out = clamp(u, -this.umax, this.umax);
      }
      this.I = I;
      this.prevY = y;
      this.prevE = e;
      this.last = { e, P, I, D: this.D, u, out, saturated };
      return out;
    }
  }

  // ------------------------------------------------------------------ step-response metrics
  /**
   * Metrics of a (possibly still running) step response.
   * t, y: sample arrays starting at the step instant; y0: initial output; r1: new target.
   */
  function stepMetrics(t, y, y0, r1, band = 0.02) {
    const n = t.length;
    const d = r1 - y0;
    const out = { rise: NaN, overshoot: NaN, settle: NaN, sse: NaN, peakTime: NaN, iae: 0 };
    if (n < 3 || Math.abs(d) < 1e-9) return out;
    let t10 = NaN;
    let t90 = NaN;
    let peak = -Infinity;
    let lastOut = -1;
    for (let k = 0; k < n; k++) {
      const yn = (y[k] - y0) / d; // normalised 0 → 1
      if (Number.isNaN(t10) && yn >= 0.1) t10 = t[k];
      if (Number.isNaN(t90) && yn >= 0.9) t90 = t[k];
      if (yn > peak) {
        peak = yn;
        out.peakTime = t[k] - t[0];
      }
      if (Math.abs(1 - yn) > band) lastOut = k;
      if (k > 0) out.iae += Math.abs(r1 - y[k]) * (t[k] - t[k - 1]);
    }
    out.rise = t90 - t10;
    out.overshoot = Math.max(0, (peak - 1) * 100);
    if (lastOut < n - 1) out.settle = t[Math.min(n - 1, lastOut + 1)] - t[0];
    // steady-state error: average over last 10 % of the window
    const k0 = Math.floor(n * 0.9);
    let s = 0;
    for (let k = k0; k < n; k++) s += r1 - y[k];
    out.sse = s / (n - k0);
    return out;
  }

  // ------------------------------------------------------------------ complex & polynomial helpers
  const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  const cdiv = (a, b) => {
    const d = b[0] * b[0] + b[1] * b[1];
    return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
  };
  const cadd = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const csub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const cabs = (a) => Math.hypot(a[0], a[1]);

  /** Evaluate a real polynomial (coefficients highest power first) at complex s. */
  function polyval(c, s) {
    let r = [0, 0];
    for (const a of c) r = cadd(cmul(r, s), [a, 0]);
    return r;
  }
  function polymul(a, b) {
    const r = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) r[i + j] += a[i] * b[j];
    return r;
  }
  function polyadd(a, b) {
    const n = Math.max(a.length, b.length);
    const r = new Array(n).fill(0);
    for (let i = 0; i < a.length; i++) r[n - a.length + i] += a[i];
    for (let i = 0; i < b.length; i++) r[n - b.length + i] += b[i];
    return r;
  }
  function trimPoly(c) {
    let k = 0;
    const scale = Math.max(...c.map(Math.abs)) || 1;
    while (k < c.length - 1 && Math.abs(c[k]) < 1e-14 * scale) k++;
    return c.slice(k);
  }

  /** All complex roots of a real polynomial via scaled Durand–Kerner iteration. */
  function polyRoots(coeffs) {
    let c = trimPoly(coeffs.slice());
    const roots = [];
    // strip zero roots
    while (c.length > 1 && Math.abs(c[c.length - 1]) < 1e-300) {
      roots.push([0, 0]);
      c = c.slice(0, -1);
    }
    const n = c.length - 1;
    if (n < 1) return roots;
    // scale s = σ·x so the monic polynomial in x is well conditioned
    const sigma = Math.pow(Math.abs(c[n] / c[0]), 1 / n) || 1;
    // coefficient of x^(n-k) is c_k σ^(n-k) / (c_0 σ^n) = (c_k / c_0) σ^(-k)
    const a = c.map((v, k) => (v / c[0]) * Math.pow(sigma, -k));
    let z = Array.from({ length: n }, (_, k) => {
      const ang = (2 * Math.PI * k) / n + 0.4;
      return [Math.cos(ang) * 1.1, Math.sin(ang) * 1.1];
    });
    for (let iter = 0; iter < 800; iter++) {
      let maxStep = 0;
      const next = z.map((zk, k) => {
        let den = [1, 0];
        for (let j = 0; j < n; j++) if (j !== k) den = cmul(den, csub(zk, z[j]));
        const step = cdiv(polyval(a, zk), den);
        maxStep = Math.max(maxStep, cabs(step));
        return csub(zk, step);
      });
      z = next;
      if (maxStep < 1e-13) break;
    }
    for (const zk of z) roots.push([zk[0] * sigma, Math.abs(zk[1] * sigma) < 1e-9 * sigma ? 0 : zk[1] * sigma]);
    return roots.sort((p, q) => q[0] - p[0]);
  }

  // ------------------------------------------------------------------ loop models
  /** Plant numerator/denominator (s-domain, highest power first) for 'position' or 'velocity'. */
  function plantTF(p, mode) {
    const den = [p.J * p.L, p.J * p.R + p.b * p.L, p.b * p.R + p.K * p.K];
    return mode === 'position' ? { num: [p.K], den: [...den, 0] } : { num: [p.K], den };
  }
  /** PID with filtered derivative: C(s) = [(Kp·Tf + Kd)s² + (Kp + Ki·Tf)s + Ki] / [Tf·s² + s]. */
  function pidTF(g) {
    // without integral action the factor s cancels: C(s) = [(Kp·Tf + Kd)s + Kp] / [Tf·s + 1]
    if (!g.ki) return { num: [g.kp * g.tf + g.kd, g.kp], den: [g.tf, 1] };
    return { num: [g.kp * g.tf + g.kd, g.kp + g.ki * g.tf, g.ki], den: [g.tf, 1, 0] };
  }
  /** First-order Padé approximation of the ZOH half-sample delay e^{−s·Ts/2}. */
  function delayTF(Ts) {
    const T = Ts / 2;
    return { num: [-T / 2, 1], den: [T / 2, 1] };
  }

  /**
   * Frequency response of plant P, controller C and loop L = C·P·e^{−jωTs/2}·S on log-spaced ω,
   * where S = 1/(τs·s + 1) models the sensor (velocity-estimate) filter.
   */
  function frequencyResponse(p, g, mode, Ts, tauS = 0, wMin = 0.1, wMax = 1e4, n = 400) {
    const P = plantTF(p, mode);
    const C = pidTF(g);
    const w = new Float64Array(n);
    const magL = new Float64Array(n);
    const phL = new Float64Array(n);
    const magP = new Float64Array(n);
    const phP = new Float64Array(n);
    const magT = new Float64Array(n);
    let prevL = null;
    let prevP = null;
    let unwrapL = 0;
    let unwrapP = 0;
    for (let k = 0; k < n; k++) {
      const wk = wMin * Math.pow(wMax / wMin, k / (n - 1));
      const s = [0, wk];
      const Pv = cdiv(polyval(P.num, s), polyval(P.den, s));
      const Cv = cdiv(polyval(C.num, s), polyval(C.den, s));
      const D = [Math.cos(-wk * Ts * 0.5), Math.sin(-wk * Ts * 0.5)];
      const Sv = cdiv([1, 0], [1, wk * tauS]);
      const Lv = cmul(cmul(cmul(Cv, Pv), D), Sv);
      const Tv = cdiv(Lv, cadd([1, 0], Lv));
      let aL = (Math.atan2(Lv[1], Lv[0]) * 180) / Math.PI;
      let aP = (Math.atan2(Pv[1], Pv[0]) * 180) / Math.PI;
      if (prevL !== null) {
        while (aL + unwrapL - prevL > 180) unwrapL -= 360;
        while (aL + unwrapL - prevL < -180) unwrapL += 360;
        while (aP + unwrapP - prevP > 180) unwrapP -= 360;
        while (aP + unwrapP - prevP < -180) unwrapP += 360;
      } else {
        // start the unwrapped phase in (−360, 0] like a textbook Bode plot
        if (aL > 0) unwrapL = -360;
        if (aP > 0) unwrapP = -360;
      }
      prevL = aL + unwrapL;
      prevP = aP + unwrapP;
      w[k] = wk;
      magL[k] = 20 * Math.log10(cabs(Lv));
      phL[k] = prevL;
      magP[k] = 20 * Math.log10(cabs(Pv));
      phP[k] = prevP;
      magT[k] = 20 * Math.log10(cabs(Tv));
    }
    return { w, magL, phL, magP, phP, magT, ...margins(w, magL, phL, magT) };
  }

  /** Gain/phase margins and closed-loop −3 dB bandwidth from sampled Bode data. */
  function margins(w, mag, ph, magT) {
    const n = w.length;
    let wc = NaN;
    let pm = NaN;
    let wp = NaN;
    let gm = Infinity;
    let bw = NaN;
    const interp = (k, a, b, target) => {
      const f = (target - a[k]) / (a[k + 1] - a[k]);
      const lw = Math.log10(w[k]) + f * (Math.log10(w[k + 1]) - Math.log10(w[k]));
      return { w: 10 ** lw, f };
    };
    for (let k = 0; k < n - 1; k++) {
      if (Number.isNaN(wc) && mag[k] >= 0 && mag[k + 1] < 0) {
        const r = interp(k, mag, mag, 0);
        wc = r.w;
        pm = 180 + ph[k] + r.f * (ph[k + 1] - ph[k]);
      }
      if (Number.isNaN(wp) && ph[k] > -180 && ph[k + 1] <= -180) {
        const r = interp(k, ph, ph, -180);
        wp = r.w;
        gm = -(mag[k] + r.f * (mag[k + 1] - mag[k]));
      }
      if (Number.isNaN(bw) && magT && magT[k] >= -3 && magT[k + 1] < -3) bw = interp(k, magT, magT, -3).w;
    }
    return { wc, pm, wp, gm, bw };
  }

  /** Closed-loop poles of 1 + C(s)·P(s)·Padé(s)·S(s) = 0 (continuous-time approximation). */
  function closedLoopPoles(p, g, mode, Ts, tauS = 0) {
    const P = plantTF(p, mode);
    const C = pidTF(g);
    const D = delayTF(Ts);
    const Sd = tauS > 0 ? [tauS, 1] : [1];
    const den = polymul(polymul(polymul(C.den, P.den), D.den), Sd);
    const num = polymul(polymul(C.num, P.num), D.num);
    return polyRoots(polyadd(den, num));
  }

  // ------------------------------------------------------------------ tuning rules
  /** Relay (Åström–Hägglund) experiment result → PID gains with classic rules. */
  function relayRule(Ku, Tu, rule) {
    const R = {
      zn: { kp: 0.6 * Ku, ti: Tu / 2, td: Tu / 8, name: 'Ziegler–Nichols' },
      tl: { kp: Ku / 2.2, ti: 2.2 * Tu, td: Tu / 6.3, name: 'Tyreus–Luyben' },
      no: { kp: 0.2 * Ku, ti: Tu / 2, td: Tu / 3, name: 'Z–N no overshoot' },
      pessen: { kp: 0.7 * Ku, ti: Tu / 2.5, td: (3 * Tu) / 20, name: 'Pessen integral' },
    }[rule] || null;
    if (!R) throw new Error('unknown rule ' + rule);
    return { kp: R.kp, ki: R.kp / R.ti, kd: R.kp * R.td, name: R.name };
  }

  /** Describing-function ultimate gain from relay amplitude d, oscillation amplitude a and hysteresis eps. */
  function relayUltimateGain(d, a, eps = 0) {
    return (4 * d) / (Math.PI * Math.sqrt(Math.max(1e-12, a * a - eps * eps)));
  }

  /**
   * First-order-plus-dead-time fit from an open-loop step (two-point 28.3 % / 63.2 % method)
   * and SIMC PI tuning (Skogestad 2003) with closed-loop time constant tauC.
   */
  function fopdtFit(t, y, du) {
    const n = t.length;
    const y0 = y[0];
    const yEnd = y[n - 1];
    const dy = yEnd - y0;
    let t28 = NaN;
    let t63 = NaN;
    for (let k = 0; k < n; k++) {
      const f = (y[k] - y0) / dy;
      if (Number.isNaN(t28) && f >= 0.283) t28 = t[k] - t[0];
      if (Number.isNaN(t63) && f >= 0.632) t63 = t[k] - t[0];
    }
    const tau = 1.5 * (t63 - t28);
    const theta = Math.max(0, t63 - tau);
    return { K: dy / du, tau, theta };
  }
  function simcPI(fit, tauC, Ts) {
    const theta = Math.max(fit.theta, Ts);
    const kp = fit.tau / (fit.K * (tauC + theta));
    const ti = Math.min(fit.tau, 4 * (tauC + theta));
    return { kp, ki: kp / ti, kd: 0 };
  }

  return {
    DEFAULT_PARAMS, DCMotor, PID, stepMetrics,
    polyRoots, polymul, polyadd, polyval,
    plantTF, pidTF, frequencyResponse, margins, closedLoopPoles,
    relayRule, relayUltimateGain, fopdtFit, simcPI,
  };
});
