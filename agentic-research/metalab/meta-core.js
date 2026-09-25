/* ==========================================================================
   MetaLab core — distributions, meta-analysis, publication-bias diagnostics,
   power analysis and study simulation. No DOM — unit-testable in Node.
   ========================================================================== */
(function (root, factory) {
  const api = factory(root.LabMath || (typeof require === 'function' ? require('../../shared/js/lab-math.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MetaCore = api;
})(typeof self !== 'undefined' ? self : this, function (LM) {
  'use strict';

  // ================================================================== distributions
  /** Standard normal CDF (Hart / West double-precision approximation, |error| < 1e-14). */
  function normCdf(x) {
    const a = Math.abs(x);
    let c;
    if (a > 37) c = 0;
    else {
      const e = Math.exp((-a * a) / 2);
      if (a < 7.07106781186547) {
        let b = 3.52624965998911e-2 * a + 0.700383064443688;
        b = b * a + 6.37396220353165;
        b = b * a + 33.912866078383;
        b = b * a + 112.079291497871;
        b = b * a + 221.213596169931;
        b = b * a + 220.206867912376;
        c = e * b;
        b = 8.83883476483184e-2 * a + 1.75566716318264;
        b = b * a + 16.064177579207;
        b = b * a + 86.7807322029461;
        b = b * a + 296.564248779674;
        b = b * a + 637.333633378831;
        b = b * a + 793.826512519948;
        b = b * a + 440.413735824752;
        c /= b;
      } else {
        let b = a + 0.65;
        b = a + 4 / b;
        b = a + 3 / b;
        b = a + 2 / b;
        b = a + 1 / b;
        c = e / b / 2.506628274631;
      }
    }
    return x > 0 ? 1 - c : c;
  }
  const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

  /** Inverse normal CDF (Acklam) with one Halley refinement step. */
  function normInv(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425;
    let x;
    if (p < pl) {
      const q = Math.sqrt(-2 * Math.log(p));
      x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (p <= 1 - pl) {
      const q = p - 0.5;
      const r = q * q;
      x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
      const q = Math.sqrt(-2 * Math.log(1 - p));
      x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    const e = normCdf(x) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    return x - u / (1 + (x * u) / 2);
  }

  /** log Γ(x) (Lanczos, g = 7). */
  function lgamma(x) {
    const g = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
    x -= 1;
    let s = g[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) s += g[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(s);
  }

  /** Continued fraction for the regularized incomplete beta (modified Lentz). */
  function betacf(a, b, x) {
    const TINY = 1e-300;
    let c = 1;
    let d = 1 - ((a + b) * x) / (a + 1);
    if (Math.abs(d) < TINY) d = TINY;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 300; m++) {
      const m2 = 2 * m;
      let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < TINY) d = TINY;
      c = 1 + aa / c;
      if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d;
      h *= d * c;
      aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < TINY) d = TINY;
      c = 1 + aa / c;
      if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-15) break;
    }
    return h;
  }
  /** Regularized incomplete beta I_x(a, b). */
  function ibeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const lbt = lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x);
    if (x < (a + 1) / (a + b + 2)) return (Math.exp(lbt) * betacf(a, b, x)) / a;
    return 1 - (Math.exp(lbt) * betacf(b, a, 1 - x)) / b;
  }
  /** Student t CDF. */
  function tCdf(t, df) {
    if (!Number.isFinite(df) || df > 1e7) return normCdf(t);
    const x = df / (df + t * t);
    const tail = 0.5 * ibeta(x, df / 2, 0.5);
    return t > 0 ? 1 - tail : tail;
  }
  /** Student t quantile (Newton on the CDF, normal start). */
  function tInv(p, df) {
    if (!Number.isFinite(df) || df > 1e7) return normInv(p);
    let x = normInv(p);
    for (let i = 0; i < 60; i++) {
      const f = tCdf(x, df) - p;
      const dens = Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (x * x) / df));
      const step = f / Math.max(dens, 1e-300);
      x -= Math.max(-2, Math.min(2, step));
      if (Math.abs(step) < 1e-13 * Math.max(1, Math.abs(x))) break;
    }
    return x;
  }
  /** Regularized lower incomplete gamma P(a, x). */
  function gammaP(a, x) {
    if (x <= 0) return 0;
    if (x < a + 1) {
      let ap = a;
      let sum = 1 / a;
      let del = sum;
      for (let n = 0; n < 500; n++) {
        ap++;
        del *= x / ap;
        sum += del;
        if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
      }
      return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
    }
    let b = x + 1 - a;
    let c = 1e300;
    let d = 1 / b;
    let h = d;
    for (let i = 1; i < 500; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b;
      if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c;
      if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-15) break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
  }
  const chi2Cdf = (x, df) => gammaP(df / 2, x / 2);

  /**
   * Non-central t CDF: P(T ≤ t; ν, δ) = ∫ Φ(t·√(x/ν) − δ) f_χ²ν(x) dx, integrated with composite
   * Simpson over ±14 SD of the χ² distribution in the variable s = √x (smooth for every ν).
   */
  function nctCdf(t, df, ncp) {
    if (df > 1e6) return normCdf(t - ncp);
    const sd = Math.sqrt(2 * df);
    const lo = Math.sqrt(Math.max(0, df - 14 * sd));
    const hi = Math.sqrt(df + 14 * sd + 40);
    const N = 800;
    const h = (hi - lo) / N;
    const lc = Math.log(2) - (df / 2) * Math.log(2) - lgamma(df / 2);
    let sum = 0;
    for (let i = 0; i <= N; i++) {
      const s = lo + i * h;
      if (s <= 0) continue;
      // density of s = √x where x ~ χ²ν:  2 s f_χ²(s²)
      const logf = lc + (df - 1) * Math.log(s) - (s * s) / 2;
      const w = i === 0 || i === N ? 1 : i % 2 ? 4 : 2;
      sum += w * Math.exp(logf) * normCdf((t * s) / Math.sqrt(df) - ncp);
    }
    return Math.min(1, Math.max(0, (sum * h) / 3));
  }

  // ================================================================== effect sizes
  /** Log risk ratio from a 2×2 table (treated events/non-events, control events/non-events); 0.5 correction on zero cells. */
  function logRR(tpos, tneg, cpos, cneg) {
    if (!tpos || !tneg || !cpos || !cneg) { tpos += 0.5; tneg += 0.5; cpos += 0.5; cneg += 0.5; }
    const n1 = tpos + tneg;
    const n2 = cpos + cneg;
    return { yi: Math.log(tpos / n1 / (cpos / n2)), vi: 1 / tpos - 1 / n1 + 1 / cpos - 1 / n2 };
  }
  function logOR(tpos, tneg, cpos, cneg) {
    if (!tpos || !tneg || !cpos || !cneg) { tpos += 0.5; tneg += 0.5; cpos += 0.5; cneg += 0.5; }
    return { yi: Math.log((tpos * cneg) / (tneg * cpos)), vi: 1 / tpos + 1 / tneg + 1 / cpos + 1 / cneg };
  }
  /** Hedges' g (bias-corrected standardized mean difference) and its large-sample variance. */
  function hedgesG(m1, sd1, n1, m2, sd2, n2) {
    const df = n1 + n2 - 2;
    const sp = Math.sqrt(((n1 - 1) * sd1 * sd1 + (n2 - 1) * sd2 * sd2) / df);
    const d = (m1 - m2) / sp;
    const J = 1 - 3 / (4 * df - 1);
    const g = J * d;
    return { yi: g, vi: (n1 + n2) / (n1 * n2) + (g * g) / (2 * (n1 + n2)) };
  }

  // ================================================================== meta-analysis
  const sum = (a) => a.reduce((s, v) => s + v, 0);

  /** DerSimonian–Laird τ². */
  function tau2DL(y, v) {
    const w = v.map((x) => 1 / x);
    const sw = sum(w);
    const mu = sum(w.map((wi, i) => wi * y[i])) / sw;
    const Q = sum(w.map((wi, i) => wi * (y[i] - mu) ** 2));
    const c = sw - sum(w.map((x) => x * x)) / sw;
    return Math.max(0, (Q - (y.length - 1)) / c);
  }
  /** Restricted maximum-likelihood τ² by Fisher scoring (starting from DL). */
  function tau2REML(y, v) {
    let t2 = tau2DL(y, v);
    for (let it = 0; it < 200; it++) {
      const w = v.map((x) => 1 / (x + t2));
      const sw = sum(w);
      const mu = sum(w.map((wi, i) => wi * y[i])) / sw;
      const sw2 = sum(w.map((x) => x * x));
      const sw3 = sum(w.map((x) => x * x * x));
      const score = 0.5 * (-sw + sw2 / sw + sum(w.map((wi, i) => wi * wi * (y[i] - mu) ** 2)));
      const info = 0.5 * (sw2 - (2 * sw3) / sw + (sw2 * sw2) / (sw * sw));
      let next = t2 + score / info;
      if (!Number.isFinite(next)) break;
      next = Math.max(0, next);
      if (Math.abs(next - t2) < 1e-10) { t2 = next; break; }
      t2 = next;
    }
    return t2;
  }

  /**
   * Pool effect sizes. opts: {method: 'FE' | 'DL' | 'REML', test: 'z' | 'knha', level: 0.95}.
   * Returns estimate, SE, CI, z/t & p, τ², Q (+p), I², H², prediction interval and study weights.
   */
  function metaAnalyze(y, v, { method = 'REML', test = 'z', level = 0.95 } = {}) {
    const k = y.length;
    if (k < 1) return null;
    const tau2 = method === 'FE' || k < 2 ? 0 : method === 'DL' ? tau2DL(y, v) : tau2REML(y, v);
    const w = v.map((x) => 1 / (x + tau2));
    const sw = sum(w);
    const mu = sum(w.map((wi, i) => wi * y[i])) / sw;
    let se = Math.sqrt(1 / sw);
    const w0 = v.map((x) => 1 / x);
    const sw0 = sum(w0);
    const mu0 = sum(w0.map((wi, i) => wi * y[i])) / sw0;
    const Q = sum(w0.map((wi, i) => wi * (y[i] - mu0) ** 2));
    const dfQ = k - 1;
    const QP = k > 1 ? 1 - chi2Cdf(Q, dfQ) : NaN;
    // typical within-study variance (Higgins & Thompson) → I² from τ²
    const s2 = k > 1 ? (dfQ * sw0) / (sw0 * sw0 - sum(w0.map((x) => x * x))) : NaN;
    const I2 = method === 'FE' ? Math.max(0, (Q - dfQ) / Q) : tau2 / (tau2 + s2);
    const H2 = method === 'FE' ? Q / dfQ : (tau2 + s2) / s2;
    let crit;
    let stat;
    let p;
    const alpha = 1 - level;
    if (test === 'knha' && k > 1) {
      const qk = sum(w.map((wi, i) => wi * (y[i] - mu) ** 2)) / dfQ;
      se *= Math.sqrt(Math.max(qk, 1e-12));
      crit = tInv(1 - alpha / 2, dfQ);
      stat = mu / se;
      p = 2 * (1 - tCdf(Math.abs(stat), dfQ));
    } else {
      crit = normInv(1 - alpha / 2);
      stat = mu / se;
      p = 2 * (1 - normCdf(Math.abs(stat)));
    }
    const piCrit = k > 2 ? tInv(1 - alpha / 2, k - 2) : crit;
    const piHalf = piCrit * Math.sqrt(tau2 + se * se);
    return {
      k, method, test, mu, se, lo: mu - crit * se, hi: mu + crit * se, stat, p, tau2, tau: Math.sqrt(tau2),
      Q, dfQ, QP, I2: Math.max(0, I2), H2, piLo: mu - piHalf, piHi: mu + piHalf,
      weights: w.map((x) => x / sw),
    };
  }

  /** Egger's regression test: z_i = y_i/se_i regressed on 1/se_i; intercept ≠ 0 signals small-study effects. */
  function eggerTest(y, v) {
    const k = y.length;
    if (k < 3) return null;
    const X = v.map((x) => 1 / Math.sqrt(x));
    const Z = y.map((yi, i) => yi * X[i]);
    const mx = sum(X) / k;
    const mz = sum(Z) / k;
    let sxx = 0;
    let sxz = 0;
    for (let i = 0; i < k; i++) { sxx += (X[i] - mx) ** 2; sxz += (X[i] - mx) * (Z[i] - mz); }
    const b1 = sxz / sxx;
    const b0 = mz - b1 * mx;
    let rss = 0;
    for (let i = 0; i < k; i++) rss += (Z[i] - b0 - b1 * X[i]) ** 2;
    const s2 = rss / (k - 2);
    const seB0 = Math.sqrt(s2 * (1 / k + (mx * mx) / sxx));
    const t = b0 / seB0;
    return { intercept: b0, slope: b1, se: seB0, t, df: k - 2, p: 2 * (1 - tCdf(Math.abs(t), k - 2)) };
  }

  /** PET: weighted regression of y on SE (weights 1/v); the intercept estimates the effect of an infinitely precise study. */
  function petEstimate(y, v) {
    const k = y.length;
    if (k < 3) return null;
    const se = v.map(Math.sqrt);
    const w = v.map((x) => 1 / x);
    const sw = sum(w);
    const mx = sum(w.map((wi, i) => wi * se[i])) / sw;
    const my = sum(w.map((wi, i) => wi * y[i])) / sw;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < k; i++) { sxx += w[i] * (se[i] - mx) ** 2; sxy += w[i] * (se[i] - mx) * (y[i] - my); }
    const b1 = sxy / sxx;
    return { estimate: my - b1 * mx, slope: b1 };
  }

  /**
   * Duval & Tweedie trim-and-fill (L0 estimator). side: 'left' fills studies missing on the left
   * (the usual case when small studies with large positive effects are over-represented).
   */
  function trimAndFill(y, v, { method = 'REML', side = 'auto' } = {}) {
    const k = y.length;
    if (k < 3) return null;
    if (side === 'auto') {
      const eg = eggerTest(y, v);
      side = eg && eg.intercept < 0 ? 'right' : 'left';
    }
    const sgn = side === 'left' ? 1 : -1; // flip so the missing studies are always on the left
    const ys = y.map((x) => x * sgn);
    const order = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b]);
    let k0 = 0;
    let mu = 0;
    for (let it = 0; it < 100; it++) {
      const keep = order.slice(0, k - k0);
      mu = metaAnalyze(keep.map((i) => ys[i]), keep.map((i) => v[i]), { method }).mu;
      const dev = ys.map((x) => x - mu);
      const idx = dev.map((_, i) => i).sort((a, b) => Math.abs(dev[a]) - Math.abs(dev[b]));
      const rank = new Array(k);
      idx.forEach((i, r) => (rank[i] = r + 1));
      let Tn = 0;
      for (let i = 0; i < k; i++) if (dev[i] > 0) Tn += rank[i];
      const L0 = (4 * Tn - k * (k + 1)) / (2 * k - 1);
      const next = Math.max(0, Math.min(k - 1, Math.round(L0)));
      if (next === k0) break;
      k0 = next;
    }
    const filled = [];
    for (let j = 0; j < k0; j++) {
      const i = order[k - 1 - j];
      filled.push({ yi: sgn * (2 * mu - ys[i]), vi: v[i], mirrorOf: i });
    }
    const all = metaAnalyze([...y, ...filled.map((f) => f.yi)], [...v, ...filled.map((f) => f.vi)], { method });
    return { k0, side, filled, adjusted: all };
  }

  function leaveOneOut(y, v, opts) {
    return y.map((_, i) => metaAnalyze(y.filter((_, j) => j !== i), v.filter((_, j) => j !== i), opts));
  }
  function cumulative(y, v, order, opts) {
    return order.map((_, n) => metaAnalyze(order.slice(0, n + 1).map((i) => y[i]), order.slice(0, n + 1).map((i) => v[i]), opts));
  }

  // ================================================================== power analysis
  /**
   * Power of common designs. design: 'two' (independent t, n per group), 'one' (one-sample / paired t),
   * 'prop' (two proportions, normal approx.; es = [p1, p2]), 'corr' (Pearson r via Fisher z).
   */
  function power(design, es, n, alpha = 0.05, tails = 2) {
    const a = tails === 2 ? alpha / 2 : alpha;
    if (design === 'two' || design === 'one') {
      const df = design === 'two' ? 2 * n - 2 : n - 1;
      if (df < 1) return NaN;
      const ncp = design === 'two' ? es * Math.sqrt(n / 2) : es * Math.sqrt(n);
      const tc = tInv(1 - a, df);
      const up = 1 - nctCdf(tc, df, ncp);
      return tails === 2 ? up + nctCdf(-tc, df, ncp) : up;
    }
    if (design === 'prop') {
      const [p1, p2] = es;
      const pb = (p1 + p2) / 2;
      const z = normInv(1 - a);
      const sd1 = Math.sqrt(2 * pb * (1 - pb));
      const sd = Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
      const diff = Math.abs(p1 - p2) * Math.sqrt(n);
      const up = normCdf((diff - z * sd1) / sd);
      return tails === 2 ? up + normCdf((-diff - z * sd1) / sd) : up;
    }
    if (design === 'corr') {
      if (n < 4) return NaN;
      const zr = Math.atanh(es) * Math.sqrt(n - 3);
      const z = normInv(1 - a);
      return tails === 2 ? normCdf(zr - z) + normCdf(-zr - z) : normCdf(zr - z);
    }
    return NaN;
  }
  /** Smallest n (per group for 'two'/'prop') reaching the target power. */
  function requiredN(design, es, target = 0.8, alpha = 0.05, tails = 2) {
    const minN = design === 'corr' ? 4 : 2;
    let lo = minN;
    let hi = minN;
    while (power(design, es, hi, alpha, tails) < target) {
      hi *= 2;
      if (hi > 1e7) return Infinity;
    }
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (power(design, es, mid, alpha, tails) >= target) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  // ================================================================== simulation
  /** Simulate `sims` two-group experiments (n per group, true d). Returns observed d, t, p for each. */
  function simulateExperiments(d, n, sims, rng) {
    const out = [];
    for (let s = 0; s < sims; s++) {
      let s1 = 0, q1 = 0, s2 = 0, q2 = 0;
      for (let i = 0; i < n; i++) {
        const a = rng.gauss(d, 1);
        const b = rng.gauss(0, 1);
        s1 += a; q1 += a * a; s2 += b; q2 += b * b;
      }
      const m1 = s1 / n;
      const m2 = s2 / n;
      const v1 = (q1 - n * m1 * m1) / (n - 1);
      const v2 = (q2 - n * m2 * m2) / (n - 1);
      const sp = Math.sqrt((v1 + v2) / 2);
      const t = (m1 - m2) / (sp * Math.sqrt(2 / n));
      out.push({ d: (m1 - m2) / sp, t, p: 2 * (1 - tCdf(Math.abs(t), 2 * n - 2)) });
    }
    return out;
  }

  /**
   * Simulate a research literature: `attempts` studies with true effects θ ~ N(delta, tau²), group sizes
   * uniform in [nMin, nMax]. Positive significant results are always published; others with probability
   * pubNonSig. With hacking = h > 1, each study measures h outcomes and reports the most significant.
   */
  function simulateLiterature({ delta = 0.2, tau = 0.1, attempts = 80, nMin = 10, nMax = 120, pubNonSig = 0.2, hacking = 1, seed = 1 } = {}) {
    const rng = LM.makeRng(seed);
    const studies = [];
    for (let s = 0; s < attempts; s++) {
      const n = nMin + rng.int(nMax - nMin + 1);
      const theta = rng.gauss(delta, tau);
      let best = null;
      for (let h = 0; h < Math.max(1, hacking); h++) {
        const vTrue = 2 / n + (theta * theta) / (4 * n);
        const g = rng.gauss(theta, Math.sqrt(vTrue));
        const vi = 2 / n + (g * g) / (4 * n);
        const z = g / Math.sqrt(vi);
        const p = 2 * (1 - normCdf(Math.abs(z)));
        if (!best || z > best.z) best = { yi: g, vi, z, p };
      }
      const sig = best.p < 0.05 && best.yi > 0;
      const published = sig || rng.next() < pubNonSig;
      studies.push({ id: s + 1, n, theta, ...best, sig, published });
    }
    return studies;
  }

  // ================================================================== datasets
  /** BCG vaccine trials (Colditz et al., 1994): tuberculosis cases in vaccinated vs control groups. */
  const BCG = [
    ['Aronson', 1948, 4, 119, 11, 128, 44],
    ['Ferguson & Simes', 1949, 6, 300, 29, 274, 55],
    ['Rosenthal et al.', 1960, 3, 228, 11, 209, 42],
    ['Hart & Sutherland', 1977, 62, 13536, 248, 12619, 52],
    ['Frimodt-Moller et al.', 1973, 33, 5036, 47, 5761, 13],
    ['Stein & Aronson', 1953, 180, 1361, 372, 1079, 44],
    ['Vandiviere et al.', 1973, 8, 2537, 10, 619, 19],
    ['TPT Madras', 1980, 505, 87886, 499, 87892, 13],
    ['Coetzee & Berjak', 1968, 29, 7470, 45, 7232, 27],
    ['Rosenthal et al.', 1961, 17, 1699, 65, 1600, 42],
    ['Comstock et al.', 1974, 186, 50448, 141, 27197, 18],
    ['Comstock & Webster', 1969, 5, 2493, 3, 2338, 33],
    ['Comstock et al.', 1976, 27, 16886, 29, 17825, 33],
  ].map(([study, year, tpos, tneg, cpos, cneg, ablat]) => ({ study, year, tpos, tneg, cpos, cneg, ablat, ...logRR(tpos, tneg, cpos, cneg) }));

  return {
    normCdf, normPdf, normInv, lgamma, ibeta, tCdf, tInv, gammaP, chi2Cdf, nctCdf,
    logRR, logOR, hedgesG, tau2DL, tau2REML, metaAnalyze, eggerTest, petEstimate, trimAndFill, leaveOneOut, cumulative,
    power, requiredN, simulateExperiments, simulateLiterature, BCG,
  };
});
