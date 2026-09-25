/* ==========================================================================
   InkSign core — pen-stroke modelling, signature image clean-up, cropping and
   document-coordinate mapping. No DOM — unit-testable in Node.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SignCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // ------------------------------------------------------------------ strokes
  /**
   * Pen widths from drawing speed (fast strokes are thinner, like a real nib), smoothed so the
   * line breathes rather than flickers. points: [{x, y, t}] in px / ms.
   */
  function strokeWidths(points, { minW = 1.2, maxW = 4.2, speedRef = 2.2, smoothing = 0.35 } = {}) {
    const w = [];
    let prev = maxW * 0.7;
    for (let i = 0; i < points.length; i++) {
      const a = points[Math.max(0, i - 1)];
      const b = points[i];
      const dt = Math.max(1, b.t - a.t);
      const v = i ? Math.hypot(b.x - a.x, b.y - a.y) / dt : 0;
      const target = clamp(maxW - (maxW - minW) * Math.min(1, v / speedRef), minW, maxW);
      prev = prev + (target - prev) * (i ? smoothing : 1);
      w.push(prev);
    }
    return w;
  }
  /** Light positional smoothing (3-point moving average, endpoints kept). */
  function smoothPoints(points) {
    if (points.length < 3) return points.slice();
    return points.map((p, i) => {
      if (i === 0 || i === points.length - 1) return p;
      const a = points[i - 1];
      const c = points[i + 1];
      return { x: (a.x + 2 * p.x + c.x) / 4, y: (a.y + 2 * p.y + c.y) / 4, t: p.t };
    });
  }
  const f2 = (v) => Math.round(v * 100) / 100;
  /**
   * Closed outline of a variable-width stroke as an SVG path string (filled, round caps).
   * Works for canvas (new Path2D(d)), SVG export and PDF vector drawing alike.
   */
  function strokeOutline(points, widths) {
    const n = points.length;
    if (!n) return '';
    const circle = (p, r) => {
      const k = 12;
      let d = '';
      for (let i = 0; i <= k; i++) {
        const a = (i / k) * Math.PI * 2;
        d += `${i ? 'L' : 'M'}${f2(p.x + r * Math.cos(a))} ${f2(p.y + r * Math.sin(a))}`;
      }
      return d + 'Z';
    };
    if (n === 1) return circle(points[0], widths[0] / 2);
    const L = [];
    const R = [];
    for (let i = 0; i < n; i++) {
      const a = points[Math.max(0, i - 1)];
      const c = points[Math.min(n - 1, i + 1)];
      let tx = c.x - a.x;
      let ty = c.y - a.y;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      const h = widths[i] / 2;
      L.push([points[i].x - ty * h, points[i].y + tx * h]);
      R.push([points[i].x + ty * h, points[i].y - tx * h]);
    }
    // semicircular cap around p from `from` to `to`, bulging along the outward direction (ox, oy)
    const cap = (p, from, to, r, ox, oy) => {
      const a0 = Math.atan2(from[1] - p.y, from[0] - p.x);
      const dir = Math.cos(a0 + Math.PI / 2) * ox + Math.sin(a0 + Math.PI / 2) * oy >= 0 ? 1 : -1;
      const out = [];
      for (let k = 1; k < 6; k++) {
        const a = a0 + dir * (Math.PI * k) / 6;
        out.push([p.x + r * Math.cos(a), p.y + r * Math.sin(a)]);
      }
      out.push(to);
      return out;
    };
    const tangent = (a, b) => {
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return [(b.x - a.x) / l, (b.y - a.y) / l];
    };
    const pts = [...L];
    const te = tangent(points[n - 2], points[n - 1]);
    pts.push(...cap(points[n - 1], L[n - 1], R[n - 1], widths[n - 1] / 2, te[0], te[1]));
    for (let i = n - 2; i >= 0; i--) pts.push(R[i]);
    const ts = tangent(points[1], points[0]);
    pts.push(...cap(points[0], R[0], L[0], widths[0] / 2, ts[0], ts[1]));
    return pts.map((p, i) => `${i ? 'L' : 'M'}${f2(p[0])} ${f2(p[1])}`).join('') + 'Z';
  }
  /** Bounding box of a set of strokes (with pen width margin). */
  function strokesBBox(strokes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of strokes) {
      s.points.forEach((p, i) => {
        const h = (s.widths[i] || 2) / 2 + 1;
        x0 = Math.min(x0, p.x - h); y0 = Math.min(y0, p.y - h);
        x1 = Math.max(x1, p.x + h); y1 = Math.max(y1, p.y + h);
      });
    }
    return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }
  /** Standalone SVG document of the drawn strokes, cropped to their bounds. */
  function strokesToSVG(strokes, color = '#111827', pad = 6) {
    const bb = strokesBBox(strokes);
    if (!bb) return null;
    const vb = `${f2(bb.x - pad)} ${f2(bb.y - pad)} ${f2(bb.w + 2 * pad)} ${f2(bb.h + 2 * pad)}`;
    const paths = strokes.map((s) => `<path d="${strokeOutline(s.points, s.widths)}"/>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${f2(bb.w + 2 * pad)}" height="${f2(bb.h + 2 * pad)}"><g fill="${color}">${paths}</g></svg>`;
  }

  // ------------------------------------------------------------------ bitmaps (RGBA arrays)
  /**
   * Turn a photo/scan of a signature on paper into transparent ink: pixels darker than the
   * paper become opaque in proportion to their darkness; optionally recolour the ink.
   * rgba: Uint8ClampedArray (modified in place). threshold in 0..255 (paper brightness cut-off).
   */
  function cleanInk(rgba, { threshold = 170, softness = 60, recolor = null } = {}) {
    for (let i = 0; i < rgba.length; i += 4) {
      const L = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      const a = clamp((threshold - L) / softness, 0, 1);
      rgba[i + 3] = Math.round(a * 255 * (rgba[i + 3] / 255));
      if (recolor) { rgba[i] = recolor[0]; rgba[i + 1] = recolor[1]; rgba[i + 2] = recolor[2]; }
    }
    return rgba;
  }
  /** Otsu's threshold on luminance — picks the paper/ink cut-off automatically. */
  function otsu(rgba) {
    const hist = new Array(256).fill(0);
    let n = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      hist[Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2])]++;
      n++;
    }
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    // when ink and paper are cleanly separated, every cut-off in the gap is optimal: take the middle of it
    let sumB = 0, wB = 0, best = 0, first = 128, last = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between > best * (1 + 1e-9)) { best = between; first = last = t; }
      else if (between >= best * (1 - 1e-9)) last = t;
    }
    return Math.round((first + last) / 2);
  }
  /** Tight bounding box of pixels with alpha > minAlpha (null when empty). */
  function alphaBBox(rgba, w, h, minAlpha = 12) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (rgba[(y * w + x) * 4 + 3] > minAlpha) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // ------------------------------------------------------------------ document geometry
  /**
   * Map a point of the page *as displayed* (u right, v down, in PDF points, origin top-left of the
   * rotated page) to PDF user space. W×H is the unrotated crop box, (bx, by) its origin, rot ∈ {0,90,180,270}
   * the page's clockwise display rotation.
   */
  function displayToPdf(u, v, W, H, rot = 0, bx = 0, by = 0) {
    let X;
    let Y;
    switch (((rot % 360) + 360) % 360) {
      case 90: X = v; Y = u; break;
      case 180: X = W - u; Y = v; break;
      case 270: X = W - v; Y = H - u; break;
      default: X = u; Y = H - v;
    }
    return { x: X + bx, y: Y + by };
  }
  /** Displayed page size for a W×H page with rotation rot. */
  const displaySize = (W, H, rot = 0) => (((rot % 180) + 180) % 180 === 90 ? { w: H, h: W } : { w: W, h: H });
  /**
   * Placement of an upright box (fractions fx, fy, fw, fh of the displayed page) in PDF space:
   * the anchor is the box's visual bottom-left corner and the content must be rotated by `rot` degrees
   * counter-clockwise so it appears upright to the reader.
   */
  function placeBox(box, W, H, rot = 0, bx = 0, by = 0) {
    const d = displaySize(W, H, rot);
    const u = box.fx * d.w;
    const v = (box.fy + box.fh) * d.h;
    const p = displayToPdf(u, v, W, H, rot, bx, by);
    return { x: p.x, y: p.y, width: box.fw * d.w, height: box.fh * d.h, rotate: ((rot % 360) + 360) % 360 };
  }

  // ------------------------------------------------------------------ misc
  const DATE_FORMATS = {
    iso: { name: '2026-09-25', f: (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` },
    dmy: { name: '25/09/2026', f: (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}` },
    mdy: { name: '09/25/2026', f: (d) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}` },
    long: { name: '25 September 2026', f: (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` },
    us: { name: 'September 25, 2026', f: (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` },
  };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function pad2(n) { return String(n).padStart(2, '0'); }
  /** Initials from a full name ("Safiullah Rahu" → "SR"). */
  const initialsOf = (name) => name.trim().split(/\s+/).filter(Boolean).map((p) => p[0].toUpperCase()).slice(0, 3).join('');
  const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  /** Hex colour → [r, g, b] (0..255). */
  const hexRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

  return { strokeWidths, smoothPoints, strokeOutline, strokesBBox, strokesToSVG, cleanInk, otsu, alphaBBox, displayToPdf, displaySize, placeBox, DATE_FORMATS, initialsOf, toHex, hexRgb };
});
