/* FallGuard — live stream, avatar, alert escalation and benchmark views. */
(function () {
  'use strict';
  const F = window.FallCore;
  const M = window.LabMath;
  Lab.boot();
  const T = Lab.theme();
  const FS = F.FS;
  const DET_COLOR = { threshold: '#fb7185', posture: '#fbbf24', fsm: '#34d399', ml: '#38bdf8' };
  const DET_NAME = { threshold: 'Impact threshold', posture: 'Impact + posture', fsm: 'State machine', ml: 'Learned model' };

  const S = {
    profile: 'real', det: 'fsm', running: true, auto: true, bench: 'real', train: 'lab', countdown: 15,
    params: { ...F.DEFAULT_PARAMS }, mlThr: 0.5,
  };

  // ------------------------------------------------------------------ models & benchmark data (built once)
  const DATA = { lab: F.makeDataset('lab', { seed: 1 }), real: F.makeDataset('real', { seed: 2 }) };
  const TRAIN = {};
  const model = (key) => {
    if (!TRAIN[key]) { const t = F.trainingSet(F.makeDataset(key, { seed: key === 'lab' ? 9 : 10 })); TRAIN[key] = F.trainLogistic(t.X, t.y); }
    return TRAIN[key];
  };
  function detector(det, params = S.params, mlThr = S.mlThr) {
    if (det === 'ml') { const m = model(S.train); return (ev) => F.detectML(ev, m, mlThr).alarms; }
    return (ev) => F.detectRules(ev, det, params).alarms;
  }

  // ------------------------------------------------------------------ live stream
  let queue = [];
  let cur = null;
  let pos = 0;
  let curAlarms = [];
  let alarmed = false;
  const rng = M.makeRng(Math.floor(Math.random() * 1e9));
  const WIN = 10 * FS;
  const ring = { x: new Lab.RingSeries(WIN), y: new Lab.RingSeries(WIN), z: new Lab.RingSeries(WIN), m: new Lab.RingSeries(WIN) };
  const alarmMarks = [];
  let tSample = 0;
  let grav = [0, 1, 0];

  function nextEvent() {
    let kind = queue.shift();
    if (!kind) {
      if (!S.auto) { kind = 'walk'; }
      else {
        const keys = Object.keys(F.ADL).filter((k) => F.ADL[k].perDay > 0);
        const tot = keys.reduce((s, k) => s + F.ADL[k].perDay, 0);
        let r = rng.next() * tot;
        kind = keys.find((k) => (r -= F.ADL[k].perDay) < 0) || 'walk';
      }
    }
    cur = F.makeEvent(kind, rng, S.profile);
    pos = 0;
    alarmed = false;
    curAlarms = detector(S.det)(cur);
    Lab.text('live-sub', `now: ${(F.ADL[kind] || F.FALLS[kind]).name}`);
  }
  function queueActivity(kind) {
    queue = [kind];
    // interrupt the current recording after its standing context so the requested activity starts promptly
    if (cur && pos < cur.n - 2 * FS) cur.n = Math.min(cur.n, pos + 1);
  }
  function pushSample() {
    if (!cur || pos >= cur.n) {
      if (cur && cur.isFall && !alarmed) logLine(`Missed fall — ${F.FALLS[cur.kind].name} (no alarm)`, 'bad');
      nextEvent();
    }
    const i = pos++;
    tSample++;
    const t = tSample / FS;
    ring.x.push(t, cur.x[i]);
    ring.y.push(t, cur.y[i]);
    ring.z.push(t, cur.z[i]);
    ring.m.push(t, cur.m[i]);
    grav = grav.map((g, k) => g + 0.06 * ([cur.x[i], cur.y[i], cur.z[i]][k] - g));
    if (curAlarms.includes(i)) {
      alarmed = true;
      alarmMarks.push(t);
      raiseAlarm(cur);
    }
  }

  // ------------------------------------------------------------------ alerting
  const alert = { state: 'idle', t: 0, truth: null };
  const alertEl = Lab.$('#alert');
  function setAlert(state, msg) {
    alert.state = state;
    alertEl.className = `alert ${state}`;
    Lab.text('alert-badge', { idle: 'Monitoring', alarm: 'Possible fall', cancel: 'Cancelled', notified: 'Caregiver called' }[state]);
    Lab.text('alert-msg', msg);
    Lab.$('#btn-ok').classList.toggle('hidden', state !== 'alarm');
    Lab.$('#alert-bar').classList.toggle('hidden', state !== 'alarm');
  }
  function raiseAlarm(ev) {
    const truth = ev.isFall ? F.FALLS[ev.kind].name : F.ADL[ev.kind].name;
    alert.truth = { isFall: ev.isFall, truth };
    alert.t = S.countdown;
    setAlert('alarm', `Watch asks “Are you OK?” — calling caregiver in ${S.countdown} s`);
    logLine(`${ev.isFall ? 'Fall detected' : 'False alarm'} — ${truth}`, ev.isFall ? 'ok' : 'warn');
  }
  function logLine(s, cls = '') {
    const d = new Date();
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = `${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}  ${s}`;
    const log = Lab.$('#log');
    log.prepend(div);
    while (log.children.length > 30) log.lastChild.remove();
  }
  Lab.$('#btn-ok').addEventListener('click', () => {
    if (alert.state !== 'alarm') return;
    setAlert('cancel', alert.truth.isFall ? 'Cancelled by the wearer — but it was a real fall.' : 'Cancelled by the wearer — false alarm avoided a call.');
    logLine('Wearer pressed “I’m OK”', '');
    setTimeout(() => alert.state === 'cancel' && setAlert('idle', 'No incident.'), 4000);
  });

  // ------------------------------------------------------------------ live plots
  const axesPlot = new Lab.Plot('cv-axes', { pad: { l: 42, r: 12, t: 22, b: 18 }, yLabel: 'g', legend: 'above', yMin: -2.5, yMax: 3, xTicks: 6, zeroLine: true });
  axesPlot.series = [
    { name: 'x forward', color: '#fb7185', width: 1.3, data: ring.x },
    { name: 'y vertical', color: '#34d399', width: 1.3, data: ring.y },
    { name: 'z lateral', color: '#38bdf8', width: 1.3, data: ring.z },
  ];
  const svmPlot = new Lab.Plot('cv-svm', { pad: { l: 42, r: 12, t: 22, b: 26 }, yLabel: '|a| (g)', xLabel: 'time (s)', yMin: 0, yMax: 5, xTicks: 6, legend: 'above' });
  svmPlot.series = [{ name: 'signal magnitude |a|', color: '#e8edfb', width: 1.5, data: ring.m }];
  function drawLive() {
    const t1 = tSample / FS;
    const x0 = Math.max(0, t1 - WIN / FS);
    for (const p of [axesPlot, svmPlot]) { p.opts.xMin = x0; p.opts.xMax = Math.max(WIN / FS, t1); }
    const showFF = S.det === 'fsm';
    svmPlot.hlines = [{ y: S.params.impact, color: Lab.alpha('#fb7185', 0.8), label: `impact ${S.params.impact.toFixed(2)} g`, align: 'right' }];
    if (showFF) svmPlot.hlines.push({ y: S.params.freefall, color: Lab.alpha('#38bdf8', 0.8), label: `free-fall ${S.params.freefall.toFixed(2)} g`, align: 'right' });
    svmPlot.vlines = alarmMarks.filter((t) => t >= x0).map((t) => ({ x: t, color: '#fbbf24', label: 'ALARM', dash: [] }));
    axesPlot.draw();
    svmPlot.draw();
  }

  // ------------------------------------------------------------------ avatar
  const pv = Lab.canvas('cv-person', () => drawPerson());
  function drawPerson() {
    const { ctx, w, h } = pv;
    pv.clear();
    const floor = h - 26;
    const cx = w / 2;
    ctx.fillStyle = 'rgba(142,160,216,0.06)';
    ctx.fillRect(0, floor, w, h - floor);
    ctx.strokeStyle = T.border2;
    ctx.beginPath(); ctx.moveTo(10, floor + 0.5); ctx.lineTo(w - 10, floor + 0.5); ctx.stroke();
    const kind = cur ? cur.kind : 'walk';
    const scale = Math.min(1.25, h / 230);
    if (kind === 'lieBed') { ctx.fillStyle = '#26335a'; Lab.roundRect(ctx, cx - 30 * scale, floor - 42 * scale, 150 * scale, 42 * scale, 6); ctx.fill(); }
    if (kind === 'sitHard' || kind === 'standUp') { ctx.fillStyle = '#26335a'; ctx.fillRect(cx - 34 * scale, floor - 40 * scale, 44 * scale, 40 * scale); ctx.fillRect(cx - 34 * scale, floor - 88 * scale, 8 * scale, 88 * scale); }
    // posture from the low-passed gravity vector
    const pitch = Math.atan2(grav[0], grav[1]);
    const roll = Math.atan2(grav[2], grav[1]);
    const tilt = Math.min(Math.PI / 2, Math.hypot(pitch, roll));
    const dirSign = Math.abs(pitch) >= Math.abs(roll) ? Math.sign(pitch) || 1 : Math.sign(roll) || 1;
    const ang = dirSign * tilt; // body angle from vertical in the side view
    const L = 120 * scale;
    const lying = tilt > 1.1;
    const base = lying ? [cx - (dirSign > 0 ? 0 : -1) * 0, floor - 10 * scale] : [cx, floor];
    const hip = lying ? [base[0], base[1]] : [cx + Math.sin(ang) * 0.45 * L, floor - Math.cos(ang) * 0.45 * L];
    const neck = [hip[0] + Math.sin(ang) * 0.45 * L, hip[1] - Math.cos(ang) * 0.45 * L];
    const head = [hip[0] + Math.sin(ang) * 0.6 * L, hip[1] - Math.cos(ang) * 0.6 * L];
    const col = alert.state === 'alarm' || alert.state === 'notified' ? '#fb7185' : '#e8edfb';
    ctx.strokeStyle = col;
    ctx.lineCap = 'round';
    ctx.lineWidth = 9 * scale;
    ctx.beginPath();
    if (lying) { ctx.moveTo(hip[0] - Math.sin(ang) * 0.45 * L, hip[1] + Math.cos(ang) * 0.45 * L * 0.02); ctx.lineTo(hip[0], hip[1]); }
    else { ctx.moveTo(cx - 12 * scale, floor); ctx.lineTo(hip[0], hip[1]); ctx.moveTo(cx + 12 * scale, floor); ctx.lineTo(hip[0], hip[1]); }
    ctx.lineTo(neck[0], neck[1]);
    ctx.stroke();
    ctx.lineWidth = 7 * scale;
    ctx.beginPath();
    const arm = 0.28 * L;
    ctx.moveTo(neck[0], neck[1]);
    ctx.lineTo(neck[0] + Math.sin(ang + 2.5) * arm, neck[1] - Math.cos(ang + 2.5) * arm);
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(head[0], head[1], 13 * scale, 0, Math.PI * 2); ctx.fill();
    // the wearable
    ctx.fillStyle = '#34d399';
    ctx.shadowColor = '#34d399';
    ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(hip[0], hip[1], 5 * scale, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.font = `11px ${T.mono}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'left';
    ctx.fillText(`tilt ${(tilt * 57.3).toFixed(0)}°`, 12, 18);
    Lab.text('person-sub', `${F.PROFILES[S.profile].name.split(' — ')[1] || F.PROFILES[S.profile].name} · detector: ${DET_NAME[S.det]}`);
  }

  // ------------------------------------------------------------------ benchmark
  const benchPlot = new Lab.Plot('cv-bench', { pad: { l: 50, r: 16, t: 26, b: 30 }, xLabel: 'false alarms per day (older adult’s routine)', yLabel: 'sensitivity (%)', yMin: 0, yMax: 105, xMin: 0, legend: 'above' });
  let benchTimer = 0;
  let results = null;
  function recomputeBench() {
    clearTimeout(benchTimer);
    benchTimer = setTimeout(() => {
      const events = DATA[S.bench];
      const impacts = [1.4, 1.6, 1.8, 2.0, 2.2, 2.5, 2.8, 3.2, 3.6, 4.0];
      const series = [];
      const current = {};
      for (const det of ['threshold', 'posture', 'fsm']) {
        const pts = impacts.map((imp) => F.evaluate(events, detector(det, { ...S.params, impact: imp })));
        series.push({ name: DET_NAME[det], color: DET_COLOR[det], width: det === S.det ? 2.6 : 1.4, data: { x: pts.map((p) => p.faPerDay), y: pts.map((p) => p.sensitivity * 100) } });
        current[det] = F.evaluate(events, detector(det));
      }
      const thrs = [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.85, 0.95];
      const mp = thrs.map((t) => F.evaluate(events, detector('ml', S.params, t)));
      series.push({ name: `${DET_NAME.ml} (${S.train})`, color: DET_COLOR.ml, width: S.det === 'ml' ? 2.6 : 1.4, data: { x: mp.map((p) => p.faPerDay), y: mp.map((p) => p.sensitivity * 100) } });
      current.ml = F.evaluate(events, detector('ml'));
      benchPlot.series = series;
      benchPlot.markers = Object.entries(current).map(([k, r]) => ({ x: r.faPerDay, y: r.sensitivity * 100, color: DET_COLOR[k], r: k === S.det ? 6 : 4, label: k === S.det ? 'current' : '' }));
      const xmax = Math.max(5, ...series.flatMap((s) => s.data.x));
      benchPlot.opts.xMax = Math.min(60, xmax * 1.05);
      benchPlot.draw();
      const other = F.evaluate(DATA[S.bench === 'lab' ? 'real' : 'lab'], detector(S.det));
      results = { cur: current[S.det], other };
      updateActs();
    }, 120);
  }
  function updateActs() {
    const r = results.cur;
    const lab = S.bench === 'lab' ? r : results.other;
    const real = S.bench === 'real' ? r : results.other;
    const sens = Lab.$('#st-sens');
    sens.innerHTML = `${(r.sensitivity * 100).toFixed(0)}<span class="u">%</span>`;
    sens.parentElement.className = 'stat ' + (r.sensitivity > 0.9 ? 'good' : r.sensitivity > 0.6 ? 'warn' : 'bad');
    const fa = Lab.$('#st-fa');
    fa.innerHTML = `${r.faPerDay.toFixed(1)}`;
    fa.parentElement.className = 'stat ' + (r.faPerDay < 0.2 ? 'good' : r.faPerDay < 2 ? 'warn' : 'bad');
    Lab.$('#st-month').innerHTML = `${(r.faPerDay * 30).toFixed(0)}`;
    Lab.$('#st-gap').innerHTML = `${(lab.sensitivity * 100).toFixed(0)}→${(real.sensitivity * 100).toFixed(0)}<span class="u">%</span>`;
    Lab.text('acts-sub', `${DET_NAME[S.det]} · ${S.bench === 'real' ? 'real-world' : 'lab'} benchmark · ${r.falls} falls`);
    // per fall type
    const events = DATA[S.bench];
    const det = detector(S.det);
    const byType = {};
    for (const ev of events) {
      if (!ev.isFall) continue;
      const b = (byType[ev.kind] = byType[ev.kind] || { n: 0, hit: 0 });
      b.n++;
      if (det(ev).some((a) => a >= ev.impactIdx - FS && a <= ev.impactIdx + 6 * FS)) b.hit++;
    }
    Lab.$('#bars-falls').innerHTML = Object.entries(byType).map(([k, b]) => {
      const p = b.hit / b.n;
      return `<div class="bar-row"><span class="nm">${F.FALLS[k].name}</span><span class="b" style="width:${Math.max(1, p * 100)}%;background:${p > 0.8 ? '#34d399' : p > 0.5 ? '#fbbf24' : '#fb7185'}"></span><span class="v">${(p * 100).toFixed(0)}%</span></div>`;
    }).join('');
    const maxFa = Math.max(0.5, ...Object.entries(r.perActivity).map(([k, v]) => v * F.ADL[k].perDay));
    Lab.$('#bars-adl').innerHTML = Object.entries(r.perActivity).map(([k, v]) => {
      const per = v * F.ADL[k].perDay;
      return `<div class="bar-row"><span class="nm">${F.ADL[k].name}</span><span class="b" style="width:${Math.max(1, (per / maxFa) * 100)}%;background:${per > 1 ? '#fb7185' : per > 0.1 ? '#fbbf24' : '#475177'}"></span><span class="v">${per.toFixed(2)}</span></div>`;
    }).join('');
  }

  // ------------------------------------------------------------------ controls
  const ACTS = [['walk', 'Walk'], ['sitHard', 'Sit down hard'], ['pickUp', 'Bend down'], ['lieBed', 'Flop onto bed'], ['stumble', 'Stumble'], ['stairs', 'Stairs'], ['fallForward', 'Fall forward'], ['fallBackward', 'Fall backward'], ['fallSide', 'Fall sideways'], ['fallSlow', 'Slow collapse']];
  Lab.$('#acts').innerHTML = ACTS.map(([k, n]) => `<button class="btn${F.FALLS[k] ? ' fall' : ''}" data-act="${k}">${F.FALLS[k] ? '⚠ ' : ''}${n}</button>`).join('');
  Lab.$$('#acts [data-act]').forEach((b) => b.addEventListener('click', () => queueActivity(b.dataset.act)));
  Lab.seg('seg-profile', (v) => { S.profile = v; queueActivity('walk'); });
  const detSeg = Lab.seg('seg-det', (v) => { S.det = v; if (cur) curAlarms = detector(S.det)(cur).filter((a) => a >= pos); recomputeBench(); });
  const benchSeg = Lab.seg('seg-bench', (v) => { S.bench = v; recomputeBench(); });
  Lab.seg('seg-train', (v) => { S.train = v; recomputeBench(); });
  Lab.toggle('tg-auto', (v) => (S.auto = v));
  const ui = {};
  const setP = (k) => (v) => { S.params[k] = v; recomputeBench(); };
  ui.impact = Lab.range('sl-impact', { format: (v) => `${v.toFixed(2)} g`, onInput: setP('impact') });
  ui.freefall = Lab.range('sl-ff', { format: (v) => `${v.toFixed(2)} g`, onInput: setP('freefall') });
  ui.posture = Lab.range('sl-posture', { format: (v) => `${v}°`, onInput: setP('posture') });
  ui.stillStd = Lab.range('sl-still', { format: (v) => `${v.toFixed(2)} g`, onInput: setP('stillStd') });
  ui.mlThr = Lab.range('sl-mlthr', { format: (v) => v.toFixed(2), onInput: (v) => { S.mlThr = v; recomputeBench(); } });
  ui.countdown = Lab.range('sl-count', { format: (v) => `${v} s`, onInput: (v) => (S.countdown = v) });
  const playBtn = Lab.$('#btn-play');
  function setRunning(on) {
    S.running = on;
    playBtn.innerHTML = on ? `${Lab.icon('pause')}<span>Pause stream</span>` : `${Lab.icon('play')}<span>Resume stream</span>`;
  }
  playBtn.addEventListener('click', () => setRunning(!S.running));
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); setRunning(!S.running); }
  });

  // ------------------------------------------------------------------ loop
  let acc = 0;
  let frame = 0;
  Lab.loop((dt) => {
    frame++;
    if (S.running) {
      acc += dt * FS;
      while (acc >= 1) { pushSample(); acc -= 1; }
    }
    if (alert.state === 'alarm') {
      alert.t -= dt;
      Lab.$('#alert-fill').style.width = `${Math.max(0, (alert.t / S.countdown) * 100)}%`;
      Lab.text('alert-msg', `Watch asks “Are you OK?” — calling caregiver in ${Math.ceil(Math.max(0, alert.t))} s`);
      if (alert.t <= 0) {
        setAlert('notified', alert.truth.isFall ? `Caregiver notified with location — real fall (${alert.truth.truth}).` : `Caregiver called — but it was a false alarm (${alert.truth.truth}).`);
        logLine(alert.truth.isFall ? 'Caregiver notified ✓' : 'Unnecessary caregiver call', alert.truth.isFall ? 'ok' : 'bad');
        setTimeout(() => alert.state === 'notified' && setAlert('idle', 'No incident.'), 7000);
      }
    }
    drawLive();
    if (frame % 2 === 0) drawPerson();
  });

  nextEvent();
  recomputeBench();
  window.FallGuard = {
    state: S,
    act: queueActivity,
    run: setRunning,
    detector: (d) => detSeg.set(d, true),
    bench: (b) => benchSeg.set(b, true),
    set(o) { Object.entries(o).forEach(([k, v]) => ui[k] && ui[k].set(v, true)); },
    /** Stream n seconds instantly (for demos and screenshots). */
    advance(sec) { for (let i = 0; i < sec * FS; i++) pushSample(); drawLive(); drawPerson(); },
    get results() { return results; },
    get alertState() { return alert.state; },
  };
})();
