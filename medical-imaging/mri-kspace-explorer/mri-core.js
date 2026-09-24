/* ==========================================================================
   k-Space Explorer core — procedural brain phantom, MR signal equations,
   k-space sampling patterns, artefacts and reconstruction (zero-filled,
   FISTA compressed sensing with Haar wavelets, POCS partial Fourier).
   No DOM — unit-testable in Node (needs LabMath for FFTs).
   ========================================================================== */
(function (root, factory) {
  const api = factory(root.LabMath || (typeof require === 'function' ? require('../../shared/js/lab-math.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MRICore = api;
})(typeof self !== 'undefined' ? self : this, function (LM) {
  'use strict';

  // Relaxation parameters at 1.5 T (literature-typical values).
  const TISSUES = [
    { key: 'csf', name: 'CSF', PD: 1.0, T1: 4000, T2: 2000, color: '#38bdf8' },
    { key: 'gm', name: 'Grey matter', PD: 0.86, T1: 1300, T2: 100, color: '#a78bfa' },
    { key: 'wm', name: 'White matter', PD: 0.72, T1: 800, T2: 80, color: '#e8edfb' },
    { key: 'fat', name: 'Scalp fat', PD: 1.0, T1: 260, T2: 80, color: '#fbbf24' },
    { key: 'marrow', name: 'Bone marrow', PD: 0.85, T1: 300, T2: 60, color: '#fb923c' },
    { key: 'bone', name: 'Cortical bone', PD: 0.05, T1: 1000, T2: 1, color: '#64748b' },
    { key: 'tumor', name: 'Tumour', PD: 0.9, T1: 1500, T2: 120, color: '#f472b6' },
    { key: 'edema', name: 'Oedema', PD: 0.95, T1: 1700, T2: 220, color: '#34d399' },
  ];
  const IDX = Object.fromEntries(TISSUES.map((t, i) => [t.key, i]));

  // ------------------------------------------------------------------ signal equations
  /**
   * Steady-state magnitude signal of one tissue.
   * SE : PD·(1 − e^(−TR/T1))·e^(−TE/T2)
   * IR : PD·|1 − 2e^(−TI/T1) + e^(−TR/T1)|·e^(−TE/T2)
   * GRE: PD·sinα·(1 − E1)/(1 − cosα·E1)·e^(−TE/T2*),  T2* ≈ 0.6·T2
   */
  function signal(t, seq) {
    const E1 = Math.exp(-seq.TR / t.T1);
    if (seq.type === 'IR') return t.PD * Math.abs(1 - 2 * Math.exp(-seq.TI / t.T1) + E1) * Math.exp(-seq.TE / t.T2);
    if (seq.type === 'GRE') {
      const a = (seq.flip * Math.PI) / 180;
      return (t.PD * Math.sin(a) * (1 - E1)) / (1 - Math.cos(a) * E1) * Math.exp(-seq.TE / (0.6 * t.T2));
    }
    return t.PD * (1 - E1) * Math.exp(-seq.TE / t.T2);
  }

  // ------------------------------------------------------------------ procedural brain phantom
  const ellipse = (u, v, cx, cy, a, b, rotDeg) => {
    const r = (rotDeg * Math.PI) / 180;
    const dx = u - cx;
    const dy = v - cy;
    const x = dx * Math.cos(r) + dy * Math.sin(r);
    const y = -dx * Math.sin(r) + dy * Math.cos(r);
    return (x * x) / (a * a) + (y * y) / (b * b) <= 1;
  };
  // smooth, seamless 3-D value noise in [0, 1]
  const h3 = (i, j, k) => {
    const x = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const fade = (t) => t * t * (3 - 2 * t);
  function vnoise(x, y, z) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const u = fade(x - xi);
    const v = fade(y - yi);
    const w = fade(z - zi);
    const L = (a, b, t) => a + (b - a) * t;
    return L(
      L(L(h3(xi, yi, zi), h3(xi + 1, yi, zi), u), L(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), u), v),
      L(L(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), u), L(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), u), v),
      w
    );
  }

  /** Tissue label at normalised position (u right, v anterior/up), both in [−1, 1]. −1 = air. */
  function classify(u, v, lesion) {
    const cy = -0.02;
    const dx = u;
    const dy = v - cy;
    const r = Math.hypot(dx, dy);
    const th = Math.atan2(dy, dx);
    const ax = 0.74;
    const ay = 0.9;
    const rEll = 1 / Math.sqrt((Math.cos(th) / ax) ** 2 + (Math.sin(th) / ay) ** 2);
    const rHead = rEll * (1 + 0.012 * Math.sin(3 * th + 0.4) + 0.008 * Math.sin(5 * th + 1.1));
    const depth = rHead - r;
    if (depth < 0) return -1;
    if (depth < 0.034) return IDX.fat;
    if (depth < 0.046) return IDX.bone;
    if (depth < 0.062) return IDX.marrow;
    if (depth < 0.074) return IDX.bone;
    if (depth < 0.082) return IDX.csf;
    const d = depth - 0.082; // depth below the smooth brain envelope

    // ---- ventricles and deep grey matter
    const inAny = (list) => list.some((e) => ellipse(u, v, ...e));
    const ventricles = [
      [-0.068, 0.2, 0.038, 0.14, 16], [0.068, 0.2, 0.038, 0.14, -16], // frontal horns
      [0, -0.01, 0.011, 0.07, 0], // third ventricle
      [-0.15, -0.3, 0.036, 0.12, -24], [0.15, -0.3, 0.036, 0.12, 24], // occipital horns
    ];
    if (inAny(ventricles)) return IDX.csf;
    const deepGM = [
      [-0.13, 0.245, 0.042, 0.075, 16], [0.13, 0.245, 0.042, 0.075, -16], // caudate heads
      [-0.072, -0.04, 0.056, 0.1, 4], [0.072, -0.04, 0.056, 0.1, -4], // thalami
      [-0.245, 0.06, 0.05, 0.13, 10], [0.245, 0.06, 0.05, 0.13, -10], // lentiform nuclei
    ];

    // ---- lesion: tumour core + vasogenic oedema confined to white matter
    let edema = false;
    if (lesion) {
      const nl = vnoise(u * 14 + 3.1, v * 14 + 7.7, 1.3);
      if (ellipse(u, v, -0.3, 0.33, 0.055 + 0.012 * nl, 0.05 + 0.012 * nl, 20)) return IDX.tumor;
      const ne = vnoise(u * 9 + 11.3, v * 9 + 2.2, 4.1);
      if (ellipse(u, v, -0.3, 0.33, 0.1 + 0.07 * ne, 0.09 + 0.06 * ne, 20)) edema = true;
    }

    // ---- interhemispheric fissure (falx)
    const wig = 0.006 * Math.sin(v * 23);
    if (Math.abs(u - wig) < 0.007 && (v > 0.37 || v < -0.47)) return IDX.csf;
    const nearFissure = Math.abs(u - wig) < 0.03 && (v > 0.34 || v < -0.44);

    // ---- cortical folding: an explicit ring of curved sulci of varying depth.
    // Grey matter is the band within T_GM of any CSF surface (brain envelope or sulcal cleft),
    // so every gyrus becomes a finger of white matter wrapped in a cortical ribbon.
    const T_GM = 0.022;
    const sArc = ((th + 2 * Math.PI) % (2 * Math.PI)) * SULCI.Rm;
    const P = SULCI.P;
    let best = Infinity;
    let inCSF = false;
    const n = SULCI.list.length;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (SULCI.list[mid].s < sArc) lo = mid + 1;
      else hi = mid;
    }
    for (let q = -2; q <= 2; q++) {
      const sc = SULCI.list[(lo + q + n) % n];
      const off = sc.bend * 1.4 * d * d + sc.amp * Math.sin(40 * d + sc.wig) * Math.min(1, d / 0.03);
      let ds = sArc - (sc.s + off);
      ds -= P * Math.round(ds / P);
      ds = Math.abs(ds);
      const w = 0.008 + 0.018 * Math.exp(-d / 0.012); // sulcal mouths widen into the subarachnoid space
      if (d < sc.D && ds < w / 2) inCSF = true;
      const dist = d < sc.D ? ds - w / 2 : Math.hypot(Math.max(0, ds - w / 2), d - sc.D);
      if (dist < best) best = dist;
      if (sc.branch && d > sc.bd - T_GM) {
        // oblique side branch leaving the main cleft at depth bd
        const dd = Math.max(0, d - sc.bd);
        const offB = sc.bend * 1.4 * sc.bd * sc.bd + sc.bs * dd;
        let db = sArc - (sc.s + offB);
        db -= P * Math.round(db / P);
        db = Math.abs(db) / Math.sqrt(1 + sc.bs * sc.bs);
        const inB = d >= sc.bd && d < sc.bD;
        if (inB && db < 0.004) inCSF = true;
        const distB = inB ? db - 0.004 : Math.hypot(Math.max(0, db - 0.004), d < sc.bd ? sc.bd - d : d - sc.bD);
        if (distB < best) best = distB;
      }
    }
    if (inCSF) return IDX.csf;
    const inCortex = d < T_GM || best < T_GM || nearFissure;
    if (inAny(deepGM)) return edema ? IDX.edema : IDX.gm;
    if (inCortex) return IDX.gm;
    return edema ? IDX.edema : IDX.wm;
  }

  /** Sulcal pattern, generated once (deterministic): irregular spacing, depth, curvature. */
  const SULCI = (() => {
    const Rm = 0.76;
    const P = 2 * Math.PI * Rm;
    const hash = (k) => {
      const x = Math.sin(k * 127.1 + 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    const raw = [];
    let s = 0;
    for (let k = 0; s < P; k++) {
      s += 0.075 + 0.055 * hash(k * 3 + 1);
      raw.push(s);
    }
    const scale = P / s;
    const list = raw.map((sv, i) => {
      const shallow = hash(i * 7 + 2) < 0.22;
      const D = shallow ? 0.03 + 0.02 * hash(i * 5 + 9) : 0.07 + 0.08 * hash(i * 11 + 4);
      const branch = !shallow && hash(i * 23 + 5) < 0.55;
      const bd = D * (0.35 + 0.3 * hash(i * 29 + 1));
      return {
        s: sv * scale,
        D,
        bend: (hash(i * 13 + 6) - 0.5) * 2,
        amp: 0.004 + 0.009 * hash(i * 19 + 3),
        wig: hash(i * 17 + 8) * 6.283,
        branch,
        bd,
        bD: bd + 0.035 + 0.035 * hash(i * 31 + 7),
        bs: (hash(i * 37 + 2) < 0.5 ? -1 : 1) * (0.5 + 0.5 * hash(i * 41 + 3)),
      };
    });
    // Sylvian fissures: the sulci nearest θ = 0 and θ = π run deep and straight
    for (const a of [0, Math.PI]) {
      const target = a * Rm;
      let bi = 0;
      for (let i = 1; i < list.length; i++) if (Math.abs(list[i].s - target) < Math.abs(list[bi].s - target)) bi = i;
      Object.assign(list[bi], { D: 0.2, bend: 0, amp: 0.003, branch: false });
    }
    return { Rm, P, list };
  })();

  /** Partial-volume tissue fractions on an N×N grid (2×2 supersampling). FOV ≈ 24 cm. */
  function makeBrain(N, { lesion = true } = {}) {
    const nT = TISSUES.length;
    const frac = Array.from({ length: nT }, () => new Float32Array(N * N));
    const ss = 2;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        for (let sj = 0; sj < ss; sj++) {
          const v = 1 - ((j + (sj + 0.5) / ss) / N) * 2;
          for (let si = 0; si < ss; si++) {
            const u = ((i + (si + 0.5) / ss) / N) * 2 - 1;
            const t = classify(u, v, lesion);
            if (t >= 0) frac[t][j * N + i] += 1 / (ss * ss);
          }
        }
      }
    }
    return { N, frac };
  }

  /** Complex image for a pulse sequence; optional smooth B0/coil phase. */
  function synthesize(brain, seq, { phase = true } = {}) {
    const { N, frac } = brain;
    const S = TISSUES.map((t) => signal(t, seq));
    const re = new Float64Array(N * N);
    const im = new Float64Array(N * N);
    for (let p = 0; p < N * N; p++) {
      let m = 0;
      for (let t = 0; t < frac.length; t++) m += frac[t][p] * S[t];
      if (phase && m > 0) {
        const i = p % N;
        const j = (p / N) | 0;
        const u = (i / N) * 2 - 1;
        const v = 1 - (j / N) * 2;
        const ph = 1.3 * (0.6 * u * u - 0.45 * v + 0.35 * u * v) + 0.4;
        re[p] = m * Math.cos(ph);
        im[p] = m * Math.sin(ph);
      } else re[p] = m;
    }
    return { re, im, signals: S };
  }

  // ------------------------------------------------------------------ centred FFTs
  /** k = F{x} with the DC term in the centre (checkerboard modulation trick). */
  function fftc(re, im, N) {
    const r = Float64Array.from(re);
    const i = Float64Array.from(im);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x + y) & 1) { r[y * N + x] = -r[y * N + x]; i[y * N + x] = -i[y * N + x]; }
    LM.fft2d(r, i, N, N, false);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x + y) & 1) { r[y * N + x] = -r[y * N + x]; i[y * N + x] = -i[y * N + x]; }
    return { re: r, im: i };
  }
  function ifftc(re, im, N) {
    const r = Float64Array.from(re);
    const i = Float64Array.from(im);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x + y) & 1) { r[y * N + x] = -r[y * N + x]; i[y * N + x] = -i[y * N + x]; }
    LM.fft2d(r, i, N, N, true);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x + y) & 1) { r[y * N + x] = -r[y * N + x]; i[y * N + x] = -i[y * N + x]; }
    return { re: r, im: i };
  }
  const magnitude = (c) => {
    const n = c.re.length;
    const m = new Float64Array(n);
    for (let p = 0; p < n; p++) m[p] = Math.hypot(c.re[p], c.im[p]);
    return m;
  };

  // ------------------------------------------------------------------ sampling patterns
  /**
   * Binary sampling mask (rows = phase-encode lines ky, columns = readout kx; DC at N/2).
   * Returns {mask, lines} where `lines` is the acquisition order used by the scan animation.
   */
  function makeMask(N, type, p, rng) {
    const mask = new Uint8Array(N * N);
    const c = N / 2;
    const rowsAll = () => {
      // centre-out ordering of phase-encode lines
      const order = [];
      for (let d = 0; order.length < N; d++) {
        const r = c + (d % 2 ? (d + 1) / 2 : -d / 2);
        if (r >= 0 && r < N) order.push(r);
      }
      return order;
    };
    const setRow = (r) => { for (let x = 0; x < N; x++) mask[r * N + x] = 1; };
    let lines = [];
    if (type === 'full') {
      lines = rowsAll().map((r) => ({ row: r }));
      lines.forEach((l) => setRow(l.row));
    } else if (type === 'lowpass') {
      const h = Math.max(1, Math.round((p.frac * N) / 2));
      for (const r of rowsAll()) {
        if (Math.abs(r - c) > h) continue;
        for (let x = 0; x < N; x++) if (Math.abs(x - c) <= h) mask[r * N + x] = 1;
        lines.push({ row: r, x0: c - h, x1: c + h });
      }
    } else if (type === 'highpass') {
      const rr = p.radius * c;
      for (const r of rowsAll()) {
        let any = false;
        for (let x = 0; x < N; x++) if (Math.hypot(x - c, r - c) >= rr) { mask[r * N + x] = 1; any = true; }
        if (any) lines.push({ row: r });
      }
    } else if (type === 'parallel') {
      const acs = p.acs ? 12 : 0;
      for (const r of rowsAll()) if ((r - c) % p.R === 0 || Math.abs(r - c) < acs) { setRow(r); lines.push({ row: r }); }
    } else if (type === 'random') {
      const acs = 12;
      const target = p.frac * N;
      // variable-density probability ∝ (1 − |ky|/kmax)^2, rescaled to hit the target number of lines
      const w = [];
      for (let r = 0; r < N; r++) w.push(Math.abs(r - c) < acs ? 0 : (1 - Math.abs(r - c) / c) ** 2);
      const sumW = w.reduce((s, v) => s + v, 0);
      const scale = Math.max(0, target - 2 * acs) / sumW;
      for (const r of rowsAll()) {
        if (Math.abs(r - c) < acs || rng.next() < Math.min(1, w[r] * scale)) { setRow(r); lines.push({ row: r }); }
      }
    } else if (type === 'radial') {
      const n = p.spokes;
      const golden = Math.PI * (3 - Math.sqrt(5)) * 0.5 + Math.PI / 2; // 111.25° golden-angle increment
      for (let s = 0; s < n; s++) {
        const a = (s * golden) % Math.PI;
        const pts = [];
        for (let t = -c; t < c; t += 0.5) {
          const x = Math.round(c + t * Math.cos(a));
          const y = Math.round(c + t * Math.sin(a));
          if (x >= 0 && y >= 0 && x < N && y < N) { mask[y * N + x] = 1; pts.push(y * N + x); }
        }
        lines.push({ spoke: a, pts });
      }
    } else if (type === 'pf') {
      const first = Math.round(N * (1 - p.pf));
      for (const r of rowsAll()) if (r >= first) { setRow(r); lines.push({ row: r }); }
    }
    return { mask, lines };
  }

  // ------------------------------------------------------------------ artefacts
  /**
   * Corrupt fully sampled k-space: complex Gaussian noise (σ in image units), a spike
   * (herring-bone artefact) and motion-induced phase errors on random phase-encode lines.
   */
  function corrupt(k, N, { noise = 0, spike = false, motion = false }, rng) {
    const re = Float64Array.from(k.re);
    const im = Float64Array.from(k.im);
    if (motion) {
      for (let r = 0; r < N; r++) {
        if (Math.abs(r - N / 2) < 6 || rng.next() > 0.35) continue;
        const ph = rng.uniform(-1.4, 1.4);
        const shift = rng.uniform(-3, 3); // pixels of rigid translation along x
        for (let x = 0; x < N; x++) {
          const a = ph + (2 * Math.PI * shift * (x - N / 2)) / N;
          const c = Math.cos(a);
          const s = Math.sin(a);
          const p = r * N + x;
          const R = re[p] * c - im[p] * s;
          im[p] = re[p] * s + im[p] * c;
          re[p] = R;
        }
      }
    }
    if (noise > 0) {
      const sk = noise * N; // unnormalised forward FFT: σ_k = σ_img · N
      for (let p = 0; p < N * N; p++) {
        re[p] += rng.gauss(0, sk / Math.SQRT2);
        im[p] += rng.gauss(0, sk / Math.SQRT2);
      }
    }
    if (spike) {
      let max = 0;
      for (let p = 0; p < N * N; p++) max = Math.max(max, Math.hypot(re[p], im[p]));
      const p = (N / 2 - 37) * N + (N / 2 + 52);
      re[p] += 0.06 * max;
      im[p] -= 0.03 * max;
    }
    return { re, im };
  }

  // ------------------------------------------------------------------ reconstruction
  function applyMask(k, mask) {
    const re = new Float64Array(k.re.length);
    const im = new Float64Array(k.im.length);
    for (let p = 0; p < mask.length; p++) if (mask[p]) { re[p] = k.re[p]; im[p] = k.im[p]; }
    return { re, im };
  }

  /** Orthonormal multi-level 2-D Haar transform (in place on a Float64Array, N power of two). */
  function haar2(x, N, levels, inverse) {
    const tmp = new Float64Array(N);
    const s = Math.SQRT1_2;
    const sizes = [];
    for (let l = 0, n = N; l < levels && n >= 2; l++, n >>= 1) sizes.push(n);
    if (inverse) sizes.reverse();
    for (const n of sizes) {
      const h = n >> 1;
      const pass = (get, set) => {
        if (!inverse) {
          for (let i = 0; i < h; i++) {
            const a = get(2 * i);
            const b = get(2 * i + 1);
            tmp[i] = (a + b) * s;
            tmp[h + i] = (a - b) * s;
          }
        } else {
          for (let i = 0; i < h; i++) {
            const a = get(i);
            const d = get(h + i);
            tmp[2 * i] = (a + d) * s;
            tmp[2 * i + 1] = (a - d) * s;
          }
        }
        for (let i = 0; i < n; i++) set(i, tmp[i]);
      };
      if (!inverse) {
        for (let r = 0; r < n; r++) pass((i) => x[r * N + i], (i, v) => (x[r * N + i] = v));
        for (let c = 0; c < n; c++) pass((i) => x[i * N + c], (i, v) => (x[i * N + c] = v));
      } else {
        for (let c = 0; c < n; c++) pass((i) => x[i * N + c], (i, v) => (x[i * N + c] = v));
        for (let r = 0; r < n; r++) pass((i) => x[r * N + i], (i, v) => (x[r * N + i] = v));
      }
    }
    return x;
  }

  /**
   * FISTA for  min_x ½‖M·F·x − y‖² + λ‖Ψx‖₁  with Ψ = 4-level Haar (complex soft-thresholding).
   * Step size 1 is exact because F is unitary up to scale and M is a projection.
   * Returns an iterator object: call step() repeatedly; `x` holds the current estimate.
   */
  function fistaCS(kMeasured, mask, N, lambdaRel) {
    const zf = ifftc(kMeasured.re, kMeasured.im, N);
    let maxv = 0;
    for (let p = 0; p < N * N; p++) maxv = Math.max(maxv, Math.hypot(zf.re[p], zf.im[p]));
    const lam = lambdaRel * maxv;
    let x = { re: Float64Array.from(zf.re), im: Float64Array.from(zf.im) };
    let z = { re: Float64Array.from(zf.re), im: Float64Array.from(zf.im) };
    let t = 1;
    const levels = 4;
    const coarse = N >> levels;
    return {
      get x() { return x; },
      step() {
        // gradient step = data consistency in k-space
        const kz = fftc(z.re, z.im, N);
        for (let p = 0; p < N * N; p++) if (mask[p]) { kz.re[p] = kMeasured.re[p]; kz.im[p] = kMeasured.im[p]; }
        const g = ifftc(kz.re, kz.im, N);
        // proximal step: soft-threshold Haar detail coefficients (complex magnitude)
        haar2(g.re, N, levels, false);
        haar2(g.im, N, levels, false);
        for (let j = 0; j < N; j++) {
          for (let i = 0; i < N; i++) {
            if (i < coarse && j < coarse) continue;
            const p = j * N + i;
            const m = Math.hypot(g.re[p], g.im[p]);
            const f = m > lam ? (m - lam) / m : 0;
            g.re[p] *= f;
            g.im[p] *= f;
          }
        }
        haar2(g.re, N, levels, true);
        haar2(g.im, N, levels, true);
        const tn = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
        const beta = (t - 1) / tn;
        for (let p = 0; p < N * N; p++) {
          const nr = g.re[p] + beta * (g.re[p] - x.re[p]);
          const ni = g.im[p] + beta * (g.im[p] - x.im[p]);
          z.re[p] = nr;
          z.im[p] = ni;
        }
        x = g;
        t = tn;
        return x;
      },
    };
  }

  /** POCS partial-Fourier reconstruction using the phase of a low-resolution, symmetric k-space centre. */
  function pocsPF(kMeasured, mask, N) {
    // symmetric centre band that is fully sampled
    let half = 0;
    while (half < N / 2 - 1 && mask[(N / 2 - half - 1) * N + N / 2] && mask[(N / 2 + half + 1) * N + N / 2]) half++;
    const lre = new Float64Array(N * N);
    const lim = new Float64Array(N * N);
    for (let r = N / 2 - half; r <= N / 2 + half; r++) {
      const w = 0.5 + 0.5 * Math.cos((Math.PI * (r - N / 2)) / (half + 1)); // Hann taper
      for (let x = 0; x < N; x++) { lre[r * N + x] = kMeasured.re[r * N + x] * w; lim[r * N + x] = kMeasured.im[r * N + x] * w; }
    }
    const low = ifftc(lre, lim, N);
    const phase = new Float64Array(N * N);
    for (let p = 0; p < N * N; p++) phase[p] = Math.atan2(low.im[p], low.re[p]);
    let x = ifftc(kMeasured.re, kMeasured.im, N);
    return {
      get x() { return x; },
      step() {
        const m = new Float64Array(N * N);
        for (let p = 0; p < N * N; p++) m[p] = Math.hypot(x.re[p], x.im[p]);
        const re = new Float64Array(N * N);
        const im = new Float64Array(N * N);
        for (let p = 0; p < N * N; p++) { re[p] = m[p] * Math.cos(phase[p]); im[p] = m[p] * Math.sin(phase[p]); }
        const k = fftc(re, im, N);
        for (let p = 0; p < N * N; p++) if (mask[p]) { k.re[p] = kMeasured.re[p]; k.im[p] = kMeasured.im[p]; }
        x = ifftc(k.re, k.im, N);
        return x;
      },
    };
  }

  return { TISSUES, IDX, signal, classify, makeBrain, synthesize, fftc, ifftc, magnitude, makeMask, corrupt, applyMask, haar2, fistaCS, pocsPF };
});
