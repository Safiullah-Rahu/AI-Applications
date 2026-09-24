/* ArmStudio — UI, interaction modes, rendering of workspace / C-space / joint plots. */
(function () {
  'use strict';
  const A = window.ArmCore;
  const M = window.LabMath;
  Lab.boot();
  const T = Lab.theme();
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const OBS_COLORS = ['#2dd4bf', '#f472b6', '#a78bfa', '#38bdf8', '#fb923c', '#a3e635'];
  const JOINT_COLORS = ['#fbbf24', '#38bdf8', '#f472b6'];
  const LIMITS = [[-180, 180], [-165, 165], [-165, 165]];
  const HOME = [90 * D2R, -90 * D2R, 0];
  const LINK_DENSITY = 2.5; // kg per metre of link

  const S = {
    dof: 2,
    L: [1.0, 0.8, 0.45],
    q: [60 * D2R, -40 * D2R, -20 * D2R],
    mode: 'plan',
    elbow: -1,
    lockPhi: false,
    lockedPhi: 0,
    speed: 90,
    payload: 1,
    floor: true,
    show: { map: true, ellipse: true, frames: false, ghosts: true, explored: true },
  };
  let obstacles = defaultObstacles();
  let arm;
  let world;
  let csDirty = true;
  let mapDirty = true;
  let csQ3 = null;

  let exec = null; // active joint-space trajectory
  let plan = null; // last planning result
  let target = null; // {x, y, ok}
  let userStroke = null; // points being sketched
  let guideStroke = null; // last sketched path (world coords)
  let pen = []; // strokes traced by the tool
  let drawJob = null;
  let clock = 0;
  let prevQ = null;

  function defaultObstacles() {
    return [
      { type: 'circle', x: 0.9, y: 0.95, r: 0.18 },
      { type: 'box', x: -1.05, y: 0.35, hw: 0.2, hh: 0.35 },
      { type: 'circle', x: -0.35, y: 1.45, r: 0.15 },
    ];
  }
  function rebuild() {
    arm = new A.PlanarArm(S.L.slice(0, S.dof), LIMITS.slice(0, S.dof));
    world = new A.World(obstacles, { floor: S.floor, pedestal: S.floor ? { hw: 0.13, h: 0.25 } : null });
    csDirty = true;
    mapDirty = true;
    updateSubtitles();
    renderObsLegend();
  }
  const curQ = () => S.q.slice(0, S.dof);
  const qDist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

  // ------------------------------------------------------------------ canvases & plots
  const work = Lab.canvas('cv-work', () => { if (arm) { computeView(); mapDirty = true; } });
  const cs = Lab.canvas('cv-cspace');
  const qPlot = new Lab.Plot('cv-q', { yLabel: 'angle (°)', yMin: -180, yMax: 180, pad: { b: 20 }, yTicks: 5 });
  const qdPlot = new Lab.Plot('cv-qd', { yLabel: 'velocity (°/s)', xLabel: 'time (s)', yMinSpan: 40 });
  const logQ = [0, 1, 2].map(() => new Lab.RingSeries(1400));
  const logQd = [0, 1, 2].map(() => new Lab.RingSeries(1400));
  const WINDOW = 12;

  // ------------------------------------------------------------------ view transforms
  let view = { scale: 100, ox: 0, oy: 0 };
  function computeView() {
    const reach = arm.reach;
    const xr = reach + 0.28;
    const yTop = arm.base.y + reach + 0.22;
    const yBot = -0.14;
    const scale = Math.min(work.w / (2 * xr), (work.h - 8) / (yTop - yBot));
    view = { scale, ox: work.w / 2, oy: work.h / 2 + ((yTop + yBot) / 2) * scale };
  }
  const sx = (x) => view.ox + x * view.scale;
  const sy = (y) => view.oy - y * view.scale;
  const toWorld = (p) => ({ x: (p.x - view.ox) / view.scale, y: (view.oy - p.y) / view.scale });

  let csRect = { x: 0, y: 0, s: 1 };
  function computeCsRect() {
    const pad = { l: 46, r: 14, t: 12, b: 30 };
    const size = Math.max(40, Math.min(cs.w - pad.l - pad.r, cs.h - pad.t - pad.b));
    csRect = { x: pad.l + (cs.w - pad.l - pad.r - size) / 2, y: pad.t + (cs.h - pad.t - pad.b - size) / 2, s: size };
  }
  const csX = (q1) => csRect.x + ((q1 + Math.PI) / (2 * Math.PI)) * csRect.s;
  const csY = (q2) => csRect.y + csRect.s - ((q2 + Math.PI) / (2 * Math.PI)) * csRect.s;

  // ------------------------------------------------------------------ C-space image
  let csCanvas = document.createElement('canvas');
  let csGrid = null;
  function computeCspace() {
    const res = S.dof === 2 ? 180 : 120;
    csQ3 = S.q[2];
    csGrid = A.cspaceGrid(arm, world, res, S.q[2]);
    csCanvas.width = res;
    csCanvas.height = res;
    const ctx = csCanvas.getContext('2d');
    const img = ctx.createImageData(res, res);
    const rgb = OBS_COLORS.map((c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]);
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const v = csGrid.data[j * res + i];
        const o = ((res - 1 - j) * res + i) * 4; // flip so +θ2 points up
        let c;
        if (v === A.FREE) c = [13, 20, 40];
        else if (v === A.FLOOR) c = ((i + j) & 3) === 0 ? [74, 85, 104] : [51, 62, 82];
        else if (v === A.LIMIT) c = ((i + (res - j)) % 6) < 2 ? [60, 40, 58] : [30, 24, 40];
        else if (v === A.SELF) c = [124, 58, 36];
        else {
          const base = rgb[v % rgb.length];
          c = [base[0] * 0.78, base[1] * 0.78, base[2] * 0.78];
        }
        img.data[o] = c[0];
        img.data[o + 1] = c[1];
        img.data[o + 2] = c[2];
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    csDirty = false;
    updateSubtitles();
  }

  // ------------------------------------------------------------------ manipulability map
  const mapCanvas = document.createElement('canvas');
  let mapTimer = 0;
  function computeMap() {
    const f = S.dof === 2 ? 3 : 5;
    const mw = Math.max(20, Math.floor(work.w / f));
    const mh = Math.max(20, Math.floor(work.h / f));
    mapCanvas.width = mw;
    mapCanvas.height = mh;
    const ctx = mapCanvas.getContext('2d');
    const img = ctx.createImageData(mw, mh);
    const W = new Float32Array(mw * mh);
    let wMax = 1e-9;
    const phis = S.dof === 3 ? Array.from({ length: 16 }, (_, k) => -Math.PI + (k * 2 * Math.PI) / 16) : [0];
    for (let j = 0; j < mh; j++) {
      for (let i = 0; i < mw; i++) {
        const p = toWorld({ x: (i + 0.5) * f, y: (j + 0.5) * f });
        if (p.y < 0) continue;
        let best = 0;
        for (const phi of phis) {
          for (const el of [-1, 1]) {
            const q = arm.ikAnalytic(p.x, p.y, el, phi);
            if (!q || world.config(arm, q) !== A.FREE) continue;
            const w = arm.manipulability(q).w;
            if (w > best) best = w;
          }
        }
        W[j * mw + i] = best;
        if (best > wMax) wMax = best;
      }
    }
    for (let k = 0; k < mw * mh; k++) {
      const t = W[k] / wMax;
      const o = k * 4;
      if (t <= 0) { img.data[o + 3] = 0; continue; }
      // reachable & collision-free: blue tint whose strength follows manipulability
      img.data[o] = 70 + 40 * t;
      img.data[o + 1] = 130 + 60 * t;
      img.data[o + 2] = 250;
      img.data[o + 3] = Math.round(16 + 58 * t);
    }
    ctx.putImageData(img, 0, 0);
    mapDirty = false;
  }

  // ------------------------------------------------------------------ planning & motion
  function goalCandidates(x, y) {
    const cands = [];
    if (S.dof === 2) {
      for (const el of [-1, 1]) { const q = arm.ikAnalytic(x, y, el); if (q) cands.push(q); }
    } else {
      for (let k = 0; k < 72; k++) {
        const phi = -Math.PI + (k * 2 * Math.PI) / 72;
        for (const el of [-1, 1]) { const q = arm.ikAnalytic(x, y, el, phi); if (q) cands.push(q); }
      }
    }
    const q0 = curQ();
    const free = cands.filter((q) => world.config(arm, q) === A.FREE).sort((a, b) => qDist(a, q0) - qDist(b, q0));
    return { free, any: cands.length > 0 };
  }

  function planTo(x, y) {
    target = { x, y, ok: true };
    const { free, any } = goalCandidates(x, y);
    if (!any) { target.ok = false; return Lab.toast('Target is outside the reachable workspace'); }
    if (!free.length) { target.ok = false; return Lab.toast('Every IK solution for this target is in collision'); }
    planToQ(free, true);
  }
  function planToQ(goals, fromTarget) {
    const qs = curQ();
    if (world.config(arm, qs) !== A.FREE) {
      if (target) target.ok = false;
      return Lab.toast('Current pose is in collision — drag the dot in C-space to a free region first');
    }
    const tries = Math.min(goals.length, S.dof === 2 ? 2 : 3);
    for (let k = 0; k < tries; k++) {
      const t0 = performance.now();
      const res = A.planPath(arm, world, qs, goals[k]);
      if (res.ok) {
        plan = { ...res, ms: performance.now() - t0, start: qs, goal: goals[k], dof: S.dof, explored: exploredImage(res) };
        startExec(res.path);
        updatePlanStats();
        return true;
      }
    }
    if (fromTarget && target) target.ok = false;
    Lab.toast('No collision-free path found');
    return false;
  }
  function startExec(path) {
    drawJob = null;
    exec = { traj: A.timeParam(path, S.speed * D2R), t: 0 };
  }
  function exploredImage(res) {
    // project the A* closed set onto the (θ1, θ2) plane
    const R = res.res;
    const c = document.createElement('canvas');
    c.width = R;
    c.height = R;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(R, R);
    const n = S.dof;
    const total = R ** n;
    for (let i = 0; i < total; i++) {
      if (!res.closed[i]) continue;
      const a = i % R;
      const b = Math.floor(i / R) % R;
      const o = ((R - 1 - b) * R + a) * 4;
      img.data[o] = 232;
      img.data[o + 1] = 237;
      img.data[o + 2] = 251;
      img.data[o + 3] = 34;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
  function updatePlanStats() {
    updateSubtitles();
  }

  // ------------------------------------------------------------------ IK drag & draw modes
  function ikFollow(x, y) {
    let q;
    if (S.dof === 2) {
      q = arm.ikAnalytic(x, y, S.elbow);
      target = { x, y, ok: !!q };
      if (!q) {
        // project onto the reachable annulus
        const dx = x - arm.base.x;
        const dy = y - arm.base.y;
        const r = Math.hypot(dx, dy) || 1e-6;
        const rr = M.clamp(r, Math.abs(S.L[0] - S.L[1]) + 1e-3, S.L[0] + S.L[1] - 1e-3);
        q = arm.ikAnalytic(arm.base.x + (dx / r) * rr, arm.base.y + (dy / r) * rr, S.elbow);
      }
      if (q) q = arm.clampToLimits(q);
    } else if (S.lockPhi) {
      q = arm.ikAnalytic(x, y, S.elbow, S.lockedPhi);
      target = { x, y, ok: !!q };
      if (q) q = arm.clampToLimits(q);
      else q = arm.ikDLS(x, y, curQ(), { iters: 40 }).q;
    } else {
      const r = arm.ikDLS(x, y, curQ(), { iters: 40 });
      q = r.q;
      target = { x, y, ok: r.err < 0.01 };
    }
    if (q) setQ(q);
  }

  function setQ(q) {
    for (let i = 0; i < q.length; i++) S.q[i] = q[i];
  }

  function resamplePath(pts, ds) {
    if (pts.length < 2) return pts.slice();
    const out = [pts[0]];
    let carry = 0;
    for (let k = 1; k < pts.length; k++) {
      const [x0, y0] = pts[k - 1];
      const [x1, y1] = pts[k];
      const seg = Math.hypot(x1 - x0, y1 - y0);
      let d = ds - carry;
      while (d <= seg) {
        const t = d / seg;
        out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
        d += ds;
      }
      carry = seg - (d - ds);
    }
    return out;
  }
  function startDrawJob(stroke) {
    const pts = resamplePath(stroke, 0.008);
    if (pts.length < 3) return;
    guideStroke = pts;
    pen = [];
    // approach: joint-space move to the IK solution of the first point
    const [x0, y0] = pts[0];
    let q0;
    if (S.dof === 2) q0 = arm.ikAnalytic(x0, y0, S.elbow);
    else q0 = arm.ikDLS(x0, y0, curQ(), { iters: 80 }).q;
    if (!q0) {
      const r = arm.ikDLS(x0, y0, curQ(), { iters: 80 });
      q0 = r.q;
    }
    q0 = arm.clampToLimits(q0);
    plan = null;
    target = null;
    updatePlanStats();
    exec = { traj: A.timeParam([curQ(), q0], S.speed * D2R * 1.5), t: 0, then: 'draw' };
    drawJob = { pts, s: 0, ds: 0.008, speed: 0.5, stroke: [] };
  }
  function stepDrawJob(dt) {
    if (!drawJob || exec) return;
    // advance continuously along the resampled path (arc length), one IK solve per frame
    drawJob.s += drawJob.speed * dt;
    const f = drawJob.s / drawJob.ds;
    const last = drawJob.pts.length - 1;
    const i = Math.min(last, Math.floor(f));
    const t = i >= last ? 0 : f - i;
    const a = drawJob.pts[i];
    const b = drawJob.pts[Math.min(last, i + 1)];
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    let q = null;
    if (S.dof === 2) q = arm.ikAnalytic(x, y, S.elbow);
    if (!q) q = arm.ikDLS(x, y, curQ(), { iters: 25 }).q;
    setQ(arm.clampToLimits(q));
    const ee = arm.fk(curQ()).pts[S.dof];
    if (Math.hypot(ee[0] - x, ee[1] - y) < 0.01) drawJob.stroke.push([ee[0], ee[1]]);
    else if (drawJob.stroke.length) { pen.push(drawJob.stroke); drawJob.stroke = []; }
    if (f >= last) {
      if (drawJob.stroke.length) pen.push(drawJob.stroke);
      drawJob = null;
    }
  }

  // ------------------------------------------------------------------ pointer interaction
  let dragging = null;
  work.canvas.addEventListener('pointerdown', (e) => {
    const p = toWorld(work.pointer(e));
    work.canvas.setPointerCapture(e.pointerId);
    if (S.mode === 'plan') {
      planTo(p.x, p.y);
    } else if (S.mode === 'ik') {
      exec = null; drawJob = null; plan = null;
      updatePlanStats();
      dragging = { kind: 'ik' };
      if (S.dof === 3) S.lockedPhi = arm.fk(curQ()).phi;
      ikFollow(p.x, p.y);
    } else if (S.mode === 'draw') {
      exec = null; drawJob = null;
      userStroke = [[p.x, p.y]];
      dragging = { kind: 'draw' };
    } else if (S.mode === 'edit') {
      const k = hitObstacle(p);
      if (k >= 0) {
        dragging = { kind: 'obs', k, dx: obstacles[k].x - p.x, dy: obstacles[k].y - p.y };
        work.canvas.style.cursor = 'grabbing';
      }
    }
  });
  work.canvas.addEventListener('pointermove', (e) => {
    const p = toWorld(work.pointer(e));
    hover = p;
    if (!dragging) {
      if (S.mode === 'edit') work.canvas.style.cursor = hitObstacle(p) >= 0 ? 'grab' : 'default';
      return;
    }
    if (dragging.kind === 'ik') ikFollow(p.x, p.y);
    else if (dragging.kind === 'draw') {
      const last = userStroke[userStroke.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) > 0.006) userStroke.push([p.x, p.y]);
    } else if (dragging.kind === 'obs') {
      const o = obstacles[dragging.k];
      o.x = M.clamp(p.x + dragging.dx, -3, 3);
      o.y = M.clamp(p.y + dragging.dy, (o.type === 'circle' ? o.r : o.hh) * 0.5, 4);
      csDirty = true;
      scheduleMap();
    }
  });
  const endDrag = () => {
    if (dragging && dragging.kind === 'draw' && userStroke) {
      startDrawJob(userStroke);
      userStroke = null;
    }
    if (dragging && dragging.kind === 'obs') { work.canvas.style.cursor = 'grab'; plan = null; updatePlanStats(); }
    dragging = null;
  };
  work.canvas.addEventListener('pointerup', endDrag);
  work.canvas.addEventListener('pointercancel', endDrag);
  work.canvas.addEventListener('pointerleave', () => (hover = null));
  work.canvas.addEventListener('dblclick', (e) => {
    if (S.mode !== 'edit') return;
    const k = hitObstacle(toWorld(work.pointer(e)));
    if (k >= 0) { obstacles.splice(k, 1); rebuild(); plan = null; updatePlanStats(); }
  });
  work.canvas.addEventListener('wheel', (e) => {
    if (S.mode !== 'edit') return;
    const k = hitObstacle(toWorld(work.pointer(e)));
    if (k < 0) return;
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    const o = obstacles[k];
    if (o.type === 'circle') o.r = M.clamp(o.r * f, 0.05, 0.6);
    else { o.hw = M.clamp(o.hw * f, 0.05, 0.8); o.hh = M.clamp(o.hh * f, 0.05, 0.8); }
    csDirty = true;
    scheduleMap();
  }, { passive: false });
  let hover = null;

  function hitObstacle(p) {
    for (let k = obstacles.length - 1; k >= 0; k--) {
      const o = obstacles[k];
      if (o.type === 'circle' ? Math.hypot(p.x - o.x, p.y - o.y) <= o.r + 0.03 : Math.abs(p.x - o.x) <= o.hw + 0.03 && Math.abs(p.y - o.y) <= o.hh + 0.03) return k;
    }
    return -1;
  }
  function scheduleMap() {
    clearTimeout(mapTimer);
    mapTimer = setTimeout(() => (mapDirty = true), 180);
  }

  let csDrag = false;
  function csPointer(e) {
    const p = cs.pointer(e);
    const q1 = M.clamp(((p.x - csRect.x) / csRect.s) * 2 * Math.PI - Math.PI, -Math.PI, Math.PI);
    const q2 = M.clamp(((csRect.y + csRect.s - p.y) / csRect.s) * 2 * Math.PI - Math.PI, -Math.PI, Math.PI);
    exec = null;
    drawJob = null;
    S.q[0] = q1;
    S.q[1] = M.clamp(q2, LIMITS[1][0] * D2R, LIMITS[1][1] * D2R);
  }
  cs.canvas.addEventListener('pointerdown', (e) => { csDrag = true; cs.canvas.setPointerCapture(e.pointerId); csPointer(e); });
  cs.canvas.addEventListener('pointermove', (e) => { if (csDrag) csPointer(e); });
  cs.canvas.addEventListener('pointerup', () => (csDrag = false));

  // ------------------------------------------------------------------ sidebar bindings
  const modeSeg = Lab.seg('seg-mode', (v) => setMode(v));
  function setMode(v) {
    S.mode = v;
    exec = exec && v === 'plan' ? exec : null;
    drawJob = null;
    const help = {
      plan: 'Click in the workspace to set a goal. A collision-free IK solution is chosen and A* searches configuration space for a path.',
      ik: 'Drag in the workspace — the tool follows using closed-form IK (2R, or 3R with locked φ) or damped least squares (redundant 3R).',
      draw: 'Sketch a path with the mouse. The arm traces it like a pen plotter using continuous inverse kinematics.',
      edit: 'Drag obstacles to move them, scroll to resize, double-click to delete. The C-space image updates live.',
    };
    Lab.$('#mode-help').textContent = help[v];
    const hint = { plan: 'click to plan a move', ik: 'drag to move the tool', draw: 'sketch a path to trace', edit: 'drag · scroll · double-click' }[v];
    Lab.$('#work-hint').textContent = hint;
    work.canvas.style.cursor = v === 'edit' ? 'default' : 'crosshair';
  }
  Lab.seg('seg-dof', (v) => {
    S.dof = parseInt(v, 10);
    Lab.$$('.only3').forEach((el) => el.classList.toggle('hidden', S.dof !== 3));
    exec = null; drawJob = null; plan = null; target = null; pen = []; guideStroke = null;
    rebuild();
    computeView();
    if (world.config(arm, curQ()) !== A.FREE) setQ(HOME.slice(0, S.dof));
    updatePlanStats();
    renderJointLegend();
  });
  ['l1', 'l2', 'l3'].forEach((id, i) =>
    Lab.range('sl-' + id, {
      format: (v) => `${v.toFixed(2)} m`,
      onInput: (v) => { S.L[i] = v; plan = null; updatePlanStats(); rebuild(); computeView(); },
    })
  );
  Lab.seg('seg-elbow', (v) => (S.elbow = parseInt(v, 10)));
  Lab.toggle('tg-lockphi', (v) => { S.lockPhi = v; S.lockedPhi = arm.fk(curQ()).phi; });
  const qSliders = ['q1', 'q2', 'q3'].map((id, i) =>
    Lab.range('sl-' + id, {
      format: (v) => `${v.toFixed(1)}°`,
      onInput: (v) => { exec = null; drawJob = null; S.q[i] = v * D2R; },
    })
  );
  Lab.$('#btn-home').addEventListener('click', () => {
    target = null;
    const g = HOME.slice(0, S.dof);
    if (world.config(arm, g) !== A.FREE) return Lab.toast('Home pose is blocked by an obstacle');
    planToQ([g], false);
  });
  Lab.range('sl-speed', { format: (v) => `${v} °/s`, onInput: (v) => (S.speed = v) });
  Lab.range('sl-payload', { format: (v) => `${v.toFixed(1)} kg`, onInput: (v) => (S.payload = v) });
  Lab.toggle('tg-floor', (v) => { S.floor = v; rebuild(); });
  Lab.toggle('tg-map', (v) => (S.show.map = v));
  Lab.toggle('tg-ellipse', (v) => (S.show.ellipse = v));
  Lab.toggle('tg-frames', (v) => (S.show.frames = v));
  Lab.toggle('tg-ghosts', (v) => (S.show.ghosts = v));
  Lab.toggle('tg-explored', (v) => (S.show.explored = v));

  const rng = M.makeRng(Date.now() % 100000);
  function randomObstacle() {
    for (let tries = 0; tries < 60; tries++) {
      const circle = rng.next() < 0.6;
      const reach = arm.reach;
      const o = circle
        ? { type: 'circle', x: rng.uniform(-reach, reach), y: rng.uniform(0.35, arm.base.y + reach * 0.9), r: rng.uniform(0.1, 0.22) }
        : { type: 'box', x: rng.uniform(-reach, reach), y: 0, hw: rng.uniform(0.1, 0.25), hh: rng.uniform(0.12, 0.4) };
      if (!circle) o.y = rng.next() < 0.6 ? o.hh : rng.uniform(0.5, arm.base.y + reach * 0.8);
      if (Math.abs(o.x) < 0.35 && o.y < 0.8) continue;
      const w2 = new A.World([o], { floor: false, pedestal: null });
      if (w2.config(arm, curQ()) !== A.FREE) continue;
      return o;
    }
    return null;
  }
  Lab.$('#btn-add-circle').addEventListener('click', () => addObstacle('circle'));
  Lab.$('#btn-add-box').addEventListener('click', () => addObstacle('box'));
  function addObstacle(type) {
    if (obstacles.length >= OBS_COLORS.length) return Lab.toast(`Up to ${OBS_COLORS.length} obstacles`);
    let o = null;
    for (let k = 0; k < 40 && (!o || o.type !== type); k++) o = randomObstacle();
    if (!o) return Lab.toast('Could not find free space for a new obstacle');
    obstacles.push(o);
    plan = null;
    updatePlanStats();
    rebuild();
  }
  Lab.$('#btn-shuffle').addEventListener('click', () => {
    obstacles = [];
    rebuild();
    const n = 2 + rng.int(3);
    for (let k = 0; k < n; k++) { const o = randomObstacle(); if (o) obstacles.push(o); }
    plan = null; target = null;
    updatePlanStats();
    rebuild();
  });
  Lab.$('#btn-clear-obs').addEventListener('click', () => { obstacles = []; plan = null; updatePlanStats(); rebuild(); });

  function renderObsLegend() {
    Lab.$('#obs-legend').innerHTML = obstacles.map((_, k) => `<span style="background:${OBS_COLORS[k % OBS_COLORS.length]}"></span>`).join('');
  }
  function renderJointLegend() {
    Lab.$('#joint-legend').innerHTML = JOINT_COLORS.slice(0, S.dof).map((c, i) => `<span><i style="background:${c}"></i>θ${'₁₂₃'[i]}</span>`).join('');
  }
  function updateSubtitles() {
    if (!arm) return;
    const Ls = S.L.slice(0, S.dof).map((v, i) => `L${'₁₂₃'[i]} ${v.toFixed(2)} m`).join(' · ');
    Lab.text('work-sub', `${S.dof}R planar arm · ${Ls} · reach ${arm.reach.toFixed(2)} m`);
    const grid = S.dof === 2 ? '180² grid' : `slice at θ₃ = ${(S.q[2] * R2D).toFixed(0)}°`;
    const stats = plan && plan.dof === S.dof
      ? ` · A* ${plan.expanded.toLocaleString()} cells, ${plan.ms.toFixed(0)} ms, ${plan.path.length} waypoints`
      : '';
    Lab.text('cs-sub', grid + stats);
  }

  // ------------------------------------------------------------------ rendering: workspace
  function drawWorkspace() {
    const { ctx, w, h } = work;
    work.clear();
    // grid
    const minor = 0.25;
    const xr = w / 2 / view.scale;
    ctx.lineWidth = 1;
    for (let gx = -Math.ceil(xr / minor) * minor; gx <= xr; gx += minor) {
      const major = Math.abs(gx / 0.5 - Math.round(gx / 0.5)) < 1e-6;
      ctx.strokeStyle = major ? 'rgba(142,160,216,0.10)' : 'rgba(142,160,216,0.05)';
      ctx.beginPath();
      ctx.moveTo(Math.round(sx(gx)) + 0.5, 0);
      ctx.lineTo(Math.round(sx(gx)) + 0.5, sy(0));
      ctx.stroke();
    }
    for (let gy = 0; sy(gy) > 0; gy += minor) {
      const major = Math.abs(gy / 0.5 - Math.round(gy / 0.5)) < 1e-6;
      ctx.strokeStyle = major ? 'rgba(142,160,216,0.10)' : 'rgba(142,160,216,0.05)';
      ctx.beginPath();
      ctx.moveTo(0, Math.round(sy(gy)) + 0.5);
      ctx.lineTo(w, Math.round(sy(gy)) + 0.5);
      ctx.stroke();
    }
    ctx.font = `10px ${T.mono}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let gx = -Math.floor(xr / 0.5) * 0.5; gx <= xr; gx += 0.5) ctx.fillText(`${gx.toFixed(1)}`.replace('-', '−'), sx(gx), sy(0) + 5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let gy = 0.5; sy(gy) > 10; gy += 0.5) ctx.fillText(`${gy.toFixed(1)} m`, 6, sy(gy));

    // manipulability / collision-free workspace map
    if (S.show.map) {
      if (mapDirty) computeMap();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(mapCanvas, 0, 0, mapCanvas.width * (S.dof === 2 ? 3 : 5), mapCanvas.height * (S.dof === 2 ? 3 : 5));
    }
    // reach circle
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(251,191,36,0.25)';
    ctx.beginPath();
    ctx.arc(sx(arm.base.x), sy(arm.base.y), arm.reach * view.scale, Math.PI, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);

    // floor & pedestal
    const fy = sy(0);
    ctx.fillStyle = '#0b1122';
    ctx.fillRect(0, fy, w, h - fy);
    ctx.strokeStyle = 'rgba(142,160,216,0.18)';
    ctx.beginPath();
    for (let x = -h; x < w; x += 12) { ctx.moveTo(x, h); ctx.lineTo(x + (h - fy), fy); }
    ctx.stroke();
    ctx.strokeStyle = '#3a4a78';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, fy);
    ctx.lineTo(w, fy);
    ctx.stroke();

    // obstacles
    obstacles.forEach((o, k) => {
      const c = OBS_COLORS[k % OBS_COLORS.length];
      ctx.fillStyle = Lab.alpha(c, 0.22);
      ctx.strokeStyle = c;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (o.type === 'circle') ctx.arc(sx(o.x), sy(o.y), o.r * view.scale, 0, Math.PI * 2);
      else ctx.rect(sx(o.x - o.hw), sy(o.y + o.hh), 2 * o.hw * view.scale, 2 * o.hh * view.scale);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = c;
      ctx.font = `700 11px ${T.mono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`#${k + 1}`, sx(o.x), sy(o.y));
    });

    // pedestal (drawn over the floor)
    const pw = 0.13 * view.scale;
    ctx.fillStyle = '#1b2440';
    ctx.strokeStyle = '#3a4a78';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx(-0.2), fy);
    ctx.lineTo(sx(-0.13), sy(arm.base.y));
    ctx.lineTo(sx(0.13), sy(arm.base.y));
    ctx.lineTo(sx(0.2), fy);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    void pw;

    // planned path: tool path + ghost poses
    if (plan && plan.dof === S.dof) {
      const traj = A.timeParam(plan.path, S.speed * D2R);
      const N = 60;
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = 'rgba(232,237,251,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let k = 0; k <= N; k++) {
        const q = traj.at((k / N) * traj.T);
        const ee = arm.fk(q).pts[S.dof];
        if (k === 0) ctx.moveTo(sx(ee[0]), sy(ee[1]));
        else ctx.lineTo(sx(ee[0]), sy(ee[1]));
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (S.show.ghosts) {
        for (let k = 0; k <= 8; k++) {
          const q = traj.at((k / 8) * traj.T);
          drawArm(ctx, q, { ghost: true, alpha: 0.1 + 0.06 * (k === 0 || k === 8 ? 1 : 0) });
        }
      }
    }

    // sketched guide + pen ink
    const strokePath = (pts) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
      ctx.stroke();
    };
    if (guideStroke) { ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(232,237,251,0.35)'; ctx.lineWidth = 1.5; strokePath(guideStroke); ctx.setLineDash([]); }
    if (userStroke) { ctx.strokeStyle = 'rgba(232,237,251,0.8)'; ctx.lineWidth = 2; strokePath(userStroke); }
    ctx.strokeStyle = T.accent;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    pen.forEach(strokePath);
    if (drawJob && drawJob.stroke.length > 1) strokePath(drawJob.stroke);
    ctx.lineCap = 'butt';

    // the arm
    const q = curQ();
    const perLink = new Array(S.dof).fill(A.FREE);
    const status = world.config(arm, q, perLink);
    drawArm(ctx, q, { perLink });
    updateCollisionChip(status, perLink);

    // manipulability ellipse
    const f = arm.fk(q);
    const ee = f.pts[S.dof];
    if (S.show.ellipse) {
      const m = arm.manipulability(q);
      const k = 0.28 * view.scale;
      ctx.save();
      ctx.translate(sx(ee[0]), sy(ee[1]));
      ctx.rotate(-m.angle);
      ctx.beginPath();
      ctx.ellipse(0, 0, Math.max(1.5, m.major * k), Math.max(1.5, m.minor * k), 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(56,189,248,0.12)';
      ctx.strokeStyle = 'rgba(56,189,248,0.85)';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // target marker
    if (target) {
      const c = target.ok ? '#e8edfb' : '#fb7185';
      ctx.strokeStyle = c;
      ctx.lineWidth = 2;
      const tx = sx(target.x);
      const ty = sy(target.y);
      ctx.beginPath();
      ctx.arc(tx, ty, 9, 0, Math.PI * 2);
      ctx.moveTo(tx - 15, ty); ctx.lineTo(tx - 5, ty);
      ctx.moveTo(tx + 5, ty); ctx.lineTo(tx + 15, ty);
      ctx.moveTo(tx, ty - 15); ctx.lineTo(tx, ty - 5);
      ctx.moveTo(tx, ty + 5); ctx.lineTo(tx, ty + 15);
      ctx.stroke();
    }
    // hover crosshair coordinates
    if (hover && !dragging && S.mode !== 'edit') {
      ctx.font = `10.5px ${T.mono}`;
      ctx.fillStyle = T.text2;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`(${hover.x.toFixed(2)}, ${hover.y.toFixed(2)}) m`, sx(hover.x) + 10, sy(hover.y) - 8);
    }
  }

  function drawArm(ctx, q, { ghost = false, alpha = 1, perLink = null } = {}) {
    const f = arm.fk(q);
    const pts = f.pts;
    const r = arm.radius * view.scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    for (let i = 0; i < S.dof; i++) {
      const bad = perLink && perLink[i] !== A.FREE;
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      ctx.strokeStyle = ghost ? '#cbd5f5' : bad ? '#fb7185' : '#fbbf24';
      ctx.lineWidth = 2 * r;
      ctx.beginPath();
      ctx.moveTo(sx(x0), sy(y0));
      ctx.lineTo(sx(x1), sy(y1));
      ctx.stroke();
      if (!ghost) {
        ctx.strokeStyle = bad ? '#9f1239' : '#b45309';
        ctx.lineWidth = Math.max(1, 2 * r - 6);
        ctx.beginPath();
        ctx.moveTo(sx(x0), sy(y0));
        ctx.lineTo(sx(x1), sy(y1));
        ctx.stroke();
        ctx.strokeStyle = bad ? 'rgba(255,228,230,0.5)' : 'rgba(254,243,199,0.55)';
        ctx.lineWidth = 1.2;
        const nx = -(y1 - y0);
        const ny = x1 - x0;
        const nl = Math.hypot(nx, ny) || 1;
        const o = (r - 4) / view.scale;
        ctx.beginPath();
        ctx.moveTo(sx(x0 + (nx / nl) * o), sy(y0 + (ny / nl) * o));
        ctx.lineTo(sx(x1 + (nx / nl) * o), sy(y1 + (ny / nl) * o));
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
    // gripper
    const ee = pts[S.dof];
    const phi = f.phi;
    const g = 0.09;
    const ux = Math.cos(phi);
    const uy = Math.sin(phi);
    const vx = -uy;
    const vy = ux;
    ctx.strokeStyle = ghost ? '#cbd5f5' : '#e2e8f0';
    ctx.lineWidth = ghost ? 2 : 3;
    ctx.beginPath();
    ctx.moveTo(sx(ee[0] + vx * g * 0.7), sy(ee[1] + vy * g * 0.7));
    ctx.lineTo(sx(ee[0] - vx * g * 0.7), sy(ee[1] - vy * g * 0.7));
    ctx.moveTo(sx(ee[0] + vx * g * 0.7), sy(ee[1] + vy * g * 0.7));
    ctx.lineTo(sx(ee[0] + vx * g * 0.7 + ux * g), sy(ee[1] + vy * g * 0.7 + uy * g));
    ctx.moveTo(sx(ee[0] - vx * g * 0.7), sy(ee[1] - vy * g * 0.7));
    ctx.lineTo(sx(ee[0] - vx * g * 0.7 + ux * g), sy(ee[1] - vy * g * 0.7 + uy * g));
    ctx.stroke();
    // joints
    if (!ghost) {
      for (let i = 0; i < S.dof; i++) {
        const [x, y] = pts[i];
        ctx.beginPath();
        ctx.arc(sx(x), sy(y), r * 0.95, 0, Math.PI * 2);
        ctx.fillStyle = '#0f172a';
        ctx.fill();
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(sx(x), sy(y), r * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = JOINT_COLORS[i];
        ctx.fill();
      }
      if (S.show.frames) {
        let a = 0;
        for (let i = 0; i <= S.dof; i++) {
          if (i < S.dof) a += q[i];
          const [x, y] = pts[i];
          const L = 0.16;
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#f87171';
          ctx.beginPath();
          ctx.moveTo(sx(x), sy(y));
          ctx.lineTo(sx(x + Math.cos(a) * L), sy(y + Math.sin(a) * L));
          ctx.stroke();
          ctx.strokeStyle = '#4ade80';
          ctx.beginPath();
          ctx.moveTo(sx(x), sy(y));
          ctx.lineTo(sx(x - Math.sin(a) * L), sy(y + Math.cos(a) * L));
          ctx.stroke();
        }
      }
      // joint angle labels
      ctx.font = `600 10.5px ${T.mono}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < S.dof; i++) {
        const [x, y] = pts[i];
        ctx.fillStyle = JOINT_COLORS[i];
        ctx.fillText(`θ${'₁₂₃'[i]} ${(q[i] * R2D).toFixed(0)}°`, sx(x) + r + 6, sy(y) - r - 4);
      }
    }
    ctx.restore();
  }

  function updateCollisionChip(status, perLink) {
    const chip = Lab.$('#coll-chip');
    if (status === A.FREE) {
      chip.className = 'chip good';
      chip.textContent = 'Collision-free';
      return;
    }
    const link = perLink.findIndex((v) => v !== A.FREE);
    const what = status === A.FLOOR ? 'floor' : status === A.LIMIT ? 'joint limit' : status === A.SELF ? 'self-collision' : `obstacle #${status + 1}`;
    chip.className = 'chip bad';
    chip.textContent = status === A.LIMIT ? 'Joint limit' : `Link ${link + 1} ↔ ${what}`;
  }

  // ------------------------------------------------------------------ rendering: C-space
  function drawCspace() {
    const { ctx, w, h } = cs;
    cs.clear();
    computeCsRect();
    if (csDirty || (S.dof === 3 && Math.abs(S.q[2] - csQ3) > 1.5 * D2R)) computeCspace();
    const { x, y, s } = csRect;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(csCanvas, x, y, s, s);
    if (plan && plan.dof === S.dof && S.show.explored && plan.explored) ctx.drawImage(plan.explored, x, y, s, s);
    ctx.imageSmoothingEnabled = true;
    // grid & ticks
    ctx.strokeStyle = 'rgba(142,160,216,0.18)';
    ctx.lineWidth = 1;
    ctx.font = `10.5px ${T.mono}`;
    ctx.fillStyle = T.muted;
    for (const d of [-180, -90, 0, 90, 180]) {
      const px = csX(d * D2R);
      const py = csY(d * D2R);
      ctx.beginPath();
      ctx.moveTo(Math.round(px) + 0.5, y);
      ctx.lineTo(Math.round(px) + 0.5, y + s);
      ctx.moveTo(x, Math.round(py) + 0.5);
      ctx.lineTo(x + s, Math.round(py) + 0.5);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`${d}°`.replace('-', '−'), px, y + s + 5);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${d}°`.replace('-', '−'), x - 6, py);
    }
    ctx.strokeStyle = T.border2;
    ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
    ctx.font = `600 10.5px ${T.sans}`;
    ctx.fillStyle = T.text2;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('θ₁ shoulder', x + s, h - 1);
    ctx.save();
    ctx.translate(11, y + s / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('θ₂ elbow', 0, 0);
    ctx.restore();

    // planned path in C-space
    if (plan && plan.dof === S.dof) {
      ctx.strokeStyle = 'rgba(232,237,251,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      plan.raw.forEach((q, i) => (i ? ctx.lineTo(csX(q[0]), csY(q[1])) : ctx.moveTo(csX(q[0]), csY(q[1]))));
      ctx.stroke();
      ctx.strokeStyle = '#e8edfb';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      plan.path.forEach((q, i) => (i ? ctx.lineTo(csX(q[0]), csY(q[1])) : ctx.moveTo(csX(q[0]), csY(q[1]))));
      ctx.stroke();
      for (const q of plan.path) {
        ctx.beginPath();
        ctx.arc(csX(q[0]), csY(q[1]), 3, 0, Math.PI * 2);
        ctx.fillStyle = '#e8edfb';
        ctx.fill();
      }
      const g = plan.goal;
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(csX(g[0]), csY(g[1]), 7, 0, Math.PI * 2);
      ctx.stroke();
      const st = plan.start;
      ctx.strokeStyle = 'rgba(232,237,251,0.8)';
      ctx.beginPath();
      ctx.rect(csX(st[0]) - 5, csY(st[1]) - 5, 10, 10);
      ctx.stroke();
    }
    // current configuration
    const q = curQ();
    const free = world.config(arm, q) === A.FREE;
    const px = csX(q[0]);
    const py = csY(q[1]);
    const glow = ctx.createRadialGradient(px, py, 0, px, py, 16);
    glow.addColorStop(0, Lab.alpha(free ? '#fbbf24' : '#fb7185', 0.55));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(px - 16, py - 16, 32, 32);
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fillStyle = free ? '#fbbf24' : '#fb7185';
    ctx.fill();
    ctx.strokeStyle = '#0b1020';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ------------------------------------------------------------------ stats & sliders
  function updateStats() {
    const q = curQ();
    const f = arm.fk(q);
    const ee = f.pts[S.dof];
    const m = arm.manipulability(q);
    Lab.$('#st-pos').innerHTML = `${ee[0].toFixed(2)}, ${ee[1].toFixed(2)}<span class="u">m</span>`;
    Lab.$('#st-phi').innerHTML = `${(M.wrapAngle(f.phi) * R2D).toFixed(1)}<span class="u">°</span>`;
    const wEl = Lab.$('#st-w');
    wEl.innerHTML = `${m.w.toFixed(3)}<span class="u">m²</span>`;
    wEl.parentElement.className = 'stat ' + (m.w < 0.08 ? 'bad' : m.w < 0.25 ? 'warn' : 'good');
    Lab.$('#st-cond').innerHTML = Number.isFinite(m.cond) && m.cond < 1e4 ? m.cond.toFixed(2) : '∞ <span class="u">singular</span>';
    const tau = arm.gravityTorques(q, LINK_DENSITY, S.payload);
    const tmax = 80;
    Lab.$('#torques').innerHTML = tau
      .map((t, i) => `<div class="tb"><span style="color:${JOINT_COLORS[i]}">τ${'₁₂₃'[i]}</span><div class="bar"><span style="width:${Math.min(100, (Math.abs(t) / tmax) * 100)}%;background:${JOINT_COLORS[i]}"></span></div><span>${t.toFixed(1)}</span></div>`)
      .join('');
    qSliders.forEach((sl, i) => { if (i < S.dof && document.activeElement !== sl.el) sl.set((S.q[i] * R2D).toFixed(1)); });
  }

  // ------------------------------------------------------------------ main loop
  let statTimer = 0;
  Lab.loop((dt) => {
    clock += dt;
    if (exec) {
      exec.t += dt;
      setQ(exec.traj.at(exec.t));
      if (exec.t >= exec.traj.T) {
        const then = exec.then;
        exec = null;
        if (then !== 'draw') updatePlanStats();
      }
    } else stepDrawJob(dt);
    const q = curQ();
    if (prevQ && prevQ.length === q.length) {
      for (let i = 0; i < S.dof; i++) {
        logQ[i].push(clock, q[i] * R2D);
        logQd[i].push(clock, ((q[i] - prevQ[i]) / Math.max(dt, 1e-3)) * R2D);
      }
    }
    prevQ = q.slice();
    drawWorkspace();
    drawCspace();
    const t1 = Math.max(clock, WINDOW);
    qPlot.opts.xMin = qdPlot.opts.xMin = t1 - WINDOW;
    qPlot.opts.xMax = qdPlot.opts.xMax = t1;
    qPlot.series = logQ.slice(0, S.dof).map((d, i) => ({ name: `θ${i + 1}`, color: JOINT_COLORS[i], data: d, width: 1.8 }));
    qdPlot.series = logQd.slice(0, S.dof).map((d, i) => ({ name: `ω${i + 1}`, color: JOINT_COLORS[i], data: d, width: 1.5 }));
    qPlot.draw();
    qdPlot.draw();
    statTimer += dt;
    if (statTimer > 0.08) { statTimer = 0; updateStats(); }
  });

  // ------------------------------------------------------------------ init
  rebuild();
  computeView();
  setMode('plan');
  renderJointLegend();
  updateStats();
  // opening demo: plan around the cabinet on the left
  setTimeout(() => { if (!exec && !plan && S.mode === 'plan') planTo(-1.35, 1.0); }, 700);

  window.ArmStudio = {
    state: S,
    planTo,
    setMode: (m) => modeSeg.set(m, true),
    draw: (pts) => startDrawJob(pts),
    get busy() { return !!exec || !!drawJob; },
  };
})();
