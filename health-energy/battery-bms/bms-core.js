/* ==========================================================================
   VoltWise core — EV battery pack physics and battery-management algorithms:
   equivalent-circuit Li-ion cells (OCV + R0 + RC), lumped thermal model,
   vehicle longitudinal dynamics and drive cycles, coulomb counting, an
   extended Kalman filter (with optional current-sensor-bias state), CC-CV
   charging and passive cell balancing. No DOM — unit-testable in Node.
   ========================================================================== */
(function (root, factory) {
  const api = factory(root.LabMath || (typeof require === 'function' ? require('../../shared/js/lab-math.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BmsCore = api;
})(typeof self !== 'undefined' ? self : this, function (LM) {
  'use strict';

  // ------------------------------------------------------------------ open-circuit voltage (NMC-like cell)
  const OCV_SOC = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1];
  const OCV_V = [3.0, 3.3, 3.45, 3.55, 3.62, 3.67, 3.72, 3.8, 3.9, 3.98, 4.08, 4.13, 4.2];

  /** Monotone piecewise-cubic Hermite interpolant (Fritsch–Carlson). Returns {f, df}. */
  function pchip(xs, ys) {
    const n = xs.length;
    const h = [];
    const d = [];
    for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / h[i]); }
    const m = new Array(n);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else {
        const w1 = 2 * h[i] + h[i - 1];
        const w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
      }
    }
    const seg = (x) => {
      let i = 0;
      while (i < n - 2 && x > xs[i + 1]) i++;
      return i;
    };
    return {
      f(x) {
        if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
        if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
        const i = seg(x);
        const t = (x - xs[i]) / h[i];
        const t2 = t * t;
        const t3 = t2 * t;
        return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
      },
      df(x) {
        if (x <= xs[0]) return m[0];
        if (x >= xs[n - 1]) return m[n - 1];
        const i = seg(x);
        const t = (x - xs[i]) / h[i];
        const t2 = t * t;
        return ((6 * t2 - 6 * t) * ys[i] + (3 * t2 - 4 * t + 1) * h[i] * m[i] + (-6 * t2 + 6 * t) * ys[i + 1] + (3 * t2 - 2 * t) * h[i] * m[i + 1]) / h[i];
      },
    };
  }
  const OCV = pchip(OCV_SOC, OCV_V);
  /** Inverse OCV by bisection (monotone curve). */
  function socFromOcv(v) {
    let lo = 0;
    let hi = 1;
    if (v <= OCV.f(0)) return 0;
    if (v >= OCV.f(1)) return 1;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (OCV.f(mid) < v) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // ------------------------------------------------------------------ cell model
  /** Nominal parameters of one parallel cell group (2p of 50 Ah NMC cells). */
  const CELL = { Q: 100, R0: 0.6e-3, R1: 0.4e-3, tau1: 20, Cth: 2000, hA: 1.2, Ea: 2500, Vmin: 3.0, Vmax: 4.2 };

  /** Temperature- and SOC-dependent ohmic resistance (Arrhenius + rise at low SOC). */
  const r0Of = (p, z, T) => p.R0 * (1 + 0.6 * Math.max(0, 1 - z / 0.3) ** 2) * Math.exp(p.Ea * (1 / (T + 273.15) - 1 / 298.15));

  /** A cell group with its own true state; positive current = discharge. */
  function makeCell(p, soc, T) {
    return { p, z: soc, v1: 0, T, v: OCV.f(soc) };
  }
  /** Exact zero-order-hold update of the Thevenin model over dt with current I. Returns terminal voltage. */
  function stepCell(c, I, dt, Tamb) {
    const p = c.p;
    const a = Math.exp(-dt / p.tau1);
    c.z -= (I * dt) / (3600 * p.Q);
    c.v1 = a * c.v1 + p.R1 * (1 - a) * I;
    const R0 = r0Of(p, Math.max(0, c.z), c.T);
    c.v = OCV.f(c.z) - c.v1 - R0 * I;
    // lumped thermal model: Joule heat (ohmic + polarisation) vs convective cooling
    const heat = I * I * R0 + (c.v1 * c.v1) / p.R1;
    c.T += ((heat - p.hA * (c.T - Tamb)) / p.Cth) * dt;
    return c.v;
  }

  // ------------------------------------------------------------------ vehicle & drive cycles
  const VEHICLE = { m: 1750, Cd: 0.29, A: 2.3, Crr: 0.01, rho: 1.2, etaDrive: 0.9, etaRegen: 0.65, aux: 450, maxRegen: 60000 };
  /** Battery power demand [W] at speed v [m/s] and acceleration a [m/s²] (positive = discharge). */
  function tractionPower(v, a, veh = VEHICLE) {
    const F = veh.m * a + 0.5 * veh.rho * veh.Cd * veh.A * v * v + (v > 0.1 ? veh.Crr * veh.m * 9.81 : 0);
    const Pw = F * v;
    const Pb = Pw >= 0 ? Pw / veh.etaDrive : Math.max(-veh.maxRegen, Pw * veh.etaRegen);
    return Pb + veh.aux;
  }
  const CYCLES = {
    city: { name: 'City (stop-and-go)', vmax: [30, 55], accel: [0.8, 1.6], cruise: [8, 40], stop: [5, 25] },
    highway: { name: 'Highway', vmax: [95, 125], accel: [0.5, 1.0], cruise: [90, 300], stop: [0, 0] },
    aggressive: { name: 'Aggressive (sporty)', vmax: [60, 130], accel: [2.2, 3.5], cruise: [5, 30], stop: [2, 8] },
  };
  /** Procedural drive cycle: a sequence of micro-trips; returns speeds [m/s] at 1 s steps. */
  function driveCycle(kind, seconds, seed = 1) {
    const c = CYCLES[kind];
    const rng = LM.makeRng(seed);
    const v = [];
    let cur = 0;
    while (v.length < seconds) {
      const target = rng.uniform(c.vmax[0], c.vmax[1]) / 3.6;
      const acc = rng.uniform(c.accel[0], c.accel[1]);
      while (cur < target && v.length < seconds) { cur = Math.min(target, cur + acc * (0.6 + 0.4 * (1 - cur / target))); v.push(cur); }
      const cruise = Math.round(rng.uniform(c.cruise[0], c.cruise[1]));
      for (let i = 0; i < cruise && v.length < seconds; i++) { cur = Math.max(0, cur + rng.gauss(0, 0.25)); v.push(cur); }
      if (c.stop[1] > 0) {
        const dec = rng.uniform(1.2, 2.5);
        while (cur > 0 && v.length < seconds) { cur = Math.max(0, cur - dec); v.push(cur); }
        const stop = Math.round(rng.uniform(c.stop[0], c.stop[1]));
        for (let i = 0; i < stop && v.length < seconds; i++) v.push(0);
      } else {
        const next = rng.uniform(c.vmax[0], c.vmax[1]) / 3.6;
        while (Math.abs(cur - next) > 0.3 && v.length < seconds) { cur += Math.sign(next - cur) * 0.3; v.push(cur); }
      }
    }
    return v;
  }

  // ------------------------------------------------------------------ estimators
  /** Coulomb counting with a (possibly wrong) initial SOC and nominal capacity. */
  class CoulombCounter {
    constructor(soc0, Q) { this.z = soc0; this.Q = Q; }
    update(Imeas, dt) { this.z -= (Imeas * dt) / (3600 * this.Q); return this.z; }
  }
  /**
   * Extended Kalman filter on the Thevenin model. State [SOC, v1] or, with bias = true,
   * [SOC, v1, b] where b is the current-sensor offset (true current = Imeas − b).
   */
  class SocEKF {
    constructor({ soc0 = 0.5, p = CELL, bias = false, sigmaV = 0.01, sigmaI = 0.5, P0soc = 0.04, T = 25 } = {}) {
      this.p = p;
      this.bias = bias;
      this.n = bias ? 3 : 2;
      this.x = bias ? [soc0, 0, 0] : [soc0, 0];
      this.P = bias ? [[P0soc, 0, 0], [0, 1e-6, 0], [0, 0, 1]] : [[P0soc, 0], [0, 1e-6]];
      this.R = sigmaV * sigmaV;
      this.sigmaI = sigmaI;
      this.T = T;
      this.innov = 0;
    }
    get soc() { return this.x[0]; }
    get sigma() { return Math.sqrt(Math.max(0, this.P[0][0])); }
    /** One predict/update cycle with measured current Imeas and terminal voltage Vmeas. */
    update(Imeas, Vmeas, dt) {
      const p = this.p;
      const n = this.n;
      const a = Math.exp(-dt / p.tau1);
      const k = dt / (3600 * p.Q);
      const b = this.bias ? this.x[2] : 0;
      const I = Imeas - b;
      // predict
      const x = this.x.slice();
      x[0] = this.x[0] - k * I;
      x[1] = a * this.x[1] + p.R1 * (1 - a) * I;
      // Jacobian F and process noise (current noise enters both states)
      const F = n === 3 ? [[1, 0, k], [0, a, -p.R1 * (1 - a)], [0, 0, 1]] : [[1, 0], [0, a]];
      const g = [-k, p.R1 * (1 - a)];
      const s2 = this.sigmaI * this.sigmaI;
      const Q = [];
      for (let i = 0; i < n; i++) { Q.push([]); for (let j = 0; j < n; j++) Q[i].push(i < 2 && j < 2 ? g[i] * g[j] * s2 : 0); }
      if (n === 3) Q[2][2] = 1e-6 * dt;
      Q[0][0] += 2e-8 * dt; // unmodelled capacity / efficiency errors
      const FP = LM.matmul(F, this.P);
      const Pp = LM.matmul(FP, LM.transpose(F)).map((row, i) => row.map((v, j) => v + Q[i][j]));
      // update with the voltage measurement
      const R0 = r0Of(p, Math.max(0, x[0]), this.T);
      const vhat = OCV.f(x[0]) - x[1] - R0 * I;
      const H = n === 3 ? [OCV.df(x[0]), -1, R0] : [OCV.df(x[0]), -1];
      const PH = Pp.map((row) => row.reduce((s, v, j) => s + v * H[j], 0));
      const S = H.reduce((s, h, i) => s + h * PH[i], 0) + this.R;
      const K = PH.map((v) => v / S);
      this.innov = Vmeas - vhat;
      for (let i = 0; i < n; i++) x[i] += K[i] * this.innov;
      const P = Pp.map((row, i) => row.map((v, j) => v - K[i] * PH[j]));
      // symmetrise
      for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) { const m = (P[i][j] + P[j][i]) / 2; P[i][j] = m; P[j][i] = m; }
      this.x = x;
      this.P = P;
      return x[0];
    }
  }

  // ------------------------------------------------------------------ pack simulation
  /**
   * Battery pack of nSeries cell groups with manufacturing spread. The monitored cell (index 0 by
   * default the weakest) feeds the estimators. opts: {nSeries, capSpread, rSpread, socSpread, T0, Tamb, seed}
   */
  function makePack({ nSeries = 96, capSpread = 0.015, rSpread = 0.05, socSpread = 0.01, soc0 = 0.8, T0 = 25, seed = 3 } = {}) {
    const rng = LM.makeRng(seed);
    const cells = [];
    for (let i = 0; i < nSeries; i++) {
      const p = { ...CELL, Q: CELL.Q * (1 + rng.gauss(0, capSpread)), R0: CELL.R0 * (1 + rng.gauss(0, rSpread)), R1: CELL.R1 * (1 + rng.gauss(0, rSpread)) };
      cells.push(makeCell(p, Math.min(1, Math.max(0.02, soc0 + rng.gauss(0, socSpread))), T0));
    }
    return { cells, n: nSeries, bleed: new Float64Array(nSeries), balancedAh: 0, balancingEnergy: 0 };
  }
  const packVoltage = (pack) => pack.cells.reduce((s, c) => s + c.v, 0);
  /** Advance the pack by dt with pack current I; passive balancing bleeds cells above min SOC + window. */
  function stepPack(pack, I, dt, Tamb, { balance = false, bleedA = 0.2, window = 0.005 } = {}) {
    let zmin = Infinity;
    for (const c of pack.cells) zmin = Math.min(zmin, c.z);
    let V = 0;
    pack.cells.forEach((c, i) => {
      const b = balance && c.z > zmin + window ? bleedA : 0;
      pack.bleed[i] = b;
      if (b) { pack.balancedAh += (b * dt) / 3600; pack.balancingEnergy += b * c.v * dt; }
      V += stepCell(c, I + b, dt, Tamb);
    });
    return V;
  }
  /** Energy available until the weakest cell reaches 0 % vs. the energy if every cell could be emptied. */
  function packEnergy(pack) {
    const zmin = Math.min(...pack.cells.map((c) => c.z));
    let usable = 0;
    let total = 0;
    const avgV = 3.7;
    for (const c of pack.cells) {
      // in series every cell passes the same charge: the pack stops when the weakest cell is empty
      const qWeak = zmin * pack.cells.reduce((m, cc) => (cc.z === zmin ? cc.p.Q : m), c.p.Q);
      usable += Math.min(c.z * c.p.Q, qWeak) * avgV;
      total += c.z * c.p.Q * avgV;
    }
    return { usableWh: usable, totalWh: total, strandedWh: total - usable };
  }

  /** Measurement chain: current-sensor gain/offset/noise and voltage-sensor noise. */
  function makeSensors({ gainErr = 0.005, offset = 0.3, noiseI = 0.5, noiseV = 0.005, seed = 7 } = {}) {
    const rng = LM.makeRng(seed);
    return {
      current: (I) => I * (1 + gainErr) + offset + rng.gauss(0, noiseI),
      voltage: (V) => V + rng.gauss(0, noiseV),
    };
  }

  /**
   * Full headless drive simulation used by tests and the app: returns time series of true SOC and
   * estimator outputs for the monitored cell.
   */
  function simulateDrive({ cycle = 'city', seconds = 3600, soc0 = 0.8, socGuess = 0.6, seed = 1, sensor = {}, ekfOpts = {}, Tamb = 25, soh = 1 } = {}) {
    const speeds = driveCycle(cycle, seconds, seed);
    const pack = makePack({ soc0, seed: seed + 11 });
    pack.cells.forEach((c) => (c.p.Q *= soh));
    const mon = pack.cells[0];
    const sens = makeSensors({ seed: seed + 5, ...sensor });
    const cc = new CoulombCounter(socGuess, CELL.Q);
    const ekf = new SocEKF({ soc0: socGuess, ...ekfOpts });
    const ekfB = new SocEKF({ soc0: socGuess, bias: true, ...ekfOpts });
    const out = { t: [], v: [], I: [], trueSoc: [], cc: [], ekf: [], ekfB: [], sigma: [], ocv: [], Vpack: [], dist: 0, energyWh: 0 };
    let V = packVoltage(pack);
    for (let k = 0; k < speeds.length; k++) {
      const v = speeds[k];
      const a = k ? v - speeds[k - 1] : 0;
      const P = tractionPower(v, a);
      const I = P / Math.max(200, V);
      V = stepPack(pack, I, 1, Tamb);
      const Im = sens.current(I);
      const Vm = sens.voltage(mon.v);
      out.t.push(k);
      out.v.push(v);
      out.I.push(I);
      out.trueSoc.push(mon.z);
      out.cc.push(cc.update(Im, 1));
      out.ekf.push(ekf.update(Im, Vm, 1));
      out.sigma.push(ekf.sigma);
      out.ekfB.push(ekfB.update(Im, Vm, 1));
      out.ocv.push(socFromOcv(Vm + r0Of(CELL, mon.z, mon.T) * Im));
      out.Vpack.push(V);
      out.dist += v;
      out.energyWh += (P * 1) / 3600;
    }
    out.pack = pack;
    out.ekfBias = ekfB.x[2];
    return out;
  }
  const rmse = (a, b, from = 0) => {
    let s = 0;
    let n = 0;
    for (let i = from; i < a.length; i++) { s += (a[i] - b[i]) ** 2; n++; }
    return Math.sqrt(s / Math.max(1, n));
  };

  return { OCV_SOC, OCV_V, OCV, pchip, socFromOcv, CELL, r0Of, makeCell, stepCell, VEHICLE, tractionPower, CYCLES, driveCycle, CoulombCounter, SocEKF, makePack, packVoltage, stepPack, packEnergy, makeSensors, simulateDrive, rmse };
});
