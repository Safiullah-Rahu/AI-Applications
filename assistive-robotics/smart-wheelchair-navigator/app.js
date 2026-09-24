/* NaviChair — world, control modes (manual / shared / autonomous), simulation and rendering. */
(function () {
  'use strict';
  const NC = window.NavCore;
  const M = window.LabMath;
  Lab.boot();
  const T = Lab.theme();

  // ------------------------------------------------------------------ world (metres, origin bottom-left, y up)
  const W = 12;
  const H = 8;
  const RES = 0.05;
  const GW = Math.round(W / RES);
  const GH = Math.round(H / RES);
  const R_ROBOT = 0.38;
  const t = 0.12;
  const WALLS = [
    // outer shell (front door gap 4.0–5.0 m in the bottom wall)
    [0, 0, 4.0, t], [5.0, 0, 12, t], [0, 8 - t, 12, 8], [0, 0, t, 8], [12 - t, 0, 12, 8],
    // living / kitchen / hallway (doors at x 2–3 and 9–10), living↔kitchen opening at y 1.2–2.4
    [0, 3.74, 2.0, 3.86], [3.0, 3.74, 9.0, 3.86], [10.0, 3.74, 12, 3.86],
    [6.44, 0, 6.56, 1.2], [6.44, 2.4, 6.56, 3.8],
    // bedrooms / bathroom / study (doors at 3.4–4.4, 6.0–7.0, 8.6–9.6)
    [0, 5.14, 3.4, 5.26], [4.4, 5.14, 6.0, 5.26], [7.0, 5.14, 8.6, 5.26], [9.6, 5.14, 12, 5.26],
    [4.94, 5.2, 5.06, 8], [7.94, 5.2, 8.06, 8],
  ].map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 }));
  const FURNITURE = [
    ['Sofa', 0.15, 0.6, 1.05, 2.8], ['Table', 1.8, 1.3, 2.6, 2.2], ['TV', 2.3, 0.15, 3.9, 0.5], ['Chair', 4.5, 2.7, 5.3, 3.6],
    ['Counter', 7.6, 0.12, 11.88, 0.75], ['', 11.25, 0.75, 11.88, 2.9], ['Dining', 8.3, 1.9, 9.9, 2.9],
    ['Bed', 0.15, 5.95, 2.2, 7.88], ['', 2.3, 7.35, 2.75, 7.88], ['Wardrobe', 3.7, 7.25, 4.88, 7.88],
    ['Shower', 5.12, 6.8, 6.3, 7.88], ['WC', 7.25, 7.1, 7.88, 7.7], ['Sink', 6.45, 7.45, 7.1, 7.88],
    ['Desk', 10.3, 6.9, 11.88, 7.88], ['Books', 8.12, 5.5, 8.5, 7.6],
  ].map(([name, x0, y0, x1, y1]) => ({ name, x0, y0, x1, y1 }));
  const ROOMS = [
    { name: 'Living room', x0: 0, y0: 0, x1: 6.5, y1: 3.8, tint: '#a78bfa', lx: 0.3, ly: 3.55 },
    { name: 'Kitchen', x0: 6.5, y0: 0, x1: 12, y1: 3.8, tint: '#34d399', lx: 6.75, ly: 3.55 },
    { name: 'Hallway', x0: 0, y0: 3.8, x1: 12, y1: 5.2, tint: '#94a3b8', lx: 3.2, ly: 5.0 },
    { name: 'Bedroom', x0: 0, y0: 5.2, x1: 5, y1: 8, tint: '#60a5fa', lx: 0.3, ly: 5.62 },
    { name: 'Bathroom', x0: 5, y0: 5.2, x1: 8, y1: 8, tint: '#2dd4bf', lx: 5.25, ly: 5.62 },
    { name: 'Study', x0: 8, y0: 5.2, x1: 12, y1: 8, tint: '#fbbf24', lx: 8.75, ly: 5.62 },
  ];
  const ICON = {
    bed: '<path d="M3 18v-8h18v8M3 14h18M7 10V7h5v3"/>',
    bath: '<path d="M4 12h16v2a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM6 12V6a2 2 0 0 1 4 0"/>',
    desk: '<path d="M3 9h18M5 9v10M19 9v10M9 5h6v4H9z"/>',
    kitchen: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M16 3c-2 2-2 6 0 8v10"/>',
    sofa: '<path d="M4 11V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3M3 11h18v6H3zM5 17v2M19 17v2"/>',
    door: '<path d="M6 21V3h12v18M3 21h18M14 12h.01"/>',
  };
  const DESTS = [
    { key: 'bed', name: 'Bed', x: 2.95, y: 6.7, th: Math.PI, words: ['bed', 'bedroom', 'sleep', 'tired', 'rest', 'nap'] },
    { key: 'bath', name: 'Bathroom', x: 6.55, y: 6.2, th: Math.PI / 2, words: ['bath', 'toilet', 'restroom', 'wash', 'shower', 'loo', 'wc'] },
    { key: 'desk', name: 'Desk', x: 10.9, y: 6.2, th: Math.PI / 2, words: ['desk', 'study', 'work', 'computer', 'read', 'office'] },
    { key: 'kitchen', name: 'Kitchen', x: 10.0, y: 1.35, th: -Math.PI / 2, words: ['kitchen', 'cook', 'food', 'eat', 'hungry', 'fridge', 'dinner', 'lunch', 'breakfast', 'drink', 'water', 'coffee', 'tea'] },
    { key: 'sofa', name: 'Sofa & TV', x: 3.2, y: 2.4, th: -Math.PI / 2, words: ['sofa', 'couch', 'tv', 'television', 'living', 'lounge', 'relax', 'watch'] },
    { key: 'door', name: 'Front door', x: 4.5, y: 0.95, th: -Math.PI / 2, words: ['door', 'exit', 'leave', 'outside', 'entrance', 'out', 'visitor', 'guest'] },
  ];
  const PEOPLE_DEF = [
    { path: [[5.4, 4.5], [11.2, 4.5]], speed: 0.55 },
    { path: [[4.0, 3.2], [5.8, 1.8], [7.6, 1.5], [5.8, 1.8]], speed: 0.45 },
  ];

  // ------------------------------------------------------------------ state
  const S = {
    mode: 'auto', vmax: 0.8, acc: 0.8, alpha: 2.5, wmax: 1.3, comfort: 6, share: 4,
    safety: true, tremor: false, tremorAmp: 0.45, beams: 180, range: 6, people: true, slam: false, edit: 'off',
    layers: { lidar: true, cost: true, dwa: true, explored: false, trail: true },
  };
  const base = NC.GridMap.fromRects(W, H, RES, [...WALLS, ...FURNITURE]);
  let edits = new Int8Array(GW * GH);
  let truth = null;
  let truthDist = null;
  let belief = new Float32Array(GW * GH);
  let planOcc = null;
  let dist = null;
  let cost = null;
  let robot = null;
  let cmd = { v: 0, w: 0 };
  let userRaw = { v: 0, w: 0 };
  let userCmd = { v: 0, w: 0 };
  let userFilt = { v: 0, w: 0 };
  let goal = null;
  let path = null;
  let pathIdx = 0;
  let pathInfo = null;
  let scanBeams = [];
  let dwaRes = null;
  let people = [];
  let trail = [];
  let limited = false;
  let blockedTime = 0;
  let status = { text: 'Idle', cls: 'neutral' };
  let clock = 0;
  const stats = { dist: 0, interventions: 0, replans: 0, assist: 0 };
  const tele = { speed: new Lab.RingSeries(2000), clear: new Lab.RingSeries(2000) };
  let costCanvas = null;
  let exploredCanvas = null;
  let editsCanvas = null;
  let beliefCanvas = null;

  function resetWorld() {
    edits = new Int8Array(GW * GH);
    belief = new Float32Array(GW * GH);
    robot = { x: 1.3, y: 4.5, th: 0, v: 0, w: 0 };
    cmd = { v: 0, w: 0 };
    goal = null;
    path = null;
    trail = [];
    Object.assign(stats, { dist: 0, interventions: 0, replans: 0, assist: 0 });
    people = PEOPLE_DEF.map((p) => ({ ...p, i: 0, dir: 1, x: p.path[0][0], y: p.path[0][1], vx: 0, vy: 0, r: 0.24, side: 0, pause: 0, next: 1 }));
    rebuildTruth();
    rebuildPlanMap();
  }
  function rebuildTruth() {
    truth = new NC.GridMap(GW, GH, RES);
    for (let k = 0; k < GW * GH; k++) truth.data[k] = edits[k] === 1 ? 1 : edits[k] === -1 ? 0 : base.data[k];
    truthDist = NC.distanceTransform(truth.data, GW, GH);
    editsCanvas = null;
  }
  function rebuildPlanMap() {
    planOcc = S.slam ? Uint8Array.from(belief, (l) => (l > 0.4 ? 1 : 0)) : truth.data;
    dist = NC.distanceTransform(planOcc, GW, GH);
    cost = NC.buildCostmap(dist, RES, R_ROBOT + 0.02, { weight: S.comfort, decay: 0.35 });
    costCanvas = null;
    beliefCanvas = null;
  }
  const cellOf = (x, y) => [M.clamp(Math.floor(x / RES), 0, GW - 1), M.clamp(Math.floor(y / RES), 0, GH - 1)];
  const clearAt = (dmap, x, y) => {
    const i = Math.floor(x / RES);
    const j = Math.floor(y / RES);
    if (i < 0 || j < 0 || i >= GW || j >= GH) return 0;
    return dmap[j * GW + i] * RES;
  };

  // ------------------------------------------------------------------ planning
  function nearestFree(i, j) {
    if (Number.isFinite(cost[j * GW + i])) return [i, j];
    for (let r = 1; r < 20; r++) {
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const a = i + di;
        const b = j + dj;
        if (a >= 0 && b >= 0 && a < GW && b < GH && Number.isFinite(cost[b * GW + a])) return [a, b];
      }
    }
    return [i, j];
  }
  function plan(announce = true) {
    if (!goal) return false;
    const t0 = performance.now();
    const s = nearestFree(...cellOf(robot.x, robot.y));
    const g = nearestFree(...cellOf(goal.x, goal.y));
    const res = NC.astar(cost, GW, GH, s, g);
    const ms = performance.now() - t0;
    if (!res.path) {
      path = null;
      setStatus('No path to ' + goal.name, 'bad');
      if (announce) Lab.toast(`No collision-free route to ${goal.name}`);
      return false;
    }
    const pts = res.path.map(([i, j]) => [(i + 0.5) * RES, (j + 0.5) * RES]);
    pts[pts.length - 1] = [goal.x, goal.y];
    const clear = (a, b) => {
      const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / RES);
      for (let k = 0; k <= n; k++) {
        const x = a[0] + ((b[0] - a[0]) * k) / n;
        const y = a[1] + ((b[1] - a[1]) * k) / n;
        if (clearAt(dist, x, y) < R_ROBOT + 0.14) return false;
      }
      return true;
    };
    path = NC.densify(NC.smoothPath(pts, clear), 0.1);
    pathIdx = 0;
    pathInfo = { expanded: res.expanded, ms, closed: res.closed };
    exploredCanvas = null;
    stats.replans++;
    return true;
  }
  function pathBlocked() {
    if (!path) return false;
    for (let k = pathIdx; k < path.length; k += 2) if (clearAt(dist, path[k][0], path[k][1]) < R_ROBOT) return true;
    return false;
  }
  function pathLength(from = 0) {
    let L = 0;
    for (let k = from + 1; path && k < path.length; k++) L += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
    return L;
  }
  function lookahead(L) {
    // advance the closest-point index monotonically, then walk L metres ahead
    let best = pathIdx;
    let bd = Infinity;
    for (let k = pathIdx; k < Math.min(path.length, pathIdx + 40); k++) {
      const d = Math.hypot(path[k][0] - robot.x, path[k][1] - robot.y);
      if (d < bd) { bd = d; best = k; }
    }
    pathIdx = best;
    let acc = 0;
    for (let k = best + 1; k < path.length; k++) {
      acc += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
      if (acc >= L) return path[k];
    }
    return path[path.length - 1];
  }

  function goTo(dest) {
    goal = { ...dest };
    modeSeg.set('auto');
    S.mode = 'auto';
    if (plan()) setStatus(`Heading to ${goal.name}`, 'accent');
  }

  // ------------------------------------------------------------------ controllers
  const dwaParams = () => ({
    window: 0.3, vMin: -0.15, vMax: S.vmax, aMax: S.acc, wMax: S.wmax, alphaMax: S.alpha,
    nv: 7, nw: 17, horizon: 1.8, step: 0.15, radius: R_ROBOT,
    wClear: 0.8, clearZone: 0.25, wGoal: 1.0, wHeading: 0.35, wSpeed: 0.6, wPath: 1.4, wUser: S.share,
  });
  const peopleCtx = () => (S.people ? people.map((p) => ({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, r: p.r })) : []);

  function control(dt) {
    dwaRes = null;
    limited = false;
    if (S.mode === 'auto') {
      if (!goal || !path) { cmd = { v: 0, w: 0 }; return; }
      const dGoal = Math.hypot(goal.x - robot.x, goal.y - robot.y);
      if (dGoal < 0.12) {
        const e = NC.wrap(goal.th - robot.th);
        if (Math.abs(e) < 0.06) {
          cmd = { v: 0, w: 0 };
          setStatus(`Arrived: ${goal.name}`, 'good');
          goal = null;
          path = null;
        } else cmd = { v: 0, w: M.clamp(1.6 * e, -S.wmax * 0.7, S.wmax * 0.7) };
        return;
      }
      if (recovery > 0) {
        // back up slightly while turning towards the path, then replan
        recovery -= dt;
        const tgt = lookahead(0.5);
        const e = NC.wrap(Math.atan2(tgt[1] - robot.y, tgt[0] - robot.x) - robot.th);
        cmd = { v: arcSafe(-0.12, 0, 0.6) ? -0.12 : 0, w: M.clamp(1.5 * e, -0.8, 0.8) };
        setStatus('Recovering — re-aligning', 'warn');
        if (recovery <= 0) plan(false);
        return;
      }
      if (dGoal < 0.6) {
        // docking: proportional point stabilisation with a safety check
        const e = NC.wrap(Math.atan2(goal.y - robot.y, goal.x - robot.x) - robot.th);
        let v = Math.min(0.35, 0.7 * dGoal) * Math.max(0, Math.cos(e));
        const w = M.clamp(2.2 * e, -S.wmax * 0.8, S.wmax * 0.8);
        if (!arcSafe(v, w, 0.8)) v = 0;
        cmd = { v, w };
        setStatus(`Docking at ${goal.name}`, 'accent');
        return;
      }
      // primary tracker: adaptive-lookahead pure pursuit on the centred global path
      const clr = clearAt(dist, robot.x, robot.y);
      const L = M.clamp(0.3 + 0.8 * (clr - R_ROBOT), 0.35, 0.8);
      const tgt = lookahead(L);
      const alpha = NC.wrap(Math.atan2(tgt[1] - robot.y, tgt[0] - robot.x) - robot.th);
      let v;
      let w;
      if (Math.abs(alpha) > 0.9) {
        v = 0;
        w = Math.sign(alpha) * Math.min(0.9, 1.8 * Math.abs(alpha));
      } else {
        const vLim = M.clamp((clr - R_ROBOT) * 3 + 0.12, 0.15, S.vmax) * (1 - 0.55 * Math.abs(alpha));
        v = Math.min(vLim, 0.55 * dGoal + 0.1);
        w = M.clamp((2 * v * Math.sin(alpha)) / L, -S.wmax, S.wmax);
      }
      // DWA runs every cycle (candidate arcs are drawn) and takes over when the pursuit arc is unsafe
      const local = path.slice(pathIdx, Math.min(path.length, pathIdx + 24));
      dwaRes = NC.dwa(robot, dwaParams(), { clearanceAt: (x, y) => clearAt(dist, x, y), people: peopleCtx(), target: lookahead(0.7), path: local, user: null });
      if (arcSafe(v, w, 1.2, 0)) {
        cmd = { v, w };
        blockedTime = 0;
        setStatus(`Heading to ${goal.name} · ${pathLength(pathIdx).toFixed(1)} m`, 'accent');
      } else if (dwaRes.best) {
        cmd = { v: Math.min(dwaRes.best.v, 0.55 * dGoal + 0.1), w: dwaRes.best.w };
        blockedTime = 0;
        setStatus(`Avoiding obstacle · ${goal.name}`, 'warn');
      } else {
        cmd = { v: 0, w: 0 };
        blockedTime += dt;
        setStatus('Waiting — path obstructed', 'warn');
        if (blockedTime > 3) { blockedTime = 0; plan(false); }
      }
      // progress watchdog: no motion towards the goal for 3 s → recovery behaviour
      progress.t += dt;
      if (progress.t > 3) {
        const moved = Math.hypot(robot.x - progress.x, robot.y - progress.y);
        const peopleNear = S.people && people.some((p) => Math.hypot(p.x - robot.x, p.y - robot.y) < 1.4);
        stuckFor = moved < 0.1 ? stuckFor + 3 : 0;
        if (moved < 0.1 && (!peopleNear || stuckFor >= 6)) recovery = 1.4;
        progress = { t: 0, x: robot.x, y: robot.y };
      }
    } else if (S.mode === 'shared') {
      const active = Math.abs(userFilt.v) > 0.03 || Math.abs(userFilt.w) > 0.05;
      if (!active) { cmd = { v: 0, w: 0 }; setStatus('Shared control · waiting for joystick', 'neutral'); return; }
      dwaRes = NC.dwa(robot, { ...dwaParams(), wClear: 0.6, wSpeed: 0 }, { clearanceAt: (x, y) => clearAt(dist, x, y), people: peopleCtx(), target: null, user: userFilt });
      cmd = dwaRes.best ? { v: dwaRes.best.v, w: dwaRes.best.w } : { v: 0, w: 0 };
      setStatus('Shared control · assisting', 'accent');
    } else {
      cmd = { ...userCmd };
      if (S.safety && Math.abs(cmd.v) > 0.02) {
        for (const f of [1, 0.75, 0.5, 0.3, 0.15, 0]) {
          if (f === 0 || arcSafe(cmd.v * f, cmd.w, 1.1)) {
            if (f < 1) {
              limited = true;
              cmd.v *= f;
            }
            break;
          }
        }
      }
      setStatus(limited ? 'Manual · safety layer braking' : 'Manual control', limited ? 'warn' : 'neutral');
    }
  }
  let wasLimited = false;
  let recovery = 0;
  let stuckFor = 0;
  let progress = { t: 0, x: 0, y: 0 };
  function arcSafe(v, w, horizon, margin = 0.03) {
    let x = robot.x;
    let y = robot.y;
    let th = robot.th;
    const ps = peopleCtx();
    for (let s = 0.1; s <= horizon; s += 0.1) {
      th += w * 0.1;
      x += v * Math.cos(th) * 0.1;
      y += v * Math.sin(th) * 0.1;
      if (clearAt(dist, x, y) < R_ROBOT + margin) return false;
      for (const p of ps) if (Math.hypot(x - (p.x + p.vx * s), y - (p.y + p.vy * s)) < R_ROBOT + p.r + 0.05) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ simulation
  function stepUserInput(dt) {
    const key = keyCommand();
    const joy = joyState.active ? { v: -joyState.y * S.vmax, w: -joyState.x * S.wmax } : null;
    userRaw = joy || key;
    userCmd = { ...userRaw };
    if (S.tremor && (Math.abs(userRaw.v) > 0.02 || Math.abs(userRaw.w) > 0.02)) {
      const a = S.tremorAmp;
      userCmd.v += a * S.vmax * 0.45 * (Math.sin(2 * Math.PI * 4.6 * clock) + 0.6 * tremorNoise());
      userCmd.w += a * S.wmax * 0.8 * (Math.sin(2 * Math.PI * 5.3 * clock + 1) + 0.6 * tremorNoise());
    }
    const k = 1 - Math.exp(-dt / 0.25);
    userFilt.v += (userCmd.v - userFilt.v) * k;
    userFilt.w += (userCmd.w - userFilt.w) * k;
  }
  const trng = M.makeRng(5);
  const tremorNoise = () => trng.gauss(0, 1);

  function stepPeople(dt) {
    for (const p of people) {
      if (!S.people) { p.vx = p.vy = 0; continue; }
      const [tx, ty] = p.path[p.next];
      const [ox, oy] = p.path[p.i];
      const segx = tx - ox;
      const segy = ty - oy;
      const L = Math.hypot(segx, segy) || 1;
      const ux = segx / L;
      const uy = segy / L;
      // walking line position (without side-step)
      p.s = p.s ?? 0;
      const rx = robot.x - p.x;
      const ry = robot.y - p.y;
      const ahead = rx * ux + ry * uy;
      const lateral = -rx * uy + ry * ux;
      const near = Math.hypot(rx, ry) < 1.6 && ahead > -0.2;
      const targetSide = near ? (lateral > 0 ? -0.42 : 0.42) : 0;
      p.side += (targetSide - p.side) * Math.min(1, dt * 2.5);
      if (p.pause > 0) { p.pause -= dt; p.vx = p.vy = 0; } else {
        const slow = near && ahead < 1.0 ? 0.35 : 1;
        p.s += p.speed * slow * dt;
        if (p.s >= L) {
          p.s = 0;
          p.i = p.next;
          p.next = (p.next + 1) % p.path.length;
          p.pause = 0.8;
        }
      }
      const bx = ox + ux * Math.min(p.s, L);
      const by = oy + uy * Math.min(p.s, L);
      let nx = bx - uy * p.side;
      let ny = by + ux * p.side;
      if (clearAt(truthDist, nx, ny) < 0.28) { nx = bx; ny = by; }
      p.vx = (nx - p.x) / Math.max(dt, 1e-3);
      p.vy = (ny - p.y) / Math.max(dt, 1e-3);
      p.x = nx;
      p.y = ny;
    }
  }

  function stepRobot(dt) {
    const dv = M.clamp(cmd.v - robot.v, -S.acc * dt, S.acc * dt);
    const dw = M.clamp(cmd.w - robot.w, -S.alpha * dt, S.alpha * dt);
    robot.v += dv;
    robot.w += dw;
    const th = robot.th + robot.w * dt;
    const x = robot.x + robot.v * Math.cos(th) * dt;
    const y = robot.y + robot.v * Math.sin(th) * dt;
    let hit = clearAt(truthDist, x, y) < R_ROBOT - 0.03;
    if (S.people) for (const p of people) if (Math.hypot(x - p.x, y - p.y) < R_ROBOT + p.r - 0.02) hit = true;
    if (hit && Math.abs(robot.v) > 0.01) {
      robot.v = 0;
      robot.th = th;
      if (status.cls !== 'bad') Lab.toast('Bump! Turn on the safety layer or use shared control.');
      setStatus('Collision — stopped', 'bad');
    } else {
      stats.dist += Math.hypot(x - robot.x, y - robot.y);
      robot.x = x;
      robot.y = y;
      robot.th = NC.wrap(th);
    }
    if (!trail.length || Math.hypot(trail[trail.length - 1][0] - robot.x, trail[trail.length - 1][1] - robot.y) > 0.05) {
      trail.push([robot.x, robot.y]);
      if (trail.length > 1600) trail.shift();
    }
  }

  function scan() {
    const n = S.beams;
    const beams = [];
    const ps = S.people ? people : [];
    for (let k = 0; k < n; k++) {
      const a = robot.th + (k * 2 * Math.PI) / n;
      let r = truth.raycast(robot.x, robot.y, a, S.range);
      let dyn = false;
      const cx = Math.cos(a);
      const cy = Math.sin(a);
      for (const p of ps) {
        // ray–circle intersection
        const fx = robot.x - p.x;
        const fy = robot.y - p.y;
        const b = fx * cx + fy * cy;
        const c = fx * fx + fy * fy - p.r * p.r;
        const disc = b * b - c;
        if (disc >= 0) {
          const tt = -b - Math.sqrt(disc);
          if (tt > 0 && tt < r) {
            r = tt;
            dyn = true;
          }
        }
      }
      if (r < S.range) r = Math.max(0.02, r + noise.gauss(0, 0.01));
      beams.push({ a, r, dyn });
    }
    scanBeams = beams;
    if (S.slam) {
      NC.updateLogOdds(belief, GW, GH, RES, robot.x, robot.y, beams, S.range);
      rebuildPlanMap();
      if (S.mode === 'auto' && goal && pathBlocked()) plan(false);
    }
  }
  const noise = M.makeRng(17);

  // ------------------------------------------------------------------ status / stats
  function setStatus(text, cls) {
    status = { text, cls };
  }
  function updateDom() {
    const chip = Lab.$('#status-chip');
    chip.textContent = status.text;
    chip.className = 'chip status-chip ' + (status.cls === 'accent' ? '' : status.cls);
    const minR = scanBeams.length ? Math.min(...scanBeams.map((b) => b.r)) : Infinity;
    Lab.$('#st-speed').innerHTML = `${Math.abs(robot.v).toFixed(2)}<span class="u">m/s</span>`;
    const cl = Lab.$('#st-clear');
    cl.innerHTML = Number.isFinite(minR) ? `${Math.max(0, minR - R_ROBOT).toFixed(2)}<span class="u">m</span>` : '—';
    cl.parentElement.className = 'stat ' + (minR - R_ROBOT < 0.15 ? 'bad' : minR - R_ROBOT < 0.35 ? 'warn' : 'good');
    Lab.$('#st-dist').innerHTML = `${stats.dist.toFixed(1)}<span class="u">m</span>`;
    Lab.$('#st-int').textContent = stats.interventions;
    Lab.$('#st-assist').innerHTML = `${Math.round(stats.assist * 100)}<span class="u">%</span>`;
    Lab.$('#st-replan').textContent = stats.replans;
    Lab.text('u-v', userCmd.v.toFixed(2));
    Lab.text('u-w', userCmd.w.toFixed(2));
    Lab.text('e-v', cmd.v.toFixed(2));
    Lab.text('e-w', cmd.w.toFixed(2));
    const p = pathInfo && path ? ` · A* ${pathInfo.expanded.toLocaleString()} cells in ${pathInfo.ms.toFixed(0)} ms` : '';
    Lab.text('map-sub', `12 × 8 m · 5 cm grid${S.slam ? ' · mapping from LIDAR' : ''}${p}`);
  }

  // ------------------------------------------------------------------ rendering
  const cv = Lab.canvas('cv-map');
  let view = { s: 60, ox: 0, oy: 0 };
  function computeView() {
    const m = 14;
    const s = Math.min((cv.w - 2 * m) / W, (cv.h - 2 * m - 26) / H);
    view = { s, ox: (cv.w - W * s) / 2, oy: (cv.h - 26 - H * s) / 2 + H * s };
  }
  const sx = (x) => view.ox + x * view.s;
  const sy = (y) => view.oy - y * view.s;
  const toWorld = (p) => ({ x: (p.x - view.ox) / view.s, y: (view.oy - p.y) / view.s });

  function gridImage(fn) {
    const c = document.createElement('canvas');
    c.width = GW;
    c.height = GH;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(GW, GH);
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const rgba = fn(j * GW + i);
        if (!rgba) continue;
        const o = ((GH - 1 - j) * GW + i) * 4;
        img.data[o] = rgba[0];
        img.data[o + 1] = rgba[1];
        img.data[o + 2] = rgba[2];
        img.data[o + 3] = rgba[3];
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
  const drawGrid = (ctx, c) => {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c, sx(0), sy(H), W * view.s, H * view.s);
    ctx.imageSmoothingEnabled = true;
  };

  function draw() {
    const { ctx } = cv;
    cv.clear();
    computeView();
    // floor & rooms
    for (const r of ROOMS) {
      ctx.fillStyle = Lab.alpha(r.tint, 0.045);
      ctx.fillRect(sx(r.x0), sy(r.y1), (r.x1 - r.x0) * view.s, (r.y1 - r.y0) * view.s);
    }
    ctx.strokeStyle = 'rgba(142,160,216,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < W; x++) { ctx.moveTo(Math.round(sx(x)) + 0.5, sy(H)); ctx.lineTo(Math.round(sx(x)) + 0.5, sy(0)); }
    for (let y = 1; y < H; y++) { ctx.moveTo(sx(0), Math.round(sy(y)) + 0.5); ctx.lineTo(sx(W), Math.round(sy(y)) + 0.5); }
    ctx.stroke();

    // costmap
    if (S.layers.cost) {
      if (!costCanvas) {
        costCanvas = gridImage((k) => {
          if (planOcc[k]) return null;
          const d = dist[k] * RES;
          if (d < R_ROBOT + 0.02) return [251, 113, 133, 38];
          const a = Math.exp(-(d - R_ROBOT) / 0.35);
          return a > 0.04 ? [167, 139, 250, Math.round(52 * a)] : null;
        });
      }
      drawGrid(ctx, costCanvas);
    }
    if (S.layers.explored && pathInfo && pathInfo.closed) {
      if (!exploredCanvas) exploredCanvas = gridImage((k) => (pathInfo.closed[k] ? [251, 191, 36, 40] : null));
      drawGrid(ctx, exploredCanvas);
    }

    // walls & furniture (ghosted in SLAM mode until discovered)
    const wallAlpha = S.slam ? 0.18 : 1;
    ctx.fillStyle = Lab.alpha('#64748b', 0.9 * wallAlpha);
    for (const f of FURNITURE) {
      Lab.roundRect(ctx, sx(f.x0), sy(f.y1), (f.x1 - f.x0) * view.s, (f.y1 - f.y0) * view.s, 4);
      ctx.fill();
    }
    ctx.fillStyle = Lab.alpha('#cbd5e1', 0.92 * wallAlpha);
    for (const w of WALLS) ctx.fillRect(sx(w.x0), sy(w.y1), (w.x1 - w.x0) * view.s, (w.y1 - w.y0) * view.s);
    if (!editsCanvas) {
      editsCanvas = gridImage((k) => (edits[k] === 1 ? [226, 232, 240, 235] : edits[k] === -1 && base.data[k] ? [15, 21, 40, 255] : null));
    }
    ctx.globalAlpha = wallAlpha;
    drawGrid(ctx, editsCanvas);
    ctx.globalAlpha = 1;
    ctx.font = `600 ${Math.max(9, view.s * 0.15)}px ${T.sans}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = S.slam ? 'rgba(226,232,240,0.25)' : 'rgba(226,232,240,0.75)';
    for (const f of FURNITURE) if (f.name && (f.x1 - f.x0) * view.s > 30) ctx.fillText(f.name, sx((f.x0 + f.x1) / 2), sy((f.y0 + f.y1) / 2));

    ctx.font = `700 ${Math.max(9.5, view.s * 0.16)}px ${T.sans}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (const r of ROOMS) {
      ctx.fillStyle = Lab.alpha(r.tint, 0.7);
      ctx.fillText(r.name.toUpperCase(), sx(r.lx), sy(r.ly));
    }

    if (S.slam) {
      if (!beliefCanvas) {
        beliefCanvas = gridImage((k) => {
          const l = belief[k];
          if (l > 0.4) return [34, 211, 238, 235];
          if (l < -0.3) return null;
          return [3, 6, 14, 170];
        });
      }
      drawGrid(ctx, beliefCanvas);
    }

    // destinations
    for (const d of DESTS) {
      const active = goal && goal.key === d.key;
      ctx.strokeStyle = active ? '#a78bfa' : 'rgba(167,139,250,0.55)';
      ctx.fillStyle = active ? 'rgba(167,139,250,0.25)' : 'rgba(167,139,250,0.08)';
      ctx.lineWidth = active ? 2 : 1.2;
      ctx.beginPath();
      ctx.arc(sx(d.x), sy(d.y), R_ROBOT * view.s * 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx(d.x), sy(d.y));
      ctx.lineTo(sx(d.x + Math.cos(d.th) * 0.3), sy(d.y + Math.sin(d.th) * 0.3));
      ctx.stroke();
    }

    // trail
    if (S.layers.trail && trail.length > 1) {
      ctx.strokeStyle = 'rgba(167,139,250,0.35)';
      ctx.lineWidth = 2;
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      trail.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // global path
    if (path) {
      ctx.strokeStyle = 'rgba(167,139,250,0.3)';
      ctx.lineWidth = 7;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let k = pathIdx; k < path.length; k++) (k === pathIdx ? ctx.moveTo(sx(path[k][0]), sy(path[k][1])) : ctx.lineTo(sx(path[k][0]), sy(path[k][1])));
      ctx.stroke();
      ctx.strokeStyle = '#a78bfa';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.lineCap = 'butt';
      const g = path[path.length - 1];
      ctx.fillStyle = '#a78bfa';
      ctx.beginPath();
      ctx.moveTo(sx(g[0]), sy(g[1]));
      ctx.lineTo(sx(g[0]), sy(g[1]) - 26);
      ctx.lineTo(sx(g[0]) + 16, sy(g[1]) - 20);
      ctx.lineTo(sx(g[0]), sy(g[1]) - 14);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#a78bfa';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx(g[0]), sy(g[1]));
      ctx.lineTo(sx(g[0]), sy(g[1]) - 26);
      ctx.stroke();
    }

    // LIDAR
    if (S.layers.lidar && scanBeams.length) {
      ctx.strokeStyle = 'rgba(34,211,238,0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const b of scanBeams) {
        ctx.moveTo(sx(robot.x), sy(robot.y));
        ctx.lineTo(sx(robot.x + Math.cos(b.a) * b.r), sy(robot.y + Math.sin(b.a) * b.r));
      }
      ctx.stroke();
      ctx.fillStyle = '#22d3ee';
      for (const b of scanBeams) {
        if (b.r >= S.range - 1e-6) continue;
        ctx.fillRect(sx(robot.x + Math.cos(b.a) * b.r) - 1.5, sy(robot.y + Math.sin(b.a) * b.r) - 1.5, 3, 3);
      }
    }

    // DWA candidates
    if (S.layers.dwa && dwaRes) {
      const valid = dwaRes.trajs.filter((t) => !t.collided);
      const cmin = Math.min(...valid.map((t) => t.cost));
      const cmax = Math.max(...valid.map((t) => t.cost));
      for (const tr of dwaRes.trajs) {
        if (!tr.pts.length) continue;
        ctx.strokeStyle = tr.collided ? 'rgba(251,113,133,0.35)' : `rgba(148,163,184,${0.12 + 0.3 * (1 - (tr.cost - cmin) / (cmax - cmin + 1e-9))})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx(robot.x), sy(robot.y));
        tr.pts.forEach(([x, y]) => ctx.lineTo(sx(x), sy(y)));
        ctx.stroke();
      }
    }
    // predicted arc of the command actually being executed
    if (S.layers.dwa && (Math.abs(cmd.v) > 0.01 || Math.abs(cmd.w) > 0.01)) {
      let x = robot.x;
      let y = robot.y;
      let th = robot.th;
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(sx(x), sy(y));
      for (let k = 0; k < 18; k++) {
        th += cmd.w * 0.1;
        x += cmd.v * Math.cos(th) * 0.1;
        y += cmd.v * Math.sin(th) * 0.1;
        ctx.lineTo(sx(x), sy(y));
      }
      ctx.stroke();
    }

    // pedestrians
    if (S.people) for (const p of people) drawPerson(ctx, p);
    drawChair(ctx);

    // edit brush hint
    if (S.edit !== 'off' && hover) {
      ctx.strokeStyle = S.edit === 'draw' ? '#e2e8f0' : '#fb7185';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(sx(hover.x), sy(hover.y), 0.14 * view.s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawPerson(ctx, p) {
    const x = sx(p.x);
    const y = sy(p.y);
    const r = p.r * view.s;
    const sp = Math.hypot(p.vx, p.vy);
    const a = sp > 0.05 ? Math.atan2(p.vy, p.vx) : 0;
    ctx.fillStyle = 'rgba(251,146,60,0.22)';
    ctx.strokeStyle = '#fb923c';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.72, -a + Math.PI / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fb923c';
    ctx.beginPath();
    ctx.arc(x, y, r * 0.42, 0, Math.PI * 2);
    ctx.fill();
    if (sp > 0.05) {
      ctx.strokeStyle = '#fb923c';
      ctx.fillStyle = '#fb923c';
      Lab.arrow(ctx, x, y, x + Math.cos(a) * r * 2.1, y - Math.sin(a) * r * 2.1, 6);
    }
  }

  function drawChair(ctx) {
    const { x, y, th } = robot;
    ctx.save();
    ctx.translate(sx(x), sy(y));
    ctx.rotate(-th);
    const s = view.s;
    // footprint used for planning
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(167,139,250,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, R_ROBOT * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // rear drive wheels
    ctx.fillStyle = '#1e293b';
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.2;
    for (const side of [-1, 1]) {
      Lab.roundRect(ctx, -0.28 * s, side * 0.31 * s - 0.05 * s, 0.56 * s, 0.1 * s, 0.04 * s);
      ctx.fill();
      ctx.stroke();
    }
    // front casters
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(0.36 * s, side * 0.2 * s, 0.045 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // seat & backrest
    ctx.fillStyle = 'rgba(167,139,250,0.35)';
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 2;
    Lab.roundRect(ctx, -0.2 * s, -0.24 * s, 0.46 * s, 0.48 * s, 0.07 * s);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#a78bfa';
    Lab.roundRect(ctx, -0.3 * s, -0.25 * s, 0.1 * s, 0.5 * s, 0.04 * s);
    ctx.fill();
    // footrest
    ctx.strokeStyle = '#c4b5fd';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0.3 * s, -0.12 * s);
    ctx.lineTo(0.44 * s, -0.12 * s);
    ctx.moveTo(0.3 * s, 0.12 * s);
    ctx.lineTo(0.44 * s, 0.12 * s);
    ctx.stroke();
    // joystick on the right armrest
    ctx.fillStyle = '#34d399';
    ctx.beginPath();
    ctx.arc(0.18 * s, -0.27 * s, 0.035 * s, 0, Math.PI * 2);
    ctx.fill();
    // LIDAR puck
    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.arc(0.05 * s, 0, 0.05 * s, 0, Math.PI * 2);
    ctx.fill();
    // heading
    ctx.strokeStyle = '#e8edfb';
    ctx.fillStyle = '#e8edfb';
    ctx.lineWidth = 1.5;
    Lab.arrow(ctx, 0.45 * s, 0, 0.66 * s, 0, 6);
    ctx.restore();
    if (limited) {
      ctx.strokeStyle = 'rgba(251,191,36,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx(x), sy(y), (R_ROBOT + 0.08) * view.s, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // telemetry plot
  const telePlot = new Lab.Plot('cv-tele', { xLabel: 'time (s)', yMin: 0, yMax: 1.6, pad: { t: 10, l: 40 } });
  function drawTele() {
    const t1 = Math.max(clock, 30);
    Object.assign(telePlot.opts, { xMin: t1 - 30, xMax: t1 });
    telePlot.series = [
      { name: 'speed', color: '#a78bfa', data: tele.speed, width: 1.8, fill: 'rgba(167,139,250,0.08)' },
      { name: 'clearance', color: '#34d399', data: tele.clear, width: 1.6 },
    ];
    telePlot.draw();
  }

  // joystick widget
  const joyCv = Lab.canvas('cv-joy', () => drawJoy());
  const joyState = { active: false, x: 0, y: 0 };
  function drawJoy() {
    const { ctx, w, h } = joyCv;
    joyCv.clear();
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 6;
    const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, R);
    g.addColorStop(0, '#1a2442');
    g.addColorStop(1, '#0b1122');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = T.border2;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(142,160,216,0.18)';
    ctx.beginPath();
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.stroke();
    ctx.font = `600 9px ${T.sans}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FWD', cx, cy - R + 11);
    ctx.fillText('REV', cx, cy + R - 11);
    // actual input incl. tremor
    const ux = -userCmd.w / S.wmax;
    const uy = -userCmd.v / S.vmax;
    ctx.fillStyle = 'rgba(251,191,36,0.5)';
    ctx.beginPath();
    ctx.arc(cx + M.clamp(ux, -1, 1) * R * 0.75, cy + M.clamp(uy, -1, 1) * R * 0.75, 5, 0, Math.PI * 2);
    ctx.fill();
    const kx = cx + joyState.x * R * 0.75;
    const ky = cy + joyState.y * R * 0.75;
    const kg = ctx.createRadialGradient(kx - 5, ky - 5, 2, kx, ky, 20);
    kg.addColorStop(0, '#c4b5fd');
    kg.addColorStop(1, '#7c3aed');
    ctx.fillStyle = kg;
    ctx.beginPath();
    ctx.arc(kx, ky, 17, 0, Math.PI * 2);
    ctx.fill();
  }
  function joyPointer(e) {
    const p = joyCv.pointer(e);
    const R = (Math.min(joyCv.w, joyCv.h) / 2 - 6) * 0.75;
    let x = (p.x - joyCv.w / 2) / R;
    let y = (p.y - joyCv.h / 2) / R;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    joyState.x = x;
    joyState.y = y;
  }
  joyCv.canvas.addEventListener('pointerdown', (e) => {
    joyCv.canvas.setPointerCapture(e.pointerId);
    joyState.active = true;
    joyPointer(e);
    takeOver();
  });
  joyCv.canvas.addEventListener('pointermove', (e) => { if (joyState.active) joyPointer(e); });
  const joyRelease = () => { joyState.active = false; };
  joyCv.canvas.addEventListener('pointerup', joyRelease);
  joyCv.canvas.addEventListener('pointercancel', joyRelease);

  function takeOver() {
    if (S.mode === 'auto') {
      goal = null;
      path = null;
      modeSeg.set('shared');
      S.mode = 'shared';
      Lab.toast('User took over — shared control engaged');
    }
  }

  // keyboard driving
  const keys = new Set();
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      keys.add(k);
      e.preventDefault();
      takeOver();
    } else if (k === ' ') {
      e.preventDefault();
      stop();
    }
  });
  document.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  function keyCommand() {
    let f = 0;
    let turn = 0;
    if (keys.has('w') || keys.has('arrowup')) f += 1;
    if (keys.has('s') || keys.has('arrowdown')) f -= 0.5;
    if (keys.has('a') || keys.has('arrowleft')) turn += 1;
    if (keys.has('d') || keys.has('arrowright')) turn -= 1;
    return { v: f * S.vmax, w: turn * S.wmax * 0.8 };
  }

  // map interaction
  let hover = null;
  let painting = false;
  function paintAt(p) {
    const [ci, cj] = cellOf(p.x, p.y);
    const R = Math.round(0.14 / RES);
    for (let j = cj - R; j <= cj + R; j++) {
      for (let i = ci - R; i <= ci + R; i++) {
        if (i < 2 || j < 2 || i >= GW - 2 || j >= GH - 2 || (i - ci) ** 2 + (j - cj) ** 2 > R * R) continue;
        edits[j * GW + i] = S.edit === 'draw' ? 1 : -1;
      }
    }
    editsCanvas = null;
  }
  cv.canvas.addEventListener('pointerdown', (e) => {
    const p = toWorld(cv.pointer(e));
    if (S.edit !== 'off') {
      painting = true;
      cv.canvas.setPointerCapture(e.pointerId);
      paintAt(p);
      return;
    }
    if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) return;
    const [i, j] = cellOf(p.x, p.y);
    if (!Number.isFinite(cost[j * GW + i])) return Lab.toast('That spot is too close to an obstacle for the wheelchair');
    goTo({ key: 'custom', name: 'selected point', x: p.x, y: p.y, th: Math.atan2(p.y - robot.y, p.x - robot.x) });
  });
  cv.canvas.addEventListener('pointermove', (e) => {
    hover = toWorld(cv.pointer(e));
    if (painting) paintAt(hover);
  });
  const endPaint = () => {
    if (!painting) return;
    painting = false;
    rebuildTruth();
    rebuildPlanMap();
    if (goal) plan(false);
  };
  cv.canvas.addEventListener('pointerup', endPaint);
  cv.canvas.addEventListener('pointerleave', () => { hover = null; endPaint(); });

  // ------------------------------------------------------------------ sidebar & drive controls
  const modeSeg = Lab.seg('seg-mode', (v) => {
    S.mode = v;
    if (v !== 'auto') { goal = null; path = null; }
    setStatus(v === 'manual' ? 'Manual control' : v === 'shared' ? 'Shared control' : 'Autonomous · choose a destination', 'neutral');
  });
  Lab.$('#dests').innerHTML = DESTS.map((d) => `<button class="btn" data-dest="${d.key}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[d.key]}</svg>${d.name}</button>`).join('');
  Lab.$$('#dests button').forEach((b) => b.addEventListener('click', () => goTo(DESTS.find((d) => d.key === b.dataset.dest))));
  function runCommand() {
    const text = Lab.$('#cmd').value.trim().toLowerCase();
    const reply = Lab.$('#cmd-reply');
    if (!text) return;
    if (/\b(stop|halt|wait|freeze)\b/.test(text)) { stop(); reply.textContent = '⏹ Stopping.'; return; }
    let best = null;
    let score = 0;
    for (const d of DESTS) {
      const s = d.words.reduce((acc, w) => acc + (new RegExp(`\\b${w}`).test(text) ? 1 : 0), 0);
      if (s > score) { score = s; best = d; }
    }
    if (!best) { reply.textContent = 'Sorry, I did not recognise a destination. Try “bedroom”, “kitchen” or “front door”.'; return; }
    goTo(best);
    reply.textContent = path ? `→ ${best.name}: ${pathLength().toFixed(1)} m, about ${Math.round(pathLength() / (S.vmax * 0.6))} s.` : `No route to ${best.name}.`;
  }
  Lab.$('#btn-cmd').addEventListener('click', runCommand);
  Lab.$('#cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCommand(); });
  function stop() {
    goal = null;
    path = null;
    cmd = { v: 0, w: 0 };
    setStatus('Stopped', 'warn');
  }
  Lab.$('#btn-stop').addEventListener('click', stop);

  Lab.toggle('tg-people', (v) => (S.people = v));
  Lab.toggle('tg-slam', (v) => {
    S.slam = v;
    belief = new Float32Array(GW * GH);
    rebuildPlanMap();
    if (goal) plan(false);
  });
  Lab.seg('seg-edit', (v) => { S.edit = v; cv.canvas.style.cursor = v === 'off' ? 'crosshair' : 'none'; });
  Lab.$('#btn-reset-map').addEventListener('click', () => { resetWorld(); setStatus('Idle', 'neutral'); });
  Lab.range('sl-vmax', { format: (v) => `${v.toFixed(2)} m/s`, onInput: (v) => (S.vmax = v) });
  Lab.range('sl-acc', { format: (v) => `${v.toFixed(1)} m/s²`, onInput: (v) => (S.acc = v) });
  Lab.range('sl-comfort', { format: (v) => v.toFixed(1), onInput: (v) => { S.comfort = v; rebuildPlanMap(); if (goal) plan(false); } });
  Lab.range('sl-share', { format: (v) => v.toFixed(1), onInput: (v) => (S.share = v) });
  Lab.toggle('tg-safety', (v) => (S.safety = v));
  Lab.toggle('tg-tremor', (v) => (S.tremor = v));
  Lab.range('sl-tremor', { format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => (S.tremorAmp = v) });
  Lab.range('sl-beams', { format: (v) => `${v}`, onInput: (v) => (S.beams = v) });
  Lab.range('sl-range', { format: (v) => `${v.toFixed(1)} m`, onInput: (v) => (S.range = v) });
  for (const k of ['lidar', 'cost', 'dwa', 'explored', 'trail']) Lab.toggle('tg-' + k, (v) => (S.layers[k] = v));

  // ------------------------------------------------------------------ main loop
  const DT = 0.02;
  let acc = 0;
  let ctrlAcc = 0;
  let scanAcc = 0;
  let domAcc = 0;
  Lab.loop((dt) => {
    acc += dt;
    while (acc >= DT) {
      acc -= DT;
      clock += DT;
      stepUserInput(DT);
      stepPeople(DT);
      scanAcc += DT;
      if (scanAcc >= 0.1) { scanAcc = 0; scan(); }
      ctrlAcc += DT;
      if (ctrlAcc >= 0.1) {
        ctrlAcc = 0;
        control(0.1);
        if (limited && !wasLimited) stats.interventions++;
        wasLimited = limited;
        if (S.mode !== 'auto' && (Math.abs(userCmd.v) > 0.03 || Math.abs(userCmd.w) > 0.05)) {
          const a = (Math.abs(cmd.v - userCmd.v) / S.vmax + Math.abs(cmd.w - userCmd.w) / S.wmax) / 2;
          stats.assist += (Math.min(1, a) - stats.assist) * 0.05;
        }
        const minR = scanBeams.length ? Math.min(...scanBeams.map((b) => b.r)) : S.range;
        tele.speed.push(clock, Math.abs(robot.v));
        tele.clear.push(clock, Math.min(1.6, Math.max(0, minR - R_ROBOT)));
      }
      stepRobot(DT);
    }
    draw();
    drawJoy();
    domAcc += dt;
    if (domAcc > 0.1) { domAcc = 0; updateDom(); drawTele(); }
  });

  // ------------------------------------------------------------------ init
  resetWorld();
  setStatus('Autonomous · choose a destination', 'neutral');
  setTimeout(() => { if (!goal && S.mode === 'auto') goTo(DESTS.find((d) => d.key === 'kitchen')); }, 600);

  window.NaviChair = {
    state: S,
    goTo: (key) => goTo(DESTS.find((d) => d.key === key)),
    mode: (m) => { modeSeg.set(m, true); },
    get robot() { return robot; },
    setRobot: (x, y, th) => Object.assign(robot, { x, y, th, v: 0, w: 0 }),
    user: (v, w) => { joyState.active = true; joyState.x = -w; joyState.y = -v; },
    release: () => (joyState.active = false),
    toggle: (id, v) => { const el = document.getElementById(id); el.checked = v; el.dispatchEvent(new Event('change')); },
    command: (t) => { Lab.$('#cmd').value = t; runCommand(); },
    get status() { return status.text; },
    get debug() {
      return { robot: { ...robot }, cmd: { ...cmd }, best: dwaRes && dwaRes.best ? { v: dwaRes.best.v, w: dwaRes.best.w, cost: dwaRes.best.cost } : null,
        nValid: dwaRes ? dwaRes.trajs.filter((t) => !t.collided).length : 0, pathIdx, pathLen: path ? path.length : 0,
        target: path ? lookaheadPeek() : null, clear: clearAt(dist, robot.x, robot.y) };
    },
  };
  function lookaheadPeek() { const i = pathIdx; const j = Math.min(path.length - 1, i + 9); return path[j]; }
})();
