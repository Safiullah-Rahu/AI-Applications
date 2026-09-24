/* ==========================================================================
   ArmStudio core — planar serial-arm kinematics, collision checking,
   configuration-space mapping and A* motion planning. No DOM (unit-testable).
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ArmCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const wrap = (a) => {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  };
  const D2R = Math.PI / 180;

  // ------------------------------------------------------------------ arm model
  class PlanarArm {
    /**
     * @param {number[]} lengths link lengths [m]
     * @param {number[][]} limitsDeg joint limits per joint [min, max] in degrees
     * @param {{x:number,y:number}} base base joint position [m]
     */
    constructor(lengths, limitsDeg, base = { x: 0, y: 0.25 }, radius = 0.045) {
      this.L = lengths.slice();
      this.limits = limitsDeg.map(([a, b]) => [a * D2R, b * D2R]);
      this.base = base;
      this.radius = radius;
    }
    get n() {
      return this.L.length;
    }
    get reach() {
      return this.L.reduce((s, v) => s + v, 0);
    }
    /** Forward kinematics: joint positions (base … end effector) and tool angle φ. */
    fk(q) {
      const pts = [[this.base.x, this.base.y]];
      let a = 0;
      let x = this.base.x;
      let y = this.base.y;
      for (let i = 0; i < this.n; i++) {
        a += q[i];
        x += this.L[i] * Math.cos(a);
        y += this.L[i] * Math.sin(a);
        pts.push([x, y]);
      }
      return { pts, phi: a };
    }
    /** 2×n position Jacobian ∂(x,y)/∂q. */
    jacobian(q) {
      const { pts } = this.fk(q);
      const ee = pts[this.n];
      const J = [new Array(this.n), new Array(this.n)];
      for (let i = 0; i < this.n; i++) {
        J[0][i] = -(ee[1] - pts[i][1]);
        J[1][i] = ee[0] - pts[i][0];
      }
      return J;
    }
    /** Yoshikawa manipulability w = √det(J Jᵀ) and the velocity ellipse. */
    manipulability(q) {
      const J = this.jacobian(q);
      let a = 0;
      let b = 0;
      let c = 0;
      for (let i = 0; i < this.n; i++) {
        a += J[0][i] * J[0][i];
        b += J[0][i] * J[1][i];
        c += J[1][i] * J[1][i];
      }
      const m = (a + c) / 2;
      const d = Math.sqrt(((a - c) / 2) ** 2 + b * b);
      const l1 = m + d;
      const l2 = Math.max(0, m - d);
      return {
        w: Math.sqrt(Math.max(0, a * c - b * b)),
        major: Math.sqrt(l1),
        minor: Math.sqrt(l2),
        angle: 0.5 * Math.atan2(2 * b, a - c),
        cond: l2 > 1e-12 ? Math.sqrt(l1 / l2) : Infinity,
      };
    }
    withinLimits(q) {
      for (let i = 0; i < this.n; i++) if (q[i] < this.limits[i][0] - 1e-9 || q[i] > this.limits[i][1] + 1e-9) return false;
      return true;
    }
    clampToLimits(q) {
      return q.map((v, i) => clamp(v, this.limits[i][0], this.limits[i][1]));
    }
    /** Closed-form IK of a 2R chain from point (bx,by). elbow = +1 / −1 selects the branch. */
    static ik2(l1, l2, bx, by, x, y, elbow) {
      const dx = x - bx;
      const dy = y - by;
      const D = (dx * dx + dy * dy - l1 * l1 - l2 * l2) / (2 * l1 * l2);
      if (D > 1 + 1e-9 || D < -1 - 1e-9) return null;
      const q2 = elbow * Math.acos(clamp(D, -1, 1));
      const q1 = Math.atan2(dy, dx) - Math.atan2(l2 * Math.sin(q2), l1 + l2 * Math.cos(q2));
      return [wrap(q1), q2];
    }
    /** Analytic IK: 2-link (position) or 3-link (position + tool angle φ). */
    ikAnalytic(x, y, elbow = 1, phi = 0) {
      if (this.n === 2) return PlanarArm.ik2(this.L[0], this.L[1], this.base.x, this.base.y, x, y, elbow);
      const wx = x - this.L[2] * Math.cos(phi);
      const wy = y - this.L[2] * Math.sin(phi);
      const s = PlanarArm.ik2(this.L[0], this.L[1], this.base.x, this.base.y, wx, wy, elbow);
      if (!s) return null;
      return [s[0], s[1], wrap(phi - s[0] - s[1])];
    }
    /** Damped-least-squares IK (position only) starting from q0. */
    ikDLS(x, y, q0, { iters = 60, lambda = 0.06, tol = 1e-4, maxStep = 0.25 } = {}) {
      let q = q0.slice();
      let err = Infinity;
      for (let k = 0; k < iters; k++) {
        const { pts } = this.fk(q);
        const ee = pts[this.n];
        const ex = x - ee[0];
        const ey = y - ee[1];
        err = Math.hypot(ex, ey);
        if (err < tol) break;
        const J = this.jacobian(q);
        // (J Jᵀ + λ² I)⁻¹ e  (2×2 closed form)
        let a = lambda * lambda;
        let b = 0;
        let d = lambda * lambda;
        for (let i = 0; i < this.n; i++) {
          a += J[0][i] * J[0][i];
          b += J[0][i] * J[1][i];
          d += J[1][i] * J[1][i];
        }
        const det = a * d - b * b;
        const vx = (d * ex - b * ey) / det;
        const vy = (-b * ex + a * ey) / det;
        let norm = 0;
        const dq = new Array(this.n);
        for (let i = 0; i < this.n; i++) {
          dq[i] = J[0][i] * vx + J[1][i] * vy;
          norm = Math.max(norm, Math.abs(dq[i]));
        }
        const s = norm > maxStep ? maxStep / norm : 1;
        for (let i = 0; i < this.n; i++) q[i] = q[i] + dq[i] * s;
        q = this.clampToLimits(q);
      }
      const { pts } = this.fk(q);
      err = Math.hypot(x - pts[this.n][0], y - pts[this.n][1]);
      return { q, err };
    }
    /**
     * Static motor torques needed to hold the arm against gravity:
     * uniform links of linear density rho [kg/m] plus a payload at the tool.
     */
    gravityTorques(q, rho, payload, g = 9.81) {
      const { pts } = this.fk(q);
      const tau = new Array(this.n).fill(0);
      for (let i = 0; i < this.n; i++) {
        let s = 0;
        for (let k = i; k < this.n; k++) {
          const cx = (pts[k][0] + pts[k + 1][0]) / 2;
          s += rho * this.L[k] * (cx - pts[i][0]);
        }
        s += payload * (pts[this.n][0] - pts[i][0]);
        tau[i] = g * s;
      }
      return tau;
    }
  }

  // ------------------------------------------------------------------ geometry
  function segPointDist2(ax, ay, bx, by, px, py) {
    const dx = bx - ax;
    const dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = clamp(t, 0, 1);
    const qx = ax + t * dx - px;
    const qy = ay + t * dy - py;
    return qx * qx + qy * qy;
  }
  /** Liang–Barsky: does segment AB intersect the axis-aligned box [x0,x1]×[y0,y1]? */
  function segHitsBox(ax, ay, bx, by, x0, y0, x1, y1) {
    let t0 = 0;
    let t1 = 1;
    const dx = bx - ax;
    const dy = by - ay;
    const p = [-dx, dx, -dy, dy];
    const qv = [ax - x0, x1 - ax, ay - y0, y1 - ay];
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) {
        if (qv[k] < 0) return false;
      } else {
        const r = qv[k] / p[k];
        if (p[k] < 0) {
          if (r > t1) return false;
          if (r > t0) t0 = r;
        } else {
          if (r < t0) return false;
          if (r < t1) t1 = r;
        }
      }
    }
    return true;
  }
  function segSegDist2(a, b, c, d) {
    // exact only when the segments do not intersect; intersection handled separately
    const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = cross(c, d, a);
    const d2 = cross(c, d, b);
    const d3 = cross(a, b, c);
    const d4 = cross(a, b, d);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
    return Math.min(
      segPointDist2(a[0], a[1], b[0], b[1], c[0], c[1]),
      segPointDist2(a[0], a[1], b[0], b[1], d[0], d[1]),
      segPointDist2(c[0], c[1], d[0], d[1], a[0], a[1]),
      segPointDist2(c[0], c[1], d[0], d[1], b[0], b[1])
    );
  }

  // ------------------------------------------------------------------ collision world
  const FREE = -1;
  const FLOOR = -2;
  const LIMIT = -3;
  const SELF = -4;

  class World {
    /**
     * obstacles: {type:'circle', x, y, r} | {type:'box', x, y, hw, hh} (centre + half extents)
     */
    constructor(obstacles = [], { floor = true, pedestal = { hw: 0.13, h: 0.25 } } = {}) {
      this.obstacles = obstacles;
      this.floor = floor;
      this.pedestal = pedestal;
    }
    /** Returns FREE or the index of the first obstacle the capsule segment touches (FLOOR for ground/pedestal). */
    segment(ax, ay, bx, by, r, linkIndex) {
      if (this.floor && Math.min(ay, by) < r) return FLOOR;
      if (this.pedestal && linkIndex > 0) {
        const p = this.pedestal;
        if (segHitsBox(ax, ay, bx, by, -p.hw - r, -1, p.hw + r, p.h + r)) return FLOOR;
      }
      const obs = this.obstacles;
      for (let k = 0; k < obs.length; k++) {
        const o = obs[k];
        if (o.type === 'circle') {
          const rr = o.r + r;
          if (segPointDist2(ax, ay, bx, by, o.x, o.y) < rr * rr) return k;
        } else if (segHitsBox(ax, ay, bx, by, o.x - o.hw - r, o.y - o.hh - r, o.x + o.hw + r, o.y + o.hh + r)) return k;
      }
      return FREE;
    }
    /** Collision status of a whole configuration: FREE, obstacle index, FLOOR, LIMIT or SELF. */
    config(arm, q, perLink) {
      if (!arm.withinLimits(q)) return LIMIT;
      const { pts } = arm.fk(q);
      let hit = FREE;
      for (let i = 0; i < arm.n; i++) {
        const h = this.segment(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], arm.radius, i);
        if (perLink) perLink[i] = h;
        if (h !== FREE && hit === FREE) hit = h;
        if (h !== FREE && !perLink) return h;
      }
      if (hit === FREE && arm.n >= 3) {
        // self collision between non-adjacent links
        for (let i = 0; i < arm.n; i++) {
          for (let j = i + 2; j < arm.n; j++) {
            if (segSegDist2(pts[i], pts[i + 1], pts[j], pts[j + 1]) < (2 * arm.radius) ** 2) {
              if (perLink) perLink[j] = SELF;
              return SELF;
            }
          }
        }
      }
      return hit;
    }
  }

  // ------------------------------------------------------------------ configuration space
  /**
   * Rasterise the (q1, q2) configuration space on a res×res grid over [−π, π)².
   * For 3-link arms, q3 is held fixed (a slice). Cell value: FREE / FLOOR / LIMIT / SELF / obstacle index.
   */
  function cspaceGrid(arm, world, res = 180, q3 = 0) {
    const data = new Int16Array(res * res);
    const step = TAU / res;
    const q = arm.n === 3 ? [0, 0, q3] : [0, 0];
    for (let j = 0; j < res; j++) {
      q[1] = -Math.PI + (j + 0.5) * step;
      for (let i = 0; i < res; i++) {
        q[0] = -Math.PI + (i + 0.5) * step;
        data[j * res + i] = world.config(arm, q);
      }
    }
    return { res, data, step };
  }

  // ------------------------------------------------------------------ A* on an N-D lattice
  class MinHeap {
    constructor() {
      this.k = [];
      this.v = [];
    }
    get size() {
      return this.k.length;
    }
    push(key, val) {
      const k = this.k;
      const v = this.v;
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
      const k = this.k;
      const v = this.v;
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

  /**
   * A* over a regular N-dimensional grid with (3^N − 1)-connectivity and lazy validity checks.
   * isFree(cellIndex) is called at most once per cell. Returns {path:[cellIdx…], expanded, closed}.
   */
  function astarGrid(dims, start, goal, isFree, maxExpand = 2e6) {
    const N = dims.length;
    const strides = new Array(N);
    let total = 1;
    for (let d = 0; d < N; d++) {
      strides[d] = total;
      total *= dims[d];
    }
    const idx = (c) => c.reduce((s, v, d) => s + v * strides[d], 0);
    const coords = (i) => dims.map((n, d) => Math.floor(i / strides[d]) % n);
    const offs = [];
    const rec = (d, cur) => {
      if (d === N) {
        if (cur.some((v) => v !== 0)) offs.push({ dv: cur.slice(), cost: Math.hypot(...cur) });
        return;
      }
      for (const v of [-1, 0, 1]) {
        cur.push(v);
        rec(d + 1, cur);
        cur.pop();
      }
    };
    rec(0, []);
    const g = new Float64Array(total).fill(Infinity);
    const came = new Int32Array(total).fill(-1);
    const closed = new Uint8Array(total);
    const valid = new Int8Array(total); // 0 unknown, 1 free, 2 blocked
    const goalC = goal;
    const h = (c) => {
      let s = 0;
      for (let d = 0; d < N; d++) s += (c[d] - goalC[d]) ** 2;
      return Math.sqrt(s);
    };
    const s0 = idx(start);
    const gI = idx(goal);
    valid[s0] = 1;
    valid[gI] = 1;
    g[s0] = 0;
    const open = new MinHeap();
    open.push(h(start), s0);
    let expanded = 0;
    while (open.size) {
      const cur = open.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      expanded++;
      if (cur === gI) break;
      if (expanded > maxExpand) return { path: null, expanded, closed };
      const cc = coords(cur);
      for (const { dv, cost } of offs) {
        let ok = true;
        const nc = new Array(N);
        for (let d = 0; d < N; d++) {
          nc[d] = cc[d] + dv[d];
          if (nc[d] < 0 || nc[d] >= dims[d]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const ni = idx(nc);
        if (closed[ni]) continue;
        if (valid[ni] === 0) valid[ni] = isFree(ni, nc) ? 1 : 2;
        if (valid[ni] === 2) continue;
        const ng = g[cur] + cost;
        if (ng < g[ni]) {
          g[ni] = ng;
          came[ni] = cur;
          open.push(ng + h(nc), ni);
        }
      }
    }
    if (!closed[gI]) return { path: null, expanded, closed };
    const path = [];
    for (let c = gI; c !== -1; c = came[c]) path.push(c);
    path.reverse();
    return { path, expanded, closed, coords };
  }

  /**
   * Plan a collision-free joint-space path from qs to qg.
   * 2-link arms search the full (q1,q2) grid; 3-link arms search a 3-D lattice.
   */
  function planPath(arm, world, qs, qg, { res } = {}) {
    const n = arm.n;
    const R = res || (n === 2 ? 180 : 72);
    const step = TAU / R;
    const toCell = (q) => q.map((v) => clamp(Math.floor((v + Math.PI) / step), 0, R - 1));
    const toQ = (c) => c.map((v) => -Math.PI + (v + 0.5) * step);
    const dims = new Array(n).fill(R);
    if (world.config(arm, qs) !== FREE) return { ok: false, reason: 'start configuration is in collision' };
    if (world.config(arm, qg) !== FREE) return { ok: false, reason: 'goal configuration is in collision' };
    const strides = dims.map((_, d) => R ** d);
    const res0 = astarGrid(dims, toCell(qs), toCell(qg), (i, c) => world.config(arm, toQ(c)) === FREE);
    if (!res0.path) return { ok: false, reason: 'no collision-free path exists at this resolution', expanded: res0.expanded, closed: res0.closed };
    const cells = res0.path.map((i) => dims.map((nn, d) => Math.floor(i / strides[d]) % nn));
    const raw = cells.map(toQ);
    raw[0] = qs.slice();
    raw[raw.length - 1] = qg.slice();
    const smooth = shortcut(raw, (a, b) => segmentFree(arm, world, a, b));
    return { ok: true, raw, path: smooth, expanded: res0.expanded, closed: res0.closed, res: R };
  }

  /** Straight joint-space motion a→b is collision-free (checked every ≤ 1°). */
  function segmentFree(arm, world, a, b) {
    let maxd = 0;
    for (let i = 0; i < a.length; i++) maxd = Math.max(maxd, Math.abs(b[i] - a[i]));
    const n = Math.max(1, Math.ceil(maxd / D2R));
    const q = new Array(a.length);
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      for (let i = 0; i < a.length; i++) q[i] = a[i] + (b[i] - a[i]) * t;
      if (world.config(arm, q) !== FREE) return false;
    }
    return true;
  }

  /** Greedy shortcut smoothing: connect each waypoint to the farthest directly reachable one. */
  function shortcut(path, free) {
    if (path.length <= 2) return path.slice();
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
      let j = path.length - 1;
      while (j > i + 1 && !free(path[i], path[j])) j--;
      out.push(path[j]);
      i = j;
    }
    return out;
  }

  /** Quintic time scaling s(τ) = 10τ³ − 15τ⁴ + 6τ⁵ (zero velocity & acceleration at both ends). */
  const quintic = (t) => {
    const u = clamp(t, 0, 1);
    return u * u * u * (10 + u * (-15 + 6 * u));
  };

  /** Time-parameterise a joint-space polyline so the peak joint-space speed equals vmax [rad/s]. */
  function timeParam(path, vmax) {
    const cum = [0];
    for (let k = 1; k < path.length; k++) {
      let s = 0;
      for (let i = 0; i < path[k].length; i++) s += (path[k][i] - path[k - 1][i]) ** 2;
      cum.push(cum[k - 1] + Math.sqrt(s));
    }
    const L = cum[cum.length - 1];
    const T = Math.max(0.25, (1.875 * L) / vmax);
    return {
      T,
      L,
      at(t) {
        const s = quintic(t / T) * L;
        let k = 1;
        while (k < cum.length - 1 && cum[k] < s) k++;
        const seg = cum[k] - cum[k - 1] || 1;
        const f = clamp((s - cum[k - 1]) / seg, 0, 1);
        return path[k].map((v, i) => path[k - 1][i] + (v - path[k - 1][i]) * f);
      },
    };
  }

  return {
    PlanarArm, World, cspaceGrid, astarGrid, planPath, segmentFree, shortcut, timeParam, quintic,
    segHitsBox, segPointDist2, segSegDist2, wrap,
    FREE, FLOOR, LIMIT, SELF, D2R,
  };
});
