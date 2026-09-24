/* ==========================================================================
   Lab UI — DOM + canvas helpers shared by the portfolio web apps.
   Requires lab-math.js (window.LabMath). Exposes window.Lab.
   ========================================================================== */
(function () {
  'use strict';
  const M = window.LabMath;
  const Lab = {};

  Lab.$ = (sel, root = document) => root.querySelector(sel);
  Lab.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const byId = (id) => (typeof id === 'string' ? document.getElementById(id) : id);

  // ------------------------------------------------------------ theme (read CSS custom properties once)
  let themeCache = null;
  Lab.theme = function () {
    if (themeCache) return themeCache;
    const cs = getComputedStyle(document.body);
    const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
    themeCache = {
      bg: v('--bg', '#070b15'),
      panel: v('--panel', '#0e1528'),
      inset: v('--inset', '#060a14'),
      border: v('--border', '#1b2542'),
      border2: v('--border-2', '#26335a'),
      text: v('--text', '#e8edfb'),
      text2: v('--text-2', '#a9b4d6'),
      muted: v('--muted', '#6b779f'),
      accent: v('--accent', '#60a5fa'),
      accent2: v('--accent-2', '#a78bfa'),
      good: v('--good', '#34d399'),
      warn: v('--warn', '#fbbf24'),
      bad: v('--bad', '#fb7185'),
      info: v('--info', '#60a5fa'),
      mono: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
    };
    return themeCache;
  };

  /** Convert "#rrggbb" to "rgba(r,g,b,a)". */
  Lab.alpha = function (hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };

  // ------------------------------------------------------------ canvases
  /**
   * Makes a canvas crisp on HiDPI screens and keeps its backing store in sync with its CSS size.
   * Drawing code works in CSS pixels (state.w × state.h).
   */
  Lab.canvas = function (canvas, onResize) {
    canvas = byId(canvas);
    const state = { canvas, ctx: canvas.getContext('2d'), w: 0, h: 0, dpr: 1 };
    function resize(initial) {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (w === state.w && h === state.h && dpr === state.dpr) return false;
      state.w = w;
      state.h = h;
      state.dpr = dpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (onResize && initial !== true) onResize(state);
      return true;
    }
    state.resize = resize;
    state.clear = function (fill) {
      const ctx = state.ctx;
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, state.w, state.h);
      } else ctx.clearRect(0, 0, state.w, state.h);
    };
    /** Pointer position in CSS pixels relative to the canvas. */
    state.pointer = function (e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => resize()).observe(canvas);
    else window.addEventListener('resize', () => resize());
    resize(true); // first sizing pass: callers draw explicitly once construction is complete
    return state;
  };

  /** requestAnimationFrame loop that passes a clamped dt (seconds). Returns {stop()}. */
  Lab.loop = function (fn) {
    let last = performance.now();
    let id = 0;
    let running = true;
    function frame(now) {
      if (!running) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      fn(dt, now / 1000);
      id = requestAnimationFrame(frame);
    }
    id = requestAnimationFrame(frame);
    return {
      stop() {
        running = false;
        cancelAnimationFrame(id);
      },
    };
  };

  // ------------------------------------------------------------ controls
  /**
   * Binds <input type=range> to a value label (element with data-value-for="<id>").
   * Keeps the filled-track CSS variable in sync.
   */
  Lab.range = function (id, { format, onInput, onChange } = {}) {
    const el = byId(id);
    const out = document.querySelector(`[data-value-for="${el.id}"]`);
    function paint() {
      const v = parseFloat(el.value);
      const min = parseFloat(el.min || 0);
      const max = parseFloat(el.max || 100);
      el.style.setProperty('--pct', ((v - min) / (max - min)) * 100 + '%');
      if (out) out.textContent = format ? format(v) : String(v);
      return v;
    }
    el.addEventListener('input', () => {
      const v = paint();
      if (onInput) onInput(v);
    });
    if (onChange) el.addEventListener('change', () => onChange(parseFloat(el.value)));
    paint();
    return {
      el,
      get value() {
        return parseFloat(el.value);
      },
      set(v, fire = false) {
        el.value = v;
        const val = paint();
        if (fire && onInput) onInput(val);
      },
      refresh: paint,
    };
  };

  /** Segmented control: container of <button data-value="...">. */
  Lab.seg = function (id, onChange) {
    const el = byId(id);
    const buttons = Array.from(el.querySelectorAll('button'));
    let value = (buttons.find((b) => b.classList.contains('active')) || buttons[0]).dataset.value;
    function set(v, fire = false) {
      value = v;
      buttons.forEach((b) => {
        const on = b.dataset.value === v;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      if (fire && onChange) onChange(v);
    }
    buttons.forEach((b) => {
      b.type = 'button';
      b.addEventListener('click', () => set(b.dataset.value, true));
    });
    set(value);
    return {
      el,
      get value() {
        return value;
      },
      set,
    };
  };

  /** Checkbox switch. */
  Lab.toggle = function (id, onChange) {
    const el = byId(id);
    el.addEventListener('change', () => onChange && onChange(el.checked));
    return {
      el,
      get value() {
        return el.checked;
      },
      set(v, fire = false) {
        el.checked = !!v;
        if (fire && onChange) onChange(el.checked);
      },
    };
  };

  /** <select> binding. */
  Lab.select = function (id, onChange) {
    const el = byId(id);
    el.addEventListener('change', () => onChange && onChange(el.value));
    return {
      el,
      get value() {
        return el.value;
      },
      set(v, fire = false) {
        el.value = v;
        if (fire && onChange) onChange(el.value);
      },
    };
  };

  /** Sets text content of an element by id (no-op when missing). */
  Lab.text = function (id, s) {
    const el = byId(id);
    if (el && el.textContent !== s) el.textContent = s;
  };

  // ------------------------------------------------------------ number formatting
  Lab.fmt = function (v, digits = 2) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
    const s = v.toFixed(digits);
    return s === '-' + (0).toFixed(digits) ? (0).toFixed(digits) : s.replace('-', '−');
  };
  Lab.fmtSI = function (v, digits = 3) {
    if (!Number.isFinite(v)) return Lab.fmt(v);
    const a = Math.abs(v);
    const units = [
      [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'],
    ];
    for (const [s, u] of units) {
      if (a >= s * 0.9995) return (v / s).toPrecision(digits).replace(/\.?0+$/, '').replace('-', '−') + u;
    }
    return v.toExponential(1);
  };

  // ------------------------------------------------------------ drawer / toast / icons
  Lab.initDrawer = function () {
    const open = () => document.body.classList.add('drawer-open');
    const close = () => document.body.classList.remove('drawer-open');
    Lab.$$('[data-open-drawer]').forEach((b) => b.addEventListener('click', open));
    Lab.$$('[data-close-drawer], .drawer-backdrop').forEach((b) => b.addEventListener('click', close));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    return { open, close };
  };

  Lab.toast = function (msg, ms = 2600) {
    let host = Lab.$('.toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .25s';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 260);
    }, ms);
  };

  const ICONS = {
    play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>',
    reset: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>',
    step: '<path d="M5 5v14l10-7z" fill="currentColor" stroke="none"/><path d="M19 5v14"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
    code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
    back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
    zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    shuffle: '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    brush: '<path d="M18.5 3.5l2 2L11 15l-3-1-1-3z"/><path d="M7 14c-2 0-3.5 1.5-3.5 3.5 0 1-.5 2-1.5 2.5 4 1 8-.5 8-4"/>',
    eraser: '<path d="M20 20H9L4 15a2 2 0 0 1 0-2.8L13.2 3a2 2 0 0 1 2.8 0L21 8a2 2 0 0 1 0 2.8L12 20"/><path d="M8.5 9.5l6 6"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
    pin: '<path d="M12 17v5M5 17h14l-2-4V5h1V3H6v2h1v8z"/>',
    github: '<path d="M9 19c-4.5 1.5-4.5-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
  };
  Lab.icon = function (name, cls = '') {
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  };
  /** Replaces <i data-icon="name"></i> placeholders with inline SVG icons. */
  Lab.applyIcons = function (root = document) {
    Lab.$$('i[data-icon]', root).forEach((i) => {
      i.outerHTML = Lab.icon(i.dataset.icon, i.className);
    });
  };

  // ------------------------------------------------------------ colormaps
  const STOPS = {
    gray: ['#000000', '#ffffff'],
    bone: ['#000000','#0e0e13','#1c1c27','#2a2a3a','#38384e','#464661','#545574','#626882','#707b90','#7e8f9e','#8ca2ac','#9ab5ba','#a9c8c8','#bfd6d6','#d5e4e4','#eaf2f2','#ffffff'],
    viridis: ['#440154','#48186a','#472d7b','#424086','#3b528b','#33638d','#2c728e','#26828e','#21918c','#1fa088','#28ae80','#3fbc73','#5ec962','#84d44b','#addc30','#d8e219','#fde725'],
    magma: ['#000004','#0a0822','#1d1147','#36106b','#51127c','#6a1c81','#832681','#9c2e7f','#b73779','#d0416f','#e75263','#f56b5c','#fc8961','#fea772','#fec488','#fde2a3','#fcfdbf'],
    inferno: ['#000004','#0b0724','#210c4a','#3d0965','#57106e','#71196e','#8a226a','#a32c61','#bc3754','#d24644','#e45a31','#f1731d','#f98e09','#fcac11','#f9cb35','#f2ea69','#fcffa4'],
    turbo: ['#30123b','#392a73','#4040a2','#4456c7','#466be3','#4680f6','#4294ff','#37a8fa','#28bceb','#1ccdd8','#18ddc2','#1fe9af','#32f298','#4ef97d','#6dfe62','#8bff4b','#a4fc3c','#b9f635','#cdec34','#dfdf37','#eecf3a','#f8be39','#fdac34','#fe962b','#fb7e21','#f46617','#eb500e','#df3f08','#d02f05','#be2102','#a91601','#920b01','#7a0403'],
    cividis: ['#00224e','#002e6a','#1a386f','#32436d','#434e6c','#535a6d','#61656f','#6f7073','#7d7c78','#8c8878','#9b9476','#aba072','#bcae6c','#cdbb63','#dec958','#f0d846','#fee838'],
    rdbu: ['#053061','#175290','#2a71b2','#3f8ec0','#6bacd1','#9bc9e0','#c2ddec','#e0ecf3','#f7f6f6','#fbe5d8','#fbccb4','#f5aa89','#e48066','#d05548','#ba2832','#930e26','#67001f'],
    coolwarm: ['#3b4cc0','#4e68d8','#6282ea','#779af7','#8db0fe','#a3c2fe','#b9d0f9','#ccd9ed','#dddcdc','#ecd3c5','#f5c4ac','#f7b093','#f4987a','#eb7d62','#dd5f4b','#ca3b37','#b40426'],
    /** Dark-centred diverging map for two-class decision surfaces. */
    duo: ['#f59e0b', '#b86f10', '#5b3a12', '#0c1224', '#0e3a52', '#127aa8', '#38bdf8'],
    /** Dark-centred diverging map (errors / signed quantities on dark UIs). */
    diverge: ['#bae6fd', '#38bdf8', '#1d4ed8', '#172554', '#0b1020', '#450a0a', '#b91c1c', '#f87171', '#fecaca'],
    /** Phase map (cyclic). */
    twilight: ['#301437','#45135c','#592a8f','#5e51ad','#6276ba','#7297c1','#95b5c7','#c4ced4','#e2d9e2','#d8c7be','#cca389','#c27c63','#b25652','#983550','#741e4f','#4a1342','#2f1436'],
  };
  const lutCache = new Map();
  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  /** 256-entry RGB lookup table (Uint8ClampedArray of length 768). Accepts a name or an array of hex stops. */
  Lab.lut = function (nameOrStops) {
    const key = Array.isArray(nameOrStops) ? nameOrStops.join() : nameOrStops;
    if (lutCache.has(key)) return lutCache.get(key);
    const stops = (Array.isArray(nameOrStops) ? nameOrStops : STOPS[nameOrStops] || STOPS.gray).map(hexToRgb);
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * (stops.length - 1);
      const k = Math.min(stops.length - 2, Math.floor(t));
      const f = t - k;
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f);
    }
    lutCache.set(key, lut);
    return lut;
  };
  Lab.cmapNames = Object.keys(STOPS);
  /** CSS color for t in [0,1] from a colormap. */
  Lab.cmap = function (name, t) {
    const lut = Lab.lut(name);
    const i = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
    return `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
  };
  /** CSS linear-gradient string for a colormap (legends). */
  Lab.cmapGradient = function (name, dir = '90deg') {
    const lut = Lab.lut(name);
    const parts = [];
    for (let k = 0; k <= 8; k++) {
      const i = Math.round((k / 8) * 255) * 3;
      parts.push(`rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]}) ${(k / 8) * 100}%`);
    }
    return `linear-gradient(${dir}, ${parts.join(', ')})`;
  };

  /**
   * Renders a scalar field into an offscreen canvas (w×h pixels) using a colormap.
   * Returns the canvas so callers can drawImage() it scaled with smoothing.
   */
  Lab.renderField = function (field, w, h, opts = {}) {
    const { lut = 'gray', min = 0, max = 1, target = null, alphaField = null } = opts;
    const c = target || document.createElement('canvas');
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const L = typeof lut === 'string' || Array.isArray(lut) ? Lab.lut(lut) : lut;
    const d = img.data;
    const scale = 255 / (max - min || 1e-12);
    for (let i = 0, n = w * h; i < n; i++) {
      let t = (field[i] - min) * scale;
      t = t < 0 ? 0 : t > 255 ? 255 : t | 0;
      const j = i << 2;
      const k = t * 3;
      d[j] = L[k];
      d[j + 1] = L[k + 1];
      d[j + 2] = L[k + 2];
      d[j + 3] = alphaField ? alphaField[i] : 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  };

  // ------------------------------------------------------------ rolling series
  /** Fixed-capacity ring buffer of (x, y) samples for scope-style plots. */
  class RingSeries {
    constructor(capacity) {
      this.cap = capacity;
      this.xs = new Float64Array(capacity);
      this.ys = new Float64Array(capacity);
      this.head = 0;
      this.length = 0;
    }
    push(x, y) {
      this.xs[this.head] = x;
      this.ys[this.head] = y;
      this.head = (this.head + 1) % this.cap;
      if (this.length < this.cap) this.length++;
    }
    idx(i) {
      return (this.head - this.length + i + this.cap) % this.cap;
    }
    xAt(i) {
      return this.xs[this.idx(i)];
    }
    yAt(i) {
      return this.ys[this.idx(i)];
    }
    last() {
      return this.length ? this.ys[(this.head - 1 + this.cap) % this.cap] : NaN;
    }
    clear() {
      this.head = 0;
      this.length = 0;
    }
  }
  Lab.RingSeries = RingSeries;

  // ------------------------------------------------------------ Plot
  const SUPERSCRIPT = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
  const logLabel = (e) => {
    const v = 10 ** e;
    if (e >= -2 && e <= 3) return String(+v.toPrecision(3));
    return '10' + String(e).split('').map((c) => SUPERSCRIPT[c] || c).join('');
  };

  /**
   * Lightweight canvas line plot with nice ticks, optional log axes, bands, reference lines,
   * legends and min/max decimation for long series.
   *
   * series item: { name, color, data: {x:[],y:[]} | RingSeries, width, dash, fill, alpha, visible }
   */
  class Plot {
    constructor(canvas, opts = {}) {
      this.opts = Object.assign(
        {
          pad: { l: 50, r: 14, t: 12, b: 30 },
          xLabel: '',
          yLabel: '',
          xMin: null, xMax: null, yMin: null, yMax: null,
          xLog: false, yLog: false,
          xTicks: 7, yTicks: 5,
          xFormat: null, yFormat: null,
          yPad: 0.08,
          yMinSpan: 0,
          grid: true,
          legend: null,
          bg: null,
          title: null,
          zeroLine: true,
        },
        opts
      );
      if (opts.pad) this.opts.pad = Object.assign({ l: 50, r: 14, t: 12, b: 30 }, opts.pad);
      this.series = [];
      this.hlines = [];
      this.vlines = [];
      this.bands = [];
      this.markers = [];
      this.c = Lab.canvas(canvas, () => this.draw());
    }
    get rect() {
      const p = this.opts.pad;
      return { x: p.l, y: p.t, w: Math.max(10, this.c.w - p.l - p.r), h: Math.max(10, this.c.h - p.t - p.b) };
    }
    _range() {
      const o = this.opts;
      let x0 = o.xMin, x1 = o.xMax, y0 = o.yMin, y1 = o.yMax;
      if (x0 === null || x1 === null || y0 === null || y1 === null) {
        let ax0 = Infinity, ax1 = -Infinity, ay0 = Infinity, ay1 = -Infinity;
        for (const s of this.series) {
          if (s.visible === false || !s.data) continue;
          const d = s.data;
          const n = d.length !== undefined && d.xAt ? d.length : d.y.length;
          for (let i = 0; i < n; i++) {
            const x = d.xAt ? d.xAt(i) : d.x ? d.x[i] : i;
            const y = d.xAt ? d.yAt(i) : d.y[i];
            if (!Number.isFinite(y) || !Number.isFinite(x)) continue;
            if (o.xMin !== null && x < o.xMin) continue;
            if (o.xMax !== null && x > o.xMax) continue;
            if (x < ax0) ax0 = x;
            if (x > ax1) ax1 = x;
            if (y < ay0) ay0 = y;
            if (y > ay1) ay1 = y;
          }
        }
        for (const hl of this.hlines) if (hl.fit) { ay0 = Math.min(ay0, hl.y); ay1 = Math.max(ay1, hl.y); }
        if (x0 === null) x0 = Number.isFinite(ax0) ? ax0 : 0;
        if (x1 === null) x1 = Number.isFinite(ax1) ? ax1 : 1;
        if (y0 === null || y1 === null) {
          let lo = Number.isFinite(ay0) ? ay0 : 0;
          let hi = Number.isFinite(ay1) ? ay1 : 1;
          if (hi - lo < o.yMinSpan) {
            const c = (hi + lo) / 2;
            lo = c - o.yMinSpan / 2;
            hi = c + o.yMinSpan / 2;
          }
          if (hi === lo) { hi += 1; lo -= 1; }
          const pad = o.yLog ? 0 : (hi - lo) * o.yPad;
          if (y0 === null) y0 = lo - pad;
          if (y1 === null) y1 = hi + pad;
        }
      }
      if (x1 === x0) x1 = x0 + 1;
      return { x0, x1, y0, y1 };
    }
    draw() {
      if (!this.c) return;
      const { ctx, w, h } = this.c;
      const o = this.opts;
      const T = Lab.theme();
      this.c.clear(o.bg);
      const r = this.rect;
      const { x0, x1, y0, y1 } = (this.range = this._range());
      const lx0 = o.xLog ? Math.log10(x0) : x0, lx1 = o.xLog ? Math.log10(x1) : x1;
      const ly0 = o.yLog ? Math.log10(y0) : y0, ly1 = o.yLog ? Math.log10(y1) : y1;
      const X = (this.X = (v) => r.x + (((o.xLog ? Math.log10(v) : v) - lx0) / (lx1 - lx0)) * r.w);
      const Y = (this.Y = (v) => r.y + r.h - (((o.yLog ? Math.log10(v) : v) - ly0) / (ly1 - ly0)) * r.h);
      this.invX = (px) => { const t = lx0 + ((px - r.x) / r.w) * (lx1 - lx0); return o.xLog ? 10 ** t : t; };
      this.invY = (py) => { const t = ly0 + ((r.y + r.h - py) / r.h) * (ly1 - ly0); return o.yLog ? 10 ** t : t; };

      ctx.font = `10.5px ${T.mono}`;
      ctx.textBaseline = 'middle';

      // bands
      for (const b of this.bands) {
        const ya = Y(Math.min(y1, Math.max(y0, b.y1)));
        const yb = Y(Math.max(y0, Math.min(y1, b.y0)));
        ctx.fillStyle = b.color;
        ctx.fillRect(r.x, ya, r.w, yb - ya);
      }

      // grid + ticks
      const xt = o.xLog ? logTicks(x0, x1) : { major: M.niceTicks(x0, x1, o.xTicks).ticks, minor: [] };
      const yt = o.yLog ? logTicks(y0, y1) : { major: M.niceTicks(y0, y1, o.yTicks).ticks, minor: [] };
      ctx.lineWidth = 1;
      if (o.grid) {
        ctx.strokeStyle = Lab.alpha('#8ea0d8', 0.06);
        ctx.beginPath();
        for (const v of xt.minor) { const px = Math.round(X(v)) + 0.5; ctx.moveTo(px, r.y); ctx.lineTo(px, r.y + r.h); }
        for (const v of yt.minor) { const py = Math.round(Y(v)) + 0.5; ctx.moveTo(r.x, py); ctx.lineTo(r.x + r.w, py); }
        ctx.stroke();
        ctx.strokeStyle = Lab.alpha('#8ea0d8', 0.12);
        ctx.beginPath();
        for (const v of xt.major) { const px = Math.round(X(v)) + 0.5; ctx.moveTo(px, r.y); ctx.lineTo(px, r.y + r.h); }
        for (const v of yt.major) { const py = Math.round(Y(v)) + 0.5; ctx.moveTo(r.x, py); ctx.lineTo(r.x + r.w, py); }
        ctx.stroke();
      }
      if (o.zeroLine && !o.yLog && y0 < 0 && y1 > 0) {
        ctx.strokeStyle = Lab.alpha('#8ea0d8', 0.3);
        ctx.beginPath();
        const py = Math.round(Y(0)) + 0.5;
        ctx.moveTo(r.x, py);
        ctx.lineTo(r.x + r.w, py);
        ctx.stroke();
      }
      // frame
      ctx.strokeStyle = T.border2;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);

      // tick labels
      ctx.fillStyle = T.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const xf = o.xFormat || ((v) => (o.xLog ? logLabel(Math.round(Math.log10(v))) : fmtTick(v)));
      for (const v of xt.major) {
        const px = X(v);
        if (px < r.x - 1 || px > r.x + r.w + 1) continue;
        const label = xf(v);
        const half = ctx.measureText(label).width / 2;
        ctx.fillText(label, Math.min(w - half - 2, Math.max(half + 2, px)), r.y + r.h + 6);
      }
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const yf = o.yFormat || ((v) => (o.yLog ? logLabel(Math.round(Math.log10(v))) : fmtTick(v)));
      for (const v of yt.major) {
        const py = Y(v);
        if (py < r.y - 1 || py > r.y + r.h + 1) continue;
        ctx.fillText(yf(v), r.x - 7, py);
      }
      // axis labels
      ctx.font = `600 10.5px ${T.sans}`;
      ctx.fillStyle = T.text2;
      if (o.xLabel) {
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(o.xLabel, r.x + r.w, h - 2);
      }
      if (o.yLabel) {
        ctx.save();
        ctx.translate(11, r.y + r.h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(o.yLabel, 0, 0);
        ctx.restore();
      }

      // series (clipped)
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      for (const s of this.series) if (s.visible !== false && s.data) this._drawSeries(s, X, Y, r);

      // reference lines
      for (const hl of this.hlines) {
        if (hl.y < y0 || hl.y > y1) continue;
        const py = Math.round(Y(hl.y)) + 0.5;
        ctx.strokeStyle = hl.color || T.muted;
        ctx.lineWidth = hl.width || 1;
        ctx.setLineDash(hl.dash || [4, 4]);
        ctx.beginPath();
        ctx.moveTo(r.x, py);
        ctx.lineTo(r.x + r.w, py);
        ctx.stroke();
        ctx.setLineDash([]);
        if (hl.label) {
          ctx.font = `10px ${T.mono}`;
          ctx.fillStyle = hl.color || T.muted;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(hl.label, r.x + 6, py - 2);
        }
      }
      for (const vl of this.vlines) {
        if (vl.x < x0 || vl.x > x1) continue;
        const px = Math.round(X(vl.x)) + 0.5;
        ctx.strokeStyle = vl.color || T.muted;
        ctx.lineWidth = vl.width || 1;
        ctx.setLineDash(vl.dash || [4, 4]);
        ctx.beginPath();
        ctx.moveTo(px, r.y);
        ctx.lineTo(px, r.y + r.h);
        ctx.stroke();
        ctx.setLineDash([]);
        if (vl.label) {
          ctx.font = `10px ${T.mono}`;
          ctx.fillStyle = vl.color || T.muted;
          ctx.textAlign = vl.align || 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(vl.label, px + (vl.align === 'right' ? -5 : 5), r.y + 5);
        }
      }
      for (const m of this.markers) {
        const px = X(m.x);
        const py = Y(m.y);
        ctx.fillStyle = m.color || T.accent;
        ctx.strokeStyle = T.bg;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, m.r || 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (m.label) {
          ctx.font = `600 10.5px ${T.mono}`;
          ctx.textAlign = m.align || 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillStyle = m.color || T.accent;
          ctx.fillText(m.label, px + (m.align === 'right' ? -7 : 7), py - 5);
        }
      }
      ctx.restore();

      // legend
      if (o.legend === 'above') {
        const items = this.series.filter((s) => s.name && s.visible !== false && !s.noLegend);
        ctx.font = `500 10.5px ${T.sans}`;
        let x = r.x + r.w;
        const y = Math.max(8, r.y - 10);
        for (let k = items.length - 1; k >= 0; k--) {
          const s = items[k];
          const tw = ctx.measureText(s.name).width;
          x -= tw;
          ctx.fillStyle = T.text2;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(s.name, x, y);
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 2.5;
          ctx.setLineDash(s.dash || []);
          ctx.beginPath();
          ctx.moveTo(x - 20, y);
          ctx.lineTo(x - 6, y);
          ctx.stroke();
          ctx.setLineDash([]);
          x -= 34;
        }
      } else if (o.legend) {
        const items = this.series.filter((s) => s.name && s.visible !== false && !s.noLegend);
        ctx.font = `500 10.5px ${T.sans}`;
        let lw = 0;
        for (const s of items) lw = Math.max(lw, ctx.measureText(s.name).width);
        const bw = lw + 30, bh = items.length * 15 + 8;
        const bx = o.legend === 'tl' ? r.x + 8 : r.x + r.w - bw - 8;
        const by = r.y + 8;
        ctx.fillStyle = Lab.alpha('#060a14', 0.78);
        ctx.strokeStyle = T.border;
        ctx.lineWidth = 1;
        roundRect(ctx, bx, by, bw, bh, 6);
        ctx.fill();
        ctx.stroke();
        items.forEach((s, i) => {
          const yy = by + 11 + i * 15;
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 2.5;
          ctx.setLineDash(s.dash || []);
          ctx.beginPath();
          ctx.moveTo(bx + 7, yy);
          ctx.lineTo(bx + 21, yy);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = T.text2;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(s.name, bx + 26, yy);
        });
      }
      if (o.title) {
        ctx.font = `600 11px ${T.sans}`;
        ctx.fillStyle = T.text2;
        ctx.textAlign = 'left';
        // draw above the plot area when there is room in the top padding, otherwise inside it
        if (o.pad.t >= 18) {
          ctx.textBaseline = 'bottom';
          ctx.fillText(o.title, r.x, r.y - 5);
        } else {
          ctx.textBaseline = 'top';
          ctx.fillText(o.title, r.x + 8, r.y + 7);
        }
      }
    }
    _drawSeries(s, X, Y, r) {
      const ctx = this.c.ctx;
      const d = s.data;
      const ring = !!d.xAt;
      const n = ring ? d.length : d.y.length;
      if (n < 1) return;
      const gx = ring ? (i) => d.xAt(i) : d.x ? (i) => d.x[i] : (i) => i;
      const gy = ring ? (i) => d.yAt(i) : (i) => d.y[i];
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.6;
      ctx.lineJoin = 'round';
      ctx.globalAlpha = s.alpha ?? 1;
      ctx.setLineDash(s.dash || []);
      if (s.points) {
        ctx.fillStyle = s.color;
        for (let i = 0; i < n; i++) {
          const y = gy(i);
          if (!Number.isFinite(y)) continue;
          ctx.beginPath();
          ctx.arc(X(gx(i)), Y(y), s.points, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        return;
      }
      const decimate = n > r.w * 3;
      ctx.beginPath();
      let started = false;
      let firstPx = null, lastPx = null;
      if (!decimate) {
        for (let i = 0; i < n; i++) {
          const y = gy(i);
          if (!Number.isFinite(y)) { started = false; continue; }
          const px = X(gx(i)), py = Y(y);
          if (!started) { ctx.moveTo(px, py); started = true; if (firstPx === null) firstPx = px; }
          else ctx.lineTo(px, py);
          lastPx = px;
        }
      } else {
        // min/max per pixel column
        let col = null, mn = 0, mx = 0, lastY = 0;
        const flush = () => {
          if (col === null) return;
          if (!started) { ctx.moveTo(col, mn); started = true; firstPx = col; }
          else ctx.lineTo(col, mn);
          ctx.lineTo(col, mx);
          ctx.lineTo(col, lastY);
          lastPx = col;
        };
        for (let i = 0; i < n; i++) {
          const y = gy(i);
          if (!Number.isFinite(y)) continue;
          const px = Math.round(X(gx(i)));
          const py = Y(y);
          if (px !== col) {
            flush();
            col = px; mn = py; mx = py;
          } else {
            if (py < mn) mn = py;
            if (py > mx) mx = py;
          }
          lastY = py;
        }
        flush();
      }
      ctx.stroke();
      if (s.fill && started && firstPx !== null) {
        const base = Y(s.fillTo ?? Math.max(this.range.y0, Math.min(this.range.y1, 0)));
        ctx.lineTo(lastPx, base);
        ctx.lineTo(firstPx, base);
        ctx.closePath();
        ctx.fillStyle = s.fill;
        ctx.globalAlpha = 1;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }
  }
  function fmtTick(v) {
    const a = Math.abs(v);
    let s;
    if (a === 0) s = '0';
    else if (a >= 1e5 || a < 1e-3) s = v.toExponential(0);
    else s = String(+v.toPrecision(4));
    return s.replace('-', '−');
  }
  function logTicks(lo, hi) {
    const major = [], minor = [];
    const e0 = Math.floor(Math.log10(lo)), e1 = Math.ceil(Math.log10(hi));
    for (let e = e0; e <= e1; e++) {
      const base = 10 ** e;
      if (base >= lo * 0.999 && base <= hi * 1.001) major.push(base);
      for (let k = 2; k <= 9; k++) {
        const v = k * base;
        if (v >= lo && v <= hi) minor.push(v);
      }
    }
    return { major, minor };
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  Lab.Plot = Plot;
  Lab.roundRect = roundRect;

  // ------------------------------------------------------------ misc canvas helpers
  /** Draws an arrow from (x0,y0) to (x1,y1). */
  Lab.arrow = function (ctx, x0, y0, x1, y1, head = 8) {
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - head * Math.cos(a - 0.45), y1 - head * Math.sin(a - 0.45));
    ctx.lineTo(x1 - head * Math.cos(a + 0.45), y1 - head * Math.sin(a + 0.45));
    ctx.closePath();
    ctx.fill();
  };

  /** Save a canvas as PNG. */
  Lab.downloadCanvas = function (canvas, filename) {
    const a = document.createElement('a');
    a.download = filename;
    a.href = canvas.toDataURL('image/png');
    a.click();
  };
  /** Save text/JSON. */
  Lab.downloadText = function (text, filename, type = 'application/json') {
    const a = document.createElement('a');
    a.download = filename;
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  /** Common boot: icons + drawer. */
  Lab.boot = function () {
    Lab.applyIcons();
    Lab.initDrawer();
  };

  window.Lab = Lab;
})();
