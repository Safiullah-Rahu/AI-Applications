/* ==========================================================================
   TomoLab core — parallel-beam CT simulation and reconstruction.
   Phantoms are analytic (ellipses & rectangles) so projections are exact line
   integrals. Images are attenuation maps μ [1/cm]; display uses Hounsfield units.
   No DOM — unit-testable in Node.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CTCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MU_WATER = 0.19; // linear attenuation of water at ~70 keV [1/cm]
  const FOV = 25.6; // field of view [cm]
  const toHU = (mu) => 1000 * (mu / MU_WATER - 1);
  const fromHU = (hu) => MU_WATER * (1 + hu / 1000);

  // ------------------------------------------------------------------ phantoms
  // Shapes use normalised coordinates (radius 1 = FOV/2), y up, angles in degrees.
  // Values v are additive and relative to water (water = 1, air = 0, bone ≈ 2).
  const E = (v, a, b, x, y, rot = 0) => ({ type: 'ellipse', v, a, b, x, y, rot });
  const R = (v, hw, hh, x, y, rot = 0) => ({ type: 'rect', v, a: hw, b: hh, x, y, rot });

  function sheppLogan() {
    // Original Shepp–Logan (1974) head phantom: its values are already water-relative
    // (skull 2.0 ≈ +1000 HU, brain 1.02, ventricles 1.00); lesion contrast doubled for visibility.
    return [
      E(2.0, 0.69, 0.92, 0, 0),
      E(-0.98, 0.6624, 0.874, 0, -0.0184),
      E(-0.02, 0.11, 0.31, 0.22, 0, -18),
      E(-0.02, 0.16, 0.41, -0.22, 0, 18),
      E(0.02, 0.21, 0.25, 0, 0.35),
      E(0.02, 0.046, 0.046, 0, 0.1),
      E(0.02, 0.046, 0.046, 0, -0.1),
      E(0.02, 0.046, 0.023, -0.08, -0.605),
      E(0.02, 0.023, 0.023, 0, -0.606),
      E(0.02, 0.023, 0.046, 0.06, -0.605),
    ];
  }

  function thorax() {
    const s = [];
    s.push(E(0.95, 0.9, 0.62, 0, -0.02)); // body outline: subcutaneous fat (−50 HU)
    s.push(E(0.09, 0.84, 0.56, 0, -0.02)); // muscle / soft tissue (+40 HU)
    s.push(E(-0.89, 0.27, 0.4, -0.45, 0.03, -8)); // right lung (−850 HU)
    s.push(E(-0.89, 0.26, 0.38, 0.47, 0.02, 8)); // left lung
    s.push(E(0.88, 0.05, 0.05, -0.53, 0.16)); // lung nodule (+30 HU inside lung)
    s.push(E(0.02, 0.19, 0.21, 0.04, -0.02, 25)); // heart (+60 HU)
    s.push(E(0.2, 0.065, 0.065, -0.07, 0.24)); // ascending aorta, contrast (+260 HU)
    s.push(E(0.2, 0.055, 0.055, 0.11, -0.3)); // descending aorta
    s.push(E(0.56, 0.1, 0.085, 0, -0.43)); // vertebral body (+600 HU)
    s.push(E(-0.56, 0.042, 0.042, 0, -0.535)); // spinal canal
    s.push(E(0.62, 0.045, 0.028, 0, -0.535)); // lamina
    s.push(E(0.75, 0.028, 0.05, 0, -0.585)); // spinous process
    s.push(E(0.6, 0.075, 0.022, 0, 0.5)); // sternum
    // ribs around the chest wall
    for (const [x, y, r] of [[-0.72, 0.3, 25], [-0.8, 0.02, 80], [-0.66, -0.3, -35], [-0.4, -0.47, -20], [0.72, 0.3, -25], [0.8, 0.02, 100], [0.66, -0.3, 35], [0.4, -0.47, 20], [-0.34, 0.5, -10], [0.34, 0.5, 10]]) {
      s.push(E(0.8, 0.045, 0.025, x, y, r));
    }
    return s;
  }

  function hipImplants() {
    const s = [];
    s.push(E(1.0, 0.93, 0.6, 0, 0)); // pelvis soft tissue
    s.push(E(-0.08, 0.93, 0.6, 0, 0)); // fat blend
    s.push(E(0.12, 0.85, 0.52, 0, 0));
    s.push(E(0.03, 0.18, 0.14, 0, 0.12)); // bladder
    s.push(E(-0.7, 0.05, 0.05, 0, -0.3)); // rectal gas
    for (const sx of [-1, 1]) {
      s.push(E(0.75, 0.16, 0.16, sx * 0.47, -0.05)); // femoral head (bone)
      s.push(E(0.6, 0.1, 0.34, sx * 0.72, 0.05, sx * 15)); // acetabulum / ilium
      s.push(E(6.25, 0.065, 0.065, sx * 0.47, -0.05)); // Co-Cr prosthesis head (≈ +7000 HU)
    }
    return s;
  }

  function resolutionBars() {
    const s = [E(1.0, 0.86, 0.86, 0, 0)];
    const mm = 1 / ((FOV / 2) * 10); // 1 mm in normalised units
    const groups = [
      [1.0, -0.42, 0.38],
      [1.5, 0.38, 0.38],
      [2.0, -0.42, -0.34],
      [3.0, 0.38, -0.34],
    ];
    for (const [w, cx, cy] of groups) {
      for (let k = 0; k < 4; k++) s.push(R(1.0, (w * mm) / 2, 0.16, cx + (k - 1.5) * 2 * w * mm, cy));
    }
    // low-contrast discs (+10, +20, +40 HU) and a point-like bead
    s.push(E(0.01, 0.07, 0.07, -0.3, 0.02));
    s.push(E(0.02, 0.07, 0.07, 0, 0.02));
    s.push(E(0.04, 0.07, 0.07, 0.3, 0.02));
    s.push(E(1.5, 0.012, 0.012, 0, -0.62));
    return s;
  }

  const PHANTOMS = {
    thorax: { name: 'Thorax (chest CT)', shapes: thorax, window: [400, 40] },
    shepplogan: { name: 'Shepp–Logan head', shapes: sheppLogan, window: [120, 30] },
    hip: { name: 'Pelvis with metal hip implants', shapes: hipImplants, window: [600, 40] },
    bars: { name: 'Resolution & low-contrast test', shapes: resolutionBars, window: [300, 20] },
  };

  // ------------------------------------------------------------------ rasterisation
  function shapeTest(sh) {
    const r = (sh.rot * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    if (sh.type === 'ellipse') {
      const ia = 1 / (sh.a * sh.a);
      const ib = 1 / (sh.b * sh.b);
      return (x, y) => {
        const dx = x - sh.x;
        const dy = y - sh.y;
        const u = dx * c + dy * s;
        const v = -dx * s + dy * c;
        return u * u * ia + v * v * ib <= 1;
      };
    }
    return (x, y) => {
      const dx = x - sh.x;
      const dy = y - sh.y;
      return Math.abs(dx * c + dy * s) <= sh.a && Math.abs(-dx * s + dy * c) <= sh.b;
    };
  }

  /** Rasterise shapes to an N×N map of μ [1/cm] with 3×3 supersampling. */
  function rasterize(shapes, N) {
    const img = new Float32Array(N * N);
    const ss = 3;
    for (const sh of shapes) {
      const inside = shapeTest(sh);
      const ext = Math.max(sh.a, sh.b) * (sh.type === 'rect' ? Math.SQRT2 : 1);
      const i0 = Math.max(0, Math.floor(((sh.x - ext + 1) / 2) * N) - 1);
      const i1 = Math.min(N - 1, Math.ceil(((sh.x + ext + 1) / 2) * N) + 1);
      const j0 = Math.max(0, Math.floor(((1 - (sh.y + ext)) / 2) * N) - 1);
      const j1 = Math.min(N - 1, Math.ceil(((1 - (sh.y - ext)) / 2) * N) + 1);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          let hits = 0;
          for (let sj = 0; sj < ss; sj++) {
            const y = 1 - ((j + (sj + 0.5) / ss) / N) * 2;
            for (let si = 0; si < ss; si++) {
              const x = ((i + (si + 0.5) / ss) / N) * 2 - 1;
              if (inside(x, y)) hits++;
            }
          }
          if (hits) img[j * N + i] += (sh.v * MU_WATER * hits) / (ss * ss);
        }
      }
    }
    return img;
  }

  /** Circular reconstruction mask (1 inside the scan field of view). */
  function fovMask(N) {
    const m = new Uint8Array(N * N);
    const r2 = (N / 2) * (N / 2);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = i - N / 2 + 0.5;
        const y = N / 2 - 0.5 - j;
        if (x * x + y * y <= r2) m[j * N + i] = 1;
      }
    }
    return m;
  }

  // ------------------------------------------------------------------ geometry
  function makeAngles(K, rangeDeg, startDeg = 0) {
    const a = new Float64Array(K);
    for (let k = 0; k < K; k++) a[k] = ((startDeg + (k * rangeDeg) / K) * Math.PI) / 180;
    return a;
  }

  // ------------------------------------------------------------------ analytic projections
  /**
   * Exact parallel-beam line integrals of the shape phantom.
   * Returns Float32Array K×nd of p = ∫ μ dl (dimensionless). Each detector bin averages `sub` rays.
   * opts.motion: {dx, dy, fromView} rigid shift (normalised units) applied from that view on.
   */
  function projectAnalytic(shapes, angles, nd, opts = {}) {
    const K = angles.length;
    const sino = new Float32Array(K * nd);
    const scale = FOV / 2; // normalised → cm
    const sub = opts.sub || 3;
    const dt = 2 / nd; // bin width in normalised units
    for (let k = 0; k < K; k++) {
      const th = angles[k];
      const c = Math.cos(th);
      const s = Math.sin(th);
      const moved = opts.motion && k >= opts.motion.fromView;
      const mx = moved ? opts.motion.dx : 0;
      const my = moved ? opts.motion.dy : 0;
      for (const sh of shapes) {
        const x0 = sh.x + mx;
        const y0 = sh.y + my;
        const alpha = (sh.rot * Math.PI) / 180;
        const tc = x0 * c + y0 * s; // projection of the centre
        const w = sh.v * MU_WATER * scale;
        if (sh.type === 'ellipse') {
          const tp = th - alpha;
          const a2 = sh.a * sh.a * Math.cos(tp) ** 2 + sh.b * sh.b * Math.sin(tp) ** 2;
          const half = Math.sqrt(a2);
          const b0 = Math.max(0, Math.floor(((tc - half + 1) / 2) * nd) - 1);
          const b1 = Math.min(nd - 1, Math.ceil(((tc + half + 1) / 2) * nd) + 1);
          for (let b = b0; b <= b1; b++) {
            let acc = 0;
            for (let q = 0; q < sub; q++) {
              const t = -1 + (b + (q + 0.5) / sub) * dt;
              const d = t - tc;
              const r = a2 - d * d;
              if (r > 0) acc += (2 * sh.a * sh.b * Math.sqrt(r)) / a2;
            }
            sino[k * nd + b] += (w * acc) / sub;
          }
        } else {
          // rectangle: chord length of the line {x·c + y·s = t} through the rotated box
          const ca = Math.cos(alpha);
          const sa = Math.sin(alpha);
          const half = Math.abs(sh.a * (c * ca + s * sa)) + Math.abs(sh.b * (-c * sa + s * ca));
          const b0 = Math.max(0, Math.floor(((tc - half + 1) / 2) * nd) - 1);
          const b1 = Math.min(nd - 1, Math.ceil(((tc + half + 1) / 2) * nd) + 1);
          // line direction in the box frame
          const dx = -s * ca + c * sa;
          const dy = s * sa + c * ca;
          for (let b = b0; b <= b1; b++) {
            let acc = 0;
            for (let q = 0; q < sub; q++) {
              const t = -1 + (b + (q + 0.5) / sub) * dt;
              // point on the line closest to the origin, relative to the box centre, in the box frame
              const px = t * c - x0;
              const py = t * s - y0;
              const u0 = px * ca + py * sa;
              const v0 = -px * sa + py * ca;
              let lo = -Infinity;
              let hi = Infinity;
              for (const [p, d, lim] of [[u0, dx, sh.a], [v0, dy, sh.b]]) {
                if (Math.abs(d) < 1e-12) {
                  if (Math.abs(p) > lim) { lo = 1; hi = 0; }
                } else {
                  let t1 = (-lim - p) / d;
                  let t2 = (lim - p) / d;
                  if (t1 > t2) [t1, t2] = [t2, t1];
                  lo = Math.max(lo, t1);
                  hi = Math.min(hi, t2);
                }
              }
              if (hi > lo) acc += hi - lo;
            }
            sino[k * nd + b] += (w * acc) / sub;
          }
        }
      }
    }
    return sino;
  }

  // ------------------------------------------------------------------ numeric projector (ray-driven, bilinear)
  /** Line integrals of a pixel image μ (N×N, pixel size FOV/N) — used for uploaded images and SART. */
  function projectNumeric(img, N, angles, nd, out, views) {
    const K = angles.length;
    const sino = out || new Float32Array(K * nd);
    const ps = FOV / N;
    const Rr = N / 2;
    const c0 = N / 2 - 0.5;
    const list = views || Array.from({ length: K }, (_, k) => k);
    const ratio = N / nd;
    for (const k of list) {
      const c = Math.cos(angles[k]);
      const s = Math.sin(angles[k]);
      for (let b = 0; b < nd; b++) {
        const Tt = (b - nd / 2 + 0.5) * ratio; // in pixel units
        const lim2 = Rr * Rr - Tt * Tt;
        if (lim2 <= 0) {
          sino[k * nd + b] = 0;
          continue;
        }
        const Umax = Math.sqrt(lim2);
        let acc = 0;
        for (let U = -Umax + 0.5; U < Umax; U += 1) {
          const col = Tt * c - U * s + c0;
          const row = c0 - Tt * s - U * c;
          if (col < 0 || row < 0 || col >= N - 1 || row >= N - 1) continue;
          const i = col | 0; // non-negative, so truncation == floor
          const j = row | 0;
          const fx = col - i;
          const fy = row - j;
          const o = j * N + i;
          acc += (img[o] * (1 - fx) + img[o + 1] * fx) * (1 - fy) + (img[o + N] * (1 - fx) + img[o + N + 1] * fx) * fy;
        }
        sino[k * nd + b] = acc * ps;
      }
    }
    return sino;
  }

  // ------------------------------------------------------------------ measurement model
  /**
   * Poisson photon statistics: counts ~ Poisson(I0·e^(−p)), p̂ = −ln(max(counts, 0.5)/I0).
   * badBins: [{bin, gain}] multiplicative detector gain errors (ring artefacts).
   */
  function addNoise(sino, I0, rng, badBins = []) {
    const out = new Float32Array(sino.length);
    for (let i = 0; i < sino.length; i++) {
      if (!Number.isFinite(I0)) {
        out[i] = sino[i];
        continue;
      }
      const lam = I0 * Math.exp(-sino[i]);
      const n = rng.poisson(lam);
      out[i] = -Math.log(Math.max(n, 0.5) / I0);
    }
    if (badBins.length) {
      const nd = badBins[0].nd;
      const K = sino.length / nd;
      for (const { bin, gain } of badBins) for (let k = 0; k < K; k++) out[k * nd + bin] -= Math.log(gain);
    }
    return out;
  }

  // ------------------------------------------------------------------ FBP
  const FILTERS = {
    ramlak: { name: 'Ram-Lak (ramp)', w: () => 1 },
    shepplogan: { name: 'Shepp–Logan', w: (u) => (u === 0 ? 1 : Math.sin((Math.PI * u) / 2) / ((Math.PI * u) / 2)) },
    cosine: { name: 'Cosine', w: (u) => Math.cos((Math.PI * u) / 2) },
    hamming: { name: 'Hamming', w: (u) => 0.54 + 0.46 * Math.cos(Math.PI * u) },
    hann: { name: 'Hann', w: (u) => 0.5 + 0.5 * Math.cos(Math.PI * u) },
  };

  /**
   * Frequency response of the band-limited ramp filter built from the discrete spatial kernel
   * (Kak & Slaney eq. 61) times an apodisation window; cutoff ∈ (0, 1] as a fraction of Nyquist.
   */
  function makeFilter(nd, tau, type, cutoff, fft) {
    let P = 1;
    while (P < 2 * nd) P <<= 1;
    const re = new Float64Array(P);
    const im = new Float64Array(P);
    for (let n = -(P / 2) + 1; n < P / 2; n++) {
      let h;
      if (n === 0) h = 1 / (4 * tau * tau);
      else if (n % 2 === 0) h = 0;
      else h = -1 / (n * n * Math.PI * Math.PI * tau * tau);
      re[(n + P) % P] = h;
    }
    fft(re, im);
    const H = new Float64Array(P);
    const win = FILTERS[type].w;
    for (let k = 0; k < P; k++) {
      const f = (k <= P / 2 ? k : P - k) / P; // cycles/sample in [0, 0.5]
      const u = f / 0.5 / cutoff;
      H[k] = u > 1 ? 0 : re[k] * win(u);
    }
    return { P, H, tau };
  }

  /** Filter each projection (zero-padded linear convolution via FFT). */
  function filterSinogram(sino, K, nd, filt, fft) {
    const { P, H, tau } = filt;
    const out = new Float32Array(K * nd);
    const re = new Float64Array(P);
    const im = new Float64Array(P);
    for (let k = 0; k < K; k++) {
      re.fill(0);
      im.fill(0);
      for (let b = 0; b < nd; b++) re[b] = sino[k * nd + b];
      fft(re, im);
      for (let i = 0; i < P; i++) {
        re[i] *= H[i];
        im[i] *= H[i];
      }
      fft(re, im, true);
      for (let b = 0; b < nd; b++) out[k * nd + b] = re[b] * tau;
    }
    return out;
  }

  /**
   * Pixel-driven backprojection with linear interpolation, accumulating views [k0, k1) into `out`.
   * weight = Δθ for FBP (so a full 180° sum gives μ).
   */
  function backproject(q, angles, nd, N, out, k0 = 0, k1 = angles.length, weight = 1, views) {
    const Rr = N / 2;
    const ratio = nd / N;
    const ndm1 = nd - 1;
    let list = views;
    if (!list) {
      list = [];
      for (let k = k0; k < k1; k++) list.push(k);
    }
    // x-extent of the circular field of view on every image row
    const i0s = new Int32Array(N);
    const i1s = new Int32Array(N);
    for (let j = 0; j < N; j++) {
      const Y = Rr - 0.5 - j;
      const half = Math.sqrt(Math.max(0, Rr * Rr - Y * Y));
      i0s[j] = Math.max(0, Math.ceil(Rr - 0.5 - half));
      i1s[j] = Math.min(N - 1, Math.floor(Rr - 0.5 + half));
    }
    for (let n = 0; n < list.length; n++) {
      const k = list[n];
      const c = Math.cos(angles[k]) * ratio;
      const s = Math.sin(angles[k]) * ratio;
      const row = k * nd;
      for (let j = 0; j < N; j++) {
        const Y = Rr - 0.5 - j;
        const i1 = i1s[j];
        const o = j * N;
        let f = (i0s[j] - Rr + 0.5) * c + Y * s + nd / 2 - 0.5;
        for (let i = i0s[j]; i <= i1; i++, f += c) {
          if (f < 0 || f >= ndm1) continue;
          const b = f | 0; // f ≥ 0, so truncation == floor
          const a = q[row + b];
          out[o + i] += weight * (a + (q[row + b + 1] - a) * (f - b));
        }
      }
    }
    return out;
  }

  /** Complete FBP (or plain BP when filt is null). */
  function fbp(sino, angles, nd, N, filt, fft, rangeRad) {
    const K = angles.length;
    const q = filt ? filterSinogram(sino, K, nd, filt, fft) : sino;
    const out = new Float32Array(N * N);
    const w = filt ? rangeRad / K : 1 / K / (FOV / N);
    backproject(q, angles, nd, N, out, 0, K, w);
    return out;
  }

  // ------------------------------------------------------------------ iterative: OS-SART (+ TV)
  function sartSetup(angles, nd, N, subsets) {
    const K = angles.length;
    const mask = fovMask(N);
    const ones = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) ones[i] = mask[i];
    const Rsum = projectNumeric(ones, N, angles, nd);
    const S = Math.max(1, Math.min(subsets, K));
    const groups = Array.from({ length: S }, (_, s) => {
      const views = [];
      for (let k = s; k < K; k += S) views.push(k);
      return views;
    });
    // column sums of each subset: backprojection of unit rays
    const onesSino = new Float32Array(K * nd).fill(1);
    const Csum = groups.map((views) => backproject(onesSino, angles, nd, N, new Float32Array(N * N), 0, 0, 1, views));
    return { K, nd, N, Rsum, groups, Csum, mask, fp: new Float32Array(K * nd), res: new Float32Array(K * nd) };
  }

  /** One full OS-SART pass (all subsets). x is updated in place (μ ≥ 0 enforced). */
  function sartIteration(x, sino, angles, setup, lambda) {
    const { nd, N, Rsum, groups, Csum, mask, fp, res } = setup;
    const back = new Float32Array(N * N);
    for (let gi = 0; gi < groups.length; gi++) {
      const views = groups[gi];
      projectNumeric(x, N, angles, nd, fp, views);
      for (const k of views) {
        for (let b = 0; b < nd; b++) {
          const i = k * nd + b;
          const r = Rsum[i];
          res[i] = r > 1e-6 ? (sino[i] - fp[i]) / r : 0;
        }
      }
      back.fill(0);
      backproject(res, angles, nd, N, back, 0, 0, 1, views);
      const C = Csum[gi];
      for (let p = 0; p < N * N; p++) {
        if (!mask[p] || C[p] <= 1e-9) continue;
        // x_j += λ · Σ a_ij r_i / Σ a_ij   (pixel-size factors cancel)
        const v = x[p] + (lambda * back[p]) / C[p];
        x[p] = v > 0 ? v : 0;
      }
    }
    return x;
  }

  /** Gradient-descent steps on isotropic total variation (ASD-POCS style), in place. */
  function tvSteps(x, N, mask, steps, stepSize) {
    const g = new Float32Array(N * N);
    const eps = 1e-8;
    for (let it = 0; it < steps; it++) {
      g.fill(0);
      for (let j = 0; j < N - 1; j++) {
        for (let i = 0; i < N - 1; i++) {
          const p = j * N + i;
          const dx = x[p] - x[p + 1];
          const dy = x[p] - x[p + N];
          const m = Math.sqrt(dx * dx + dy * dy + eps);
          g[p] += (dx + dy) / m;
          g[p + 1] -= dx / m;
          g[p + N] -= dy / m;
        }
      }
      let norm = 0;
      for (let p = 0; p < N * N; p++) norm += g[p] * g[p];
      norm = Math.sqrt(norm) || 1;
      for (let p = 0; p < N * N; p++) {
        if (!mask[p]) continue;
        const v = x[p] - (stepSize * g[p]) / norm;
        x[p] = v > 0 ? v : 0;
      }
    }
    return x;
  }

  return {
    MU_WATER, FOV, toHU, fromHU, PHANTOMS, FILTERS,
    rasterize, fovMask, makeAngles, projectAnalytic, projectNumeric, addNoise,
    makeFilter, filterSinogram, backproject, fbp, sartSetup, sartIteration, tvSteps,
  };
});
