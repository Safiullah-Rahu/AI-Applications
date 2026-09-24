/* ==========================================================================
   NaviChair core — occupancy grids, LIDAR ray casting, Euclidean distance
   transform, cost-aware A*, path smoothing, Dynamic Window Approach and
   log-odds mapping. No DOM (unit-testable).
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NavCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const INF = 1e20;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const wrap = (a) => {
    a = (a + Math.PI) % (2 * Math.PI);
    if (a < 0) a += 2 * Math.PI;
    return a - Math.PI;
  };

  // ------------------------------------------------------------------ occupancy grid
  class GridMap {
    /** w×h cells of size res [m]; cell (i, j) covers x ∈ [i·res, (i+1)·res), y ∈ [j·res, (j+1)·res). */
    constructor(w, h, res) {
      this.w = w;
      this.h = h;
      this.res = res;
      this.data = new Uint8Array(w * h);
    }
    static fromRects(widthM, heightM, res, rects) {
      const g = new GridMap(Math.round(widthM / res), Math.round(heightM / res), res);
      for (const r of rects) g.fillRect(r.x0, r.y0, r.x1, r.y1, 1);
      return g;
    }
    fillRect(x0, y0, x1, y1, v) {
      const i0 = clamp(Math.floor(Math.min(x0, x1) / this.res + 1e-9), 0, this.w - 1);
      const i1 = clamp(Math.ceil(Math.max(x0, x1) / this.res - 1e-9) - 1, 0, this.w - 1);
      const j0 = clamp(Math.floor(Math.min(y0, y1) / this.res + 1e-9), 0, this.h - 1);
      const j1 = clamp(Math.ceil(Math.max(y0, y1) / this.res - 1e-9) - 1, 0, this.h - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.data[j * this.w + i] = v;
    }
    cell(x, y) {
      return [Math.floor(x / this.res), Math.floor(y / this.res)];
    }
    occupiedCell(i, j) {
      return i < 0 || j < 0 || i >= this.w || j >= this.h || this.data[j * this.w + i] === 1;
    }
    occupied(x, y) {
      const [i, j] = this.cell(x, y);
      return this.occupiedCell(i, j);
    }
    /** Amanatides–Woo grid traversal: distance [m] to the first occupied cell along a ray (or maxRange). */
    raycast(x, y, ang, maxRange) {
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      let i = Math.floor(x / this.res);
      let j = Math.floor(y / this.res);
      const stepI = dx > 0 ? 1 : -1;
      const stepJ = dy > 0 ? 1 : -1;
      const tDeltaX = Math.abs(this.res / (dx || 1e-12));
      const tDeltaY = Math.abs(this.res / (dy || 1e-12));
      let tMaxX = dx > 0 ? ((i + 1) * this.res - x) / dx : dx < 0 ? (i * this.res - x) / dx : INF;
      let tMaxY = dy > 0 ? ((j + 1) * this.res - y) / dy : dy < 0 ? (j * this.res - y) / dy : INF;
      let t = 0;
      while (t < maxRange) {
        if (this.occupiedCell(i, j)) return t;
        if (tMaxX < tMaxY) {
          t = tMaxX;
          tMaxX += tDeltaX;
          i += stepI;
        } else {
          t = tMaxY;
          tMaxY += tDeltaY;
          j += stepJ;
        }
      }
      return maxRange;
    }
  }

  // ------------------------------------------------------------------ distance transform
  function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  }
  /** Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), in cells, of a binary occupancy grid. */
  function distanceTransform(occ, w, h) {
    const n = Math.max(w, h);
    const f = new Float64Array(n);
    const d = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    const tmp = new Float64Array(w * h);
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) f[j] = occ[j * w + i] ? 0 : INF;
      edt1d(f, h, d, v, z);
      for (let j = 0; j < h; j++) tmp[j * w + i] = d[j];
    }
    const out = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) f[i] = tmp[j * w + i];
      edt1d(f, w, d, v, z);
      for (let i = 0; i < w; i++) out[j * w + i] = Math.sqrt(d[i]);
    }
    return out;
  }

  /**
   * Traversal cost: impassable inside the robot radius, then an exponentially decaying penalty
   * that keeps the wheelchair comfortably away from walls.
   */
  function buildCostmap(dist, res, rRobot, { weight = 6, decay = 0.35 } = {}) {
    const c = new Float32Array(dist.length);
    for (let k = 0; k < dist.length; k++) {
      const dm = dist[k] * res;
      c[k] = dm < rRobot ? Infinity : 1 + weight * Math.exp(-(dm - rRobot) / decay);
    }
    return c;
  }

  // ------------------------------------------------------------------ A*
  class Heap {
    constructor() {
      this.k = [];
      this.v = [];
    }
    get size() {
      return this.k.length;
    }
    push(key, val) {
      const { k, v } = this;
      k.push(key);
      v.push(val);
      let i = k.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (k[p] <= k[i]) break;
        [k[p], k[i]] = [k[i], k[p]];
        [v[p], v[i]] = [v[i], v[p]];
        i = p;
      }
    }
    pop() {
      const { k, v } = this;
      const top = v[0];
      const lk = k.pop();
      const lv = v.pop();
      if (k.length) {
        k[0] = lk;
        v[0] = lv;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < k.length && k[l] < k[m]) m = l;
          if (r < k.length && k[r] < k[m]) m = r;
          if (m === i) break;
          [k[m], k[i]] = [k[i], k[m]];
          [v[m], v[i]] = [v[i], v[m]];
          i = m;
        }
      }
      return top;
    }
  }

  /** 8-connected A* on a cost grid (Infinity = blocked). Returns {path:[[i,j]…], expanded, closed}. */
  function astar(cost, w, h, start, goal) {
    const N = w * h;
    const g = new Float64Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const s = start[1] * w + start[0];
    const t = goal[1] * w + goal[0];
    if (!Number.isFinite(cost[s]) || !Number.isFinite(cost[t])) return { path: null, expanded: 0, closed };
    const hfun = (i, j) => Math.hypot(i - goal[0], j - goal[1]);
    g[s] = 0;
    const open = new Heap();
    open.push(hfun(start[0], start[1]), s);
    const nb = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
    let expanded = 0;
    while (open.size) {
      const cur = open.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      expanded++;
      if (cur === t) break;
      const ci = cur % w;
      const cj = (cur - ci) / w;
      for (const [di, dj, step] of nb) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const n = nj * w + ni;
        if (closed[n] || !Number.isFinite(cost[n])) continue;
        // no corner cutting between two blocked cells
        if (di && dj && (!Number.isFinite(cost[cj * w + ni]) || !Number.isFinite(cost[nj * w + ci]))) continue;
        const ng = g[cur] + step * 0.5 * (cost[cur] + cost[n]);
        if (ng < g[n]) {
          g[n] = ng;
          came[n] = cur;
          open.push(ng + hfun(ni, nj), n);
        }
      }
    }
    if (!closed[t]) return { path: null, expanded, closed };
    const path = [];
    for (let c = t; c !== -1; c = came[c]) path.push([c % w, Math.floor(c / w)]);
    path.reverse();
    return { path, expanded, closed };
  }

  /** Greedy line-of-sight smoothing: keep a waypoint only when the straight segment would violate clearance. */
  function smoothPath(points, clear) {
    if (points.length <= 2) return points.slice();
    const out = [points[0]];
    let i = 0;
    while (i < points.length - 1) {
      let j = points.length - 1;
      while (j > i + 1 && !clear(points[i], points[j])) j--;
      out.push(points[j]);
      i = j;
    }
    return out;
  }
  /** Resample a polyline every `step` metres. */
  function densify(points, step) {
    const out = [points[0]];
    for (let k = 1; k < points.length; k++) {
      const [x0, y0] = points[k - 1];
      const [x1, y1] = points[k];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
      for (let s = 1; s <= n; s++) out.push([x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n]);
    }
    return out;
  }

  // ------------------------------------------------------------------ Dynamic Window Approach
  /**
   * Samples (v, ω) inside the dynamic window, rolls each out for `horizon` seconds and scores it.
   * ctx: {clearanceAt(x,y) → m, people: [{x,y,vx,vy,r}], target: [x,y] | null, user: {v,w} | null}
   */
  function dwa(state, p, ctx) {
    const { x, y, th, v, w } = state;
    const dt = p.window;
    const vLo = Math.max(p.vMin, v - p.aMax * dt);
    const vHi = Math.min(p.vMax, v + p.aMax * dt);
    const wLo = Math.max(-p.wMax, w - p.alphaMax * dt);
    const wHi = Math.min(p.wMax, w + p.alphaMax * dt);
    const trajs = [];
    let best = null;
    const nv = p.nv;
    const nw = p.nw;
    for (let a = 0; a < nv; a++) {
      const vs = nv === 1 ? vHi : vLo + ((vHi - vLo) * a) / (nv - 1);
      for (let b = 0; b < nw; b++) {
        const ws = nw === 1 ? 0 : wLo + ((wHi - wLo) * b) / (nw - 1);
        const pts = [];
        let px = x;
        let py = y;
        let pt = th;
        let minClear = Infinity;
        let collided = false;
        const steps = Math.round(p.horizon / p.step);
        for (let s = 1; s <= steps; s++) {
          pt += ws * p.step;
          px += vs * Math.cos(pt) * p.step;
          py += vs * Math.sin(pt) * p.step;
          pts.push([px, py]);
          let c = ctx.clearanceAt(px, py) - p.radius;
          for (const q of ctx.people) {
            const t = s * p.step;
            const d = Math.hypot(px - (q.x + q.vx * t), py - (q.y + q.vy * t)) - q.r - p.radius;
            if (d < c) c = d;
          }
          if (c < minClear) minClear = c;
          // only a collision if it happens before the chair could brake to a stop
          if (c <= 0 && s * p.step <= Math.abs(vs) / p.aMax + 0.6) {
            collided = true;
            break;
          }
        }
        const tr = { v: vs, w: ws, pts, collided, clear: minClear };
        if (!collided) {
          // hinge penalty: only arcs passing within `clearZone` of an obstacle are penalised, so the
          // planner still commits to narrow doorways instead of loitering in open space
          const zone = p.clearZone || 0.25;
          const clearCost = Math.max(0, zone - minClear) / zone;
          let cost = p.wClear * clearCost;
          if (ctx.target) {
            const end = pts[pts.length - 1] || [x, y];
            const dGoal = Math.hypot(ctx.target[0] - end[0], ctx.target[1] - end[1]);
            const hErr = Math.abs(wrap(Math.atan2(ctx.target[1] - end[1], ctx.target[0] - end[0]) - pt));
            cost += p.wGoal * dGoal + p.wHeading * hErr + p.wSpeed * (p.vMax - vs);
          }
          if (ctx.path && ctx.path.length) {
            // path-distance bias: stay close to the (centred) global path, e.g. through doorways
            let dp = Infinity;
            const mid = pts[Math.floor(pts.length / 2)] || [x, y];
            const end = pts[pts.length - 1] || [x, y];
            for (const q of ctx.path) {
              const d1 = Math.hypot(q[0] - mid[0], q[1] - mid[1]);
              const d2 = Math.hypot(q[0] - end[0], q[1] - end[1]);
              if (d1 + d2 < dp) dp = d1 + d2;
            }
            cost += (p.wPath || 0) * dp * 0.5;
          }
          if (ctx.user) {
            cost += p.wUser * (((vs - ctx.user.v) / p.vMax) ** 2 * 4 + ((ws - ctx.user.w) / p.wMax) ** 2);
          }
          tr.cost = cost;
          if (!best || cost < best.cost) best = tr;
        }
        trajs.push(tr);
      }
    }
    return { best, trajs };
  }

  // ------------------------------------------------------------------ log-odds occupancy mapping
  const L_OCC = 0.85;
  const L_FREE = -0.4;
  const L_MIN = -4;
  const L_MAX = 4;
  /**
   * Update a log-odds grid from one LIDAR scan (traversal of each beam).
   * Beams flagged `dyn` hit a tracked moving obstacle (a person): they only clear free space
   * in front of it and never mark cells occupied, so pedestrians do not leave ghost walls.
   */
  function updateLogOdds(L, w, h, res, x, y, beams, maxRange) {
    for (const { a, r, dyn } of beams) {
      const hit = r < maxRange - 1e-6 && !dyn;
      const len = dyn ? Math.max(0, r - 0.3) : Math.min(r, maxRange);
      const n = Math.ceil(len / (res * 0.7));
      const cx = Math.cos(a);
      const cy = Math.sin(a);
      let last = -1;
      for (let s = 0; s < n; s++) {
        const d = (s / n) * len;
        const i = Math.floor((x + cx * d) / res);
        const j = Math.floor((y + cy * d) / res);
        if (i < 0 || j < 0 || i >= w || j >= h) break;
        const k = j * w + i;
        if (k === last) continue;
        last = k;
        L[k] = Math.max(L_MIN, L[k] + L_FREE);
      }
      if (hit) {
        const i = Math.floor((x + cx * (len + res * 0.3)) / res);
        const j = Math.floor((y + cy * (len + res * 0.3)) / res);
        if (i >= 0 && j >= 0 && i < w && j < h) L[j * w + i] = Math.min(L_MAX, L[j * w + i] + L_OCC + (-L_FREE));
      }
    }
  }

  return { GridMap, distanceTransform, buildCostmap, astar, smoothPath, densify, dwa, updateLogOdds, wrap, clamp };
});
