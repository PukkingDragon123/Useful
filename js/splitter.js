// splitter.js — sprite-sheet splitting algorithms (pure, no DOM dependencies
// beyond <canvas>). Two detection modes plus a grid auto-guesser.
//
// Performance notes (see research brief):
//  - Read pixels ONCE with getImageData over the whole sheet.
//  - Use typed arrays only; never recursive flood-fill (stack overflow on big
//    connected regions). Union-find is safe for 4096x4096 sheets.

// --- background / mask -----------------------------------------------------

/**
 * Inspect the four corners. If the sheet looks opaque with a consistent
 * corner colour, return that colour to use as a chroma key. If the corners
 * are transparent, return null (use the alpha channel instead).
 */
export function detectBackgroundColor(data, W, H, tol = 18) {
  const offsets = [
    0,
    (W - 1) * 4,
    (H - 1) * W * 4,
    ((H - 1) * W + (W - 1)) * 4,
  ];
  // Transparent corners -> real alpha sheet, no colour key needed.
  if (offsets.every((o) => data[o + 3] < 16)) return null;

  const ref = [data[offsets[0]], data[offsets[0] + 1], data[offsets[0] + 2]];
  const agree = offsets.every((o) => {
    const d =
      Math.abs(data[o] - ref[0]) +
      Math.abs(data[o + 1] - ref[1]) +
      Math.abs(data[o + 2] - ref[2]);
    return d <= tol * 3;
  });
  return agree ? { r: ref[0], g: ref[1], b: ref[2] } : null;
}

/**
 * Build a 1-byte-per-pixel "solid" mask. With a bg colour we key on colour
 * distance; otherwise we key on the alpha channel.
 */
export function buildMask(data, W, H, opts = {}) {
  const { threshold = 12, bg = null, colorTolerance = 48 } = opts;
  const N = W * H;
  const mask = new Uint8Array(N);
  if (bg) {
    const { r, g, b } = bg;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      const dist =
        Math.abs(data[o] - r) + Math.abs(data[o + 1] - g) + Math.abs(data[o + 2] - b);
      if (dist > colorTolerance && data[o + 3] > 8) mask[i] = 1;
    }
  } else {
    for (let i = 0; i < N; i++) mask[i] = data[i * 4 + 3] > threshold ? 1 : 0;
  }
  return mask;
}

// --- connected-component labelling (auto detect) ---------------------------

/**
 * Union-find connected-component labelling on a solid mask.
 * Returns tight bounding boxes [{x,y,w,h,area}], filtered by minArea/minDim.
 */
export function detectBoxes(mask, W, H, opts = {}) {
  // Noise is filtered by area (minArea, user-tunable). minDim only rejects
  // degenerate boxes so thin-but-real sprites (e.g. a 2px line) survive.
  const { eightConn = true, minArea = 24, minDim = 1 } = opts;
  const N = W * H;
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = mask[i] ? i : -1;

  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const n = parent[x];
      parent[x] = r;
      x = n;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (parent[i] === -1) continue;
      if (x > 0 && parent[i - 1] !== -1) union(i, i - 1);
      if (y > 0 && parent[i - W] !== -1) union(i, i - W);
      if (eightConn) {
        if (x > 0 && y > 0 && parent[i - W - 1] !== -1) union(i, i - W - 1);
        if (x < W - 1 && y > 0 && parent[i - W + 1] !== -1) union(i, i - W + 1);
      }
    }
  }

  const boxes = new Map();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (parent[i] === -1) continue;
      const r = find(i);
      let b = boxes.get(r);
      if (!b) boxes.set(r, { minX: x, minY: y, maxX: x, maxY: y, area: 1 });
      else {
        if (x < b.minX) b.minX = x;
        else if (x > b.maxX) b.maxX = x;
        if (y < b.minY) b.minY = y;
        else if (y > b.maxY) b.maxY = y;
        b.area++;
      }
    }
  }

  return [...boxes.values()]
    .map((b) => ({
      x: b.minX,
      y: b.minY,
      w: b.maxX - b.minX + 1,
      h: b.maxY - b.minY + 1,
      area: b.area,
    }))
    .filter((b) => b.area >= minArea && b.w >= minDim && b.h >= minDim);
}

/**
 * Merge boxes that sit within `gap` pixels of each other. Handles sprites that
 * get split by internal transparency (a donut, a detached sword, etc.).
 */
export function mergeBoxes(boxes, gap) {
  if (gap <= 0 || boxes.length < 2) return boxes;
  const arr = boxes.map((b) => ({ ...b }));
  let merged = true;
  let guard = 0;
  while (merged && guard++ < 10000) {
    merged = false;
    for (let i = 0; i < arr.length && !merged; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i];
        const b = arr[j];
        const overlap =
          a.x - gap < b.x + b.w + gap &&
          b.x - gap < a.x + a.w + gap &&
          a.y - gap < b.y + b.h + gap &&
          b.y - gap < a.y + a.h + gap;
        if (overlap) {
          const nx = Math.min(a.x, b.x);
          const ny = Math.min(a.y, b.y);
          const nmx = Math.max(a.x + a.w, b.x + b.w);
          const nmy = Math.max(a.y + a.h, b.y + b.h);
          arr[i] = {
            x: nx,
            y: ny,
            w: nmx - nx,
            h: nmy - ny,
            area: (a.area || 0) + (b.area || 0),
          };
          arr.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return arr;
}

// --- reading order ---------------------------------------------------------

/**
 * Sort boxes into a natural left-to-right, top-to-bottom reading order so the
 * exported file numbering matches how a human scans the sheet.
 */
export function sortReadingOrder(boxes) {
  if (!boxes.length) return boxes;
  const avgH = boxes.reduce((s, b) => s + b.h, 0) / boxes.length;
  const rowTol = Math.max(8, avgH * 0.5);
  return [...boxes].sort((a, b) => {
    if (Math.abs(a.y - b.y) > rowTol) return a.y - b.y;
    return a.x - b.x;
  });
}

// --- fixed grid ------------------------------------------------------------

export function gridBoxesBySize(W, H, { cellW, cellH, margin = 0, spacing = 0 }) {
  const boxes = [];
  if (cellW <= 0 || cellH <= 0) return boxes;
  const cols = Math.floor((W - 2 * margin + spacing) / (cellW + spacing));
  const rows = Math.floor((H - 2 * margin + spacing) / (cellH + spacing));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      boxes.push({
        x: margin + c * (cellW + spacing),
        y: margin + r * (cellH + spacing),
        w: cellW,
        h: cellH,
      });
    }
  }
  return boxes;
}

export function gridBoxesByCount(W, H, { cols, rows, margin = 0, spacing = 0 }) {
  const boxes = [];
  if (cols <= 0 || rows <= 0) return boxes;
  const cellW = Math.floor((W - 2 * margin - (cols - 1) * spacing) / cols);
  const cellH = Math.floor((H - 2 * margin - (rows - 1) * spacing) / rows);
  if (cellW <= 0 || cellH <= 0) return boxes;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      boxes.push({
        x: margin + c * (cellW + spacing),
        y: margin + r * (cellH + spacing),
        w: cellW,
        h: cellH,
      });
    }
  }
  return boxes;
}

// --- grid auto-guess via projection ----------------------------------------

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function analyzeProjection(proj, len) {
  let i = 0;
  while (i < len && proj[i] === 0) i++;
  const margin = i;
  if (i >= len) return null;

  const runs = [];
  const gutters = [];
  let start = i;
  while (i < len) {
    if (proj[i] === 0) {
      runs.push([start, i - 1]);
      const g0 = i;
      while (i < len && proj[i] === 0) i++;
      if (i < len) gutters.push(i - g0);
      start = i;
    } else {
      i++;
    }
  }
  if (start < len) runs.push([start, len - 1]);
  if (runs.length < 2) return null; // not a grid

  const cell = Math.round(median(runs.map((r) => r[1] - r[0] + 1)));
  const spacing = gutters.length ? Math.round(median(gutters)) : 0;
  return { cell, margin, spacing, count: runs.length };
}

/**
 * Estimate grid parameters from the gutter structure of a solid mask.
 * Returns {cellW,cellH,margin,spacing,cols,rows} or null if no regular grid.
 */
export function autoGuessGrid(mask, W, H) {
  const rowSum = new Int32Array(H);
  const colSum = new Int32Array(W);
  for (let y = 0; y < H; y++) {
    let s = 0;
    const base = y * W;
    for (let x = 0; x < W; x++) s += mask[base + x];
    rowSum[y] = s;
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = 0; y < H; y++) s += mask[y * W + x];
    colSum[x] = s;
  }
  const cols = analyzeProjection(colSum, W);
  const rows = analyzeProjection(rowSum, H);
  if (!cols || !rows) return null;
  return {
    cellW: cols.cell,
    cellH: rows.cell,
    margin: Math.round((cols.margin + rows.margin) / 2),
    spacing: Math.round((cols.spacing + rows.spacing) / 2),
    cols: cols.count,
    rows: rows.count,
  };
}

// --- extraction ------------------------------------------------------------

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/** Trim transparent border from a canvas. Returns a new canvas, or null if empty. */
export function trimCanvas(canvas, threshold = 8) {
  const W = canvas.width;
  const H = canvas.height;
  const cx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = cx.getImageData(0, 0, W, H);
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = makeCanvas(w, h);
  out.getContext('2d').drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
  return out;
}

function padCanvas(canvas, pad) {
  const out = makeCanvas(canvas.width + pad * 2, canvas.height + pad * 2);
  out.getContext('2d').drawImage(canvas, pad, pad);
  return out;
}

function fitCanvas(canvas, tw, th) {
  const out = makeCanvas(tw, th);
  const ctx = out.getContext('2d');
  const scale = Math.min(tw / canvas.width, th / canvas.height);
  const w = Math.round(canvas.width * scale);
  const h = Math.round(canvas.height * scale);
  ctx.drawImage(canvas, Math.round((tw - w) / 2), Math.round((th - h) / 2), w, h);
  return out;
}

/**
 * Extract a single sprite from the source canvas.
 * opts: { trim, pad, threshold, uniform:{w,h}|null }
 */
export function extractCanvas(srcCanvas, box, opts = {}) {
  const { trim = false, pad = 0, threshold = 8, uniform = null } = opts;
  let x = Math.max(0, Math.round(box.x));
  let y = Math.max(0, Math.round(box.y));
  let w = Math.min(Math.round(box.w), srcCanvas.width - x);
  let h = Math.min(Math.round(box.h), srcCanvas.height - y);
  if (w <= 0 || h <= 0) return null;

  let c = makeCanvas(w, h);
  c.getContext('2d').drawImage(srcCanvas, x, y, w, h, 0, 0, w, h);

  if (trim) {
    const t = trimCanvas(c, threshold);
    if (!t) return null; // fully transparent cell
    c = t;
  }
  if (pad > 0) c = padCanvas(c, pad);
  if (uniform && uniform.w > 0 && uniform.h > 0) c = fitCanvas(c, uniform.w, uniform.h);
  return c;
}
