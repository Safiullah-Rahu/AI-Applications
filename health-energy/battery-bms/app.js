/* VoltWise — live EV pack simulation, SOC estimators, charging and balancing views. */
(function () {
  'use strict';
  const B = window.BmsCore;
  Lab.boot();
  const T = Lab.theme();
  const C = { truth: '#e8edfb', cc: '#fb7185', ocv: '#a78bfa', ekf: '#34d399', ekfB: '#fbbf24', speed: '#38bdf8', power: '#34d399' };

  const S = {
    running: true, speed: 60, mode: 'drive', cycle: 'city', amb: 20,
    guess: 0.6, offset: 0.8, vnoise: 5, soh: 1, spread: 0.02, balance: true, bleed: 0.5, soc0: 0.85,
    errTab: 'err',
  };

  let pack;
  let mon; // monitored cell group: the one with the lowest capacity (it limits the pack)
  let sens;
  let cc;
  let ekf;
  let ekfB;
  let speeds = [];
  let tk = 0; // simulated seconds
  let driveIdx = 0;
  let dist = 0;
  let energyWh = 0;
  let lastV = 0;
  let I = 0;
  let P = 0;
  let chargeI = 0;
  let consumption = 170; // Wh/km, rolling
  const H = { t: [], soc: [], cc: [], ocv: [], ekf: [], sig: [], ekfB: [], spd: [], pw: [], vm: [], vhat: [], temp: [] };

  function reset() {
    pack = B.makePack({ soc0: S.soc0, capSpread: S.spread, seed: Math.floor(Math.random() * 1e6) });
    pack.cells.forEach((c) => (c.baseQ = c.p.Q));
    applySoh();
    mon = pack.cells.reduce((a, c) => (c.p.Q < a.p.Q ? c : a), pack.cells[0]);
    rebuildSensors();
    cc = new B.CoulombCounter(S.guess, B.CELL.Q);
    ekf = new B.SocEKF({ soc0: S.guess, T: S.amb });
    ekfB = new B.SocEKF({ soc0: S.guess, bias: true, T: S.amb });
    speeds = B.driveCycle(S.cycle, 4 * 3600, Math.floor(Math.random() * 1e6));
    tk = 0;
    driveIdx = 0;
    dist = 0;
    energyWh = 0;
    lastV = B.packVoltage(pack);
    chargeI = 0;
    Object.keys(H).forEach((k) => (H[k] = []));
    pack.cells.forEach((c) => (c.T = S.amb));
    drawAll();
  }
  function applySoh() {
    if (pack) pack.cells.forEach((c) => (c.p.Q = c.baseQ * S.soh));
  }
  function rebuildSensors() {
    sens = B.makeSensors({ offset: S.offset, noiseV: S.vnoise / 1000, seed: Math.floor(Math.random() * 1e6) });
  }

  /** One simulated second. */
  function step() {
    const veh = { ...B.VEHICLE, aux: 450 + Math.max(0, 15 - S.amb) * 180 };
    let v = 0;
    if (S.mode === 'drive') {
      v = speeds[driveIdx % speeds.length];
      const a = driveIdx ? v - speeds[(driveIdx - 1) % speeds.length] : 0;
      driveIdx++;
      P = B.tractionPower(v, a, veh);
      I = P / Math.max(200, lastV);
    } else if (S.mode === 'charge') {
      // CC at 0.5 C until the highest cell reaches 4.2 V, then CV on that cell
      const vmax = Math.max(...pack.cells.map((c) => c.v));
      if (!chargeI) chargeI = -0.5 * B.CELL.Q;
      if (vmax > 4.195) chargeI = Math.min(0, chargeI + 60 * (vmax - 4.195) + 0.2);
      I = chargeI;
      P = I * lastV;
      if (Math.abs(I) < 0.05 * B.CELL.Q && vmax > 4.19) {
        setMode('rest');
        Lab.toast('Charge complete — constant-voltage phase finished');
      }
    } else {
      I = 0;
      P = 0;
    }
    lastV = B.stepPack(pack, I, 1, S.amb, { balance: S.balance && S.mode !== 'drive', bleedA: S.bleed });
    const Im = sens.current(I);
    const Vm = sens.voltage(mon.v);
    ekf.T = mon.T;
    ekfB.T = mon.T;
    cc.update(Im, 1);
    ekf.update(Im, Vm, 1);
    ekfB.update(Im, Vm, 1);
    const ocvSoc = I === 0 ? B.socFromOcv(Vm) : B.socFromOcv(Vm + B.r0Of(B.CELL, ekf.soc, mon.T) * Im);
    dist += v;
    energyWh += P / 3600;
    if (v > 1) consumption += 0.002 * ((P / v) * (1000 / 3600) - consumption);
    tk++;
    const tm = tk / 60;
    H.t.push(tm);
    H.soc.push(mon.z * 100);
    H.cc.push(cc.z * 100);
    H.ocv.push(ocvSoc * 100);
    H.ekf.push(ekf.soc * 100);
    H.sig.push(ekf.sigma * 100);
    H.ekfB.push(ekfB.soc * 100);
    H.spd.push(v * 3.6);
    H.pw.push(P / 1000);
    H.vm.push(Vm);
    H.vhat.push(Vm - ekf.innov);
    H.temp.push(mon.T);
    if (S.mode === 'drive' && Math.min(...pack.cells.map((c) => c.z)) < 0.02) {
      setMode('rest');
      Lab.toast('Weakest cell is empty — the pack cut off. Switch to Charge.', 4200);
    }
  }

  // ------------------------------------------------------------------ drawing helpers
  /** Decimate history arrays to ≤ maxN points (keeps the plots fast over hours of data). */
  function dec(keys, from = 0, maxN = 1400) {
    const n = H.t.length - from;
    const stride = Math.max(1, Math.ceil(n / maxN));
    const out = {};
    keys.forEach((k) => (out[k] = []));
    for (let i = from; i < H.t.length; i += stride) keys.forEach((k) => out[k].push(H[k][i]));
    return out;
  }
  const socPlot = new Lab.Plot('cv-soc', { pad: { l: 46, r: 14, t: 28, b: 30 }, xLabel: 'time (min)', yLabel: 'SOC (%)', yMin: 0, yMax: 100, legend: 'above' });
  const drivePlot = new Lab.Plot('cv-drive', { pad: { l: 46, r: 14, t: 12, b: 30 }, xLabel: 'time (min) — last 15 min', legend: 'tl' });
  const errPlot = new Lab.Plot('cv-err', { pad: { l: 50, r: 14, t: 12, b: 30 }, xLabel: 'time (min)', zeroLine: true });

  function drawSoc() {
    if (!H.t.length) { socPlot.series = []; socPlot.draw(); return; }
    const d = dec(['t', 'soc', 'cc', 'ocv', 'ekf', 'sig', 'ekfB']);
    socPlot.series = [
      { name: 'EKF ±3σ', color: C.ekf, area: true, alpha: 0.18, noLegend: true, data: { x: d.t, y: d.ekf.map((v, i) => v + 3 * d.sig[i]), lo: d.ekf.map((v, i) => v - 3 * d.sig[i]) } },
      { name: 'voltage lookup', color: C.ocv, width: 1, alpha: 0.55, data: { x: d.t, y: d.ocv } },
      { name: 'coulomb count', color: C.cc, width: 1.8, data: { x: d.t, y: d.cc } },
      { name: 'EKF + bias', color: C.ekfB, width: 1.5, dash: [5, 3], data: { x: d.t, y: d.ekfB } },
      { name: 'EKF', color: C.ekf, width: 2, data: { x: d.t, y: d.ekf } },
      { name: 'true', color: C.truth, width: 1.6, data: { x: d.t, y: d.soc } },
    ];
    socPlot.opts.xMin = 0;
    socPlot.opts.xMax = Math.max(5, H.t[H.t.length - 1]);
    socPlot.draw();
    const n = H.t.length - 1;
    Lab.text('soc-sub', `true ${H.soc[n].toFixed(1)} % · EKF ${H.ekf[n].toFixed(1)} ± ${(3 * H.sig[n]).toFixed(1)} % · coulomb ${H.cc[n].toFixed(1)} %`);
  }
  function drawDrive() {
    const from = Math.max(0, H.t.length - 900);
    const d = dec(['t', 'spd', 'pw'], from, 900);
    drivePlot.series = [
      { name: 'speed (km/h)', color: C.speed, width: 1.8, data: { x: d.t, y: d.spd } },
      { name: 'battery power (kW)', color: C.power, width: 1.4, fill: Lab.alpha(C.power, 0.12), data: { x: d.t, y: d.pw } },
    ];
    const t1 = H.t.length ? H.t[H.t.length - 1] : 0;
    drivePlot.opts.xMin = Math.max(0, t1 - 15);
    drivePlot.opts.xMax = Math.max(15, t1);
    drivePlot.draw();
  }
  function drawErr() {
    if (!H.t.length) { errPlot.series = []; errPlot.draw(); return; }
    if (S.errTab === 'err') {
      const d = dec(['t', 'soc', 'cc', 'ocv', 'ekf', 'sig', 'ekfB']);
      const e = (arr) => arr.map((v, i) => v - d.soc[i]);
      const ek = e(d.ekf);
      errPlot.series = [
        { name: 'EKF ±3σ', color: C.ekf, area: true, alpha: 0.18, data: { x: d.t, y: ek.map((v, i) => v + 3 * d.sig[i]), lo: ek.map((v, i) => v - 3 * d.sig[i]) } },
        { name: 'voltage lookup', color: C.ocv, width: 1, alpha: 0.5, data: { x: d.t, y: e(d.ocv) } },
        { name: 'coulomb count', color: C.cc, width: 1.6, data: { x: d.t, y: e(d.cc) } },
        { name: 'EKF + bias', color: C.ekfB, width: 1.4, dash: [5, 3], data: { x: d.t, y: e(d.ekfB) } },
        { name: 'EKF', color: C.ekf, width: 2, data: { x: d.t, y: ek } },
      ];
      Object.assign(errPlot.opts, { yLabel: 'estimate − true (% SOC)', yMin: null, yMax: null, xMin: 0, xMax: Math.max(5, H.t[H.t.length - 1]), xLabel: 'time (min)', xLog: false });
      // robust y-range: ignore the initialisation transient of the voltage lookup
      const all = [].concat(e(d.cc), ek, e(d.ekfB)).filter(Number.isFinite);
      const lim = Math.max(3, Math.min(40, Math.max(...all.map(Math.abs)) * 1.15));
      errPlot.opts.yMin = -lim;
      errPlot.opts.yMax = lim;
      errPlot.vlines = [];
      errPlot.markers = [];
    } else if (S.errTab === 'volt') {
      const from = Math.max(0, H.t.length - 600);
      const d = dec(['t', 'vm', 'vhat'], from, 600);
      errPlot.series = [
        { name: 'measured', color: '#a9b4d6', width: 1.2, data: { x: d.t, y: d.vm } },
        { name: 'EKF model', color: C.ekf, width: 1.8, data: { x: d.t, y: d.vhat } },
      ];
      Object.assign(errPlot.opts, { yLabel: 'cell voltage (V) — last 10 min', yMin: null, yMax: null, xMin: d.t[0], xMax: d.t[d.t.length - 1] || 1, xLabel: 'time (min)' });
      errPlot.vlines = [];
      errPlot.markers = [];
    } else {
      const xs = [];
      const ys = [];
      for (let k = 0; k <= 100; k++) { xs.push(k); ys.push(B.OCV.f(k / 100)); }
      errPlot.series = [{ name: 'OCV(SOC)', color: '#a9b4d6', width: 2, data: { x: xs, y: ys } }];
      Object.assign(errPlot.opts, { yLabel: 'open-circuit voltage (V)', yMin: 2.95, yMax: 4.25, xMin: 0, xMax: 100, xLabel: 'state of charge (%)' });
      const n = H.t.length - 1;
      errPlot.vlines = [];
      errPlot.markers = [
        { x: H.soc[n], y: B.OCV.f(H.soc[n] / 100), color: C.truth, label: 'true', align: 'right' },
        { x: H.ekf[n], y: B.OCV.f(H.ekf[n] / 100), color: C.ekf, label: 'EKF' },
      ];
    }
    errPlot.series.forEach((s) => (s.noLegend = false));
    errPlot.opts.legend = S.errTab === 'err' ? null : 'tl';
    errPlot.draw();
    if (H.t.length > 60) {
      const from = Math.min(H.t.length - 1, 300);
      const rm = (k) => Math.sqrt(H[k].slice(from).reduce((s, v, i) => s + (v - H.soc[from + i]) ** 2, 0) / Math.max(1, H.t.length - from));
      Lab.text('err-sub', `RMSE after 5 min — coulomb ${rm('cc').toFixed(2)} · voltage ${rm('ocv').toFixed(2)} · EKF ${rm('ekf').toFixed(2)} · EKF+bias ${rm('ekfB').toFixed(2)} (% SOC)`);
    }
  }

  const pv = Lab.canvas('cv-pack', () => drawPack());
  function drawPack() {
    const { ctx, w, h } = pv;
    pv.clear();
    if (!pack) return;
    const cells = pack.cells;
    const zs = cells.map((c) => c.z);
    const zmin = Math.min(...zs);
    const zmax = Math.max(...zs);
    const perRow = 48;
    const pad = { l: 40, r: 12, t: 14, b: 44 };
    const rowH = (h - pad.t - pad.b) / 2 - 8;
    const bw = (w - pad.l - pad.r) / perRow;
    const lo = Math.max(0, zmin - 0.03);
    const hi = Math.min(1, zmax + 0.03);
    ctx.font = `10px ${T.mono}`;
    for (let r = 0; r < 2; r++) {
      const y0 = pad.t + r * (rowH + 16);
      ctx.fillStyle = T.muted;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${(hi * 100).toFixed(0)}%`, pad.l - 6, y0 + 4);
      ctx.fillText(`${(lo * 100).toFixed(0)}%`, pad.l - 6, y0 + rowH - 4);
      for (let k = 0; k < perRow; k++) {
        const i = r * perRow + k;
        const c = cells[i];
        const x = pad.l + k * bw;
        if (k % 12 === 0 && k) { ctx.fillStyle = T.border2; ctx.fillRect(x - 1, y0, 1, rowH); }
        const f = (c.z - lo) / (hi - lo || 1);
        const hh = Math.max(1, f * rowH);
        const temp = Math.max(0, Math.min(1, (c.T - 15) / 30));
        ctx.fillStyle = Lab.cmap('viridis', 0.25 + 0.7 * f);
        ctx.fillRect(x + 1, y0 + rowH - hh, bw - 2, hh);
        if (c === mon) { ctx.strokeStyle = '#e8edfb'; ctx.lineWidth = 1.5; ctx.strokeRect(x + 0.5, y0, bw - 1, rowH); }
        if (pack.bleed[i] > 0) { ctx.fillStyle = '#fbbf24'; ctx.fillRect(x + 1, y0 - 5, bw - 2, 3); }
        ctx.fillStyle = Lab.alpha(temp > 0.6 ? '#fb7185' : '#38bdf8', 0.35 + 0.5 * Math.abs(temp - 0.33));
        ctx.fillRect(x + 1, y0 + rowH + 2, bw - 2, 3);
      }
    }
    const e = B.packEnergy(pack);
    ctx.font = `11px ${T.sans}`;
    ctx.fillStyle = T.text2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('bar = SOC · outlined = weakest (monitored) · amber = bleeding · strip = temp', pad.l, h - 22);
    ctx.fillStyle = T.text;
    ctx.font = `600 11.5px ${T.mono}`;
    ctx.fillText(`spread ${((zmax - zmin) * 100).toFixed(1)} % · stranded ${(e.strandedWh / 1000).toFixed(2)} kWh · bled ${pack.balancedAh.toFixed(1)} Ah`, pad.l, h - 6);
    Lab.text('pack-sub', `${(lastV).toFixed(0)} V · usable ${(e.usableWh / 1000).toFixed(1)} of ${(e.totalWh / 1000).toFixed(1)} kWh`);
  }
  function updateTiles() {
    const n = H.t.length - 1;
    const v = n >= 0 ? H.spd[n] : 0;
    Lab.$('#st-speed').innerHTML = `${v.toFixed(0)}<span class="u">km/h</span>`;
    Lab.$('#st-power').innerHTML = `${(P / 1000).toFixed(1)}<span class="u">kW</span>`;
    const usable = pack.cells.length * B.CELL.Q * 3.7 * (ekf ? ekf.soc : 0);
    const range = S.mode === 'charge' ? NaN : usable / Math.max(80, consumption);
    Lab.$('#st-range').innerHTML = Number.isFinite(range) ? `${Math.max(0, range).toFixed(0)}<span class="u">km</span>` : '—';
    Lab.$('#st-pack').innerHTML = `${lastV.toFixed(0)}<span class="u">V</span> ${I.toFixed(0)}<span class="u">A</span>`;
    const tc = Lab.$('#st-temp');
    tc.innerHTML = `${mon.T.toFixed(1)}<span class="u">°C</span>`;
    tc.parentElement.className = 'stat ' + (mon.T > 45 ? 'bad' : mon.T > 38 ? 'warn' : '');
    Lab.$('#st-trip').innerHTML = `${(dist / 1000).toFixed(1)}<span class="u">km</span> ${(energyWh / 1000).toFixed(1)}<span class="u">kWh</span>`;
    const hh = Math.floor(tk / 3600);
    const mm = Math.floor((tk % 3600) / 60);
    Lab.text('drive-sub', `${S.mode === 'drive' ? B.CYCLES[S.cycle].name : S.mode === 'charge' ? 'Charging (CC-CV, 0.5 C)' : 'Parked'} · t = ${hh}:${String(mm).padStart(2, '0')} h · ${consumption.toFixed(0)} Wh/km`);
  }
  function drawAll() {
    drawSoc();
    drawDrive();
    drawErr();
    drawPack();
    updateTiles();
  }

  // ------------------------------------------------------------------ controls
  const playBtn = Lab.$('#btn-play');
  function setRunning(on) {
    S.running = on;
    playBtn.innerHTML = on ? `${Lab.icon('pause')}<span>Pause</span>` : `${Lab.icon('play')}<span>Run</span>`;
  }
  playBtn.addEventListener('click', () => setRunning(!S.running));
  Lab.$('#btn-reset').addEventListener('click', reset);
  const speedSeg = Lab.seg('seg-speed', (v) => (S.speed = +v));
  const modeSeg = Lab.seg('seg-mode', (v) => setMode(v));
  function setMode(m) {
    S.mode = m;
    modeSeg.set(m);
    chargeI = 0;
    Lab.$('#f-cycle').classList.toggle('hidden', m !== 'drive');
  }
  Lab.seg('seg-cycle', (v) => { S.cycle = v; speeds = B.driveCycle(v, 4 * 3600, Math.floor(Math.random() * 1e6)); driveIdx = 0; });
  const errSeg = Lab.seg('seg-errtab', (v) => { S.errTab = v; drawErr(); });
  const ui = {};
  ui.amb = Lab.range('sl-amb', { format: (v) => `${v} °C`, onInput: (v) => (S.amb = v) });
  ui.guess = Lab.range('sl-guess', { format: (v) => `${Math.round(v * 100)} %`, onInput: (v) => (S.guess = v), onChange: () => { cc.z = S.guess; ekf.x[0] = S.guess; ekfB.x[0] = S.guess; ekf.P[0][0] = 0.04; ekfB.P[0][0] = 0.04; Lab.toast('BMS estimators re-initialised'); } });
  ui.offset = Lab.range('sl-offset', { format: (v) => `${v.toFixed(1)} A`, onInput: (v) => { S.offset = v; rebuildSensors(); } });
  ui.vnoise = Lab.range('sl-vnoise', { format: (v) => `${v} mV`, onInput: (v) => { S.vnoise = v; rebuildSensors(); } });
  ui.soh = Lab.range('sl-soh', { format: (v) => `${Math.round(v * 100)} %`, onInput: (v) => { S.soh = v; applySoh(); } });
  ui.spread = Lab.range('sl-spread', { format: (v) => `±${(v * 100).toFixed(1)} %`, onInput: (v) => (S.spread = v) });
  ui.bleed = Lab.range('sl-bleed', { format: (v) => `${v.toFixed(2)} A`, onInput: (v) => (S.bleed = v) });
  ui.soc0 = Lab.range('sl-soc0', { format: (v) => `${Math.round(v * 100)} %`, onInput: (v) => (S.soc0 = v) });
  Lab.toggle('tg-balance', (v) => (S.balance = v));
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); setRunning(!S.running); }
  });

  let acc = 0;
  let frame = 0;
  Lab.loop((dt) => {
    frame++;
    if (S.running) {
      acc += dt * S.speed;
      let n = 0;
      while (acc >= 1 && n < 3000) { step(); acc -= 1; n++; }
    }
    if (frame % 3 === 0) drawAll();
  });

  reset();
  window.VoltWise = {
    state: S,
    reset,
    mode: setMode,
    run: setRunning,
    speed: (v) => speedSeg.set(String(v), true),
    tab: (t) => errSeg.set(t, true),
    /** Advance the simulation headlessly by `seconds`. */
    advance(seconds) { for (let i = 0; i < seconds; i++) step(); drawAll(); },
    set(o) { Object.entries(o).forEach(([k, v]) => { if (ui[k]) ui[k].set(v, true); else S[k] = v; }); },
    get pack() { return pack; },
    get estimates() { return { true: mon.z, cc: cc.z, ekf: ekf.soc, ekfB: ekfB.soc, bias: ekfB.x[2] }; },
  };
})();
