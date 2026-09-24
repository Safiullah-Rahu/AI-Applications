/* EvoDrive — evolution loop, race mode, rendering and UI. */
(function () {
  'use strict';
  const E = window.EvoCore;
  const M = window.LabMath;
  Lab.boot();
  const T = Lab.theme();
  const PINK = '#f472b6';
  const INDIGO = '#818cf8';
  const GOLD = '#fbbf24';
  const GREEN = '#34d399';
  const SKY = '#38bdf8';
  const AMBER = '#f59e0b';
  const RED = '#fb7185';
  const GREY = '#8b93b8';
  const KMH = 0.54; // display scale: 1 world px ≈ 0.15 m
  const DT = 1 / 60;
  const { w: WW, h: WH } = E.WORLD;

  const S = {
    running: true, speed: 1, seed: 14, halfWidth: 30, wiggle: 0.45, rotate: false,
    pop: 50, mutRate: 0.08, mutSigma: 0.25, elite: 4, hidden: 8, rays: 'leader',
    maxLaps: 3, timeLimit: 60, stallTime: 2.5, mode: 'evolve',
  };

  // ------------------------------------------------------------------ evolution state
  let track = null;
  let topo = E.topology(S.hidden);
  let rng = M.makeRng(7);
  let runSeed = 7;
  let genomes = [];
  let cars = [];
  let gen = 1;
  let simT = 0;
  let leader = null;
  let crashes = [];
  let bestLine = null; // last generation's best run on this track: {pts: [[x, y, v]], crashed}
  let champ = null; // {genome, hidden, fitness, lapTime, gen}
  let bestLap = Infinity;
  let firstLap = null;
  let lastGen = null; // summary of the previous generation
  const hist = { x: [], best: [], mean: [], p25: [], p75: [] };
  const marks = [];
  const simOpts = () => ({ topo, maxLaps: S.maxLaps, timeLimit: S.timeLimit, stallTime: S.stallTime });

  function setTrack(seed, keepGeneration = true) {
    S.seed = seed;
    track = E.makeTrack(seed, { halfWidth: S.halfWidth, wiggle: S.wiggle });
    bestLine = null;
    bestLap = Infinity;
    renderTrackLayer();
    Lab.text('track-seed', `seed ${seed}`);
    updateTrackSub();
    if (keepGeneration && cars.length) startGeneration();
  }

  function resetEvolution(seedGenome) {
    runSeed += 1;
    rng = M.makeRng(runSeed * 7919);
    topo = E.topology(S.hidden);
    genomes = Array.from({ length: S.pop }, () => E.randomGenome(rng, topo));
    if (seedGenome) {
      // seed the population with a known driver and mutated copies of it
      genomes = genomes.map((g, i) => {
        if (i === 0) return Float64Array.from(seedGenome);
        if (i < S.pop * 0.6) return Float64Array.from(seedGenome, (v) => v + (rng.next() < 0.15 ? rng.gauss(0, 0.3) : 0));
        return g;
      });
    }
    gen = 1;
    champ = seedGenome ? { genome: Float64Array.from(seedGenome), hidden: S.hidden, fitness: NaN, lapTime: NaN, gen: 0 } : null;
    bestLap = Infinity;
    firstLap = null;
    lastGen = null;
    bestLine = null;
    for (const k of Object.keys(hist)) hist[k] = [];
    marks.length = 0;
    startGeneration();
    updateBrainSub();
  }

  function startGeneration() {
    cars = genomes.map((g, i) => {
      const c = E.makeCar(track, g, i);
      c.elite = gen > 1 && i < S.elite;
      c.px = c.x;
      c.py = c.y;
      return c;
    });
    simT = 0;
    crashes = [];
    leader = cars[0];
    clearSkids();
    acc = 0;
  }

  function endGeneration() {
    const f = cars.map((c) => c.fitness).sort((a, b) => a - b);
    const q = (p) => f[Math.min(f.length - 1, Math.max(0, Math.round(p * (f.length - 1))))];
    const best = cars.reduce((a, b) => (b.fitness > a.fitness ? b : a));
    hist.x.push(gen);
    hist.best.push(best.fitness);
    hist.mean.push(f.reduce((s, v) => s + v, 0) / f.length);
    hist.p25.push(q(0.25));
    hist.p75.push(q(0.75));
    const finishers = cars.filter((c) => c.finished).length;
    const genLap = Math.min(...cars.map((c) => c.lapTime));
    if (Number.isFinite(genLap)) bestLap = Math.min(bestLap, genLap);
    if (firstLap === null && cars.some((c) => c.laps >= 1)) {
      firstLap = gen;
      marks.push({ gen, label: 'first lap', color: GREEN });
    }
    lastGen = { gen, best: best.fitness, finishers, lap: genLap };
    champ = { genome: Float64Array.from(best.genome), hidden: S.hidden, fitness: best.fitness, lapTime: best.lapTime, gen };
    if (!S.rotate) bestLine = traceRun(best.genome);
    genomes = E.nextGeneration(cars, rng, { elite: S.elite, mutRate: S.mutRate, mutSigma: S.mutSigma, size: S.pop });
    gen++;
    if (S.rotate) setTrack(S.seed + 1, false);
    startGeneration();
    drawFitness();
    updateStats();
  }

  /** Re-simulate one genome on the current track and record its path (the best lap once it has a flying lap). */
  function traceRun(genome) {
    const c = E.makeCar(track, genome, -1);
    const opts = simOpts();
    const pts = [];
    let lapStartIdx = 0;
    let lapsSeen = 0;
    let bestLapIdx = null;
    let bestLapT = Infinity;
    let lapT0 = 0;
    while (c.alive) {
      E.stepCar(c, track, DT, opts);
      pts.push([c.x, c.y, c.v]);
      if (c.laps > lapsSeen) {
        const lt = c.t - lapT0;
        if (lapsSeen >= 1 && lt < bestLapT) { bestLapT = lt; bestLapIdx = [lapStartIdx, pts.length]; }
        lapsSeen = c.laps;
        lapStartIdx = pts.length;
        lapT0 = c.t;
      }
    }
    if (bestLapIdx) return { pts: pts.slice(bestLapIdx[0], bestLapIdx[1]), crashed: false, lap: bestLapT };
    return { pts, crashed: c.crashed, lap: NaN };
  }

  let acc = 0;
  function step(dt) {
    let alive = 0;
    const opts = simOpts();
    for (const c of cars) {
      if (!c.alive) continue;
      c.px = c.x;
      c.py = c.y;
      E.stepCar(c, track, dt, opts);
      if (c.slip && c.alive) skidMark(c);
      if (!c.alive && c.crashed) crashes.push([c.x, c.y]);
      if (c.alive) alive++;
    }
    simT += dt;
    if (!alive) endGeneration();
  }

  function pickLeader() {
    let best = null;
    for (const c of cars) if (c.alive && (!best || c.fitness > best.fitness)) best = c;
    if (best) leader = best;
    else if (!leader || !cars.includes(leader)) leader = cars[0];
  }

  // ------------------------------------------------------------------ race mode (you vs the champion)
  const keys = new Set();
  let raceTopo = topo;
  const race = { phase: 'idle', countdown: 0, ai: null, me: null, t: 0, steer: 0, result: null };
  const pilot = () => {
    const target = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
    race.steer += (target - race.steer) * Math.min(1, DT * 9);
    return [race.steer, keys.has('up') ? 1 : keys.has('down') ? -1 : 0];
  };
  function startRace() {
    if (!champ) {
      const P = window.EVO_PRETRAINED;
      champ = { genome: Float64Array.from(P.genome), hidden: P.hidden, fitness: NaN, lapTime: NaN, gen: 0 };
      Lab.toast('No champion yet — you are racing the pre-trained driver');
    }
    const genome = champ.genome;
    raceTopo = E.topology(champ.hidden);
    S.mode = 'race';
    race.ai = E.makeCar(track, genome, 0);
    race.me = E.makeCar(track, null, 1);
    race.ai.th = race.me.th;
    // side by side on the grid
    const n0 = track.nor[0];
    const off = track.halfWidth * 0.45;
    race.ai.x += n0[0] * off; race.ai.y += n0[1] * off;
    race.me.x -= n0[0] * off; race.me.y -= n0[1] * off;
    race.phase = 'countdown';
    race.countdown = 3;
    race.t = 0;
    race.steer = 0;
    race.result = null;
    race.bannerFinal = false;
    clearSkids();
    crashes = [];
    Lab.$('#btn-race').innerHTML = `${Lab.icon('back')}Back to evolution`;
    showBanner();
  }
  function stopRace() {
    S.mode = 'evolve';
    race.phase = 'idle';
    Lab.$('#btn-race').innerHTML = `${Lab.icon('target')}Race the champion yourself`;
    hideBanner();
    startGeneration();
  }
  function raceStep(dt) {
    if (race.phase === 'countdown') {
      race.countdown -= dt;
      showBanner();
      if (race.countdown <= 0) { race.phase = 'go'; hideBanner(); }
      return;
    }
    if (race.phase !== 'go' && race.phase !== 'done') return;
    acc += dt;
    while (acc >= DT) {
      acc -= DT;
      race.t += DT;
      const aiOpts = { topo: raceTopo, maxLaps: S.maxLaps, timeLimit: 120, stallTime: S.stallTime };
      const meOpts = { topo: raceTopo, maxLaps: S.maxLaps, timeLimit: 600, stallTime: 1e9, pilot };
      for (const [c, o] of [[race.ai, aiOpts], [race.me, meOpts]]) {
        if (!c.alive) continue;
        c.px = c.x;
        c.py = c.y;
        E.stepCar(c, track, DT, o);
        if (c.slip && c.alive) skidMark(c);
        if (!c.alive && c.crashed) crashes.push([c.x, c.y]);
      }
      if (race.phase === 'go' && !race.me.alive) {
        race.phase = 'done';
        showBanner();
      } else if (race.phase === 'done' && !race.ai.alive && !race.bannerFinal) {
        race.bannerFinal = true;
        showBanner();
      }
      if (!race.me.alive && !race.ai.alive) break;
    }
  }
  const fmtT = (t) => (Number.isFinite(t) ? `${t.toFixed(2)} s` : '—');
  function showBanner() {
    const b = Lab.$('#banner');
    b.classList.remove('hidden');
    if (race.phase === 'countdown') {
      b.innerHTML = `<h3>Race the champion · ${Math.max(1, Math.ceil(race.countdown))}</h3>
        <p>You drive the <b style="color:${GREEN}">green</b> car, the evolved champion drives the <b style="color:${PINK}">pink</b> one. ${S.maxLaps} laps.</p>
        <div class="keys"><span><kbd>↑</kbd>/<kbd>W</kbd> throttle</span><span><kbd>↓</kbd>/<kbd>S</kbd> brake</span><span><kbd>←</kbd><kbd>→</kbd> steer</span></div>`;
    } else if (race.phase === 'done') {
      const me = race.me;
      const ai = race.ai;
      const mine = me.finished ? `You: ${S.maxLaps} laps in ${fmtT(me.t)} · best lap ${fmtT(me.lapTime)}` : `You crashed after ${Math.max(0, (me.bestProg / track.n) * 100).toFixed(0)} % of a lap`;
      const theirs = ai.finished ? `Champion: ${fmtT(ai.t)} · best lap ${fmtT(ai.lapTime)}` : ai.alive ? 'Champion still racing…' : `Champion crashed at ${((ai.bestProg / track.n) * 100).toFixed(0)} % of a lap`;
      const won = me.finished && (!ai.finished || me.t < ai.t);
      const title = won ? '🏁 You beat the AI!' : me.finished ? (ai.alive ? '🏁 Finished — waiting for the AI…' : '🏁 Finished — the AI was faster') : 'Crashed!';
      b.innerHTML = `<h3>${title}</h3>
        <div class="result" style="color:${GREEN}">${mine}</div><div class="result" style="color:${PINK}">${theirs}</div>
        <div class="keys"><span><kbd>R</kbd> race again</span><span><kbd>Esc</kbd> back to evolution</span></div>`;
    }
  }
  function hideBanner() {
    Lab.$('#banner').classList.add('hidden');
  }

  // ------------------------------------------------------------------ track view
  const tv = Lab.canvas('cv-track', () => {
    layout();
    renderTrackLayer();
  });
  const view = { s: 1, ox: 0, oy: 0 };
  function layout() {
    const s = Math.min((tv.w - 8) / WW, (tv.h - 8) / WH);
    view.s = s;
    view.ox = (tv.w - WW * s) / 2;
    view.oy = (tv.h - WH * s) / 2;
  }
  layout();
  const trackLayer = document.createElement('canvas');
  const SK = 1.5;
  const skid = document.createElement('canvas');
  skid.width = WW * SK;
  skid.height = WH * SK;
  const sk = skid.getContext('2d');
  function clearSkids() {
    sk.setTransform(1, 0, 0, 1, 0, 0);
    sk.clearRect(0, 0, skid.width, skid.height);
  }
  function skidMark(c) {
    sk.setTransform(SK, 0, 0, SK, 0, 0);
    sk.strokeStyle = 'rgba(3, 5, 10, 0.55)';
    sk.lineWidth = 1.6;
    sk.beginPath();
    const cth = Math.cos(c.th);
    const sth = Math.sin(c.th);
    for (const side of [-3.4, 3.4]) {
      const ox = -5 * cth - side * sth;
      const oy = -5 * sth + side * cth;
      sk.moveTo(c.px + ox, c.py + oy);
      sk.lineTo(c.x + ox, c.y + oy);
    }
    sk.stroke();
  }

  function trackPath(g, arr) {
    g.moveTo(arr[0][0], arr[0][1]);
    for (let i = 1; i < arr.length; i++) g.lineTo(arr[i][0], arr[i][1]);
    g.closePath();
  }
  function renderTrackLayer() {
    if (!track || !tv.w) return;
    const { w, h, dpr } = tv;
    trackLayer.width = Math.round(w * dpr);
    trackLayer.height = Math.round(h * dpr);
    const g = trackLayer.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = T.inset;
    g.fillRect(0, 0, w, h);
    const { s, ox, oy } = view;
    g.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    const px = 1 / s;
    const hw = track.halfWidth;
    const n = track.n;
    // ground with a faint survey grid
    g.fillStyle = '#080d1b';
    Lab.roundRect(g, 0, 0, WW, WH, 10);
    g.fill();
    g.strokeStyle = 'rgba(142,160,216,0.045)';
    g.lineWidth = px;
    g.beginPath();
    for (let x = 40; x < WW; x += 40) { g.moveTo(x, 0); g.lineTo(x, WH); }
    for (let y = 40; y < WH; y += 40) { g.moveTo(0, y); g.lineTo(WW, y); }
    g.stroke();
    // run-off halo
    g.lineJoin = 'round';
    g.strokeStyle = '#0c1326';
    g.lineWidth = 2 * hw + 20;
    g.beginPath();
    trackPath(g, track.pts);
    g.stroke();
    // asphalt
    g.beginPath();
    trackPath(g, track.left);
    trackPath(g, track.right);
    g.fillStyle = '#19203a';
    g.fill('evenodd');
    // centre dashes
    g.setLineDash([9, 13]);
    g.strokeStyle = 'rgba(226,232,240,0.09)';
    g.lineWidth = 1.4;
    g.beginPath();
    trackPath(g, track.pts);
    g.stroke();
    g.setLineDash([]);
    // kerbs on the inside of tight corners
    g.lineWidth = 4.2;
    g.lineCap = 'butt';
    for (let i = 0; i < n; i++) {
      if (Math.abs(track.curv[i]) * 3.2 * hw < 1) continue;
      const a = track.tan[(i - 1 + n) % n];
      const b = track.tan[(i + 1) % n];
      const nr = track.nor[i];
      const side = nr[0] * (b[0] - a[0]) + nr[1] * (b[1] - a[1]) > 0 ? 1 : -1;
      const j = (i + 1) % n;
      const off = (hw - 2.3) * side;
      g.strokeStyle = Math.floor(i / 3) % 2 ? '#e2e8f0' : '#e11d48';
      g.beginPath();
      g.moveTo(track.pts[i][0] + nr[0] * off, track.pts[i][1] + nr[1] * off);
      g.lineTo(track.pts[j][0] + track.nor[j][0] * off, track.pts[j][1] + track.nor[j][1] * off);
      g.stroke();
    }
    // walls
    g.strokeStyle = 'rgba(199,210,254,0.72)';
    g.lineWidth = 1.5 * px;
    for (const side of [track.left, track.right]) {
      g.beginPath();
      trackPath(g, side);
      g.stroke();
    }
    // start / finish line (chequered) and direction chevrons
    const p0 = track.pts[0];
    const t0 = track.tan[0];
    g.save();
    g.translate(p0[0], p0[1]);
    g.rotate(Math.atan2(t0[1], t0[0]));
    const m = Math.round((2 * hw) / 5);
    const c = (2 * hw) / m;
    for (let r = 0; r < 2; r++) {
      for (let q = 0; q < m; q++) {
        g.fillStyle = (q + r) % 2 ? '#0b1020' : '#f1f5f9';
        g.fillRect(-c + r * c - 3, -hw + q * c, c, c);
      }
    }
    g.restore();
    g.strokeStyle = 'rgba(244,114,182,0.35)';
    g.lineWidth = 2;
    for (const k of [14, 20, 26]) {
      const p = track.pts[k % n];
      const t = track.tan[k % n];
      const nr = track.nor[k % n];
      g.beginPath();
      g.moveTo(p[0] - t[0] * 4 + nr[0] * 6, p[1] - t[1] * 4 + nr[1] * 6);
      g.lineTo(p[0] + t[0] * 3, p[1] + t[1] * 3);
      g.lineTo(p[0] - t[0] * 4 - nr[0] * 6, p[1] - t[1] * 4 - nr[1] * 6);
      g.stroke();
    }
  }

  function carColor(c) {
    if (S.mode === 'race') return c === race.me ? GREEN : PINK;
    if (c === leader) return PINK;
    if (c.finished) return GREEN;
    if (c.elite) return GOLD;
    return GREY;
  }
  function drawCar(ctx, c, color, alpha) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.th);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    Lab.roundRect(ctx, -8.5, -4.6, 17, 9.2, 3);
    ctx.fill();
    ctx.fillStyle = 'rgba(6,10,20,0.72)';
    Lab.roundRect(ctx, 1, -3.3, 4, 6.6, 1.4);
    ctx.fill();
    ctx.fillStyle = 'rgba(6,10,20,0.45)';
    Lab.roundRect(ctx, -6.5, -3, 2.6, 6, 1);
    ctx.fill();
    ctx.restore();
  }
  function drawRays(ctx, c, alpha, width) {
    const R = E.CAR.sensorRange;
    for (let k = 0; k < E.SENSOR_ANGLES.length; k++) {
      const a = c.th + E.SENSOR_ANGLES[k];
      const d = c.sensors[k];
      const prox = 1 - d / R;
      const col = prox > 0.66 ? RED : prox > 0.33 ? AMBER : GREEN;
      const ex = c.x + Math.cos(a) * d;
      const ey = c.y + Math.sin(a) * d;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = col;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      if (d < R - 1e-6) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(ex, ey, 2.4 * width, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
  function drawBestLine(ctx) {
    if (!bestLine || bestLine.pts.length < 2 || S.mode === 'race') return;
    const pts = bestLine.pts;
    const vmax = E.CAR.maxSpeed;
    const lutC = Lab.lut([SKY, INDIGO, PINK]);
    ctx.lineWidth = 2.2 / view.s;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.75;
    const stepN = 2;
    for (let i = stepN; i < pts.length; i += stepN) {
      const t = Math.max(0, Math.min(255, Math.round((pts[i][2] / vmax) * 255))) * 3;
      ctx.strokeStyle = `rgb(${lutC[t]},${lutC[t + 1]},${lutC[t + 2]})`;
      ctx.beginPath();
      ctx.moveTo(pts[i - stepN][0], pts[i - stepN][1]);
      ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (bestLine.crashed) {
      const [x, y] = pts[pts.length - 1];
      drawCross(ctx, x, y, 6, RED, 0.9);
    }
  }
  function drawCross(ctx, x, y, r, color, alpha) {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8 / view.s;
    ctx.beginPath();
    ctx.moveTo(x - r, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r);
    ctx.lineTo(x - r, y + r);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawTrack() {
    const { ctx, dpr } = tv;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(trackLayer, 0, 0);
    const { s, ox, oy } = view;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    ctx.drawImage(skid, 0, 0, WW, WH);
    drawBestLine(ctx);
    for (const [x, y] of crashes) drawCross(ctx, x, y, 3.2, RED, 0.55);
    const list = S.mode === 'race' ? [race.ai, race.me] : cars;
    // dead cars first, then alive ones, leader on top
    for (const c of list) if (!c.alive && !c.finished) drawCar(ctx, c, '#5b6488', 0.28);
    if (S.mode === 'evolve' && S.rays === 'all') for (const c of list) if (c.alive) drawRays(ctx, c, 0.16, 0.7 / s);
    for (const c of list) if ((c.alive || c.finished) && c !== leader) drawCar(ctx, c, carColor(c), c.alive ? 0.92 : 0.5);
    if (S.mode === 'race') {
      if (race.ai.alive) drawRays(ctx, race.ai, 0.6, 1 / s);
    } else if (leader) {
      if (S.rays !== 'none' && leader.alive) drawRays(ctx, leader, 0.85, 1.1 / s);
      ctx.shadowColor = PINK;
      ctx.shadowBlur = 14 * dpr;
      drawCar(ctx, leader, PINK, leader.alive ? 1 : 0.5);
      ctx.shadowBlur = 0;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ------------------------------------------------------------------ brain view
  const bv = Lab.canvas('cv-brain', () => drawBrain());
  const duo = Lab.lut('duo');
  const duoCss = (v) => {
    const t = Math.max(0, Math.min(255, Math.round(((v + 1) / 2) * 255))) * 3;
    return `rgb(${duo[t]},${duo[t + 1]},${duo[t + 2]})`;
  };
  const SENSOR_LABELS = ['−90°', '−50°', '−22°', '0°', '+22°', '+50°', '+90°', 'speed'];
  function drawBrain() {
    const { ctx, w, h } = bv;
    bv.clear();
    const car = S.mode === 'race' ? race.ai : leader;
    const genome = car && car.genome;
    if (!genome) return;
    const tp = S.mode === 'race' ? raceTopo : topo;
    if (genome.length !== E.genomeLength(tp)) return;
    const acts = E.brainForward(genome, car.inputs, tp, true);
    const dashH = 92;
    const top = 26;
    const bot = h - dashH - 8;
    const xs = [w * 0.21, w * 0.52, w * 0.76];
    const layerY = tp.map((nn) => {
      const span = Math.min(bot - top, nn * 44);
      const y0 = (top + bot) / 2 - span / 2;
      return Array.from({ length: nn }, (_, i) => (nn === 1 ? (top + bot) / 2 : y0 + (i * span) / (nn - 1)));
    });
    ctx.font = `600 10px ${T.sans}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ['INPUTS', `HIDDEN · ${tp[1]}`, 'OUTPUTS'].forEach((s, l) => ctx.fillText(s, xs[l], 14));
    // edges: colour = weight sign, width = |w|, opacity = |signal| flowing through
    for (let l = 0; l < tp.length - 1; l++) {
      for (let j = 0; j < tp[l + 1]; j++) {
        for (let i = 0; i < tp[l]; i++) {
          const wgt = E.weightAt(genome, tp, l, i, j);
          const sig = Math.abs(wgt * acts[l][i]);
          const x0 = xs[l] + 9;
          const y0 = layerY[l][i];
          const x1 = xs[l + 1] - 9;
          const y1 = layerY[l + 1][j];
          ctx.strokeStyle = wgt > 0 ? SKY : AMBER;
          ctx.globalAlpha = 0.07 + 0.8 * Math.min(1, sig / 1.2);
          ctx.lineWidth = 0.5 + 2.2 * Math.min(1, Math.abs(wgt) / 2.5);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          const mx = (x0 + x1) / 2;
          ctx.bezierCurveTo(mx, y0, mx, y1, x1, y1);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
    // nodes
    for (let l = 0; l < tp.length; l++) {
      for (let i = 0; i < tp[l]; i++) {
        const x = xs[l];
        const y = layerY[l][i];
        const v = acts[l][i];
        const r = l === tp.length - 1 ? 12 : l === 0 ? 8 : 9;
        ctx.fillStyle = duoCss(v);
        ctx.strokeStyle = l === 0 && i < E.SENSOR_ANGLES.length && v > 0.66 ? RED : T.border2;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (l === 0) Lab.roundRect(ctx, x - r, y - r, 2 * r, 2 * r, 4);
        else ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    // input labels with direction glyphs
    ctx.font = `10.5px ${T.mono}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < tp[0]; i++) {
      const y = layerY[0][i];
      ctx.fillStyle = T.text2;
      ctx.fillText(SENSOR_LABELS[i], xs[0] - 30, y);
      if (i < E.SENSOR_ANGLES.length) {
        const a = E.SENSOR_ANGLES[i] - Math.PI / 2;
        ctx.strokeStyle = T.muted;
        ctx.fillStyle = T.muted;
        ctx.lineWidth = 1.4;
        Lab.arrow(ctx, xs[0] - 21 - Math.cos(a) * 5, y - Math.sin(a) * 5, xs[0] - 21 + Math.cos(a) * 5, y + Math.sin(a) * 5, 3.5);
      }
    }
    // outputs
    ctx.textAlign = 'left';
    const outs = acts[tp.length - 1];
    const outNames = ['steer', 'throttle'];
    for (let j = 0; j < tp[tp.length - 1]; j++) {
      const y = layerY[tp.length - 1][j];
      ctx.fillStyle = T.text2;
      ctx.font = `600 10.5px ${T.sans}`;
      ctx.fillText(outNames[j], xs[2] + 18, y - 7);
      ctx.font = `11px ${T.mono}`;
      ctx.fillStyle = T.text;
      const v = outs[j];
      const tag = j === 0 ? (v < -0.05 ? ' ◀' : v > 0.05 ? ' ▶' : '') : '';
      ctx.fillText(Lab.fmt(v, 2) + tag, xs[2] + 18, y + 7);
    }
    drawDash(ctx, w, h, dashH, car);
  }
  function drawDash(ctx, w, h, dashH, car) {
    const y0 = h - dashH;
    ctx.strokeStyle = T.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(12, y0 + 0.5);
    ctx.lineTo(w - 12, y0 + 0.5);
    ctx.stroke();
    const cy = y0 + dashH / 2 + 2;
    // steering wheel
    const wx = 52;
    const rr = 25;
    ctx.save();
    ctx.translate(wx, cy);
    ctx.rotate(car.steer * E.CAR.maxSteer * 2.6);
    ctx.strokeStyle = T.text2;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-rr, 0);
    ctx.lineTo(rr, 0);
    ctx.moveTo(0, 0);
    ctx.lineTo(0, rr);
    ctx.stroke();
    ctx.fillStyle = PINK;
    ctx.beginPath();
    ctx.arc(0, -rr, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // throttle / brake bar
    const bx = 100;
    const bw = Math.max(60, w - bx - 118);
    const by = cy - 16;
    ctx.fillStyle = T.inset;
    ctx.strokeStyle = T.border2;
    Lab.roundRect(ctx, bx, by, bw, 12, 6);
    ctx.fill();
    ctx.stroke();
    const mid = bx + bw / 2;
    const th = car.throttle;
    ctx.fillStyle = th >= 0 ? GREEN : RED;
    const len = (Math.abs(th) * bw) / 2;
    ctx.fillRect(th >= 0 ? mid : mid - len, by + 2, len, 8);
    ctx.fillStyle = T.border2;
    ctx.fillRect(mid - 0.5, by - 2, 1, 16);
    ctx.font = `600 9.5px ${T.sans}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('BRAKE', bx, by + 17);
    ctx.textAlign = 'right';
    ctx.fillText('THROTTLE', bx + bw, by + 17);
    // speed
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 24px ${T.mono}`;
    ctx.fillStyle = T.text;
    ctx.fillText(String(Math.round(car.v * KMH)), w - 44, cy + 8);
    ctx.font = `10px ${T.sans}`;
    ctx.fillStyle = T.muted;
    ctx.fillText('km/h', w - 14, cy + 8);
    if (car.slip && car.alive) {
      ctx.font = `700 9.5px ${T.sans}`;
      ctx.fillStyle = AMBER;
      ctx.fillText('UNDERSTEER', w - 14, cy - 18);
    }
  }

  // ------------------------------------------------------------------ charts
  const fitPlot = new Lab.Plot('cv-fit', { pad: { l: 46, r: 16, t: 14, b: 28 }, xLabel: 'generation', yLabel: 'fitness', yMin: 0, yPad: 0.06 });
  function drawFitness() {
    const live = cars.reduce((m, c) => Math.max(m, c.fitness), 0);
    const xs = hist.x;
    let hi = Math.max(60, live);
    for (const v of hist.best) hi = Math.max(hi, v);
    const finishLine = S.maxLaps * 100;
    Object.assign(fitPlot.opts, { xMin: 1, xMax: Math.max(10, gen), yMax: hi > finishLine * 0.8 ? Math.max(hi * 1.06, finishLine + 60) : hi * 1.1 });
    fitPlot.series = [
      { name: '25–75 %', color: INDIGO, area: true, alpha: 0.2, data: { x: xs, y: hist.p75, lo: hist.p25 } },
      { name: 'mean', color: INDIGO, width: 1.6, data: { x: xs, y: hist.mean } },
      { name: 'best', color: PINK, width: 2.2, data: { x: xs, y: hist.best } },
    ];
    fitPlot.hlines = [
      { y: finishLine, color: Lab.alpha(GREEN, 0.7), label: `${S.maxLaps} laps · finish`, dash: [5, 4], align: 'right' },
      { y: 100, color: Lab.alpha('#a9b4d6', 0.35), label: '1 lap', dash: [2, 4], align: 'right' },
    ];
    fitPlot.vlines = marks.map((m) => ({ x: m.gen, color: Lab.alpha(m.color, 0.8), label: m.label, align: m.gen > gen * 0.7 ? 'right' : 'left' }));
    fitPlot.markers = S.mode === 'evolve' ? [{ x: gen, y: live, color: PINK, r: 3.5 }] : [];
    fitPlot.draw();
    const last = hist.best.length ? hist.best[hist.best.length - 1] : NaN;
    Lab.text('fit-sub', hist.x.length ? `gen ${hist.x[hist.x.length - 1]} · best ${last.toFixed(0)} · mean ${hist.mean[hist.mean.length - 1].toFixed(0)}` : 'first generation running…');
  }

  const pv = Lab.canvas('cv-pop', () => drawPop());
  function drawPop() {
    const { ctx, w, h } = pv;
    pv.clear();
    const list = cars.slice().sort((a, b) => b.fitness - a.fitness);
    const pad = { l: 34, r: 10, t: 12, b: 20 };
    const W = w - pad.l - pad.r;
    const H = h - pad.t - pad.b;
    if (H < 20 || !list.length) return;
    const fmax = Math.max(50, list[0].fitness) * 1.08;
    const Y = (v) => pad.t + H - (v / fmax) * H;
    // lap gridlines
    ctx.font = `10px ${T.mono}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const stepV = fmax > 250 ? 100 : fmax > 100 ? 50 : 25;
    for (let v = 0; v <= fmax; v += stepV) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = v % 100 === 0 && v > 0 ? 'rgba(52,211,153,0.28)' : 'rgba(142,160,216,0.1)';
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + W, y);
      ctx.stroke();
      ctx.fillStyle = T.muted;
      ctx.fillText(v >= 100 && v % 100 === 0 ? `${v / 100}L` : `${v}`, pad.l - 6, y);
    }
    const bw = W / list.length;
    list.forEach((c, k) => {
      const x = pad.l + k * bw;
      const y = Y(c.fitness);
      let col = c.alive ? INDIGO : '#3b4366';
      if (c.finished) col = GREEN;
      else if (c === leader) col = PINK;
      ctx.fillStyle = col;
      ctx.fillRect(x + bw * 0.12, y, Math.max(1, bw * 0.76), pad.t + H - y);
      if (c.elite) {
        ctx.fillStyle = GOLD;
        ctx.beginPath();
        ctx.arc(x + bw / 2, y - 4, Math.min(2.6, bw * 0.35), 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 10px ${T.sans}`;
    ctx.fillText('cars ranked by fitness · ● elite · L = laps', pad.l, h - 5);
  }

  // ------------------------------------------------------------------ text / HUD
  const htmlCache = new Map();
  function html(id, s) {
    if (htmlCache.get(id) === s) return;
    htmlCache.set(id, s);
    Lab.$('#' + id).innerHTML = s;
  }
  function updateTrackSub() {
    if (!track) return;
    Lab.text('track-sub', `${(track.length * 0.15).toFixed(0)} m · ${S.maxLaps} laps · ${S.mode === 'race' ? 'race mode' : `${cars.length || S.pop} cars`}`);
  }
  function updateBrainSub() {
    const tp = S.mode === 'race' ? raceTopo : topo;
    const car = S.mode === 'race' ? race.ai : leader;
    const who = S.mode === 'race' ? 'champion' : car ? `car #${car.id + 1}${car.elite ? ' · elite' : ''}` : '';
    Lab.text('brain-sub', `${tp.join('–')} · ${E.genomeLength(tp)} weights · ${who}`);
  }
  const HUD_KEYS = { evolve: ['Generation', 'Alive', 'Time', 'Leader', 'Speed'], race: ['Mode', 'You', 'Time', 'Champion', 'Your speed'] };
  function updateHud() {
    HUD_KEYS[S.mode].forEach((k, i) => Lab.text(`hud-k${i + 1}`, k));
    if (S.mode === 'race') {
      const me = race.me;
      Lab.text('hud-gen', 'RACE');
      Lab.text('hud-alive', me.finished ? 'finished' : me.alive ? `lap ${Math.min(S.maxLaps, me.laps + 1)}/${S.maxLaps}` : 'crashed');
      html('hud-time', `${race.t.toFixed(1)}<small>s</small>`);
      const ai = race.ai;
      Lab.text('hud-lap', ai.finished ? `${ai.t.toFixed(1)} s` : ai.alive ? `lap ${Math.min(S.maxLaps, ai.laps + 1)}/${S.maxLaps}` : 'crashed');
      html('hud-speed', `${Math.round(me.v * KMH)}<small>km/h</small>`);
      return;
    }
    Lab.text('hud-gen', String(gen));
    const alive = cars.filter((c) => c.alive).length;
    Lab.text('hud-alive', `${alive}/${cars.length}`);
    html('hud-time', `${simT.toFixed(1)}<small>s</small>`);
    const L = leader;
    if (L) {
      const lapFrac = Math.max(0, L.bestProg) / track.n;
      Lab.text('hud-lap', L.finished ? 'finished' : L.laps >= 1 ? `lap ${Math.min(S.maxLaps, L.laps + 1)}/${S.maxLaps}` : `${(lapFrac * 100).toFixed(0)} % lap`);
      html('hud-speed', `${Math.round(L.v * KMH)}<small>km/h</small>`);
    }
  }
  function updateStats() {
    const lap = Lab.$('#st-lap');
    lap.innerHTML = Number.isFinite(bestLap) ? `${bestLap.toFixed(2)}<span class="u">s</span>` : '—';
    lap.parentElement.className = 'stat' + (Number.isFinite(bestLap) ? ' good' : '');
    Lab.$('#st-first').innerHTML = firstLap ? `gen ${firstLap}` : '—';
    Lab.$('#st-fin').innerHTML = lastGen ? `${lastGen.finishers}<span class="u">/ ${cars.length}</span>` : '—';
    Lab.text('pop-sub', lastGen ? `generation ${gen} · last best ${lastGen.best.toFixed(0)}` : `generation ${gen}`);
    updateTrackSub();
  }

  // ------------------------------------------------------------------ champion I/O
  function loadGenome(arr, hidden, label) {
    const tp = E.topology(hidden);
    if (!Array.isArray(arr) && !(arr instanceof Float64Array)) throw new Error('genome must be an array');
    if (arr.length !== E.genomeLength(tp)) throw new Error(`expected ${E.genomeLength(tp)} weights for ${tp.join('–')}, got ${arr.length}`);
    if (!Array.from(arr).every(Number.isFinite)) throw new Error('genome contains non-numeric values');
    if (hidden !== S.hidden) {
      S.hidden = hidden;
      ui.hidden.set(hidden);
    }
    resetEvolution(Float64Array.from(arr));
    Lab.toast(`Loaded ${label} (${tp.join('–')})`);
  }
  function saveChampion() {
    if (!champ) return Lab.toast('Let at least one generation finish first');
    const data = {
      app: 'EvoDrive', version: 1, topology: E.topology(champ.hidden), hidden: champ.hidden,
      generation: champ.gen, fitness: +Number(champ.fitness).toFixed(2), bestLap: Number.isFinite(champ.lapTime) ? +champ.lapTime.toFixed(3) : null,
      track: { seed: S.seed, halfWidth: S.halfWidth, wiggle: S.wiggle }, car: { ...E.CAR },
      genome: Array.from(champ.genome, (v) => +v.toFixed(5)),
    };
    Lab.downloadText(JSON.stringify(data, null, 1), `evodrive-champion-gen${champ.gen}.json`);
  }

  // ------------------------------------------------------------------ sidebar
  const playBtn = Lab.$('#btn-play');
  function setRunning(on) {
    S.running = on;
    playBtn.innerHTML = on ? `${Lab.icon('pause')}<span>Pause</span>` : `${Lab.icon('play')}<span>Run</span>`;
  }
  function skipGeneration() {
    if (S.mode !== 'evolve') return;
    const g = gen;
    let guard = 0;
    while (gen === g && guard++ < 1e5) step(DT);
  }
  function newTrack() {
    if (S.mode === 'race') stopRace();
    setTrack(S.seed + 1);
    if (!S.rotate) marks.push({ gen, label: 'new track', color: SKY });
    drawFitness();
    Lab.toast(champ ? 'New track — the population keeps its brains. Do they generalise?' : 'New track');
  }
  playBtn.addEventListener('click', () => setRunning(!S.running));
  Lab.$('#btn-skip').addEventListener('click', skipGeneration);
  Lab.$('#btn-reset').addEventListener('click', () => {
    if (S.mode === 'race') stopRace();
    resetEvolution();
    drawFitness();
    updateStats();
  });
  Lab.$('#btn-track').addEventListener('click', newTrack);
  const speedSeg = Lab.seg('seg-speed', (v) => (S.speed = v === 'max' ? 'max' : Number(v)));
  Lab.seg('seg-rays', (v) => (S.rays = v));
  const ui = {};
  const regen = () => {
    if (S.mode === 'race') stopRace();
    setTrack(S.seed);
  };
  ui.width = Lab.range('sl-width', { format: (v) => `${(v * 0.3).toFixed(1)} m`, onInput: (v) => (S.halfWidth = v), onChange: regen });
  ui.curvy = Lab.range('sl-curvy', { format: (v) => v.toFixed(2), onInput: (v) => (S.wiggle = v), onChange: regen });
  Lab.toggle('tg-rotate', (v) => {
    S.rotate = v;
    if (v) marks.push({ gen, label: 'new track each gen', color: SKY });
    Lab.toast(v ? 'Every generation now races on a fresh track' : 'Track stays fixed');
  });
  ui.pop = Lab.range('sl-pop', { format: (v) => `${v}`, onInput: (v) => (S.pop = v) });
  ui.mrate = Lab.range('sl-mrate', { format: (v) => `${Math.round(v * 100)} %`, onInput: (v) => (S.mutRate = v) });
  ui.msigma = Lab.range('sl-msigma', { format: (v) => v.toFixed(2), onInput: (v) => (S.mutSigma = v) });
  ui.elite = Lab.range('sl-elite', { format: (v) => `${v}`, onInput: (v) => (S.elite = v) });
  ui.hidden = Lab.range('sl-hidden', {
    format: (v) => `${v}`,
    onInput: (v) => (S.hidden = v),
    onChange: () => {
      if (S.mode === 'race') stopRace();
      resetEvolution();
      drawFitness();
      updateStats();
      Lab.toast(`New population · ${topo.join('–')} network`);
    },
  });
  ui.grip = Lab.range('sl-grip', { format: (v) => `${Math.round(v / 5.2)} %`, onInput: (v) => (E.CAR.aLat = v) });
  ui.range = Lab.range('sl-range', { format: (v) => `${(v * 0.15).toFixed(0)} m`, onInput: (v) => (E.CAR.sensorRange = v) });
  Lab.$('#btn-race').addEventListener('click', (e) => {
    e.currentTarget.blur();
    if (S.mode === 'race') stopRace();
    else startRace();
  });
  Lab.$('#btn-save').addEventListener('click', saveChampion);
  Lab.$('#btn-load').addEventListener('click', () => Lab.$('#file-brain').click());
  Lab.$('#file-brain').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const hidden = data.hidden || (data.topology && data.topology[1]);
      if (!Number.isInteger(hidden) || hidden < 1 || hidden > 64) throw new Error('missing hidden-layer size');
      if (S.mode === 'race') stopRace();
      loadGenome(data.genome, hidden, f.name);
      drawFitness();
      updateStats();
    } catch (err) {
      Lab.toast(`Could not load brain: ${err.message}`, 4200);
    }
  });
  Lab.$('#btn-pretrained').addEventListener('click', () => {
    if (S.mode === 'race') stopRace();
    const P = window.EVO_PRETRAINED;
    loadGenome(P.genome, P.hidden, 'pre-trained driver');
    drawFitness();
    updateStats();
  });

  const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (S.mode === 'race') {
      if (KEYMAP[e.code] || e.code === 'Space') {
        e.preventDefault();
        if (KEYMAP[e.code]) keys.add(KEYMAP[e.code]);
        return;
      }
      if (e.code === 'KeyR') startRace();
      if (e.code === 'Escape' && !document.body.classList.contains('drawer-open')) stopRace();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      setRunning(!S.running);
    }
    if (e.code === 'KeyG') skipGeneration();
    if (e.code === 'KeyN') newTrack();
  });
  document.addEventListener('keyup', (e) => {
    if (KEYMAP[e.code]) keys.delete(KEYMAP[e.code]);
  });
  window.addEventListener('blur', () => keys.clear());

  // ------------------------------------------------------------------ main loop
  let frame = 0;
  Lab.loop((dt) => {
    frame++;
    if (S.mode === 'evolve' && S.running) {
      if (S.speed === 'max') {
        const t0 = performance.now();
        while (performance.now() - t0 < 14) for (let k = 0; k < 10; k++) step(DT);
      } else {
        acc += dt * S.speed;
        let n = 0;
        while (acc >= DT && n < 600) {
          step(DT);
          acc -= DT;
          n++;
        }
      }
      pickLeader();
    } else if (S.mode === 'race') raceStep(dt);
    drawTrack();
    drawBrain();
    updateHud();
    if (frame % 3 === 0) {
      drawPop();
      drawFitness();
      updateBrainSub();
    }
  });

  // ------------------------------------------------------------------ init
  setTrack(S.seed, false);
  resetEvolution();
  drawFitness();
  updateStats();

  window.EvoDrive = {
    state: S,
    get generation() { return gen; },
    get track() { return track; },
    get cars() { return cars; },
    get history() { return hist; },
    get champion() { return champ; },
    run: setRunning,
    speed: (v) => speedSeg.set(String(v), true),
    skip: skipGeneration,
    /** Run n whole generations headlessly (for demos / screenshots). */
    fastForward(n) {
      for (let k = 0; k < n; k++) skipGeneration();
    },
    advance(seconds) {
      for (let t = 0; t < seconds; t += DT) step(DT);
      pickLeader();
    },
    newTrack,
    setTrack,
    race: startRace,
    stopRace,
    pretrained: () => Lab.$('#btn-pretrained').click(),
    press: (k, down = true) => (down ? keys.add(k) : keys.delete(k)),
    raceState: race,
  };
})();
