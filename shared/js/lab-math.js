/* ==========================================================================
   LabMath — small, dependency-free numerics shared by the portfolio apps.
   UMD: works as a classic <script> (window.LabMath) and in Node (require).
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LabMath = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------ scalar helpers
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const mapRange = (v, a0, a1, b0, b1) => b0 + ((v - a0) * (b1 - b0)) / (a1 - a0);
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const wrapAngle = (a) => {
    // wrap to (-pi, pi]
    a = (a + Math.PI) % (2 * Math.PI);
    if (a < 0) a += 2 * Math.PI;
    return a - Math.PI;
  };
  const deg = (r) => (r * 180) / Math.PI;
  const rad = (d) => (d * Math.PI) / 180;
  const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

  // ------------------------------------------------------------ random numbers
  /** Mulberry32: tiny, fast, seedable PRNG returning floats in [0, 1). */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Seedable RNG with convenience distributions. */
  function makeRng(seed = 12345) {
    const next = mulberry32(seed);
    let spare = null;
    const rng = {
      next,
      uniform: (a = 0, b = 1) => a + (b - a) * next(),
      int: (n) => Math.floor(next() * n),
      pick: (arr) => arr[Math.floor(next() * arr.length)],
      /** Standard normal via Marsaglia polar method. */
      gauss(mean = 0, sd = 1) {
        if (spare !== null) {
          const s = spare;
          spare = null;
          return mean + sd * s;
        }
        let u, v, s;
        do {
          u = next() * 2 - 1;
          v = next() * 2 - 1;
          s = u * u + v * v;
        } while (s >= 1 || s === 0);
        const m = Math.sqrt((-2 * Math.log(s)) / s);
        spare = v * m;
        return mean + sd * u * m;
      },
      /** Poisson sample (Knuth for small lambda, normal approximation for large). */
      poisson(lambda) {
        if (lambda < 30) {
          const L = Math.exp(-lambda);
          let k = 0;
          let p = 1;
          do {
            k++;
            p *= next();
          } while (p > L);
          return k - 1;
        }
        return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * rng.gauss()));
      },
      shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          const t = arr[i];
          arr[i] = arr[j];
          arr[j] = t;
        }
        return arr;
      },
    };
    return rng;
  }

  // ------------------------------------------------------------ FFT
  const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;
  const nextPow2 = (n) => {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  };

  const twiddleCache = new Map();
  function twiddles(n) {
    let t = twiddleCache.get(n);
    if (!t) {
      const cos = new Float64Array(n / 2);
      const sin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) {
        cos[i] = Math.cos((2 * Math.PI * i) / n);
        sin[i] = Math.sin((2 * Math.PI * i) / n);
      }
      t = { cos, sin };
      twiddleCache.set(n, t);
    }
    return t;
  }

  /**
   * In-place iterative radix-2 Cooley–Tukey FFT.
   * Forward uses e^{-i2πkn/N}; inverse uses e^{+i2πkn/N} and scales by 1/N.
   */
  function fft(re, im, inverse = false) {
    const n = re.length;
    if (!isPow2(n)) throw new Error('fft: length must be a power of two, got ' + n);
    // bit reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const { cos, sin } = twiddles(n);
    const s = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k];
          const wi = s * sin[k];
          const a = i + j;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }

  /** 2-D FFT of a row-major w×h complex image (both powers of two), in place. */
  function fft2d(re, im, w, h, inverse = false) {
    const rr = new Float64Array(w);
    const ri = new Float64Array(w);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        rr[x] = re[o + x];
        ri[x] = im[o + x];
      }
      fft(rr, ri, inverse);
      for (let x = 0; x < w; x++) {
        re[o + x] = rr[x];
        im[o + x] = ri[x];
      }
    }
    const cr = new Float64Array(h);
    const ci = new Float64Array(h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        cr[y] = re[y * w + x];
        ci[y] = im[y * w + x];
      }
      fft(cr, ci, inverse);
      for (let y = 0; y < h; y++) {
        re[y * w + x] = cr[y];
        im[y * w + x] = ci[y];
      }
    }
  }

  /** Swap quadrants so the zero frequency sits in the centre (works both ways for even sizes). */
  function fftshift2d(arr, w, h) {
    const out = new arr.constructor(arr.length);
    const hw = w >> 1;
    const hh = h >> 1;
    for (let y = 0; y < h; y++) {
      const yy = (y + hh) % h;
      for (let x = 0; x < w; x++) out[yy * w + ((x + hw) % w)] = arr[y * w + x];
    }
    return out;
  }

  // ------------------------------------------------------------ statistics / image metrics
  function mean(a) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }
  function std(a, m = mean(a)) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / a.length);
  }
  function minMax(a) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return [lo, hi];
  }
  function rmse(a, b, mask) {
    let s = 0;
    let n = 0;
    for (let i = 0; i < a.length; i++) {
      if (mask && !mask[i]) continue;
      const d = a[i] - b[i];
      s += d * d;
      n++;
    }
    return Math.sqrt(s / Math.max(1, n));
  }
  /** Peak signal-to-noise ratio in dB using the reference's dynamic range. */
  function psnr(ref, test, mask) {
    const [lo, hi] = minMax(ref);
    const e = rmse(ref, test, mask);
    if (e === 0) return Infinity;
    return 20 * Math.log10((hi - lo) / e);
  }
  /**
   * Mean SSIM over non-overlapping 8×8 windows (Wang et al. 2004 constants),
   * a light-weight approximation of the Gaussian-window SSIM.
   */
  function ssim(ref, test, w, h, win = 8) {
    const [lo, hi] = minMax(ref);
    const L = hi - lo || 1;
    const c1 = (0.01 * L) ** 2;
    const c2 = (0.03 * L) ** 2;
    let total = 0;
    let count = 0;
    for (let by = 0; by + win <= h; by += win / 2) {
      for (let bx = 0; bx + win <= w; bx += win / 2) {
        let mx = 0;
        let my = 0;
        for (let y = by; y < by + win; y++) {
          for (let x = bx; x < bx + win; x++) {
            mx += ref[y * w + x];
            my += test[y * w + x];
          }
        }
        const n = win * win;
        mx /= n;
        my /= n;
        let vx = 0;
        let vy = 0;
        let cxy = 0;
        for (let y = by; y < by + win; y++) {
          for (let x = bx; x < bx + win; x++) {
            const dx = ref[y * w + x] - mx;
            const dy = test[y * w + x] - my;
            vx += dx * dx;
            vy += dy * dy;
            cxy += dx * dy;
          }
        }
        vx /= n - 1;
        vy /= n - 1;
        cxy /= n - 1;
        total += ((2 * mx * my + c1) * (2 * cxy + c2)) / ((mx * mx + my * my + c1) * (vx + vy + c2));
        count++;
      }
    }
    return total / count;
  }

  // ------------------------------------------------------------ linear algebra (small dense)
  /** Solve A x = b with partial pivoting. A is an array of rows (copied). */
  function solve(A, b) {
    const n = A.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-14) throw new Error('solve: singular matrix');
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x;
  }

  /** Inverse via Gauss–Jordan elimination with partial pivoting. */
  function invert(A) {
    const n = A.length;
    const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-14) throw new Error('invert: singular matrix');
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c];
      for (let k = 0; k < 2 * n; k++) M[c][k] /= d;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c];
        if (f === 0) continue;
        for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row) => row.slice(n));
  }

  const matmul = (A, B) =>
    A.map((row) => B[0].map((_, j) => row.reduce((s, v, k) => s + v * B[k][j], 0)));
  const transpose = (A) => A[0].map((_, j) => A.map((row) => row[j]));

  /** Eigen-decomposition of a real symmetric matrix (cyclic Jacobi). Returns {values, vectors(columns)}. */
  function eigSym(S, maxSweeps = 60) {
    const n = S.length;
    const A = S.map((r) => r.slice());
    const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < maxSweeps; sweep++) {
      let off = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
      if (off < 1e-20) break;
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          if (Math.abs(A[p][q]) < 1e-300) continue;
          const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1);
          const s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = A[k][p];
            const akq = A[k][q];
            A[k][p] = c * akp - s * akq;
            A[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = A[p][k];
            const aqk = A[q][k];
            A[p][k] = c * apk - s * aqk;
            A[q][k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = V[k][p];
            const vkq = V[k][q];
            V[k][p] = c * vkp - s * vkq;
            V[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    const values = A.map((r, i) => r[i]);
    const order = values.map((v, i) => i).sort((a, b) => values[b] - values[a]);
    return {
      values: order.map((i) => values[i]),
      vectors: V.map((row) => order.map((i) => row[i])),
    };
  }

  // ------------------------------------------------------------ axis ticks
  function niceNum(range, round) {
    const exp = Math.floor(Math.log10(range));
    const f = range / 10 ** exp;
    let nf;
    if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
    else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * 10 ** exp;
  }
  /** "Nice" linear axis ticks covering [lo, hi]. */
  function niceTicks(lo, hi, maxTicks = 6) {
    if (!isFinite(lo) || !isFinite(hi)) return { ticks: [], step: 1 };
    if (hi === lo) {
      hi = lo + 1;
      lo = lo - 1;
    }
    const step = niceNum((hi - lo) / Math.max(1, maxTicks - 1), true);
    const start = Math.ceil(lo / step - 1e-9) * step;
    const ticks = [];
    for (let v = start; v <= hi + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return { ticks, step };
  }

  return {
    clamp, lerp, mapRange, smoothstep, wrapAngle, deg, rad, sign,
    mulberry32, makeRng,
    isPow2, nextPow2, fft, fft2d, fftshift2d,
    mean, std, minMax, rmse, psnr, ssim,
    solve, invert, matmul, transpose, eigSym,
    niceNum, niceTicks,
  };
});
