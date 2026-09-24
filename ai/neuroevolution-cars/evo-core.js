/* ==========================================================================
   EvoDrive core — procedural race tracks, kinematic bicycle cars with ray
   sensors and grip-limited cornering, a tiny neural-network brain and a
   genetic algorithm. No DOM — unit-testable (a headless evolution runs in Node).
   ========================================================================== */
(function (root, factory) {
  const api = factory(root.LabMath || (typeof require === 'function' ? require('../../shared/js/lab-math.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EvoCore = api;
})(typeof self !== 'undefined' ? self : this, function (LM) {
  'use strict';

  const WORLD = { w: 1000, h: 680 };
  const SENSOR_ANGLES = [-90, -50, -22, 0, 22, 50, 90].map((d) => (d * Math.PI) / 180);
  const N_IN = SENSOR_ANGLES.length + 1; // 7 distance rays + own speed
  const N_OUT = 2; // steering, throttle/brake
  const DS = 4; // centre-line resampling step (px)

  // ------------------------------------------------------------------ track
  /** Convex hull (Andrew's monotone chain), counter-clockwise. */
  function convexHull(P) {
    const pts = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (list) => {
      const h = [];
      for (const p of list) {
        while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
        h.push(p);
      }
      h.pop();
      return h;
    };
    return half(pts).concat(half(pts.slice().reverse()));
  }

  /** One candidate layout, or null if it self-overlaps or has corners too tight for the track width. */
  function buildTrack(rng, wig, points, hw, ellipse) {
    // 1. control polygon: convex hull of random points, then displaced edge midpoints carve bays and bumps
    const P = Array.from({ length: points }, () => [rng.uniform(-1, 1), rng.uniform(-1, 1)]);
    const hull = ellipse ? Array.from({ length: 12 }, (_, i) => [Math.cos((i / 12) * 2 * Math.PI), Math.sin((i / 12) * 2 * Math.PI)]) : convexHull(P);
    let ctrl = [];
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      ctrl.push(a);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 0.45 || ellipse) continue;
      const d = rng.uniform(-1, 0.45) * wig * len; // mostly inwards
      ctrl.push([(a[0] + b[0]) / 2 + (dy / len) * d, (a[1] + b[1]) / 2 - (dx / len) * d]);
    }
    // push apart control points that crowd each other
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < ctrl.length; i++) {
        for (let j = i + 1; j < ctrl.length; j++) {
          const dx = ctrl[j][0] - ctrl[i][0];
          const dy = ctrl[j][1] - ctrl[i][1];
          const d = Math.hypot(dx, dy) || 1e-9;
          if (d < 0.32) {
            const k = (0.32 - d) / 2 / d;
            ctrl[i] = [ctrl[i][0] - dx * k, ctrl[i][1] - dy * k];
            ctrl[j] = [ctrl[j][0] + dx * k, ctrl[j][1] + dy * k];
          }
        }
      }
    }
    if (ctrl.length < 4) return null;
    points = ctrl.length;
    // 2. Chaikin corner cutting → a smooth closed quadratic B-spline (corners get rounded, never overshoot)
    let dense = ctrl;
    for (let it = 0; it < 5; it++) {
      const next = [];
      for (let i = 0; i < dense.length; i++) {
        const a = dense[i];
        const b = dense[(i + 1) % dense.length];
        next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
      }
      dense = next;
    }
    // 3. stretch to fill the world with a margin
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of dense) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const m = hw + 16;
    const sx = (WORLD.w - 2 * m) / (x1 - x0);
    const sy = (WORLD.h - 2 * m) / (y1 - y0);
    for (const p of dense) { p[0] = m + (p[0] - x0) * sx; p[1] = m + (p[1] - y0) * sy; }
    // 4. resample at uniform arc length so progress indices are proportional to distance
    const cum = [0];
    for (let i = 1; i <= dense.length; i++) {
      const a = dense[i - 1];
      const b = dense[i % dense.length];
      cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const length = cum[dense.length];
    const n = Math.round(length / DS);
    const ds = length / n;
    const pts = [];
    for (let k = 0, j = 0; k < n; k++) {
      const s = k * ds;
      while (cum[j + 1] < s) j++;
      const f = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
      const a = dense[j];
      const b = dense[(j + 1) % dense.length];
      pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
    // 5. frames and signed curvature
    const tan = [];
    const curv = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 2 + n) % n];
      const c = pts[(i + 2) % n];
      const l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      tan.push([(c[0] - a[0]) / l, (c[1] - a[1]) / l]);
      const b = pts[i];
      const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]) * l;
      curv[i] = d > 0 ? (-2 * cr) / d : 0;
    }
    let maxK = 0;
    for (let i = 0; i < n; i++) maxK = Math.max(maxK, Math.abs(curv[i]));
    if (maxK > 1 / (1.3 * hw)) return null; // inner edge would fold over itself
    // 6. non-neighbouring parts of the loop must keep their distance
    const gap = Math.ceil((4.2 * hw) / ds);
    const minSep2 = (2.5 * hw) ** 2;
    for (let i = 0; i < n; i += 2) {
      for (let j = i + gap; j < n - Math.max(0, gap - i); j += 2) {
        const dx = pts[i][0] - pts[j][0];
        const dy = pts[i][1] - pts[j][1];
        if (dx * dx + dy * dy < minSep2) return null;
      }
    }
    const nor = tan.map(([tx, ty]) => [-ty, tx]);
    const left = pts.map((p, i) => [p[0] + nor[i][0] * hw, p[1] + nor[i][1] * hw]);
    const right = pts.map((p, i) => [p[0] - nor[i][0] * hw, p[1] - nor[i][1] * hw]);
    const segs = new Float64Array(n * 8);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      segs.set([left[i][0], left[i][1], left[j][0], left[j][1], right[i][0], right[i][1], right[j][0], right[j][1]], i * 8);
    }
    return { pts, tan, nor, curv, left, right, halfWidth: hw, n, ds, length, segs, grid: buildGrid(segs), stamp: new Uint32Array(n * 2), stampId: 0 };
  }

  /**
   * Closed race track from a random seed: convex hull of random points with displaced edge
   * midpoints, smoothed by Chaikin corner cutting. Retries with gradually calmer layouts and finally falls
   * back to an ellipse, so it always returns a valid track.
   */
  function makeTrack(seed, { halfWidth = 30, wiggle = 0.45, points = 12 } = {}) {
    const tries = 80;
    for (let attempt = 0; attempt <= tries; attempt++) {
      const rng = LM.makeRng(((seed >>> 0) * 7919 + attempt * 104729 + 1) >>> 0);
      const wig = attempt === tries ? 0 : wiggle * Math.max(0.15, 1 - attempt / 55);
      const t = buildTrack(rng, wig, points, halfWidth, attempt === tries);
      if (t) return Object.assign(t, { seed, attempt, wiggle: wig });
    }
    throw new Error('unreachable: ellipse fallback failed');
  }

  /** Uniform spatial hash of wall segments (flat [x0 y0 x1 y1]*) for fast ray queries. */
  function buildGrid(segs, cell = 40) {
    const cols = Math.ceil(WORLD.w / cell);
    const rows = Math.ceil(WORLD.h / cell);
    const cells = Array.from({ length: cols * rows }, () => []);
    for (let k = 0; k < segs.length / 4; k++) {
      const o = k * 4;
      const gx0 = Math.max(0, Math.floor(Math.min(segs[o], segs[o + 2]) / cell));
      const gx1 = Math.min(cols - 1, Math.floor(Math.max(segs[o], segs[o + 2]) / cell));
      const gy0 = Math.max(0, Math.floor(Math.min(segs[o + 1], segs[o + 3]) / cell));
      const gy1 = Math.min(rows - 1, Math.floor(Math.max(segs[o + 1], segs[o + 3]) / cell));
      for (let y = gy0; y <= gy1; y++) for (let x = gx0; x <= gx1; x++) cells[y * cols + x].push(k);
    }
    return { cell, cols, rows, cells: cells.map((c) => Int32Array.from(c)) };
  }

  /** Distance along a unit ray to the nearest wall (≤ range): Amanatides–Woo walk over the segment grid. */
  function castRay(track, x, y, dx, dy, range) {
    const { grid, segs, stamp } = track;
    const cell = grid.cell;
    if (++track.stampId > 0xfffffff0) { stamp.fill(0); track.stampId = 1; }
    const id = track.stampId;
    let cx = Math.floor(x / cell);
    let cy = Math.floor(y / cell);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(cell / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(cell / dy) : Infinity;
    let tmx = dx !== 0 ? (dx > 0 ? (cx + 1) * cell - x : x - cx * cell) / Math.abs(dx) : Infinity;
    let tmy = dy !== 0 ? (dy > 0 ? (cy + 1) * cell - y : y - cy * cell) / Math.abs(dy) : Infinity;
    let best = range;
    let tEnter = 0;
    while (tEnter <= best && cx >= 0 && cy >= 0 && cx < grid.cols && cy < grid.rows) {
      const list = grid.cells[cy * grid.cols + cx];
      for (let q = 0; q < list.length; q++) {
        const k = list[q];
        if (stamp[k] === id) continue;
        stamp[k] = id;
        const o = k * 4;
        const ex = segs[o + 2] - segs[o];
        const ey = segs[o + 3] - segs[o + 1];
        const den = dx * ey - dy * ex;
        if (den > -1e-12 && den < 1e-12) continue;
        const wx = segs[o] - x;
        const wy = segs[o + 1] - y;
        const t = (wx * ey - wy * ex) / den;
        if (t < 0 || t >= best) continue;
        const u = (wx * dy - wy * dx) / den;
        if (u >= 0 && u <= 1) best = t;
      }
      if (tmx < tmy) { tEnter = tmx; tmx += tdx; cx += stepX; } else { tEnter = tmy; tmy += tdy; cy += stepY; }
    }
    return best;
  }

  // ------------------------------------------------------------------ brain: fixed-topology MLP, tanh everywhere
  const topology = (hidden = 8) => [N_IN, hidden, N_OUT];
  const genomeLength = (topo) => topo.slice(1).reduce((s, n, i) => s + n * topo[i] + n, 0);
  /** Genome layout per layer: weights row-major [out][in], then biases. Returns activations per layer if keep. */
  function brainForward(genome, inputs, topo, keep) {
    let a = inputs;
    let o = 0;
    const acts = keep ? [Float64Array.from(inputs)] : null;
    for (let l = 1; l < topo.length; l++) {
      const nIn = topo[l - 1];
      const nOut = topo[l];
      const out = new Float64Array(nOut);
      for (let j = 0; j < nOut; j++) {
        let s = genome[o + nIn * nOut + j];
        const w = o + j * nIn;
        for (let i = 0; i < nIn; i++) s += genome[w + i] * a[i];
        out[j] = Math.tanh(s);
      }
      o += nIn * nOut + nOut;
      a = out;
      if (acts) acts.push(out);
    }
    return keep ? acts : a;
  }
  /** Weight of edge (layer l → l+1, from i to j) inside a genome. */
  function weightAt(genome, topo, l, i, j) {
    let o = 0;
    for (let k = 1; k <= l; k++) o += topo[k - 1] * topo[k] + topo[k];
    return genome[o + j * topo[l] + i];
  }
  function randomGenome(rng, topo, sd = 1) {
    return Float64Array.from({ length: genomeLength(topo) }, () => rng.gauss(0, sd));
  }

  // ------------------------------------------------------------------ car
  // Kinematic bicycle model. aLat caps lateral acceleration (tyre grip): above v² / R the car
  // understeers and runs wide, so a fast driver must learn to brake before tight corners.
  const CAR = { wheelBase: 15, maxSteer: 0.6, accel: 240, brake: 480, drag: 0.45, maxSpeed: 380, radius: 7, aLat: 520, sensorRange: 170 };

  function makeCar(track, genome, id) {
    const p = track.pts[0];
    const t = track.tan[0];
    return {
      id, genome, x: p[0], y: p[1], th: Math.atan2(t[1], t[0]), v: 0,
      alive: true, finished: false, crashed: false, idx: 0, progress: 0, bestProg: 0, lastProgT: 0,
      t: 0, laps: 0, lapStart: 0, lapTime: Infinity, lastLap: Infinity, dist: 0,
      sensors: new Float64Array(SENSOR_ANGLES.length).fill(CAR.sensorRange), inputs: new Float64Array(N_IN),
      steer: 0, throttle: 0, slip: false, fitness: 0,
    };
  }

  /**
   * Advance one car by dt: sense → think → act → integrate → progress & collisions.
   * opts: {topo, maxLaps, stallTime, timeLimit, pilot(car) → [steer, throttle] to override the brain}
   */
  function stepCar(car, track, dt, opts) {
    if (!car.alive) return;
    const n = track.n;
    const R = CAR.sensorRange;
    for (let k = 0; k < SENSOR_ANGLES.length; k++) {
      const a = car.th + SENSOR_ANGLES[k];
      car.sensors[k] = castRay(track, car.x, car.y, Math.cos(a), Math.sin(a), R);
      car.inputs[k] = 1 - car.sensors[k] / R;
    }
    car.inputs[SENSOR_ANGLES.length] = car.v / CAR.maxSpeed;
    const out = opts.pilot ? opts.pilot(car) : brainForward(car.genome, car.inputs, opts.topo);
    car.steer = Math.max(-1, Math.min(1, out[0]));
    car.throttle = Math.max(-1, Math.min(1, out[1]));
    const acc = car.throttle >= 0 ? car.throttle * CAR.accel : car.throttle * CAR.brake;
    car.v = Math.max(0, Math.min(CAR.maxSpeed, car.v + (acc - CAR.drag * car.v) * dt));
    let yawRate = (car.v / CAR.wheelBase) * Math.tan(car.steer * CAR.maxSteer);
    const maxYaw = CAR.aLat / Math.max(car.v, 1);
    car.slip = Math.abs(yawRate) > maxYaw && car.v > 60;
    if (Math.abs(yawRate) > maxYaw) yawRate = Math.sign(yawRate) * maxYaw; // grip-limited → understeer
    car.th += yawRate * dt;
    car.x += car.v * Math.cos(car.th) * dt;
    car.y += car.v * Math.sin(car.th) * dt;
    car.dist += car.v * dt;
    car.t += dt;
    // progress along the centre line (local search around the previous index)
    let best = car.idx;
    let bd = Infinity;
    for (let o = -8; o <= 14; o++) {
      const i = (car.idx + o + n) % n;
      const d = (car.x - track.pts[i][0]) ** 2 + (car.y - track.pts[i][1]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    let di = best - car.idx;
    if (di > n / 2) di -= n;
    if (di < -n / 2) di += n;
    car.idx = best;
    car.progress += di;
    if (car.progress > car.bestProg) {
      car.bestProg = car.progress;
      car.lastProgT = car.t; // stall timer restarts on every new furthest point
    }
    const lap = Math.floor(car.progress / n);
    if (lap > car.laps) {
      car.laps = lap;
      car.lastLap = car.t - car.lapStart;
      car.lapTime = Math.min(car.lapTime, car.lastLap);
      car.lapStart = car.t;
      if (car.laps >= (opts.maxLaps || 3)) { car.finished = true; car.alive = false; }
    }
    // collision: lateral offset from the centre line beyond the half-width
    const p = track.pts[best];
    const nrm = track.nor[best];
    const lat = (car.x - p[0]) * nrm[0] + (car.y - p[1]) * nrm[1];
    if (Math.abs(lat) > track.halfWidth - CAR.radius * 0.6) { car.alive = false; car.crashed = true; }
    if (car.t - car.lastProgT > (opts.stallTime || 2.5)) car.alive = false;
    if (opts.timeLimit && car.t >= opts.timeLimit) car.alive = false;
    car.fitness = fitnessOf(car, track, opts);
  }

  /** Fitness in “% of a lap”, plus a bonus for finishing that grows with how fast the laps were done. */
  function fitnessOf(car, track, opts) {
    const f = (100 * Math.max(0, car.bestProg)) / track.n;
    if (!car.finished) return f;
    const tl = opts.timeLimit || 60;
    return f + 100 * Math.max(0, 1 - car.t / tl);
  }

  /** Headless evaluation of a whole generation (fixed 60 Hz steps). Returns the finished cars. */
  function runGeneration(track, genomes, opts, dt = 1 / 60) {
    const cars = genomes.map((g, i) => makeCar(track, g, i));
    let alive = cars.length;
    while (alive > 0) {
      alive = 0;
      for (const c of cars) {
        stepCar(c, track, dt, opts);
        if (c.alive) alive++;
      }
    }
    return cars;
  }

  // ------------------------------------------------------------------ genetic algorithm
  /** Elitism + tournament selection + uniform crossover + Gaussian mutation. Returns the next genomes. */
  function nextGeneration(pop, rng, { elite = 3, mutRate = 0.12, mutSigma = 0.35, tournament = 3, size } = {}) {
    const N = size || pop.length;
    const sorted = pop.slice().sort((a, b) => b.fitness - a.fitness);
    const next = sorted.slice(0, Math.min(elite, N)).map((c) => Float64Array.from(c.genome));
    const pick = () => {
      let best = null;
      for (let k = 0; k < tournament; k++) {
        const c = pop[rng.int(pop.length)];
        if (!best || c.fitness > best.fitness) best = c;
      }
      return best.genome;
    };
    while (next.length < N) {
      const a = pick();
      const b = pick();
      const child = new Float64Array(a.length);
      for (let i = 0; i < a.length; i++) {
        child[i] = rng.next() < 0.5 ? a[i] : b[i];
        if (rng.next() < mutRate) child[i] += rng.gauss(0, mutSigma);
      }
      next.push(child);
    }
    return next;
  }

  return { WORLD, SENSOR_ANGLES, N_IN, N_OUT, CAR, makeTrack, castRay, topology, genomeLength, brainForward, weightAt, randomGenome, makeCar, stepCar, fitnessOf, runGeneration, nextGeneration };
});
