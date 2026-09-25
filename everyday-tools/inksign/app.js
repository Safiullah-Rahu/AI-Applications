/* ==========================================================================
   InkSign — signature studio (draw / type / photo), signature library and
   document signing (pdf.js to view, pdf-lib to write). Runs fully offline.
   ========================================================================== */
(function () {
  'use strict';
  const S = window.SignCore;
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const pdfjsLib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
  if (pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;

  const PAD_UNITS = 1000; // pad strokes live in a 1000-unit-wide virtual space (resolution independent)
  const TEXT_FS = 0.7; // text fields: font size as a fraction of the box height
  const TEXT_BASE = 0.742; // …and the baseline position from the top of the box
  const LIB_KEY = 'inksign-library-v1';
  const PREF_KEY = 'inksign-prefs-v1';
  const FONTS = [
    { family: 'Great Vibes', label: 'Great Vibes', scale: 1 },
    { family: 'Dancing Script', label: 'Dancing Script', scale: 0.86, weight: 600 },
    { family: 'Allura', label: 'Allura', scale: 1.05 },
    { family: 'Sacramento', label: 'Sacramento', scale: 1.08 },
    { family: 'Caveat', label: 'Caveat', scale: 0.95, weight: 500 },
  ];

  const state = {
    tab: 'studio',
    mode: 'draw',
    kind: 'sig',
    ink: '#111827',
    font: 0,
    strokes: [],
    cur: null,
    upload: null,
    out: null, // {canvas, url}
    lib: [],
    active: { sig: null, ini: null },
    remember: true,
    doc: null,
    fields: [],
    sel: null,
    armed: null,
    zoom: 1,
    helv: null,
  };
  let nextId = 1;

  // ================================================================== storage
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } },
  };
  function persist() {
    store.set(PREF_KEY, { remember: state.remember, ink: state.ink, font: state.font, dateFmt: selDate.value, signer: $('in-signer').value });
    if (!state.remember) return store.del(LIB_KEY);
    const ok = store.set(LIB_KEY, { items: state.lib, sig: state.active.sig && state.active.sig.id, ini: state.active.ini && state.active.ini.id });
    if (!ok) Lab.toast('Browser storage is full or blocked; signatures are kept for this session only.');
  }

  // ================================================================== controls
  const segTab = Lab.seg('seg-tab', (v) => setTab(v));
  const segMode = Lab.seg('seg-mode', (v) => setMode(v));
  const segKind = Lab.seg('seg-kind', (v) => { state.kind = v; syncStudio(); });
  const slPen = Lab.range('sl-pen', { format: (v) => v.toFixed(2) + '×', onInput: () => renderPad() });
  const slPress = Lab.range('sl-press', { format: (v) => Math.round(v * 100) + '%', onInput: () => renderPad() });
  const slSlant = Lab.range('sl-slant', { format: (v) => v + '°', onInput: () => syncStudio() });
  const slThr = Lab.range('sl-thr', { format: (v) => String(v), onInput: () => processUpload() });
  const tgRecolor = Lab.toggle('tg-recolor', () => processUpload());
  const tgCert = Lab.toggle('tg-cert');
  const tgRemember = Lab.toggle('tg-remember', (v) => {
    state.remember = v;
    persist();
    Lab.toast(v ? 'Signatures will be remembered in this browser.' : 'Saved signatures were removed from this browser.');
  });
  const segZoom = Lab.seg('seg-zoom', (v) => { state.zoom = parseFloat(v); layoutPages(); });
  const selDate = $('sel-date');
  const today = new Date();
  for (const [k, f] of Object.entries(S.DATE_FORMATS)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = f.f(today);
    selDate.appendChild(o);
  }
  selDate.value = (navigator.language || 'en-US') === 'en-US' ? 'us' : 'long';

  // ================================================================== tabs & modes
  function setTab(t) {
    state.tab = t;
    segTab.set(t);
    $('view-studio').classList.toggle('hidden', t !== 'studio');
    $('view-doc').classList.toggle('hidden', t !== 'doc');
    $$('.for-studio').forEach((e) => e.classList.toggle('hidden', t !== 'studio'));
    $$('.for-doc').forEach((e) => e.classList.toggle('hidden', t !== 'doc'));
    disarm();
    if (t === 'studio') requestAnimationFrame(() => { sizePad(); renderPad(); });
    else layoutPages();
  }
  function setMode(m) {
    state.mode = m;
    segMode.set(m);
    for (const k of ['draw', 'type', 'upload']) $$('.mode-' + k).forEach((e) => e.classList.toggle('hidden', k !== m));
    $('btn-clear').classList.toggle('hidden', m === 'type');
    $('paper').classList.toggle('checker', m === 'upload');
    syncStudio();
  }
  function syncStudio() {
    const what = state.kind === 'ini' ? 'initials' : 'signature';
    const titles = { draw: `Draw your ${what}`, type: `Type your ${what}`, upload: `Photo or scan of your ${what}` };
    Lab.text('pad-title', titles[state.mode]);
    Lab.text('guide-label', state.mode === 'draw' ? `Sign above the line` : '');
    $('paper').querySelector('.guide').classList.toggle('hidden', state.mode === 'upload');
    $('btn-save').querySelector('span').textContent = `Save & use as my ${what}`;
    $('btn-svg').disabled = state.mode !== 'draw';
    renderFontCards();
    renderPad();
    scheduleOutput();
  }

  // ================================================================== ink colour
  function setInk(c, fromCustom) {
    state.ink = c;
    $$('.swatch').forEach((b) => b.classList.toggle('active', b.dataset.color === c));
    if (!fromCustom && !$$('.swatch').some((b) => b.dataset.color === c)) $('ink-custom').value = c;
    renderFontCards();
    if (state.mode === 'upload') processUpload();
    else { renderPad(); scheduleOutput(); }
  }
  $$('.swatch').forEach((b) => b.addEventListener('click', () => setInk(b.dataset.color)));
  $('ink-custom').addEventListener('input', (e) => setInk(e.target.value, true));

  // ================================================================== pad (drawing surface)
  const padCv = $('cv-pad');
  const padCtx = padCv.getContext('2d');
  const pad = { w: 1, h: 1, dpr: 1, k: 1 }; // k = CSS px per pad unit
  function sizePad() {
    const r = padCv.getBoundingClientRect();
    if (!r.width) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (Math.round(r.width) === pad.w && Math.round(r.height) === pad.h && dpr === pad.dpr) return false;
    pad.w = Math.round(r.width);
    pad.h = Math.round(r.height);
    pad.dpr = dpr;
    pad.k = pad.w / PAD_UNITS;
    padCv.width = Math.round(pad.w * dpr);
    padCv.height = Math.round(pad.h * dpr);
    return true;
  }
  new ResizeObserver(() => { if (sizePad()) renderPad(); }).observe(padCv);

  function penOpts() {
    const maxW = 7.2 * slPen.value;
    return { maxW, minW: maxW * (1 - 0.78 * slPress.value), speedRef: 2.6, smoothing: 0.3 };
  }
  /** Finalise geometry of a stroke (smoothed points + widths, pressure-aware). */
  function strokeGeom(s) {
    const w = S.strokeWidths(s.points, penOpts());
    if (s.pen) {
      const maxW = penOpts().maxW;
      s.points.forEach((p, i) => { w[i] = maxW * (0.25 + 0.95 * (p.p || 0.5)) * 0.6 + w[i] * 0.4; });
    }
    return { points: S.smoothPoints(s.points), widths: w };
  }
  function geomStrokes() {
    const all = state.cur ? [...state.strokes, state.cur] : state.strokes;
    return all.map(strokeGeom);
  }
  function renderPad() {
    const ctx = padCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, padCv.width, padCv.height);
    const empty = $('pad-empty');
    empty.classList.add('hidden');
    if (state.mode === 'draw') {
      ctx.setTransform(pad.k * pad.dpr, 0, 0, pad.k * pad.dpr, 0, 0);
      ctx.fillStyle = state.ink;
      for (const g of geomStrokes()) ctx.fill(new Path2D(S.strokeOutline(g.points, g.widths)));
      if (!state.strokes.length && !state.cur) { empty.textContent = 'Sign here with your mouse, finger or stylus'; empty.classList.remove('hidden'); }
    } else if (state.mode === 'type') {
      const text = typedText();
      const f = FONTS[state.font];
      ctx.setTransform(pad.dpr, 0, 0, pad.dpr, 0, 0);
      let size = pad.h * 0.42 * f.scale;
      ctx.font = fontCss(f, size);
      const w = ctx.measureText(text).width;
      if (w > pad.w * 0.8) size *= (pad.w * 0.8) / w;
      ctx.font = fontCss(f, size);
      ctx.fillStyle = state.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.translate(pad.w / 2, pad.h * 0.72);
      ctx.transform(1, 0, -Math.tan((slSlant.value * Math.PI) / 180), 1, 0, 0);
      ctx.fillText(text, 0, 0);
      if (!text) { empty.textContent = 'Type your name in the sidebar'; empty.classList.remove('hidden'); }
    } else {
      const u = state.upload;
      if (!u) { empty.textContent = 'Drop a photo of your signature here'; empty.classList.remove('hidden'); return; }
      ctx.setTransform(pad.dpr, 0, 0, pad.dpr, 0, 0);
      const s = Math.min((pad.w * 0.92) / u.w, (pad.h * 0.88) / u.h);
      ctx.drawImage(u.processed, (pad.w - u.w * s) / 2, (pad.h - u.h * s) / 2, u.w * s, u.h * s);
    }
  }
  const fontCss = (f, size) => `${f.weight || 400} ${size}px "${f.family}"`;
  const typedText = () => {
    const name = $('in-name').value.trim();
    return state.kind === 'ini' ? S.initialsOf(name) : name;
  };

  // --- pointer drawing
  let drawing = null;
  padCv.addEventListener('pointerdown', (e) => {
    if (state.mode !== 'draw' || e.button > 0) return;
    e.preventDefault();
    padCv.setPointerCapture(e.pointerId);
    drawing = e.pointerId;
    state.cur = { points: [], pen: e.pointerType === 'pen' && e.pressure > 0 && e.pressure !== 0.5 };
    addPoint(e);
    renderPad();
  });
  padCv.addEventListener('pointermove', (e) => {
    if (drawing !== e.pointerId || !state.cur) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of evs.length ? evs : [e]) addPoint(ce);
    renderPad();
  });
  const endStroke = (e) => {
    if (drawing !== e.pointerId || !state.cur) return;
    drawing = null;
    if (state.cur.points.length) state.strokes.push(state.cur);
    state.cur = null;
    renderPad();
    scheduleOutput();
  };
  padCv.addEventListener('pointerup', endStroke);
  padCv.addEventListener('pointercancel', endStroke);
  function addPoint(e) {
    const r = padCv.getBoundingClientRect();
    const p = { x: (e.clientX - r.left) / pad.k, y: (e.clientY - r.top) / pad.k, t: e.timeStamp, p: e.pressure };
    const pts = state.cur.points;
    const last = pts[pts.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.9) return;
    pts.push(p);
  }
  $('btn-undo').addEventListener('click', undo);
  function undo() {
    state.strokes.pop();
    renderPad();
    scheduleOutput();
  }
  $('btn-clear').addEventListener('click', () => {
    if (state.mode === 'draw') state.strokes = [];
    else if (state.mode === 'upload') state.upload = null;
    renderPad();
    scheduleOutput();
  });

  // ================================================================== typing
  function renderFontCards() {
    const host = $('fonts');
    const text = typedText() || 'Your Name';
    if (host.children.length !== FONTS.length) {
      host.innerHTML = '';
      FONTS.forEach((f, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'font-card';
        b.innerHTML = `<span class="sample"></span><span class="nm">${f.label}</span>`;
        b.addEventListener('click', () => { state.font = i; syncStudio(); persist(); });
        host.appendChild(b);
      });
    }
    Array.from(host.children).forEach((b, i) => {
      const f = FONTS[i];
      const s = b.querySelector('.sample');
      s.textContent = text;
      s.style.fontFamily = `"${f.family}"`;
      s.style.fontWeight = f.weight || 400;
      s.style.color = state.ink;
      s.style.transform = `skewX(${-slSlant.value}deg)`;
      b.classList.toggle('active', i === state.font);
    });
  }
  $('in-name').addEventListener('input', () => { renderFontCards(); renderPad(); scheduleOutput(); });
  if (document.fonts) document.fonts.ready.then(() => { renderPad(); scheduleOutput(); });
  const loadFonts = () => Promise.all(FONTS.map((f) => (document.fonts ? document.fonts.load(fontCss(f, 40)) : null))).catch(() => null);

  // ================================================================== photo / scan
  $('btn-pick-sig').addEventListener('click', () => $('file-sig').click());
  $('file-sig').addEventListener('change', (e) => { if (e.target.files[0]) loadSigImage(e.target.files[0]); e.target.value = ''; });
  const paper = $('paper');
  paper.addEventListener('dragover', (e) => { e.preventDefault(); paper.classList.add('dragging'); });
  paper.addEventListener('dragleave', () => paper.classList.remove('dragging'));
  paper.addEventListener('drop', (e) => {
    e.preventDefault();
    paper.classList.remove('dragging');
    const f = e.dataTransfer.files[0];
    if (f && /^image\//.test(f.type)) { setMode('upload'); loadSigImage(f); }
  });
  $('btn-auto').addEventListener('click', (e) => {
    e.preventDefault();
    if (!state.upload) return Lab.toast('Choose a photo first.');
    slThr.set(state.upload.auto);
    processUpload();
  });

  async function loadSigImage(file) {
    let img;
    try { img = await fileToImage(file); } catch (err) { return Lab.toast('Could not read that image.'); }
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const src = document.createElement('canvas');
    src.width = w; src.height = h;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(img, 0, 0, w, h);
    // flatten uneven lighting: divide by a heavily blurred copy (the paper background estimate)
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(w / 28)); small.height = Math.max(1, Math.round(h / 28));
    const smctx = small.getContext('2d');
    smctx.filter = 'blur(1.5px)';
    smctx.drawImage(src, 0, 0, small.width, small.height);
    const bg = document.createElement('canvas');
    bg.width = w; bg.height = h;
    const bctx = bg.getContext('2d', { willReadFrequently: true });
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(small, 0, 0, w, h);
    const orig = sctx.getImageData(0, 0, w, h).data;
    const bgd = bctx.getImageData(0, 0, w, h).data;
    const norm = new Uint8ClampedArray(orig.length);
    for (let i = 0; i < orig.length; i += 4) {
      const L = 0.299 * orig[i] + 0.587 * orig[i + 1] + 0.114 * orig[i + 2];
      const B = Math.max(40, 0.299 * bgd[i] + 0.587 * bgd[i + 1] + 0.114 * bgd[i + 2]);
      const n = Math.min(255, (L / B) * 240);
      norm[i] = norm[i + 1] = norm[i + 2] = n;
      norm[i + 3] = 255;
    }
    const auto = clamp(S.otsu(norm) + 20, 60, 245);
    const processed = document.createElement('canvas');
    processed.width = w; processed.height = h;
    state.upload = { w, h, orig, norm, auto, processed };
    slThr.set(auto);
    setMode('upload');
    processUpload();
  }
  function processUpload() {
    const u = state.upload;
    if (!u) return;
    const px = new Uint8ClampedArray(u.norm);
    S.cleanInk(px, { threshold: slThr.value, softness: 45, recolor: tgRecolor.value ? S.hexRgb(state.ink) : null });
    if (!tgRecolor.value) for (let i = 0; i < px.length; i += 4) { px[i] = u.orig[i]; px[i + 1] = u.orig[i + 1]; px[i + 2] = u.orig[i + 2]; }
    u.px = px;
    u.processed.getContext('2d').putImageData(new ImageData(px, u.w, u.h), 0, 0);
    renderPad();
    scheduleOutput();
  }

  // ================================================================== output (trimmed transparent PNG)
  let outTimer = 0;
  function scheduleOutput() {
    clearTimeout(outTimer);
    outTimer = setTimeout(buildOutput, 60);
  }
  /** Current studio signature as a tight, transparent canvas (null when empty). */
  function studioCanvas() {
    if (state.mode === 'draw') {
      const geo = state.strokes.map(strokeGeom);
      const bb = S.strokesBBox(geo);
      if (!bb) return null;
      const k = 1.6;
      const padU = 4;
      const c = document.createElement('canvas');
      c.width = Math.ceil((bb.w + 2 * padU) * k);
      c.height = Math.ceil((bb.h + 2 * padU) * k);
      const ctx = c.getContext('2d');
      ctx.setTransform(k, 0, 0, k, -(bb.x - padU) * k, -(bb.y - padU) * k);
      ctx.fillStyle = state.ink;
      for (const g of geo) ctx.fill(new Path2D(S.strokeOutline(g.points, g.widths)));
      return c;
    }
    if (state.mode === 'type') {
      const text = typedText();
      if (!text) return null;
      return textCanvas(text, FONTS[state.font], 150, state.ink, slSlant.value);
    }
    const u = state.upload;
    if (!u || !u.px) return null;
    return trimCanvas(u.processed, u.px, u.w, u.h, 4);
  }
  function textCanvas(text, f, size, color, slant = 0) {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.font = fontCss(f, size);
    const w = Math.ceil(ctx.measureText(text).width + size * 1.2);
    c.width = w; c.height = Math.ceil(size * 1.9);
    ctx.font = fontCss(f, size);
    ctx.fillStyle = color;
    ctx.textBaseline = 'alphabetic';
    ctx.translate(size * 0.6, size * 1.3);
    ctx.transform(1, 0, -Math.tan((slant * Math.PI) / 180), 1, 0, 0);
    ctx.fillText(text, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    return trimCanvas(c, d, c.width, c.height, 6);
  }
  function trimCanvas(src, rgba, w, h, padPx) {
    const bb = S.alphaBBox(rgba, w, h, 10);
    if (!bb) return null;
    const c = document.createElement('canvas');
    c.width = bb.w + 2 * padPx;
    c.height = bb.h + 2 * padPx;
    c.getContext('2d').drawImage(src, bb.x, bb.y, bb.w, bb.h, padPx, padPx, bb.w, bb.h);
    return c;
  }
  function buildOutput() {
    const c = studioCanvas();
    const prev = $('out-prev');
    const usage = $('usage-sig');
    Lab.text('usage-date', S.DATE_FORMATS[selDate.value].f(new Date()));
    if (!c) {
      state.out = null;
      prev.innerHTML = '<span class="none">Your signature will appear here</span>';
      usage.innerHTML = '';
      Lab.text('out-sub', '');
      Lab.text('pad-sub', '');
      return;
    }
    const url = c.toDataURL('image/png');
    state.out = { canvas: c, url };
    prev.innerHTML = `<img alt="Signature preview" src="${url}" />`;
    usage.innerHTML = `<img alt="" src="${url}" />`;
    Lab.text('out-sub', `${c.width} × ${c.height} px · transparent`);
    Lab.text('pad-sub', state.mode === 'draw' ? `${state.strokes.length} stroke${state.strokes.length === 1 ? '' : 's'}` : '');
  }

  // --- exports
  const baseName = () => (state.kind === 'ini' ? 'initials' : 'signature');
  function need() {
    if (!state.out) { Lab.toast('Create a signature first.'); return false; }
    return true;
  }
  $('btn-png').addEventListener('click', () => {
    if (!need()) return;
    // 3× the on-screen size for crisp printing
    const src = state.out.canvas;
    const k = state.mode === 'draw' ? 1.9 : 1;
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
    const ctx = c.getContext('2d');
    if (state.mode === 'draw') {
      const geo = state.strokes.map(strokeGeom);
      const bb = S.strokesBBox(geo);
      const kk = 1.6 * k;
      ctx.setTransform(kk, 0, 0, kk, -(bb.x - 4) * kk, -(bb.y - 4) * kk);
      ctx.fillStyle = state.ink;
      for (const g of geo) ctx.fill(new Path2D(S.strokeOutline(g.points, g.widths)));
    } else ctx.drawImage(src, 0, 0, c.width, c.height);
    c.toBlob((b) => downloadBlob(b, `${baseName()}.png`), 'image/png');
  });
  $('btn-svg').addEventListener('click', () => {
    if (!need()) return;
    if (state.mode !== 'draw') return Lab.toast('SVG export is available for drawn signatures.');
    const svg = S.strokesToSVG(state.strokes.map(strokeGeom), state.ink, 4);
    Lab.downloadText(svg, `${baseName()}.svg`, 'image/svg+xml');
  });
  $('btn-copy').addEventListener('click', async () => {
    if (!need()) return;
    try {
      const blob = await new Promise((r) => state.out.canvas.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      Lab.toast('Copied: paste it into Word, Docs or an email.');
    } catch (e) {
      Lab.toast('Clipboard is not available here; use PNG instead.');
    }
  });
  $('btn-save').addEventListener('click', () => {
    if (!need()) return;
    const c = state.out.canvas;
    // keep stored images compact: ≤ 900 px wide
    const k = Math.min(1, 900 / c.width);
    let png = state.out.url;
    let w = c.width;
    let h = c.height;
    if (k < 1) {
      const d = document.createElement('canvas');
      d.width = Math.round(c.width * k); d.height = Math.round(c.height * k);
      d.getContext('2d').drawImage(c, 0, 0, d.width, d.height);
      png = d.toDataURL('image/png'); w = d.width; h = d.height;
    }
    const item = { id: 'i' + Date.now().toString(36) + (nextId++), kind: state.kind, png, w, h, created: Date.now() };
    state.lib.unshift(item);
    const same = state.lib.filter((x) => x.kind === item.kind);
    if (same.length > 6) state.lib = state.lib.filter((x) => x !== same[same.length - 1]);
    state.active[item.kind] = item;
    persist();
    renderLibrary();
    Lab.toast(`Saved. Now open “Sign a document” to place your ${item.kind === 'ini' ? 'initials' : 'signature'}.`);
  });

  // ================================================================== library
  function renderLibrary() {
    const host = $('lib');
    host.innerHTML = '';
    if (!state.lib.length) host.innerHTML = '<div class="lib-empty">Nothing saved yet. Create a signature and press “Save &amp; use”.</div>';
    for (const it of state.lib) {
      const d = document.createElement('div');
      d.className = 'lib-item' + (state.active[it.kind] === it ? ' active' : '');
      d.title = 'Use for signing';
      d.innerHTML = `<span class="tag">${it.kind === 'ini' ? 'Initials' : 'Signature'}${state.active[it.kind] === it ? ' · in use' : ''}</span><img alt="" src="${it.png}" /><button class="del" title="Delete">×</button>`;
      d.addEventListener('click', (e) => {
        if (e.target.classList.contains('del')) {
          state.lib = state.lib.filter((x) => x !== it);
          if (state.active[it.kind] === it) state.active[it.kind] = state.lib.find((x) => x.kind === it.kind) || null;
        } else state.active[it.kind] = it;
        persist();
        renderLibrary();
      });
      host.appendChild(d);
    }
    Lab.text('lib-count', state.lib.length ? `${state.lib.length} saved` : '');
    for (const k of ['sig', 'ini']) {
      const t = $('thumb-' + k);
      t.classList.toggle('hidden', !state.active[k]);
      if (state.active[k]) t.src = state.active[k].png;
    }
  }

  // ================================================================== documents
  const docBody = $('doc-body');
  const pagesEl = $('pages');
  $('btn-open').addEventListener('click', () => $('file-doc').click());
  $('btn-open2').addEventListener('click', () => $('file-doc').click());
  $('file-doc').addEventListener('change', (e) => { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ''; });
  $('btn-sample').addEventListener('click', () => loadSample());
  docBody.addEventListener('dragover', (e) => { e.preventDefault(); docBody.classList.add('over'); });
  docBody.addEventListener('dragleave', (e) => { if (e.target === docBody) docBody.classList.remove('over'); });
  docBody.addEventListener('drop', (e) => {
    e.preventDefault();
    docBody.classList.remove('over');
    if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
  });
  // a file dropped anywhere else should not navigate away from the page
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  async function openFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      if (isPdf(file)) await loadPdf(bytes, file.name, bytes, false);
      else if (/^image\/(png|jpe?g|webp)$/.test(file.type)) await loadPdf(await imageToPdf(file), file.name, bytes, true);
      else return Lab.toast('Please choose a PDF, JPG, PNG or WebP file.');
    } catch (err) {
      console.error(err);
      Lab.toast(err && err.name === 'PasswordException' ? 'This PDF is password-protected. Remove the password first, then sign it.' : 'Could not open that file.', 4200);
    }
  }
  async function fileToImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  /** Photo or scan of a paper document → single-page PDF (EXIF orientation applied by the browser). */
  async function imageToPdf(file) {
    const img = await fileToImage(file);
    const k = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const png = file.type === 'image/png';
    const data = await blobBytes(await new Promise((r) => c.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.9)));
    const pdf = await PDFDocument.create();
    const emb = png ? await pdf.embedPng(data) : await pdf.embedJpg(data);
    const s = Math.min(0.75, 842 / Math.max(c.width, c.height)); // ≈ A4 on the long side
    const page = pdf.addPage([c.width * s, c.height * s]);
    page.drawImage(emb, { x: 0, y: 0, width: c.width * s, height: c.height * s });
    pdf.setTitle(file.name.replace(/\.[^.]+$/, ''));
    return pdf.save();
  }
  const blobBytes = async (b) => new Uint8Array(await b.arrayBuffer());

  async function loadPdf(pdfBytes, name, originalBytes, fromImage) {
    if (!pdfjsLib) throw new Error('pdf.js missing');
    const task = pdfjsLib.getDocument({ data: pdfBytes.slice(), isEvalSupported: false });
    const pdf = await task.promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      pages.push({ index: i - 1, proxy: p, dw: vp.width, dh: vp.height, rot: p.rotate, el: null, cv: null, rendered: 0, task: null });
    }
    if (state.doc && state.doc.pdf) state.doc.pdf.destroy();
    state.doc = { name, pdfBytes, originalBytes, fromImage, pdf, pages, hash: null };
    state.fields = [];
    state.sel = null;
    $('done').classList.add('hidden');
    sha256(originalBytes).then((h) => { if (state.doc && state.doc.originalBytes === originalBytes) state.doc.hash = h; });
    Lab.text('doc-title', name);
    Lab.text('doc-sub', `${pages.length} page${pages.length > 1 ? 's' : ''}${fromImage ? ' · image converted to PDF' : ''}`);
    buildPages();
    setTab('doc');
    syncSelected();
    return state.doc;
  }
  async function sha256(bytes) {
    try { return S.toHex(await crypto.subtle.digest('SHA-256', bytes)); } catch (e) { return null; }
  }

  // --- page views
  let io = null;
  function buildPages() {
    pagesEl.innerHTML = '';
    if (io) io.disconnect();
    io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) renderPage(pageOf(en.target)); }), { root: docBody, rootMargin: '600px 0px' });
    for (const pg of state.doc.pages) {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.page = pg.index;
      el.innerHTML = `<span class="pno">${pg.index + 1} / ${state.doc.pages.length}</span>`;
      const cv = document.createElement('canvas');
      el.appendChild(cv);
      pg.el = el; pg.cv = cv; pg.rendered = 0;
      el.addEventListener('pointerdown', (e) => onPagePointer(e, pg));
      pagesEl.appendChild(el);
      io.observe(el);
    }
    layoutPages();
  }
  const pageOf = (el) => state.doc.pages[+el.dataset.page];
  function layoutPages() {
    const doc = state.doc;
    if (!doc || state.tab !== 'doc') return;
    const avail = Math.max(240, docBody.clientWidth - 40);
    const maxDw = Math.max(...doc.pages.map((p) => p.dw));
    const fit = Math.min(avail, 880);
    for (const pg of doc.pages) {
      const w = Math.round(fit * state.zoom * (pg.dw / maxDw));
      pg.cssW = w;
      pg.cssH = Math.round((w * pg.dh) / pg.dw);
      pg.el.style.width = w + 'px';
      pg.el.style.height = pg.cssH + 'px';
      const r = pg.el.getBoundingClientRect();
      const b = docBody.getBoundingClientRect();
      if (r.bottom > b.top - 600 && r.top < b.bottom + 600) renderPage(pg);
    }
    renderFields();
  }
  async function renderPage(pg) {
    if (!pg || !pg.cssW) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const target = Math.min(4096, Math.round(pg.cssW * dpr));
    if (pg.rendered === target) return;
    if (pg.task) { try { pg.task.cancel(); } catch (e) { /* already finished */ } }
    pg.rendered = target;
    const vp = pg.proxy.getViewport({ scale: target / pg.dw });
    const off = document.createElement('canvas');
    off.width = Math.round(vp.width); off.height = Math.round(vp.height);
    const task = pg.proxy.render({ canvasContext: off.getContext('2d'), viewport: vp });
    pg.task = task;
    try {
      await task.promise;
      pg.cv.width = off.width; pg.cv.height = off.height;
      pg.cv.getContext('2d').drawImage(off, 0, 0);
    } catch (e) {
      if (!e || e.name !== 'RenderingCancelledException') console.error(e);
      if (pg.rendered === target) pg.rendered = 0;
    } finally {
      if (pg.task === task) pg.task = null;
    }
  }
  new ResizeObserver(() => {
    clearTimeout(layoutPages.t);
    layoutPages.t = setTimeout(layoutPages, 120);
  }).observe(docBody);

  // ================================================================== fields
  // Field: {id, page, type: sig|ini|check|name|date|text, fx, fy, fw, fh (fractions of the displayed page), src?, text?, color}
  function measureText(text, sizePt) {
    if (state.helv) return state.helv.widthOfTextAtSize(text || ' ', sizePt);
    const c = measureText.c || (measureText.c = document.createElement('canvas').getContext('2d'));
    c.font = `${sizePt}px Helvetica, Arial, sans-serif`;
    return c.measureText(text || ' ').width;
  }
  function fitText(f) {
    const pg = state.doc.pages[f.page];
    const sizePt = f.fh * pg.dh * TEXT_FS;
    f.fw = Math.min(1 - f.fx, (measureText(f.text, sizePt) + sizePt * 0.1) / pg.dw);
  }
  function checkPng(color) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.strokeStyle = color;
    ctx.lineWidth = 17;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(20, 68); ctx.lineTo(50, 100); ctx.lineTo(108, 26);
    ctx.stroke();
    return c.toDataURL('image/png');
  }
  function textFor(type) {
    if (type === 'date') return S.DATE_FORMATS[selDate.value].f(new Date());
    if (type === 'name') return $('in-signer').value.trim() || 'Your name';
    return 'Text';
  }
  /** Create a field centred at (u, v) (fractions of the displayed page). */
  function addField(type, pageIndex, u, v, extra = {}) {
    const pg = state.doc.pages[pageIndex];
    const f = { id: 'f' + nextId++, page: pageIndex, type, color: state.ink, auto: true };
    if (type === 'sig' || type === 'ini') {
      const a = state.active[type];
      f.src = a.png;
      const hPt = type === 'sig' ? 44 : 28;
      let wPt = (hPt * a.w) / a.h;
      const maxW = type === 'sig' ? 190 : 80;
      const s = wPt > maxW ? maxW / wPt : 1;
      wPt *= s;
      f.fw = wPt / pg.dw;
      f.fh = (hPt * s) / pg.dh;
    } else if (type === 'check') {
      f.src = checkPng(state.ink);
      f.fw = 14 / pg.dw;
      f.fh = 14 / pg.dh;
    } else {
      f.text = textFor(type);
      f.fh = 11 / TEXT_FS / pg.dh; // 11 pt text
      f.fx = 0;
      fitText(f);
    }
    f.fx = clamp(u - f.fw / 2, 0, 1 - f.fw);
    f.fy = clamp(v - f.fh / 2, 0, 1 - f.fh);
    Object.assign(f, extra);
    state.fields.push(f);
    return f;
  }
  function onPagePointer(e, pg) {
    if (e.target.closest('.item')) return;
    const r = pg.el.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    if (state.armed) {
      const f = addField(state.armed, pg.index, u, v);
      if (!e.shiftKey) disarm();
      select(f.id);
      renderFields();
      if (f.type === 'text') setTimeout(() => { $('sel-text').focus(); $('sel-text').select(); }, 0);
    } else if (state.sel) {
      select(null);
      renderFields();
    }
  }

  function renderFields() {
    if (!state.doc) return;
    $$('.item').forEach((e) => e.remove());
    for (const f of state.fields) {
      const pg = state.doc.pages[f.page];
      const el = document.createElement('div');
      el.className = 'item' + (f.id === state.sel ? ' sel' : '');
      el.dataset.id = f.id;
      if (f.src) el.innerHTML = `<img alt="" src="${f.src}" />`;
      else {
        const t = document.createElement('span');
        t.className = 'txt';
        t.textContent = f.text;
        t.style.color = f.color;
        el.appendChild(t);
      }
      el.insertAdjacentHTML('beforeend', '<span class="h" title="Resize"></span><span class="x" title="Delete">×</span>');
      placeEl(el, f, pg);
      el.addEventListener('pointerdown', (e) => onItemPointer(e, f, el));
      pg.el.appendChild(el);
    }
  }
  function placeEl(el, f, pg) {
    el.style.left = f.fx * 100 + '%';
    el.style.top = f.fy * 100 + '%';
    el.style.width = f.fw * 100 + '%';
    el.style.height = f.fh * 100 + '%';
    const t = el.querySelector('.txt');
    if (t) {
      const hPx = f.fh * (pg.cssH || 1);
      t.style.fontSize = hPx * TEXT_FS + 'px';
      t.style.lineHeight = hPx + 'px';
    }
  }
  function onItemPointer(e, f, el) {
    e.preventDefault();
    e.stopPropagation();
    if (e.target.classList.contains('x')) return removeField(f.id);
    if (state.sel !== f.id) {
      select(f.id);
      $$('.item.sel').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
    }
    const pg = state.doc.pages[f.page];
    const r = pg.el.getBoundingClientRect();
    const resize = e.target.classList.contains('h');
    const start = { x: e.clientX, y: e.clientY, fx: f.fx, fy: f.fy, fw: f.fw, fh: f.fh };
    el.setPointerCapture(e.pointerId);
    el.style.cursor = resize ? 'nwse-resize' : 'grabbing';
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / r.width;
      const dy = (ev.clientY - start.y) / r.height;
      if (resize) {
        // keep the aspect ratio: scale by the larger relative change
        const s = clamp(Math.max((start.fw + dx) / start.fw, (start.fh + dy) / start.fh), 0.2, 8);
        const s2 = Math.min(s, (1 - f.fx) / start.fw, (1 - f.fy) / start.fh);
        f.fw = start.fw * s2;
        f.fh = start.fh * s2;
      } else {
        f.fx = clamp(start.fx + dx, 0, 1 - f.fw);
        f.fy = clamp(start.fy + dy, 0, 1 - f.fh);
      }
      placeEl(el, f, pg);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.style.cursor = '';
      syncSelected();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  function select(id) {
    state.sel = id;
    syncSelected();
  }
  const fieldById = (id) => state.fields.find((f) => f.id === id);
  const TYPE_NAMES = { sig: 'Signature', ini: 'Initials', name: 'Name', date: 'Date', text: 'Text', check: 'Checkmark' };
  function syncSelected() {
    const f = fieldById(state.sel);
    $('sel-text-wrap').classList.toggle('hidden', !f || !!f.src);
    $('sel-actions').classList.toggle('hidden', !f);
    if (!f) return Lab.text('sel-info', state.doc ? 'Nothing selected. Click a field on the page.' : 'Open a document to add fields.');
    const pg = state.doc.pages[f.page];
    Lab.text('sel-info', `${TYPE_NAMES[f.type]} · page ${f.page + 1} · ${Math.round(f.fw * pg.dw)} × ${Math.round(f.fh * pg.dh)} pt`);
    if (!f.src && document.activeElement !== $('sel-text')) $('sel-text').value = f.text;
  }
  $('sel-text').addEventListener('input', (e) => {
    const f = fieldById(state.sel);
    if (!f || f.src) return;
    f.text = e.target.value;
    f.auto = false;
    fitText(f);
    renderFields();
  });
  function removeField(id) {
    state.fields = state.fields.filter((f) => f.id !== id);
    if (state.sel === id) state.sel = null;
    renderFields();
    syncSelected();
  }
  $('btn-del').addEventListener('click', () => state.sel && removeField(state.sel));
  $('btn-dup').addEventListener('click', () => {
    const f = fieldById(state.sel);
    if (!f) return;
    let n = 0;
    for (const pg of state.doc.pages) {
      if (pg.index === f.page) continue;
      state.fields.push({ ...f, id: 'f' + nextId++, page: pg.index });
      n++;
    }
    renderFields();
    Lab.toast(n ? `Copied to ${n} other page${n > 1 ? 's' : ''}.` : 'This document has one page.');
  });

  // --- tools
  function disarm() {
    state.armed = null;
    $$('#tools .btn, #mbar .btn').forEach((b) => b.classList.remove('active'));
    $$('.page').forEach((p) => p.classList.remove('armed'));
  }
  function canPlace(type) {
    if (!state.doc) { Lab.toast('Open a document first (or try the sample contract).'); return false; }
    if ((type === 'sig' || type === 'ini') && !state.active[type]) {
      Lab.toast(`Create your ${type === 'ini' ? 'initials' : 'signature'} first, then press “Save & use”.`, 3600);
      segKind.set(type);
      state.kind = type;
      setTab('studio');
      syncStudio();
      return false;
    }
    return true;
  }
  $$('#tools .btn').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.tool;
    if (state.armed === t) return disarm();
    if (!canPlace(t)) return;
    disarm();
    state.armed = t;
    b.classList.add('active');
    $$('.page').forEach((p) => p.classList.add('armed'));
    Lab.toast(`Click on the page where the ${TYPE_NAMES[t].toLowerCase()} should go (Shift-click to place several).`);
  }));
  // phone layout: a compact tool bar under the document mirrors the sidebar tools
  $$('#mbar .btn').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.proxy;
    if (t === 'export') return $('btn-export').click();
    document.querySelector(`#tools .btn[data-tool="${t}"]`).click();
    $$('#mbar .btn').forEach((x) => x.classList.toggle('active', x.dataset.proxy === state.armed));
  }));
  $('btn-initial-all').addEventListener('click', () => {
    if (!canPlace('ini')) return;
    for (const pg of state.doc.pages) {
      const f = addField('ini', pg.index, 0.5, 0.5);
      f.fx = 1 - f.fw - 40 / pg.dw;
      f.fy = 1 - f.fh - 30 / pg.dh;
    }
    renderFields();
    Lab.toast(`Initials added to all ${state.doc.pages.length} pages (bottom-right). Drag any of them to adjust.`);
  });
  selDate.addEventListener('change', () => {
    state.fields.filter((f) => f.type === 'date' && f.auto).forEach((f) => { f.text = textFor('date'); fitText(f); });
    renderFields();
    buildOutput();
    persist();
  });
  $('in-signer').addEventListener('input', () => {
    state.fields.filter((f) => f.type === 'name' && f.auto).forEach((f) => { f.text = textFor('name'); fitText(f); });
    renderFields();
  });
  $('in-signer').addEventListener('change', persist);

  // --- keyboard
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (state.tab === 'studio' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing && state.mode === 'draw') {
      e.preventDefault();
      return undo();
    }
    if (state.tab !== 'doc' || typing) return;
    if (e.key === 'Escape') { disarm(); select(null); renderFields(); return; }
    const f = fieldById(state.sel);
    if (!f) return;
    const pg = state.doc.pages[f.page];
    const step = e.shiftKey ? 10 : 1; // points
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (moves[e.key]) {
      e.preventDefault();
      f.fx = clamp(f.fx + (moves[e.key][0] * step) / pg.dw, 0, 1 - f.fw);
      f.fy = clamp(f.fy + (moves[e.key][1] * step) / pg.dh, 0, 1 - f.fh);
      renderFields();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeField(f.id);
    }
  });

  // ================================================================== export
  const dataUrlBytes = (url) => {
    const b64 = url.slice(url.indexOf(',') + 1);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const winAnsiOk = (s) => /^[\x20-\x7e\xa0-\xff]*$/.test(s);
  const rgbOf = (hex) => { const [r, g, b] = S.hexRgb(hex); return rgb(r / 255, g / 255, b / 255); };
  /** Text that Helvetica cannot encode (e.g. Arabic, Urdu, CJK) is embedded as a high-resolution image instead. */
  function textPng(f, pg) {
    const hPx = f.fh * pg.dh * 4;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(f.fw * pg.dw * 4));
    c.height = Math.max(1, Math.round(hPx));
    const ctx = c.getContext('2d');
    ctx.font = `${hPx * TEXT_FS}px Helvetica, Arial, sans-serif`;
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, 0, hPx * TEXT_BASE);
    return c.toDataURL('image/png');
  }

  async function buildSignedPdf() {
    const doc = state.doc;
    let pdf;
    try {
      pdf = await PDFDocument.load(doc.pdfBytes, { updateMetadata: false });
    } catch (err) {
      if (/encrypt/i.test(String(err && err.message))) throw new Error('encrypted');
      throw err;
    }
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    const imgCache = new Map();
    const embed = async (src) => {
      if (!imgCache.has(src)) imgCache.set(src, await pdf.embedPng(dataUrlBytes(src)));
      return imgCache.get(src);
    };
    const pages = pdf.getPages();
    for (const f of state.fields) {
      const page = pages[f.page];
      const cb = page.getCropBox();
      const rot = (((page.getRotation().angle || 0) % 360) + 360) % 360;
      const pg = doc.pages[f.page];
      if (f.src || !winAnsiOk(f.text)) {
        const img = await embed(f.src || textPng(f, pg));
        const b = S.placeBox(f, cb.width, cb.height, rot, cb.x, cb.y);
        page.drawImage(img, { x: b.x, y: b.y, width: b.width, height: b.height, rotate: degrees(b.rotate) });
      } else if (f.text.trim()) {
        const size = f.fh * S.displaySize(cb.width, cb.height, rot).h * TEXT_FS;
        const b = S.placeBox({ fx: f.fx, fy: f.fy, fw: f.fw, fh: f.fh * TEXT_BASE }, cb.width, cb.height, rot, cb.x, cb.y);
        page.drawText(f.text, { x: b.x, y: b.y, size, font: helv, color: rgbOf(f.color), rotate: degrees(b.rotate) });
      }
    }
    const now = new Date();
    if (tgCert.value) await addCertificate(pdf, now, embed);
    pdf.setModificationDate(now);
    pdf.setProducer('InkSign (pdf-lib)');
    return pdf.save();
  }

  async function addCertificate(pdf, now, embed) {
    const doc = state.doc;
    const first = doc.pages[0];
    const portrait = first.dh >= first.dw;
    const [W, H] = portrait && first.dw > 500 && first.dw < 640 ? [first.dw, first.dh] : [595.28, 841.89];
    const page = pdf.addPage([W, H]);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const reg = await pdf.embedFont(StandardFonts.Helvetica);
    const mono = await pdf.embedFont(StandardFonts.Courier);
    const ink = rgb(0.07, 0.09, 0.15);
    const grey = rgb(0.39, 0.45, 0.55);
    const accent = rgb(0.31, 0.27, 0.9);
    const M = 56;
    const safe = (s) => (winAnsiOk(s) ? s : s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?'));
    let y = H - M;
    page.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: accent });
    page.drawText('Signing certificate', { x: M, y: y - 16, size: 22, font: bold, color: ink });
    y -= 36;
    page.drawText('Audit record of a simple electronic signature, created with InkSign', { x: M, y, size: 10, font: reg, color: grey });
    y -= 30;
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();
    const off = -now.getTimezoneOffset();
    const offS = `UTC${off >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`;
    const local = `${S.DATE_FORMATS.long.f(now)}, ${now.toTimeString().slice(0, 8)} (${[tz, offS].filter(Boolean).join(', ')})`;
    const counts = {};
    for (const f of state.fields) counts[f.type] = (counts[f.type] || 0) + 1;
    const rows = [
      ['Document', safe(doc.name)],
      ['Pages', `${doc.pages.length} (this certificate page added after the last page)`],
      ['Signer', safe($('in-signer').value.trim() || '(not provided)')],
      ['Email', safe($('in-email').value.trim() || '(not provided)')],
      ['Signed (local time)', local],
      ['Signed (UTC)', now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')],
      ['Fields placed', Object.entries(counts).map(([k, n]) => `${n} x ${TYPE_NAMES[k].toLowerCase()}`).join(', ') || 'none'],
    ];
    for (const [k, v] of rows) {
      page.drawText(k.toUpperCase(), { x: M, y, size: 7.5, font: bold, color: grey });
      page.drawText(v, { x: M + 120, y, size: 10, font: reg, color: ink, maxWidth: W - 2 * M - 120 });
      y -= 21;
    }
    y -= 4;
    page.drawText('ORIGINAL FILE SHA-256', { x: M, y, size: 7.5, font: bold, color: grey });
    const hash = doc.hash || (await sha256(doc.originalBytes)) || 'unavailable (browser without Web Crypto)';
    page.drawText(hash.slice(0, 32), { x: M + 120, y, size: 9.5, font: mono, color: ink });
    if (hash.length > 32) page.drawText(hash.slice(32), { x: M + 120, y: y - 12, size: 9.5, font: mono, color: ink });
    y -= 40;
    // field list, grouped by page
    page.drawText('FIELDS BY PAGE', { x: M, y, size: 7.5, font: bold, color: grey });
    y -= 16;
    const byPage = new Map();
    for (const f of state.fields) {
      if (!byPage.has(f.page)) byPage.set(f.page, []);
      byPage.get(f.page).push(f.src ? TYPE_NAMES[f.type] : `${TYPE_NAMES[f.type]} "${safe(f.text).slice(0, 40)}"`);
    }
    const lines = [...byPage.keys()].sort((a, b) => a - b).map((p) => `Page ${p + 1}: ${byPage.get(p).join(', ')}`);
    for (const ln of lines.slice(0, 14)) {
      page.drawText(ln, { x: M + 8, y, size: 9.5, font: reg, color: ink, maxWidth: W - 2 * M - 8 });
      y -= 14;
    }
    if (lines.length > 14) { page.drawText(`… and ${lines.length - 14} more pages`, { x: M + 8, y, size: 9.5, font: reg, color: grey }); y -= 14; }
    // specimens
    y -= 18;
    let x = M;
    for (const k of ['sig', 'ini']) {
      const used = state.fields.find((f) => f.type === k);
      if (!used) continue;
      const img = await embed(used.src);
      const h = k === 'sig' ? 46 : 32;
      const w = Math.min(200, (h * img.width) / img.height);
      const hh = (w * img.height) / img.width;
      page.drawText(k === 'sig' ? 'SIGNATURE' : 'INITIALS', { x, y: y - 8, size: 7.5, font: bold, color: grey });
      page.drawImage(img, { x, y: y - 16 - hh, width: w, height: hh });
      page.drawLine({ start: { x, y: y - 18 - hh }, end: { x: x + Math.max(w, 110), y: y - 18 - hh }, thickness: 0.6, color: grey });
      x += Math.max(w, 110) + 40;
    }
    // explanatory footer
    const note = [
      'How to verify: compute the SHA-256 of the original, unsigned file (macOS/Linux: shasum -a 256 <file>;',
      'Windows: certutil -hashfile <file> SHA256) and compare it with the fingerprint above.',
      'This is a simple electronic signature applied in the signer\'s browser. It is not a certificate-based (PKI)',
      'digital signature and does not by itself prove identity. Keep the signed PDF with any related correspondence.',
    ];
    let fy = M + 44;
    page.drawLine({ start: { x: M, y: fy + 16 }, end: { x: W - M, y: fy + 16 }, thickness: 0.6, color: rgb(0.85, 0.87, 0.9) });
    for (const ln of note) {
      page.drawText(ln, { x: M, y: fy, size: 8.2, font: reg, color: grey });
      fy -= 12;
    }
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.download = name;
    a.href = URL.createObjectURL(blob);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const outName = (ext) => state.doc.name.replace(/\.[^.]+$/, '') + '-signed.' + ext;
  const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

  $('btn-export').addEventListener('click', async () => {
    if (!state.doc) return Lab.toast('Open a document first.');
    if (!state.fields.length && !confirm('No fields have been placed. Download the document anyway?')) return;
    const btn = $('btn-export');
    btn.disabled = true;
    try {
      const bytes = await buildSignedPdf();
      const name = outName('pdf');
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
      const h = await sha256(bytes);
      const done = $('done');
      done.innerHTML = `<div><b>✓ Signed</b> · ${name} · ${fmtBytes(bytes.length)}</div>${h ? `<div>SHA-256 of the signed file:</div><code>${h}</code>` : ''}`;
      done.classList.remove('hidden');
      Lab.toast('Signed PDF downloaded.');
    } catch (err) {
      console.error(err);
      Lab.toast(err.message === 'encrypted'
        ? 'This PDF has editing restrictions (encryption), so it cannot be modified. Use “Current page as PNG” instead.'
        : 'Export failed: ' + (err.message || err), 5000);
    } finally {
      btn.disabled = false;
    }
  });

  function currentPage() {
    const f = fieldById(state.sel);
    if (f) return state.doc.pages[f.page];
    const b = docBody.getBoundingClientRect();
    let best = state.doc.pages[0];
    let bestVis = -1;
    for (const pg of state.doc.pages) {
      const r = pg.el.getBoundingClientRect();
      const vis = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      if (vis > bestVis) { bestVis = vis; best = pg; }
    }
    return best;
  }
  $('btn-export-img').addEventListener('click', async () => {
    if (!state.doc) return Lab.toast('Open a document first.');
    const pg = currentPage();
    const scale = Math.min(3, 3000 / Math.max(pg.dw, pg.dh)) * 1.0;
    const vp = pg.proxy.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await pg.proxy.render({ canvasContext: ctx, viewport: vp }).promise;
    for (const f of state.fields.filter((x) => x.page === pg.index)) {
      const x = f.fx * c.width, y = f.fy * c.height, w = f.fw * c.width, h = f.fh * c.height;
      if (f.src) {
        const img = new Image();
        img.src = f.src;
        await img.decode();
        ctx.drawImage(img, x, y, w, h);
      } else {
        ctx.font = `${h * TEXT_FS}px Helvetica, Arial, sans-serif`;
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, x, y + h * TEXT_BASE);
      }
    }
    c.toBlob((b) => downloadBlob(b, outName('png').replace('-signed.png', `-page${pg.index + 1}-signed.png`)), 'image/png');
  });

  // ================================================================== sample contract
  async function makeSample() {
    const pdf = await PDFDocument.create();
    const reg = await pdf.embedFont(StandardFonts.TimesRoman);
    const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
    const sans = await pdf.embedFont(StandardFonts.Helvetica);
    const W = 612, H = 792, M = 72;
    const ink = rgb(0.1, 0.1, 0.12);
    const grey = rgb(0.45, 0.47, 0.52);
    const wrap = (text, font, size, width) => {
      const out = [];
      let line = '';
      for (const word of text.split(' ')) {
        const t = line ? line + ' ' + word : word;
        if (font.widthOfTextAtSize(t, size) > width && line) { out.push(line); line = word; } else line = t;
      }
      if (line) out.push(line);
      return out;
    };
    const paras = [
      ['1. Purpose.', 'The parties wish to explore a collaboration on assistive-robotics research (the "Purpose") and, in doing so, may disclose confidential technical and business information to each other.'],
      ['2. Confidential Information.', 'means any non-public information disclosed by one party to the other, in writing, orally or by inspection, including designs, source code, data sets, prototypes, clinical protocols and business plans, whether or not marked as confidential.'],
      ['3. Obligations.', 'The receiving party shall (a) use Confidential Information only for the Purpose; (b) protect it with at least the degree of care it uses for its own information of a similar nature, and no less than reasonable care; and (c) not disclose it to any third party without prior written consent.'],
      ['4. Exclusions.', 'Obligations do not apply to information that is or becomes public through no fault of the receiving party, was known to it before disclosure, is independently developed, or is rightfully received from a third party without restriction.'],
      ['5. Term.', 'This Agreement takes effect on the date of the last signature and remains in force for three (3) years. Obligations regarding trade secrets survive for as long as the information remains a trade secret.'],
      ['6. Return of materials.', 'On request, each party shall promptly return or destroy all Confidential Information of the other party and confirm this in writing.'],
      ['7. No licence.', 'Nothing in this Agreement grants any licence under any patent, copyright or other intellectual property right, except the limited right to use Confidential Information for the Purpose.'],
      ['8. Governing law.', 'This Agreement is governed by the laws of the jurisdiction in which the disclosing party has its registered office.'],
      ['9. Entire agreement.', 'This Agreement is the entire agreement between the parties on its subject and supersedes all prior discussions. It may be amended only in writing signed by both parties.'],
      ['10. Electronic signatures.', 'The parties agree that this Agreement may be signed electronically and that an electronic signature has the same effect as a handwritten one.'],
    ];
    const pages = [pdf.addPage([W, H]), pdf.addPage([W, H])];
    let p = pages[0];
    let y = H - M;
    p.drawText('MUTUAL NON-DISCLOSURE AGREEMENT', { x: M, y, size: 17, font: bold, color: ink });
    y -= 20;
    p.drawText('Sample document generated by InkSign for demonstration', { x: M, y, size: 9.5, font: sans, color: grey });
    y -= 28;
    for (const t of wrap('This Mutual Non-Disclosure Agreement (the "Agreement") is entered into between Northwind Assistive Robotics Ltd. ("Northwind") and the undersigned individual (the "Recipient"), each a "party".', reg, 11.5, W - 2 * M)) {
      p.drawText(t, { x: M, y, size: 11.5, font: reg, color: ink });
      y -= 16;
    }
    y -= 8;
    paras.forEach(([head, body], pi) => {
      const lines = wrap(head + ' ' + body, reg, 11.5, W - 2 * M);
      if (pi === 6 || y - lines.length * 16 < 110) { p = pages[1]; y = H - M; }
      lines.forEach((t, i) => {
        if (i === 0) {
          p.drawText(head, { x: M, y, size: 11.5, font: bold, color: ink });
          p.drawText(t.slice(head.length), { x: M + bold.widthOfTextAtSize(head, 11.5), y, size: 11.5, font: reg, color: ink });
        } else p.drawText(t, { x: M, y, size: 11.5, font: reg, color: ink });
        y -= 16;
      });
      y -= 9;
    });
    // acknowledgement checkbox + signature blocks on page 2
    y -= 6;
    p.drawRectangle({ x: M, y: y - 3, width: 12, height: 12, borderColor: ink, borderWidth: 1 });
    p.drawText('I have read and agree to the terms of this Agreement.', { x: M + 22, y, size: 11.5, font: reg, color: ink });
    const box = { check: [M + 6, y + 3] };
    y -= 44;
    p.drawText('IN WITNESS WHEREOF, the parties have executed this Agreement.', { x: M, y, size: 11.5, font: reg, color: ink });
    y -= 70;
    const col = [M, W / 2 + 12];
    const lbl = (x, yy, t) => p.drawText(t, { x, y: yy, size: 8.5, font: sans, color: grey });
    const line = (x, yy) => p.drawLine({ start: { x, y: yy }, end: { x: x + 210, y: yy }, thickness: 0.8, color: ink });
    // Northwind column, already signed by the counter-party (typed, for the demo)
    const nwSig = await pdf.embedPng(dataUrlBytes(textCanvas('Mara Lindqvist', FONTS[3], 90, '#1e3a8a', 0).toDataURL('image/png')));
    const nsw = 150;
    p.drawImage(nwSig, { x: col[0] + 4, y: y - 4, width: nsw, height: (nsw * nwSig.height) / nwSig.width });
    line(col[0], y); lbl(col[0], y - 12, 'SIGNATURE (NORTHWIND)');
    line(col[1], y); lbl(col[1], y - 12, 'SIGNATURE (RECIPIENT)');
    box.sig = [col[1] + 100, y + 18];
    y -= 42;
    p.drawText('Mara Lindqvist, Director', { x: col[0] + 2, y: y + 4, size: 11, font: sans, color: ink });
    line(col[0], y); lbl(col[0], y - 12, 'NAME & TITLE');
    line(col[1], y); lbl(col[1], y - 12, 'NAME');
    box.name = [col[1] + 2, y + 4];
    y -= 42;
    p.drawText(S.DATE_FORMATS.long.f(new Date(Date.now() - 2 * 86400000)), { x: col[0] + 2, y: y + 4, size: 11, font: sans, color: ink });
    line(col[0], y); lbl(col[0], y - 12, 'DATE');
    line(col[1], y); lbl(col[1], y - 12, 'DATE');
    box.date = [col[1] + 2, y + 4];
    pages.forEach((pp, i) => {
      pp.drawText(`Page ${i + 1} of 2`, { x: W / 2 - 22, y: 36, size: 9, font: sans, color: grey });
      // the initials line sits where “Initial every page” puts initials (40 pt from the right, 30 pt from the bottom)
      pp.drawText('Initials:', { x: W - 178, y: 34, size: 9, font: sans, color: grey });
      pp.drawLine({ start: { x: W - 140, y: 32 }, end: { x: W - 36, y: 32 }, thickness: 0.8, color: grey });
    });
    pdf.setTitle('Mutual Non-Disclosure Agreement (sample)');
    const bytes = await pdf.save();
    // anchor points as fractions of the displayed page (for the demo hook)
    const fr = ([x, yy]) => [x / W, 1 - yy / H];
    return { bytes, anchors: { page: 1, check: fr(box.check), sig: fr(box.sig), name: fr(box.name), date: fr(box.date) } };
  }
  let sampleAnchors = null;
  async function loadSample() {
    await loadFonts();
    const s = await makeSample();
    sampleAnchors = s.anchors;
    await loadPdf(s.bytes, 'Mutual-NDA-sample.pdf', s.bytes, false);
    Lab.toast('Sample contract loaded. Pick a tool, then click the page.');
    return s.anchors;
  }

  // ================================================================== demo strokes (for the tour / screenshots)
  function demoStrokes(kind) {
    const strokes = [];
    let t = 0;
    const mk = (fn, n, speed) => {
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const p = fn(u);
        t += 7 + 9 * (1 - speed(u));
        pts.push({ x: p[0], y: p[1], t });
      }
      strokes.push({ points: pts });
      t += 180;
    };
    // capital: a tall looped stem sweeping into the word
    mk((u) => {
      const a = -Math.PI / 2 + u * Math.PI * 2.4;
      return [236 + 34 * Math.cos(a) * (1 - 0.35 * u) - 30 * u, 186 + 98 * Math.sin(a) * (1 - 0.2 * u)];
    }, 80, (u) => 0.35 + 0.55 * Math.sin(Math.PI * u));
    // cursive body: prolate-cycloid loops (x' < 0 near the tops) with taller ascenders
    const hs = kind === 'ini' ? [40, 96, 38] : [38, 34, 98, 36, 40, 92, 34, 38];
    const a = 10.5;
    const x0 = 262;
    mk((u) => {
      const T = -Math.PI + u * hs.length * Math.PI * 2;
      const k = clamp(Math.floor((T + Math.PI) / (Math.PI * 2)), 0, hs.length - 1);
      const hh = hs[k];
      const b = a * (1.25 + hh / 70);
      return [x0 + a * (T + Math.PI) - b * Math.sin(T), 283 - (hh * (1 + Math.cos(T))) / 2 + 4 * Math.sin(T / 4)];
    }, 56 * hs.length, (u) => 0.5 + 0.45 * Math.sin(Math.PI * u * 4) ** 2);
    const endX = x0 + a * hs.length * Math.PI * 2;
    // underline flourish: back-stroke from the end of the word, curving under it
    mk((u) => [endX + 30 - (endX - 150) * u, 300 + 22 * Math.sin(Math.PI * u) - 14 * u], 70, (u) => 0.95 - 0.5 * Math.abs(u - 0.5));
    // i-dot
    strokes.push({ points: [{ x: x0 + a * Math.PI * 4.6, y: 196, t: t + 10 }] });
    return strokes;
  }

  // ================================================================== boot
  (function restore() {
    const prefs = store.get(PREF_KEY) || {};
    if (prefs.remember === false) state.remember = false;
    tgRemember.set(state.remember);
    if (prefs.ink) state.ink = prefs.ink;
    if (Number.isInteger(prefs.font) && FONTS[prefs.font]) state.font = prefs.font;
    if (prefs.dateFmt && S.DATE_FORMATS[prefs.dateFmt]) selDate.value = prefs.dateFmt;
    if (prefs.signer) { $('in-signer').value = prefs.signer; $('in-name').value = prefs.signer; }
    const lib = state.remember && store.get(LIB_KEY);
    if (lib && Array.isArray(lib.items)) {
      state.lib = lib.items.filter((x) => x && x.png && (x.kind === 'sig' || x.kind === 'ini'));
      state.active.sig = state.lib.find((x) => x.id === lib.sig) || null;
      state.active.ini = state.lib.find((x) => x.id === lib.ini) || null;
    }
  })();
  PDFDocument.create().then((d) => d.embedFont(StandardFonts.Helvetica)).then((f) => { state.helv = f; }).catch(() => null);
  $('in-name').addEventListener('change', () => { if (!$('in-signer').value.trim()) $('in-signer').value = $('in-name').value; });
  Lab.boot();
  setInk(state.ink);
  setMode('draw');
  setTab('studio');
  renderLibrary();
  syncSelected();

  // ================================================================== automation hook (screenshots & tests)
  window.InkSign = {
    tab: (t) => setTab(t),
    mode: (m) => setMode(m),
    kind: (k) => { segKind.set(k); state.kind = k; syncStudio(); },
    ink: (c) => setInk(c),
    font: (i) => { state.font = i; syncStudio(); },
    name: (n) => { $('in-name').value = n; $('in-signer').value = n; renderFontCards(); renderPad(); scheduleOutput(); },
    photo: (blob) => loadSigImage(blob),
    demoDraw(kind = 'sig') { setMode('draw'); state.strokes = demoStrokes(kind); renderPad(); buildOutput(); },
    save() { buildOutput(); $('btn-save').click(); },
    sample: loadSample,
    anchors: () => sampleAnchors,
    /** Place a field centred on (u, v); text fields instead start at u with their baseline on v. */
    place(type, page, u, v, extra) {
      const f = addField(type, page, u, v, extra);
      if (f.text !== undefined && !extra) { f.fx = u; f.fy = v - f.fh * TEXT_BASE; }
      renderFields();
      return f.id;
    },
    initialAll: () => $('btn-initial-all').click(),
    select(id) { select(id); renderFields(); },
    arm: (t) => $$(`#tools .btn[data-tool="${t}"]`)[0].click(),
    zoom: (z) => { segZoom.set(String(z)); state.zoom = z; layoutPages(); },
    open: (bytes, name = 'doc.pdf') => loadPdf(bytes, name, bytes, false),
    async exportBytes() { return buildSignedPdf(); },
    fields: () => state.fields.map((f) => ({ ...f, src: f.src ? f.src.length : 0 })),
    out: () => state.out && { w: state.out.canvas.width, h: state.out.canvas.height },
    state,
  };
})();
