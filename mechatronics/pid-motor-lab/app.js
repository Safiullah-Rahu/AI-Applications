/* MotorLab — UI, real-time simulation loop, auto-tuners and rendering. */
(function () {
  'use strict';
  const { DCMotor, PID, stepMetrics, frequencyResponse, closedLoopPoles, relayRule, relayUltimateGain, fopdtFit, simcPI, DEFAULT_PARAMS } = window.MotorCore;
  const M = window.LabMath;
  Lab.boot();
  const T = Lab.theme();
  const DEG = 180 / Math.PI;
  const RPM = 60 / (2 * Math.PI);
  const rng = M.makeRng(2024);

  // ------------------------------------------------------------------ configuration
  const PRESETS = {
    position: {
      sluggish: { kp: 10, ki: 0, kd: 3 },
      balanced: { kp: 120, ki: 400, kd: 7 },
      aggressive: { kp: 80, ki: 40, kd: 1.5 },
      oscillatory: { kp: 150, ki: 300, kd: 0.2 },
    },
    velocity: {
      sluggish: { kp: 0.3, ki: 1, kd: 0 },
      balanced: { kp: 1.5, ki: 10, kd: 0 },
      aggressive: { kp: 0.4, ki: 25, kd: 0 },
      oscillatory: { kp: 0.1, ki: 80, kd: 0 },
    },
  };
  const RANGES = {
    position: { kp: [0.5, 1000], ki: [0.5, 5000], kd: [0.01, 50] },
    velocity: { kp: [0.01, 30], ki: [0.05, 500], kd: [1e-4, 0.5] },
  };
  const UNITS = {
    position: { kp: 'V/rad', ki: 'V/(rad·s)', kd: 'V·s/rad' },
    velocity: { kp: 'V·s/rad', ki: 'V/rad', kd: 'V·s²/rad' },
  };
  const TUNE_METHODS = {
    position: [
      ['bump-pp', 'Bump test → pole placement (ζ = 0.8)'],
      ['relay-tl', 'Relay test → Tyreus–Luyben'],
      ['relay-zn', 'Relay test → Ziegler–Nichols'],
      ['relay-no', 'Relay test → Z–N “no overshoot”'],
      ['relay-pessen', 'Relay test → Pessen integral rule'],
    ],
    velocity: [
      ['bump-balanced', 'Bump test → SIMC PI (balanced)'],
      ['bump-fast', 'Bump test → SIMC PI (fast)'],
      ['bump-smooth', 'Bump test → SIMC PI (smooth)'],
    ],
  };
  const PIN_COLORS = ['#60a5fa', '#34d399', '#f472b6', '#c084fc'];
  const SPEED_FULL_SCALE = 450; // rpm, tachometer range
  const H = 5e-5; // physics step: 20 kHz RK4
  const LOG_EVERY = 40; // log every 2 ms
  const LOG_DT = H * LOG_EVERY;
  const WINDOW = 5; // seconds shown on live scopes
  const CAP = Math.ceil((WINDOW * 1.25) / LOG_DT);

  const S = {
    mode: 'position',
    profile: 'square',
    amp: { position: 90, velocity: 250 },
    period: 2.5,
    gains: { position: { ...PRESETS.position.balanced }, velocity: { ...PRESETS.velocity.balanced } },
    fc: 40,
    rate: 1000,
    antiWindup: true,
    dOnMeas: true,
    inertiaExp: 0,
    coulomb: 0.02,
    vmax: 24,
    cpr: 16384,
    noiseDeg: 0,
    loadTorque: 1.5,
    loadOn: false,
    speed: 0.5,
    running: true,
    manual: { position: 0, velocity: 150 },
  };

  // ------------------------------------------------------------------ simulation state
  const motor = new DCMotor(plantParams());
  const pid = new PID();
  let tick = 0; // physics ticks since reset
  let simT = 0;
  let u = 0;
  let ref = 0;
  let prevRef = null;
  let kickUntil = -1;
  let tuner = null;
  const meas = { th: 0, w: 0, thPrev: null };
  const VEL_FILTER_TAU = 0.004;

  const log = {};
  ['r', 'y', 'u', 'i', 'P', 'I', 'D', 'U'].forEach((k) => (log[k] = new Lab.RingSeries(CAP)));

  let capture = null; // in-progress step capture
  let lastCapture = null;
  const pins = [];
  let analysis = null; // {fr, poles}
  let analysisDirty = true;

  function plantParams() {
    return {
      ...DEFAULT_PARAMS,
      J: DEFAULT_PARAMS.J * Math.pow(2, S.inertiaExp),
      tauC: S.coulomb,
      Vmax: S.vmax,
    };
  }
  function applyPlant() {
    Object.assign(motor.p, plantParams());
    analysisDirty = true;
  }
  function applyPid() {
    const g = S.gains[S.mode];
    pid.kp = g.kp;
    pid.ki = g.ki;
    pid.kd = g.kd;
    pid.tf = 1 / (2 * Math.PI * S.fc);
    pid.umax = S.vmax;
    pid.antiWindup = S.antiWindup;
    pid.dOnMeas = S.dOnMeas;
    analysisDirty = true;
  }

  function resetSim() {
    motor.reset(0, 0);
    pid.reset();
    tick = 0;
    simT = 0;
    u = 0;
    ref = 0;
    prevRef = null;
    kickUntil = -1;
    meas.th = 0;
    meas.w = 0;
    meas.thPrev = null;
    Object.values(log).forEach((s) => s.clear());
    capture = null;
    lastCapture = null;
    if (tuner) endTuner(null);
    updateMetricsDom(true);
  }

  // ------------------------------------------------------------------ setpoint generation
  function shape(ph, profile) {
    // canonical waveform in [-1, 1] for phase ph ∈ [0, 1)
    if (profile === 'square') return ph < 0.5 ? 1 : -1;
    if (profile === 'sine') return Math.sin(2 * Math.PI * ph);
    // trapezoid: ramp up (20 %), hold, ramp down (20 %), hold
    if (ph < 0.2) return -1 + (2 * ph) / 0.2;
    if (ph < 0.5) return 1;
    if (ph < 0.7) return 1 - (2 * (ph - 0.5)) / 0.2;
    return -1;
  }
  function setpoint(time) {
    if (S.profile === 'manual') return S.mode === 'position' ? S.manual.position / DEG : S.manual.velocity / RPM;
    const ph = (((time % S.period) + S.period) % S.period) / S.period;
    const f = shape(ph, S.profile);
    if (S.mode === 'position') return ((S.amp.position / 2) * f) / DEG;
    const A = S.amp.velocity / RPM;
    return S.profile === 'square' ? (A * (1 + f)) / 2 : A * f;
  }

  // ------------------------------------------------------------------ sensing & control
  function sense(Ts) {
    const q = (2 * Math.PI) / S.cpr;
    let th = Math.round(motor.th / q) * q;
    if (S.noiseDeg > 0) th += rng.gauss(0, S.noiseDeg / DEG);
    if (meas.thPrev === null) meas.w = motor.w;
    else {
      const raw = (th - meas.thPrev) / Ts;
      const a = Math.exp(-Ts / VEL_FILTER_TAU);
      meas.w = a * meas.w + (1 - a) * raw;
    }
    meas.thPrev = th;
    meas.th = th;
  }

  function controlStep(Ts) {
    sense(Ts);
    const y = S.mode === 'position' ? meas.th : meas.w;
    if (tuner) {
      ref = tuner.ref;
      u = tuner.control(y, Ts);
      prevRef = ref;
      return;
    }
    ref = setpoint(simT);
    detectStep(ref, y);
    u = pid.update(ref, y, Ts);
  }

  function detectStep(r, y) {
    const thr = S.mode === 'position' ? 0.5 / DEG : 2 / RPM;
    if (prevRef !== null && Math.abs(r - prevRef) > thr && (S.profile === 'square' || S.profile === 'manual')) {
      if (capture && capture.ts.length > 25) lastCapture = capture;
      capture = { t0: simT, y0: y, r0: prevRef, r1: r, ts: [], ys: [], iPk: 0, gains: { ...S.gains[S.mode] }, mode: S.mode };
    }
    prevRef = r;
  }

  function loadTorque(time) {
    return (S.loadOn ? S.loadTorque : 0) + (time < kickUntil ? 4 : 0);
  }

  function logSample() {
    const conv = S.mode === 'position' ? DEG : RPM;
    const y = S.mode === 'position' ? meas.th : meas.w;
    log.r.push(simT, ref * conv);
    log.y.push(simT, y * conv);
    log.u.push(simT, u);
    log.i.push(simT, motor.i);
    const l = pid.last;
    log.P.push(simT, tuner ? NaN : l.P);
    log.I.push(simT, tuner ? NaN : l.I);
    log.D.push(simT, tuner ? NaN : l.D);
    log.U.push(simT, tuner ? NaN : l.u);
    if (capture) {
      const dt = simT - capture.t0;
      const maxDur = Math.min(4, S.profile === 'square' ? S.period / 2 : 4);
      if (dt <= maxDur + 1e-9) {
        capture.ts.push(dt);
        capture.ys.push(y);
        capture.iPk = Math.max(capture.iPk, Math.abs(motor.i));
      } else if (!capture.done) {
        capture.done = true;
        lastCapture = capture;
      }
    }
  }

  function advance(dtSim) {
    const ctrlEvery = Math.max(1, Math.round(1 / S.rate / H));
    const Ts = ctrlEvery * H;
    const steps = Math.round(dtSim / H);
    for (let k = 0; k < steps; k++) {
      if (tick % ctrlEvery === 0) controlStep(Ts);
      motor.step(u, loadTorque(simT), H);
      tick++;
      simT = tick * H;
      if (tick % LOG_EVERY === 0) logSample();
    }
    if (tuner) tuner.check();
  }

  // ------------------------------------------------------------------ auto-tuners
  function startTuner(method) {
    if (tuner) return;
    const [kind, variant] = method.split(/-(.+)/);
    const y0 = S.mode === 'position' ? meas.th : meas.w;
    if (kind === 'relay') tuner = makeRelayTuner(variant, y0);
    else tuner = makeBumpTuner(variant);
    tuner.t0 = simT;
    capture = null;
    setTuningUi(true, tuner.label());
    Lab.$('#btn-tune').disabled = true;
  }

  function makeRelayTuner(rule, y0) {
    const d = 0.35 * S.vmax;
    const eps = Math.max((2 * 2 * Math.PI) / S.cpr, (3 * S.noiseDeg) / DEG, 0.15 / DEG);
    const cycles = 10;
    const tn = {
      kind: 'relay', ref: y0, d, eps, out: d, switches: [], amps: [], yMax: -Infinity, yMin: Infinity,
      label: () => `Relay test · cycle ${Math.max(0, tn.switches.length - 1)}/${cycles}`,
      control(y) {
        const e = tn.ref - y;
        let nu = tn.out;
        if (e > eps) nu = d;
        else if (e < -eps) nu = -d;
        if (nu > 0 && tn.out < 0) {
          tn.switches.push(simT);
          if (tn.switches.length > 1) tn.amps.push((tn.yMax - tn.yMin) / 2);
          tn.yMax = -Infinity;
          tn.yMin = Infinity;
        }
        tn.out = nu;
        tn.yMax = Math.max(tn.yMax, y);
        tn.yMin = Math.min(tn.yMin, y);
        return nu;
      },
      check() {
        setTuningUi(true, tn.label());
        if (tn.switches.length >= cycles + 1) {
          const sw = tn.switches.slice(-7);
          let Tu = 0;
          for (let k = 1; k < sw.length; k++) Tu += sw[k] - sw[k - 1];
          Tu /= sw.length - 1;
          const a = tn.amps.slice(-6).reduce((s, v) => s + v, 0) / Math.min(6, tn.amps.length);
          const Ku = relayUltimateGain(d, a, eps);
          const g = relayRule(Ku, Tu, rule);
          endTuner({
            gains: g,
            html: `Relay ±${d.toFixed(1)} V, hysteresis ${(eps * DEG).toFixed(2)}° → limit cycle a = <b>${(a * DEG).toFixed(2)}°</b>, T<sub>u</sub> = <b>${(Tu * 1000).toFixed(0)} ms</b><br>` +
              `Ultimate gain K<sub>u</sub> = 4d/(π√(a²−ε²)) = <b>${Ku.toFixed(1)} V/rad</b><br>${g.name}: ` +
              `K<sub>p</sub> <b>${fmtG(g.kp)}</b> · K<sub>i</sub> <b>${fmtG(g.ki)}</b> · K<sub>d</sub> <b>${fmtG(g.kd)}</b>`,
          });
        } else if (simT - tn.t0 > 10) endTuner({ error: 'No stable limit cycle detected — try more supply voltage or less friction.' });
      },
    };
    return tn;
  }

  function makeBumpTuner(variant) {
    const du = 0.25 * S.vmax;
    const tn = {
      kind: 'bump', phase: 'coast', ref: S.mode === 'position' ? meas.th : 0, du, ts: [], ws: [], tStep: 0,
      label: () => (tn.phase === 'coast' ? 'Bump test · waiting for standstill' : `Bump test · open-loop step +${du.toFixed(1)} V`),
      control(y) {
        if (tn.phase === 'coast') return 0;
        tn.ts.push(simT - tn.tStep);
        tn.ws.push(meas.w);
        return du;
      },
      check() {
        setTuningUi(true, tn.label());
        if (tn.phase === 'coast') {
          tn.ref = S.mode === 'position' ? meas.th : 0;
          if ((Math.abs(motor.w) < 0.05 && simT - tn.t0 > 0.15) || simT - tn.t0 > 4) {
            tn.phase = 'step';
            tn.tStep = simT;
          }
          return;
        }
        const n = tn.ws.length;
        const elapsed = simT - tn.tStep;
        if (elapsed < 0.3 || n < 20) return;
        // steady when the last 25 % of the record changed by < 0.3 %
        const k0 = Math.floor(n * 0.75);
        const settled = Math.abs(tn.ws[n - 1] - tn.ws[k0]) < 0.003 * Math.abs(tn.ws[n - 1]) && elapsed > 1.0;
        if (settled || elapsed > 6) {
          const fit = fopdtFit(tn.ts, tn.ws, du);
          const Ts = 1 / S.rate;
          let g;
          let rule;
          if (S.mode === 'velocity') {
            const tc = variant === 'fast' ? Math.max(fit.theta, fit.tau / 10) : variant === 'smooth' ? fit.tau / 1.5 : fit.tau / 4;
            g = simcPI(fit, tc, Ts);
            rule = `SIMC PI with τ<sub>c</sub> = ${(tc * 1000).toFixed(0)} ms`;
          } else {
            const zeta = 0.8;
            const wn = 7 / fit.tau;
            const kp = (fit.tau * wn * wn) / fit.K;
            const kd = Math.max(0, (2 * zeta * wn * fit.tau - 1) / fit.K);
            g = { kp, kd, ki: (kp * wn) / 25 };
            rule = `Pole placement ζ = ${zeta}, ω<sub>n</sub> = ${wn.toFixed(1)} rad/s (+ slow integral)`;
            // re-home the multi-turn angle so the loop does not unwind every revolution of the test
            motor.th = M.wrapAngle(motor.th);
            meas.thPrev = null;
          }
          endTuner({
            gains: g,
            html: `FOPDT fit of ω/V: K = <b>${fit.K.toFixed(3)}</b> rad/s/V, τ = <b>${(fit.tau * 1000).toFixed(0)} ms</b>, θ = <b>${(fit.theta * 1000).toFixed(1)} ms</b><br>` +
              `${rule}<br>K<sub>p</sub> <b>${fmtG(g.kp)}</b> · K<sub>i</sub> <b>${fmtG(g.ki)}</b> · K<sub>d</sub> <b>${fmtG(g.kd)}</b>`,
          });
        }
      },
    };
    return tn;
  }

  function endTuner(result) {
    tuner = null;
    setTuningUi(false);
    Lab.$('#btn-tune').disabled = false;
    pid.reset();
    prevRef = null;
    if (!result) return;
    const box = Lab.$('#tune-result');
    box.classList.add('on');
    if (result.error) {
      box.innerHTML = `<span style="color:var(--bad)">${result.error}</span>`;
      Lab.toast('Auto-tune failed');
      return;
    }
    box.innerHTML = result.html;
    setGains(result.gains);
    Lab.toast('Auto-tune complete — new gains applied');
  }

  function setTuningUi(on, text) {
    Lab.$('#tuning-banner').classList.toggle('on', on);
    if (text) Lab.text('tuning-text', text);
  }

  // ------------------------------------------------------------------ UI bindings
  const fmtG = (v) => (v === 0 ? '0' : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toExponential(1));

  function logSlider(id, key) {
    const toGain = (s) => {
      if (s <= 0) return 0;
      const [lo, hi] = RANGES[S.mode][key];
      return lo * Math.pow(hi / lo, (s - 1) / 999);
    };
    const toSlider = (g) => {
      if (g <= 0) return 0;
      const [lo, hi] = RANGES[S.mode][key];
      return M.clamp(1 + (999 * Math.log(g / lo)) / Math.log(hi / lo), 1, 1000);
    };
    const r = Lab.range(id, {
      format: () => fmtG(S.gains[S.mode][key]),
      onInput: (s) => {
        S.gains[S.mode][key] = toGain(s);
        r.refresh();
        applyPid();
        markPresets();
      },
    });
    return { r, sync: () => r.set(toSlider(S.gains[S.mode][key])) };
  }
  const sliders = { kp: logSlider('sl-kp', 'kp'), ki: logSlider('sl-ki', 'ki'), kd: logSlider('sl-kd', 'kd') };

  function setGains(g) {
    const [cur] = [S.gains[S.mode]];
    for (const k of ['kp', 'ki', 'kd']) {
      const [lo, hi] = RANGES[S.mode][k];
      cur[k] = g[k] <= 0 ? 0 : M.clamp(g[k], lo, hi);
    }
    syncGainSliders();
    applyPid();
    markPresets();
  }
  function syncGainSliders() {
    Object.values(sliders).forEach((s) => s.sync());
    const U = UNITS[S.mode];
    Lab.text('gain-units', `${U.kp} · ${U.ki} · ${U.kd}`);
  }
  function markPresets() {
    const g = S.gains[S.mode];
    Lab.$$('#presets button').forEach((b) => {
      const p = PRESETS[S.mode][b.dataset.preset];
      const same = ['kp', 'ki', 'kd'].every((k) => Math.abs(p[k] - g[k]) <= 1e-9 + 0.01 * Math.abs(p[k]));
      b.classList.toggle('active', same);
    });
  }
  Lab.$$('#presets button').forEach((b) =>
    b.addEventListener('click', () => {
      setGains(PRESETS[S.mode][b.dataset.preset]);
      pid.reset();
    })
  );

  const speedSeg = Lab.seg('seg-speed', (v) => (S.speed = parseFloat(v)));
  S.speed = parseFloat(speedSeg.value);

  const ampSlider = Lab.range('sl-amp', {
    format: (v) => (S.mode === 'position' ? `${v}°` : `${v} rpm`),
    onInput: (v) => (S.amp[S.mode] = v),
  });
  Lab.range('sl-period', { format: (v) => `${v.toFixed(2)} s`, onInput: (v) => (S.period = v) });

  const modeSeg = Lab.seg('seg-mode', (v) => setMode(v));
  function setMode(mode) {
    if (tuner) endTuner(null);
    S.mode = mode;
    const pos = mode === 'position';
    Lab.text('lbl-amp', pos ? 'Step size' : 'Speed amplitude');
    ampSlider.el.min = pos ? 10 : 50;
    ampSlider.el.max = pos ? 180 : 400;
    ampSlider.el.step = pos ? 5 : 10;
    ampSlider.set(S.amp[mode]);
    fillTuneMethods();
    syncGainSliders();
    applyPid();
    markPresets();
    pid.reset();
    prevRef = null;
    capture = null;
    lastCapture = null;
    pins.length = 0;
    Object.values(log).forEach((s) => s.clear());
    updateProfileHelp();
    respPlot.opts.yLabel = pos ? 'angle (°)' : 'speed (rpm)';
    respPlot.opts.yMinSpan = pos ? 20 : 60;
  }

  const profileSeg = Lab.seg('seg-profile', (v) => {
    if (v === 'manual') S.manual[S.mode] = S.mode === 'position' ? Math.round((meas.th * DEG) / 5) * 5 : S.manual.velocity;
    S.profile = v;
    updateProfileHelp();
  });
  function updateProfileHelp() {
    const help = {
      manual: S.mode === 'position' ? 'Click the dial to command a new angle. <kbd>←</kbd> <kbd>→</kbd> nudge ±15°.' : 'Click the dial: the clicked angle maps to a speed command (±450 rpm).',
      square: 'Square wave — every edge is captured as a step response.',
      sine: 'Sinusoidal tracking — watch the phase lag grow with frequency.',
      ramp: 'Trapezoidal moves with constant-velocity ramps, like a CNC axis.',
    };
    Lab.$('#profile-help').innerHTML = help[S.profile];
  }

  Lab.range('sl-fc', { format: (v) => `${v} Hz`, onInput: (v) => { S.fc = v; applyPid(); } });
  Lab.seg('seg-rate', (v) => { S.rate = parseFloat(v); pid.reset(); analysisDirty = true; });
  Lab.toggle('tg-aw', (v) => { S.antiWindup = v; applyPid(); });
  Lab.toggle('tg-dom', (v) => { S.dOnMeas = v; applyPid(); });

  Lab.range('sl-inertia', { format: (v) => `${(DEFAULT_PARAMS.J * Math.pow(2, v)).toFixed(3)} kg·m²`, onInput: (v) => { S.inertiaExp = v; applyPlant(); } });
  Lab.range('sl-coulomb', { format: (v) => `${v.toFixed(2)} N·m`, onInput: (v) => { S.coulomb = v; applyPlant(); } });
  Lab.range('sl-vmax', { format: (v) => `${v} V`, onInput: (v) => { S.vmax = v; applyPlant(); applyPid(); } });
  Lab.select('sel-cpr', (v) => { S.cpr = parseInt(v, 10); Lab.text('servo-sub', `Output shaft · 20:1 gearbox · ${S.cpr} CPR encoder`); });
  Lab.range('sl-noise', { format: (v) => `${v.toFixed(2)}°`, onInput: (v) => (S.noiseDeg = v) });
  Lab.range('sl-load', { format: (v) => `${v.toFixed(1)} N·m`, onInput: (v) => (S.loadTorque = v) });
  Lab.toggle('tg-load', (v) => (S.loadOn = v));
  Lab.$('#btn-kick').addEventListener('click', () => (kickUntil = simT + 0.05));

  function fillTuneMethods() {
    const sel = Lab.$('#sel-tune');
    sel.innerHTML = TUNE_METHODS[S.mode].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  }
  Lab.$('#btn-tune').addEventListener('click', () => startTuner(Lab.$('#sel-tune').value));

  const playBtn = Lab.$('#btn-play');
  function setRunning(on) {
    S.running = on;
    playBtn.innerHTML = on ? `${Lab.icon('pause')}<span>Pause</span>` : `${Lab.icon('play')}<span>Run</span>`;
  }
  playBtn.addEventListener('click', () => setRunning(!S.running));
  Lab.$('#btn-reset').addEventListener('click', resetSim);

  const viewSeg = Lab.seg('seg-view');
  Lab.$('#btn-pin').addEventListener('click', () => {
    const c = capture && capture.ts.length > 10 ? capture : lastCapture;
    if (!c) return Lab.toast('No step captured yet — use a square or manual profile.');
    const d = c.r1 - c.y0;
    pins.push({
      ts: c.ts.slice(),
      yn: c.ys.map((y) => (y - c.y0) / d),
      color: PIN_COLORS[pins.length % PIN_COLORS.length],
      name: `Kp ${fmtG(c.gains.kp)} · Ki ${fmtG(c.gains.ki)} · Kd ${fmtG(c.gains.kd)}`,
    });
    if (pins.length > 4) pins.shift();
    viewSeg.set('capture');
    Lab.toast('Step response pinned — change gains and compare');
  });
  Lab.$('#btn-clear-pins').addEventListener('click', () => (pins.length = 0));

  const tabSeg = Lab.seg('seg-tab', (v) => {
    Lab.$$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.tab === v));
    updateLegend();
  });
  function updateLegend() {
    const items = {
      drive: [['#fbbf24', 'voltage u'], ['#38bdf8', 'current i']],
      terms: [['#fbbf24', 'P'], ['#34d399', 'I'], ['#a78bfa', 'D'], ['#e8edfb', 'u (unclipped)']],
      bode: [['#fbbf24', 'loop L = C·P'], ['#6b779f', 'plant P'], ['#38bdf8', 'closed loop T']],
      poles: [['#fbbf24', 'closed-loop poles'], ['#fb7185', 'unstable region']],
    }[tabSeg.value];
    Lab.$('#tab-legend').innerHTML = items.map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('');
  }

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); setRunning(!S.running); }
    else if (e.key === 'r' || e.key === 'R') resetSim();
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && S.mode === 'position') {
      e.preventDefault();
      if (S.profile !== 'manual') { S.manual.position = Math.round((meas.th * DEG) / 5) * 5; profileSeg.set('manual'); S.profile = 'manual'; updateProfileHelp(); }
      S.manual.position += e.key === 'ArrowRight' ? 15 : -15;
    } else if (['1', '2', '3', '4'].includes(e.key)) setGains(PRESETS[S.mode][['sluggish', 'balanced', 'aggressive', 'oscillatory'][+e.key - 1]]);
  });

  // ------------------------------------------------------------------ canvases & plots
  const dial = Lab.canvas('cv-dial');
  let lastDrawTh = 0;
  dial.canvas.addEventListener('pointerdown', (e) => {
    const p = dial.pointer(e);
    const cx = dial.w / 2;
    const cy = dial.h / 2;
    const ang = Math.atan2(p.x - cx, -(p.y - cy)); // 0 at top, clockwise positive
    if (S.mode === 'position') {
      // choose the equivalent angle closest to the current shaft angle (multi-turn aware)
      const cur = meas.th;
      let a = ang;
      a += Math.round((cur - a) / (2 * Math.PI)) * 2 * Math.PI;
      S.manual.position = Math.round(a * DEG);
    } else {
      S.manual.velocity = Math.round(((ang * DEG) / 150) * SPEED_FULL_SCALE / 5) * 5;
      S.manual.velocity = M.clamp(S.manual.velocity, -SPEED_FULL_SCALE, SPEED_FULL_SCALE);
    }
    if (S.profile !== 'manual') { profileSeg.set('manual'); S.profile = 'manual'; updateProfileHelp(); }
  });

  const respPlot = new Lab.Plot('cv-resp', { yLabel: 'angle (°)', xLabel: 'time (s)', legend: 'above', yMinSpan: 20, pad: { t: 26 } });
  const uPlot = new Lab.Plot('cv-u', { yLabel: 'voltage (V)', pad: { b: 20 } });
  const iPlot = new Lab.Plot('cv-i', { yLabel: 'current (A)', xLabel: 'time (s)', yMinSpan: 1 });
  const termsPlot = new Lab.Plot('cv-terms', { yLabel: 'contribution (V)', xLabel: 'time (s)', yMinSpan: 2 });
  const magPlot = new Lab.Plot('cv-mag', { xLog: true, yLabel: 'magnitude (dB)', pad: { b: 20 }, xMin: 0.1, xMax: 1e4, yPad: 0.06 });
  const phPlot = new Lab.Plot('cv-ph', { xLog: true, yLabel: 'phase (°)', xLabel: 'ω (rad/s)', xMin: 0.1, xMax: 1e4, yMin: -360, yMax: 0 });
  const poles = Lab.canvas('cv-poles', () => drawPoles());

  function drawLive() {
    const t1 = Math.max(simT, WINDOW);
    const common = { xMin: t1 - WINDOW, xMax: t1 };
    const convName = S.mode === 'position' ? 'angle' : 'speed';
    if (viewSeg.value === 'live') {
      Object.assign(respPlot.opts, common, { yMin: null, yMax: null, xLabel: 'time (s)', legend: 'above' });
      respPlot.opts.yLabel = S.mode === 'position' ? 'angle (°)' : 'speed (rpm)';
      respPlot.series = [
        { name: 'setpoint r(t)', color: '#cbd5f5', data: log.r, width: 1.4, dash: [6, 4], alpha: 0.85 },
        { name: `measured ${convName} y(t)`, color: T.accent, data: log.y, width: 2.2 },
      ];
      respPlot.bands = [];
      respPlot.hlines = [];
      respPlot.vlines = [];
      respPlot.markers = [];
      respPlot.draw();
    } else drawCapture();

    if (tabSeg.value === 'drive') {
      Object.assign(uPlot.opts, common, { yMin: -S.vmax * 1.2, yMax: S.vmax * 1.2 });
      uPlot.bands = [
        { y0: S.vmax, y1: S.vmax * 1.3, color: 'rgba(251,113,133,0.10)' },
        { y0: -S.vmax * 1.3, y1: -S.vmax, color: 'rgba(251,113,133,0.10)' },
      ];
      uPlot.hlines = [
        { y: S.vmax, color: 'rgba(251,113,133,0.7)', label: `+Vmax ${S.vmax} V` },
        { y: -S.vmax, color: 'rgba(251,113,133,0.7)', label: `−Vmax` },
      ];
      uPlot.series = [{ name: 'u', color: '#fbbf24', data: log.u, width: 1.6, fill: 'rgba(251,191,36,0.08)' }];
      uPlot.draw();
      Object.assign(iPlot.opts, common);
      iPlot.series = [{ name: 'i', color: '#38bdf8', data: log.i, width: 1.6, fill: 'rgba(56,189,248,0.08)' }];
      iPlot.draw();
    } else if (tabSeg.value === 'terms') {
      // unclipped terms can reach hundreds of volts on a step: show ±2.5·Vmax and let the rest clip
      Object.assign(termsPlot.opts, common, { legend: null, yMin: -2.5 * S.vmax, yMax: 2.5 * S.vmax });
      termsPlot.hlines = [
        { y: S.vmax, color: 'rgba(251,113,133,0.55)', label: 'saturation' },
        { y: -S.vmax, color: 'rgba(251,113,133,0.55)' },
      ];
      termsPlot.series = [
        { name: 'u', color: 'rgba(232,237,251,0.75)', data: log.U, width: 1.1 },
        { name: 'P', color: '#fbbf24', data: log.P, width: 1.6 },
        { name: 'I', color: '#34d399', data: log.I, width: 1.8 },
        { name: 'D', color: '#a78bfa', data: log.D, width: 1.4 },
      ];
      termsPlot.draw();
    }
  }

  function drawCapture() {
    const c = capture && capture.ts.length > 3 ? capture : lastCapture;
    respPlot.opts.xMin = 0;
    respPlot.opts.xMax = Math.min(4, S.profile === 'square' ? S.period / 2 : 2);
    respPlot.opts.yMin = -0.15;
    respPlot.opts.yMax = 1.6;
    respPlot.opts.xLabel = 'time since step (s)';
    respPlot.opts.yLabel = 'normalised output';
    respPlot.opts.legend = 'tr';
    respPlot.bands = [{ y0: 0.98, y1: 1.02, color: 'rgba(52,211,153,0.12)' }];
    respPlot.hlines = [{ y: 1, color: 'rgba(203,213,245,0.55)', label: 'target' }];
    respPlot.vlines = [];
    respPlot.markers = [];
    respPlot.series = pins.map((p) => ({ name: p.name, color: p.color, data: { x: p.ts, y: p.yn }, width: 1.5, alpha: 0.85, dash: [5, 3] }));
    if (c) {
      const d = c.r1 - c.y0;
      const yn = c.ys.map((y) => (y - c.y0) / d);
      respPlot.series.push({ name: 'latest step', color: T.accent, data: { x: c.ts, y: yn }, width: 2.4 });
      const m = stepMetrics(c.ts, c.ys, c.y0, c.r1);
      if (m.overshoot > 0.5) respPlot.markers.push({ x: m.peakTime, y: 1 + m.overshoot / 100, color: T.accent, label: `+${m.overshoot.toFixed(1)}%` });
      if (Number.isFinite(m.settle)) respPlot.vlines.push({ x: m.settle, color: 'rgba(52,211,153,0.8)', label: `ts ${m.settle.toFixed(2)} s` });
    }
    respPlot.draw();
  }

  function computeAnalysis() {
    const g = { ...S.gains[S.mode], tf: 1 / (2 * Math.PI * S.fc) };
    const Ts = 1 / S.rate;
    const tauS = S.mode === 'velocity' ? VEL_FILTER_TAU : 0;
    const fr = frequencyResponse(motor.p, g, S.mode, Ts, tauS, 0.1, 1e4, 500);
    let pl = [];
    try { pl = closedLoopPoles(motor.p, g, S.mode, Ts, tauS); } catch (err) { pl = []; }
    analysis = { fr, poles: pl, g };
    analysisDirty = false;
    drawBode();
    drawPoles();
    updateHealthDom();
  }

  function drawBode() {
    if (!analysis) return;
    const { fr } = analysis;
    const x = fr.w;
    magPlot.series = [
      { name: 'plant', color: '#6b779f', data: { x, y: fr.magP }, width: 1.3, dash: [5, 4] },
      { name: 'T', color: '#38bdf8', data: { x, y: fr.magT }, width: 1.3 },
      { name: 'L', color: '#fbbf24', data: { x, y: fr.magL }, width: 2.2 },
    ];
    magPlot.hlines = [{ y: 0, color: 'rgba(203,213,245,0.5)', dash: [3, 3] }];
    magPlot.vlines = Number.isFinite(fr.wc) ? [{ x: fr.wc, color: 'rgba(251,191,36,0.6)', label: `ωc ${fr.wc.toFixed(1)} rad/s` }] : [];
    magPlot.markers = [];
    if (Number.isFinite(fr.wp)) {
      const k = nearestIdx(x, fr.wp);
      magPlot.markers.push({ x: fr.wp, y: fr.magL[k], color: '#fb7185', label: `GM ${fr.gm.toFixed(1)} dB`, align: 'right' });
    }
    magPlot.draw();
    const lo = Math.min(-270, Math.floor(Math.min(...fr.phL.filter(Number.isFinite)) / 90) * 90);
    phPlot.opts.yMin = Math.max(lo, -450);
    phPlot.opts.yMax = 0;
    phPlot.series = [
      { name: 'plant', color: '#6b779f', data: { x, y: fr.phP }, width: 1.3, dash: [5, 4] },
      { name: 'L', color: '#fbbf24', data: { x, y: fr.phL }, width: 2.2 },
    ];
    phPlot.hlines = [{ y: -180, color: 'rgba(251,113,133,0.7)', label: '−180°' }];
    phPlot.vlines = Number.isFinite(fr.wc) ? [{ x: fr.wc, color: 'rgba(251,191,36,0.6)' }] : [];
    phPlot.markers = Number.isFinite(fr.pm) ? [{ x: fr.wc, y: fr.pm - 180, color: fr.pm > 45 ? '#34d399' : fr.pm > 20 ? '#fbbf24' : '#fb7185', label: `PM ${fr.pm.toFixed(1)}°` }] : [];
    phPlot.draw();
    const p = motor.p;
    const a2 = p.J * p.L;
    const a1 = p.J * p.R + p.b * p.L;
    const a0 = p.b * p.R + p.K * p.K;
    Lab.text('tf-line', `P(s) = ${p.K.toFixed(2)} / (${sci(a2)}·s² + ${sci(a1)}·s + ${sci(a0)})${S.mode === 'position' ? ' · 1/s' : ''}   ·   Ts = ${(1000 / S.rate).toFixed(2)} ms`);
  }
  const sci = (v) => (Math.abs(v) >= 0.01 ? v.toPrecision(3) : v.toExponential(2));
  const nearestIdx = (arr, v) => {
    let best = 0;
    for (let k = 1; k < arr.length; k++) if (Math.abs(Math.log(arr[k] / v)) < Math.abs(Math.log(arr[best] / v))) best = k;
    return best;
  };

  function drawPoles() {
    if (!analysis || !poles.w) return;
    const { ctx, w, h } = poles;
    poles.clear();
    const pl = analysis.poles;
    if (!pl.length) return;
    // view: fit the slowest poles, list the fast ones at the edge
    const mags = pl.map((z) => Math.hypot(z[0], z[1])).sort((a, b) => a - b);
    const dom = mags[Math.min(mags.length - 1, 2)] || 10;
    const R = Math.max(5, dom * 1.8);
    const pad = { l: 46, r: 16, t: 16, b: 28 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const xMin = -R * 1.25;
    const xMax = R * 0.35;
    const yHalf = ((xMax - xMin) * ph) / pw / 2; // equal aspect
    const X = (v) => pad.l + ((v - xMin) / (xMax - xMin)) * pw;
    const Y = (v) => pad.t + ph / 2 - (v / yHalf) * (ph / 2);
    // RHP shading
    ctx.fillStyle = 'rgba(251,113,133,0.08)';
    ctx.fillRect(X(0), pad.t, pad.l + pw - X(0), ph);
    // grid
    ctx.strokeStyle = 'rgba(142,160,216,0.12)';
    ctx.lineWidth = 1;
    const { ticks } = M.niceTicks(xMin, xMax, 7);
    ctx.font = `10.5px ${T.mono}`;
    ctx.fillStyle = T.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.beginPath();
    for (const v of ticks) { ctx.moveTo(X(v) + 0.5, pad.t); ctx.lineTo(X(v) + 0.5, pad.t + ph); }
    const yt = M.niceTicks(-yHalf, yHalf, 5).ticks;
    for (const v of yt) { ctx.moveTo(pad.l, Y(v) + 0.5); ctx.lineTo(pad.l + pw, Y(v) + 0.5); }
    ctx.stroke();
    for (const v of ticks) ctx.fillText(String(+v.toPrecision(3)).replace('-', '−'), X(v), pad.t + ph + 6);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of yt) ctx.fillText(String(+v.toPrecision(3)).replace('-', '−') + 'j', pad.l - 6, Y(v));
    // axes
    ctx.strokeStyle = 'rgba(203,213,245,0.45)';
    ctx.beginPath();
    ctx.moveTo(X(0) + 0.5, pad.t);
    ctx.lineTo(X(0) + 0.5, pad.t + ph);
    ctx.moveTo(pad.l, Y(0) + 0.5);
    ctx.lineTo(pad.l + pw, Y(0) + 0.5);
    ctx.stroke();
    // damping ratio guide ζ = 0.707
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(52,211,153,0.45)';
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    ctx.lineTo(X(xMin), Y(-xMin));
    ctx.moveTo(X(0), Y(0));
    ctx.lineTo(X(xMin), Y(xMin));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(52,211,153,0.8)';
    ctx.textAlign = 'right';
    const tz = 0.8 * Math.min(yHalf, -xMin);
    ctx.fillText('ζ = 0.707', X(-tz) - 6, Y(tz) + 4);
    // poles
    const off = [];
    for (const z of pl) {
      if (z[0] < xMin || Math.abs(z[1]) > yHalf) { off.push(z); continue; }
      const px = X(z[0]);
      const py = Y(z[1]);
      const unstable = z[0] > 1e-9;
      ctx.strokeStyle = unstable ? '#fb7185' : T.accent;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(px - 6, py - 6); ctx.lineTo(px + 6, py + 6);
      ctx.moveTo(px + 6, py - 6); ctx.lineTo(px - 6, py + 6);
      ctx.stroke();
    }
    // dominant pole annotation
    const domPole = pl.filter((z) => z[1] >= 0).sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]))
      .find((z) => Math.abs(z[1]) > 1e-6) || pl.slice().sort((a, b) => b[0] - a[0])[0];
    if (domPole && domPole[0] >= xMin) {
      const wn = Math.hypot(domPole[0], domPole[1]);
      const zeta = -domPole[0] / wn;
      ctx.font = `600 11px ${T.mono}`;
      ctx.fillStyle = T.text;
      ctx.textAlign = 'left';
      ctx.fillText(`ωn ${wn.toFixed(1)} rad/s · ζ ${zeta.toFixed(2)}`, Math.min(X(domPole[0]) + 10, w - 190), Y(domPole[1]) - 12);
    }
    if (off.length) {
      ctx.font = `10.5px ${T.mono}`;
      ctx.fillStyle = T.muted;
      ctx.textAlign = 'left';
      ctx.fillText(`fast poles off-chart: ${off.map((z) => fmtC(z)).join(', ')}`, pad.l + 8, pad.t + 12);
    }
    ctx.strokeStyle = T.border2;
    ctx.strokeRect(pad.l + 0.5, pad.t + 0.5, pw - 1, ph - 1);
    ctx.font = `600 10.5px ${T.sans}`;
    ctx.fillStyle = T.text2;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('Re(s)', pad.l + pw, h - 2);
  }
  const fmtC = (z) => (Math.abs(z[1]) < 1e-6 ? `${z[0].toFixed(0)}` : `${z[0].toFixed(0)}±${Math.abs(z[1]).toFixed(0)}j`).replace(/-/g, '−');

  // ------------------------------------------------------------------ servo dial
  function drawDial(dtFrame) {
    const { ctx, w, h } = dial;
    dial.clear();
    const cx = w / 2;
    const cy = h / 2 + 2;
    const R = Math.max(40, Math.min(w, h) / 2 - 30);
    const pos = S.mode === 'position';
    const th = motor.th;
    // screen angle: 0 at top, clockwise positive
    const sa = (a) => a - Math.PI / 2;

    // ambient glow
    const glow = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.25);
    glow.addColorStop(0, Lab.alpha(T.accent, 0.07));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // bezel
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    const bez = ctx.createLinearGradient(cx, cy - R, cx, cy + R);
    bez.addColorStop(0, '#1a2443');
    bez.addColorStop(1, '#0a1022');
    ctx.fillStyle = bez;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#2b3a66';
    ctx.stroke();

    ctx.font = `10.5px ${T.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (pos) {
      for (let d = 0; d < 360; d += 5) {
        const a = sa((d * Math.PI) / 180);
        const major = d % 30 === 0;
        const r0 = R * (major ? 0.885 : 0.93);
        ctx.strokeStyle = major ? '#8ea0d8' : 'rgba(142,160,216,0.4)';
        ctx.lineWidth = major ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * R * 0.985, cy + Math.sin(a) * R * 0.985);
        ctx.stroke();
        if (major) {
          const lab = d > 180 ? d - 360 : d;
          ctx.fillStyle = T.muted;
          ctx.fillText(`${lab}°`.replace('-', '−'), cx + Math.cos(a) * (R + 15), cy + Math.sin(a) * (R + 15));
        }
      }
    } else {
      // tachometer scale: ±SPEED_FULL_SCALE mapped onto ±150°
      const toA = (rpm) => sa(((rpm / SPEED_FULL_SCALE) * 150 * Math.PI) / 180);
      for (let r = -SPEED_FULL_SCALE; r <= SPEED_FULL_SCALE; r += 25) {
        const a = toA(r);
        const major = r % 150 === 0;
        const r0 = R * (major ? 0.885 : 0.93);
        ctx.strokeStyle = major ? '#8ea0d8' : 'rgba(142,160,216,0.4)';
        ctx.lineWidth = major ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * R * 0.985, cy + Math.sin(a) * R * 0.985);
        ctx.stroke();
        if (major) {
          ctx.fillStyle = T.muted;
          ctx.fillText(String(r).replace('-', '−'), cx + Math.cos(a) * (R + 16), cy + Math.sin(a) * (R + 16));
        }
      }
      const wr = motor.w * RPM;
      ctx.lineCap = 'round';
      ctx.lineWidth = 5;
      ctx.strokeStyle = Lab.alpha(T.accent, 0.9);
      ctx.beginPath();
      const a0 = toA(0);
      const a1 = toA(M.clamp(wr, -SPEED_FULL_SCALE, SPEED_FULL_SCALE));
      ctx.arc(cx, cy, R * 0.955, Math.min(a0, a1), Math.max(a0, a1));
      ctx.stroke();
      ctx.lineCap = 'butt';
      markerTriangle(ctx, cx, cy, toA(M.clamp(ref * RPM, -SPEED_FULL_SCALE, SPEED_FULL_SCALE)), R * 0.86, '#e8edfb');
      ctx.fillStyle = T.muted;
      ctx.fillText('rpm', cx, cy + R + 16);
    }

    // rotating disk
    const rd = R * 0.8;
    ctx.save();
    ctx.translate(cx, cy);
    const disk = ctx.createRadialGradient(-rd * 0.3, -rd * 0.35, rd * 0.1, 0, 0, rd);
    disk.addColorStop(0, '#2a3761');
    disk.addColorStop(0.6, '#172142');
    disk.addColorStop(1, '#0f1631');
    ctx.beginPath();
    ctx.arc(0, 0, rd, 0, Math.PI * 2);
    ctx.fillStyle = disk;
    ctx.fill();
    ctx.strokeStyle = '#34457a';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // motion blur wedge
    const swept = th - lastDrawTh;
    if (Math.abs(swept) > 0.06) {
      const span = Math.min(Math.abs(swept), Math.PI * 1.6) * Math.sign(swept);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, rd * 0.93, sa(th - span), sa(th), span < 0);
      ctx.closePath();
      ctx.fillStyle = Lab.alpha(T.accent, 0.13);
      ctx.fill();
    }

    ctx.rotate(th);
    // encoder slots
    ctx.strokeStyle = 'rgba(142,160,216,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2;
      ctx.moveTo(Math.cos(a) * rd * 0.84, Math.sin(a) * rd * 0.84);
      ctx.lineTo(Math.cos(a) * rd * 0.93, Math.sin(a) * rd * 0.93);
    }
    ctx.stroke();
    // lightening holes
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * rd * 0.52, Math.sin(a) * rd * 0.52, rd * 0.11, 0, Math.PI * 2);
      ctx.fillStyle = '#0a1020';
      ctx.fill();
      ctx.strokeStyle = '#2d3c6b';
      ctx.stroke();
    }
    // pointer needle
    ctx.shadowColor = T.accent;
    ctx.shadowBlur = 14;
    ctx.fillStyle = T.accent;
    ctx.beginPath();
    ctx.moveTo(-rd * 0.05, 0);
    ctx.lineTo(0, -rd * 0.97);
    ctx.lineTo(rd * 0.05, 0);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();

    // hub
    ctx.beginPath();
    ctx.arc(cx, cy, rd * 0.15, 0, Math.PI * 2);
    ctx.fillStyle = '#0c1226';
    ctx.fill();
    ctx.strokeStyle = '#3a4c85';
    ctx.lineWidth = 2;
    ctx.stroke();
    for (let k = 0; k < 4; k++) {
      const a = th + (k * Math.PI) / 2 + Math.PI / 4;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rd * 0.09, cy + Math.sin(a) * rd * 0.09, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#5b6ea8';
      ctx.fill();
    }

    if (pos) {
      const tgt = tuner ? tuner.ref : ref;
      // error arc
      const err = tgt - th;
      if (Math.abs(err) > 0.5 / DEG) {
        ctx.beginPath();
        ctx.arc(cx, cy, rd * 0.99, sa(Math.min(th, tgt)), sa(Math.max(th, tgt)));
        ctx.strokeStyle = 'rgba(251,113,133,0.75)';
        ctx.lineWidth = 4;
        ctx.stroke();
      }
      // target line + marker
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = 'rgba(232,237,251,0.55)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sa(tgt)) * rd * 1.02, cy + Math.sin(sa(tgt)) * rd * 1.02);
      ctx.stroke();
      ctx.setLineDash([]);
      markerTriangle(ctx, cx, cy, sa(tgt), R * 0.86, '#e8edfb');
    }

    // digital readout on the dial face
    if (readout) {
      const sgn = (v, d) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);
      const d = readout.pos ? 1 : 0;
      const main = `${sgn(readout.y, d)}${readout.pos ? '°' : ' rpm'}`;
      const sub = `target ${sgn(readout.r, d)}${readout.pos ? '°' : ' rpm'}`;
      const by = cy + rd * 0.5;
      ctx.font = `600 ${Math.round(Math.max(13, rd * 0.13))}px ${T.mono}`;
      const bw = Math.max(ctx.measureText(main).width, 70) + 26;
      const bh = Math.max(34, rd * 0.3);
      ctx.fillStyle = 'rgba(6,10,20,0.86)';
      ctx.strokeStyle = '#2b3a66';
      ctx.lineWidth = 1;
      Lab.roundRect(ctx, cx - bw / 2, by - bh / 2, bw, bh, 7);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = T.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(main, cx, by + 1);
      ctx.font = `10px ${T.mono}`;
      ctx.fillStyle = T.muted;
      ctx.fillText(sub, cx, by + bh / 2 - 5);
    }

    // load torque indicator
    const tl = loadTorque(simT);
    if (tl > 0) {
      const rr = rd * 0.33;
      ctx.strokeStyle = '#fb7185';
      ctx.fillStyle = '#fb7185';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, sa(th + 0.9), sa(th - 0.9), true);
      ctx.stroke();
      const ea = sa(th - 0.9);
      const ex = cx + Math.cos(ea) * rr;
      const ey = cy + Math.sin(ea) * rr;
      const ta = ea - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(ex + Math.cos(ta) * 8, ey + Math.sin(ta) * 8);
      ctx.lineTo(ex + Math.cos(ta + 2.5) * 6, ey + Math.sin(ta + 2.5) * 6);
      ctx.lineTo(ex + Math.cos(ta - 2.5) * 6, ey + Math.sin(ta - 2.5) * 6);
      ctx.closePath();
      ctx.fill();
      ctx.font = `600 11px ${T.mono}`;
      ctx.fillText(`τL ${tl.toFixed(1)} N·m`, cx, cy + rd * 0.55);
    }
    lastDrawTh = th;
  }
  function markerTriangle(ctx, cx, cy, a, r, color) {
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * -9, y + Math.sin(a) * -9);
    ctx.lineTo(x + Math.cos(a + 2.4) * -7 + Math.cos(a) * 6, y + Math.sin(a + 2.4) * -7 + Math.sin(a) * 6);
    ctx.lineTo(x + Math.cos(a - 2.4) * -7 + Math.cos(a) * 6, y + Math.sin(a - 2.4) * -7 + Math.sin(a) * 6);
    ctx.closePath();
    ctx.fill();
  }

  // ------------------------------------------------------------------ DOM readouts
  let readout = null;
  function setMeter(id, frac, sat) {
    const el = document.getElementById(id);
    const span = el.firstElementChild;
    const f = M.clamp(frac, -1, 1);
    span.style.left = f >= 0 ? '50%' : `${50 + f * 50}%`;
    span.style.width = `${Math.abs(f) * 50}%`;
    el.classList.toggle('sat', !!sat);
  }
  function updateReadouts() {
    const pos = S.mode === 'position';
    const y = pos ? meas.th * DEG : meas.w * RPM;
    const r = (tuner ? tuner.ref : ref) * (pos ? DEG : RPM);
    const unit = pos ? '°' : ' rpm';
    readout = { y, r, unit, pos };
    const istall = S.vmax / motor.p.R;
    const wmax = motor.speedGain * S.vmax;
    Lab.text('m-u', `${u.toFixed(1)} V`);
    Lab.text('m-i', `${motor.i.toFixed(2)} A`);
    Lab.text('m-w', `${(motor.w * RPM).toFixed(0)} rpm`);
    setMeter('mb-u', u / S.vmax, Math.abs(u) >= S.vmax - 1e-6);
    setMeter('mb-i', motor.i / istall);
    setMeter('mb-w', motor.w / wmax);
  }

  function setStat(id, text, cls) {
    const el = document.getElementById(id);
    if (el.innerHTML !== text) el.innerHTML = text;
    const tile = el.parentElement;
    tile.classList.remove('good', 'warn', 'bad');
    if (cls) tile.classList.add(cls);
  }
  function updateMetricsDom(clear) {
    // prefer the latest completed step; fall back to the one in progress
    const c = lastCapture || (capture && capture.ts.length > 10 ? capture : null);
    const stepProfile = S.profile === 'square' || S.profile === 'manual';
    if (clear || !c || !stepProfile) {
      ['st-rise', 'st-os', 'st-settle', 'st-sse', 'st-ipk', 'st-iae'].forEach((id) => setStat(id, '—'));
      Lab.text('metrics-sub', stepProfile ? 'waiting for a step…' : 'continuous profile — switch to Square/Manual for step metrics');
      return;
    }
    const m = stepMetrics(c.ts, c.ys, c.y0, c.r1);
    const conv = c.mode === 'position' ? DEG : RPM;
    const unit = c.mode === 'position' ? '°' : 'rpm';
    const stepSize = (c.r1 - c.y0) * conv;
    Lab.text('metrics-sub', `step of ${stepSize >= 0 ? '+' : '−'}${Math.abs(stepSize).toFixed(c.mode === 'position' ? 1 : 0)}${unit === '°' ? '°' : ' rpm'} at t = ${c.t0.toFixed(2)} s`);
    const ms = (v) => (Number.isFinite(v) ? `${(v * 1000).toFixed(0)}<span class="u">ms</span>` : '—');
    setStat('st-rise', ms(m.rise));
    setStat('st-os', Number.isFinite(m.overshoot) ? `${m.overshoot.toFixed(1)}<span class="u">%</span>` : '—', m.overshoot < 10 ? 'good' : m.overshoot < 25 ? 'warn' : 'bad');
    setStat('st-settle', Number.isFinite(m.settle) ? ms(m.settle) : '<span class="u">not settled</span>', Number.isFinite(m.settle) ? null : 'warn');
    setStat('st-sse', `${(m.sse * conv).toFixed(c.mode === 'position' ? 2 : 1)}<span class="u">${unit}</span>`);
    setStat('st-ipk', `${c.iPk.toFixed(1)}<span class="u">A</span>`);
    setStat('st-iae', `${(m.iae * conv).toFixed(c.mode === 'position' ? 1 : 0)}<span class="u">${unit}·s</span>`);
  }
  function updateHealthDom() {
    if (!analysis) return;
    const { fr, poles: pl } = analysis;
    setStat('st-pm', Number.isFinite(fr.pm) ? `${fr.pm.toFixed(1)}<span class="u">°</span>` : '—', !Number.isFinite(fr.pm) ? null : fr.pm > 45 ? 'good' : fr.pm > 20 ? 'warn' : 'bad');
    setStat('st-gm', Number.isFinite(fr.gm) ? `${fr.gm.toFixed(1)}<span class="u">dB</span>` : '∞', fr.gm > 6 ? 'good' : 'bad');
    setStat('st-wc', Number.isFinite(fr.wc) ? `${fr.wc.toFixed(1)}<span class="u">rad/s</span>` : '—');
    setStat('st-bw', Number.isFinite(fr.bw) ? `${(fr.bw / (2 * Math.PI)).toFixed(2)}<span class="u">Hz</span>` : '—');
    const maxRe = pl.length ? Math.max(...pl.map((z) => z[0])) : -1;
    const chip = Lab.$('#stab-chip');
    chip.className = 'chip ' + (maxRe > 1e-9 || fr.pm < 0 ? 'bad' : fr.pm < 30 ? 'warn' : 'good');
    chip.textContent = maxRe > 1e-9 || fr.pm < 0 ? 'Unstable (linear)' : fr.pm < 30 ? 'Marginal' : 'Stable';
  }

  // ------------------------------------------------------------------ main loop
  let domTimer = 0;
  Lab.loop((dt) => {
    if (S.running) advance(dt * S.speed);
    if (analysisDirty) computeAnalysis();
    drawDial(dt);
    drawLive();
    domTimer += dt;
    if (domTimer > 0.1) {
      domTimer = 0;
      updateReadouts();
      updateMetricsDom(false);
    }
  });

  // ------------------------------------------------------------------ init
  fillTuneMethods();
  syncGainSliders();
  applyPid();
  markPresets();
  updateProfileHelp();
  updateLegend();
  updateReadouts();

  // tiny automation hook used by the screenshot script
  window.MotorLab = {
    state: S,
    setGains,
    setMode: (m) => modeSeg.set(m, true),
    setView: (v) => viewSeg.set(v, true),
    setTab: (v) => tabSeg.set(v, true),
    pin: () => Lab.$('#btn-pin').click(),
    advance: (sec) => advance(sec),
    get t() { return simT; },
  };
})();
