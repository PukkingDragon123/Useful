// app.js — main controller for Pukking's Useful Tools.
import { $, $$, el, toast, blobToImage, imageToCanvas, canvasToBlob, isCanvasTainted,
  formatBytes, debounce, pad, setupImageInput, imageFilesFrom } from './util.js';
import * as SPL from './splitter.js';
import { removeBackground, MODELS, isCrossOriginIsolated } from './bgremove.js';
import { saveAll, buildZip, downloadBlob } from './exporter.js';
import { makeDemoSheet } from './demo.js';
import { openPinterestSearch, suggestQueries, loadRemoteImage } from './pinterest.js';

// ---------------------------------------------------------------- overlay ---
const overlay = el('div', { class: 'overlay', hidden: true }, [
  el('div', { class: 'spinner' }),
  el('div', { class: 'overlay__msg', id: 'overlay-msg', text: 'Working…' }),
  el('div', { class: 'overlay__bar' }, [el('i', { id: 'overlay-bar' })]),
]);
document.body.appendChild(overlay);
const overlayMsg = $('#overlay-msg', overlay);
const overlayBar = $('#overlay-bar', overlay);

function showOverlay(msg) {
  overlayMsg.textContent = msg || 'Working…';
  overlayBar.style.width = '0%';
  overlay.hidden = false;
}
function setOverlayProgress(msg, frac) {
  if (msg) overlayMsg.textContent = msg;
  if (typeof frac === 'number') overlayBar.style.width = `${Math.round(frac * 100)}%`;
}
function hideOverlay() { overlay.hidden = true; }

// A progress handler for the bg-removal engine (model download + inference).
function bgProgress(label) {
  return (key, current, total) => {
    if (total) {
      const phase = String(key).startsWith('fetch') ? 'Downloading AI model (one-time)' : 'Removing background';
      setOverlayProgress(`${label} — ${phase} ${Math.round((current / total) * 100)}%`, current / total);
    } else {
      setOverlayProgress(label);
    }
  };
}

// ------------------------------------------------------------------- tabs ---
function activateTab(name) {
  $$('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $$('.panel').forEach((p) => {
    const on = p.id === `tab-${name}`;
    p.classList.toggle('is-active', on);
    p.hidden = !on;
  });
}
$$('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.tab)));

// ================================================================ SPLITTER ==
const MAX_SPRITES = 500; // safety cap on extracted sprites

const SP = {
  src: null,        // full-res working canvas
  base: null,       // original (pre-bg-removal) canvas, for reset
  imgData: null,    // cached { data, W, H }
  rawCache: null,   // cached connected-component labelling { key, boxes }
  mode: 'auto',
  gridInput: 'count',
  boxes: [],
  results: [],      // [{ canvas, blob, name, box, bgRemoved, selected }]
  version: 0,
  zip: { sig: null, blob: null },
};

function resetSplitterCaches() {
  SP.imgData = null;
  SP.rawCache = null;
}

const spPreview = $('#splitter-preview');
const spDims = $('#splitter-dims');
const spCount = $('#splitter-count');

function readControls() {
  return {
    threshold: +$('#ctl-threshold').value,
    minArea: +$('#ctl-minarea').value,
    merge: +$('#ctl-merge').value,
    diag: $('#ctl-diag').checked,
    gridInput: SP.gridInput,
    cols: Math.max(1, +$('#ctl-cols').value || 1),
    rows: Math.max(1, +$('#ctl-rows').value || 1),
    cellW: Math.max(1, +$('#ctl-cellw').value || 1),
    cellH: Math.max(1, +$('#ctl-cellh').value || 1),
    margin: Math.max(0, +$('#ctl-margin').value || 0),
    spacing: Math.max(0, +$('#ctl-spacing').value || 0),
    trim: $('#ctl-trim').checked,
    pad: Math.max(0, +$('#ctl-pad').value || 0),
    uniform: $('#ctl-uniform').checked,
  };
}

function ensureImageData() {
  if (SP.imgData) return SP.imgData;
  const ctx = SP.src.getContext('2d', { willReadFrequently: true });
  SP.imgData = { data: ctx.getImageData(0, 0, SP.src.width, SP.src.height).data, W: SP.src.width, H: SP.src.height };
  return SP.imgData;
}

// The expensive part of auto-detect (mask + connected-component labelling)
// depends only on the threshold and connectivity. minArea / merge are cheap
// post-filters, so we cache the raw labelled boxes and only relabel when the
// threshold, connectivity, or source image changes.
function computeRawBoxes(c) {
  const key = `${c.threshold}|${c.diag}`;
  if (SP.rawCache && SP.rawCache.key === key) return SP.rawCache.boxes;
  const { data, W, H } = ensureImageData();
  const bg = SPL.detectBackgroundColor(data, W, H);
  const mask = SPL.buildMask(data, W, H, { threshold: c.threshold, bg });
  const boxes = SPL.detectBoxes(mask, W, H, { eightConn: c.diag, minArea: 1 });
  SP.rawCache = { key, boxes };
  return boxes;
}

function computeBoxes() {
  const c = readControls();
  const W = SP.src.width, H = SP.src.height;
  if (SP.mode === 'grid') {
    return c.gridInput === 'count'
      ? SPL.gridBoxesByCount(W, H, c)
      : SPL.gridBoxesBySize(W, H, c);
  }
  // auto: filter the cached raw labelling (cheap), then merge + sort.
  let boxes = computeRawBoxes(c).filter((b) => b.area >= c.minArea);
  if (c.merge > 0) boxes = SPL.mergeBoxes(boxes, c.merge);
  return SPL.sortReadingOrder(boxes);
}

function drawPreview() {
  const W = SP.src.width, H = SP.src.height;
  const maxDim = Math.max(W, H);
  const scale = Math.min(1, 1600 / maxDim);
  const pw = Math.round(W * scale), ph = Math.round(H * scale);
  spPreview.width = pw; spPreview.height = ph;
  const ctx = spPreview.getContext('2d');
  ctx.clearRect(0, 0, pw, ph);
  ctx.drawImage(SP.src, 0, 0, pw, ph);
  // overlay boxes
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,77,109,0.95)';
  ctx.fillStyle = 'rgba(255,77,109,0.12)';
  for (const b of SP.boxes) {
    ctx.fillRect(b.x * scale, b.y * scale, b.w * scale, b.h * scale);
    ctx.strokeRect(b.x * scale + 0.5, b.y * scale + 0.5, b.w * scale, b.h * scale);
  }
  spDims.textContent = `${W} × ${H}px`;
}

const refreshDetection = debounce(() => {
  if (!SP.src) return;
  try {
    SP.boxes = computeBoxes();
  } catch (err) {
    console.error(err);
    if (isCanvasTainted(SP.src)) {
      toast('This image is cross-origin protected and can’t be processed. Download it and re-upload.', 'error', 6000);
    }
    SP.boxes = [];
  }
  spCount.textContent = `${SP.boxes.length} sprite${SP.boxes.length === 1 ? '' : 's'}`;
  drawPreview();
}, 200);

const boxKey = (b) => `${b.x},${b.y},${b.w},${b.h}`;

function buildResults() {
  if (!SP.src || !SP.boxes.length) {
    SP.results = [];
    SP.version++;
    renderResults();
    return;
  }
  let boxes = SP.boxes;
  if (boxes.length > MAX_SPRITES) {
    toast(`Found ${boxes.length} regions — showing the first ${MAX_SPRITES}. Raise "ignore specks" or use Grid mode.`, 'warn', 5500);
    boxes = boxes.slice(0, MAX_SPRITES);
  }
  const c = readControls();
  // uniform target = largest box (after potential trim we just use raw box size)
  let uniform = null;
  if (c.uniform) {
    let mw = 0, mh = 0;
    for (const b of boxes) { mw = Math.max(mw, b.w); mh = Math.max(mh, b.h); }
    uniform = { w: mw + c.pad * 2, h: mh + c.pad * 2 };
  }
  // Preserve prior selection keyed by stable box geometry (not positional
  // index, which drifts as detection changes).
  const prevSelected = new Map(SP.results.map((r) => [boxKey(r.box), r.selected]));
  const results = [];
  boxes.forEach((box) => {
    const canvas = SPL.extractCanvas(SP.src, box, {
      trim: c.trim, pad: c.pad, threshold: c.threshold,
      uniform: c.uniform ? uniform : null,
    });
    if (!canvas) return;
    const key = boxKey(box);
    results.push({
      canvas,
      blob: null,
      box: { x: box.x, y: box.y, w: box.w, h: box.h },
      name: `sprite-${pad(results.length + 1)}.png`,
      bgRemoved: false,
      selected: prevSelected.has(key) ? prevSelected.get(key) : true,
    });
  });
  SP.results = results;
  SP.version++;
  renderResults();
  // Blobs are encoded lazily (on export / pre-zip), not eagerly here.
  scheduleZip();
}

// Encode PNG blobs for the given results only (those that don't have one yet).
async function materializeBlobs(list) {
  await Promise.all(list.map(async (r) => {
    if (!r.blob) r.blob = await canvasToBlob(r.canvas, 'image/png');
  }));
}

function selectionSig() {
  return SP.version + ':' + SP.results.map((r, i) => (r.selected ? i : '')).join(',');
}

const scheduleZip = debounce(async () => {
  const sel = SP.results.filter((r) => r.selected);
  if (sel.length < 2) { SP.zip = { sig: null, blob: null }; return; }
  const sig = selectionSig();
  try {
    await materializeBlobs(sel);
    if (selectionSig() !== sig) return; // selection changed mid-build; next run handles it
    const blob = await buildZip(sel.map((r) => ({ name: r.name, blob: r.blob })));
    SP.zip = { sig, blob };
  } catch (err) { SP.zip = { sig: null, blob: null }; }
}, 450);

function updateResultsCount() {
  const n = SP.results.filter((r) => r.selected).length;
  $('#results-count').textContent = `${n} of ${SP.results.length} selected`;
}

function renderResults() {
  const wrap = $('#splitter-results');
  const grid = $('#results-grid');
  grid.innerHTML = '';
  if (!SP.results.length) { wrap.hidden = true; return; }
  wrap.hidden = false;

  SP.results.forEach((r, i) => {
    const card = el('div', { class: 'card' + (r.selected ? ' is-selected' : '') });
    const check = el('input', { type: 'checkbox', class: 'card__check', 'aria-label': `Select ${r.name}` });
    check.checked = r.selected;
    check.addEventListener('change', () => {
      r.selected = check.checked;
      card.classList.toggle('is-selected', r.selected);
      updateResultsCount();
      scheduleZip();
    });
    const thumb = el('div', { class: 'card__thumb' }, [r.canvas]);
    thumb.addEventListener('click', () => { check.checked = !check.checked; check.dispatchEvent(new Event('change')); });
    const badge = r.bgRemoved ? el('span', { class: 'card__badge', text: 'BG ✓' }) : null;
    const meta = el('div', { class: 'card__meta' }, [
      el('span', { text: `#${pad(i + 1)}` }),
      el('span', { text: `${r.canvas.width}×${r.canvas.height}` }),
    ]);
    const btns = el('div', { class: 'card__btns' }, [
      el('button', { text: '⬇︎', title: 'Download', onClick: () => downloadOne(r) }),
      el('button', { text: '🪄', title: 'Remove background', onClick: () => removeOneBg(r, card) }),
    ]);
    card.append(check, thumb, meta, btns);
    if (badge) card.append(badge);
    grid.append(card);
  });
  updateResultsCount();
}

async function downloadOne(r) {
  if (!r.blob) r.blob = await canvasToBlob(r.canvas, 'image/png');
  downloadBlob(r.blob, r.name);
}

async function removeOneBg(r, card) {
  try {
    showOverlay('Removing background…');
    const src = r.blob || (await canvasToBlob(r.canvas, 'image/png'));
    const out = await removeBackground(src, { model: currentModel(), onProgress: bgProgress(r.name), onStatus: setOverlayProgress });
    const img = await blobToImage(out);
    const canvas = imageToCanvas(img);
    r.canvas = canvas; r.blob = out; r.bgRemoved = true;
    SP.version++;
    renderResults();
    scheduleZip();
    toast('Background removed.', 'good');
  } catch (err) {
    console.error(err);
    toast(err.message || 'Background removal failed.', 'error', 5000);
  } finally { hideOverlay(); }
}

// load an image/canvas into the splitter
function loadIntoSplitter(canvas) {
  SP.src = canvas;
  SP.base = canvas;
  resetSplitterCaches();
  SP.results = [];
  SP.zip = { sig: null, blob: null };
  $('#splitter-bg-status').hidden = true;
  $('#splitter-removebg').disabled = false;
  $('#splitter-intro').hidden = true;
  $('#splitter-workspace').hidden = false;
  refreshDetection();
  // build results shortly after first detection settles
  setTimeout(buildResults, 200);
}

async function loadSplitterFromBlob(file) {
  try {
    const img = await blobToImage(file);
    loadIntoSplitter(imageToCanvas(img));
    activateTab('splitter');
  } catch (err) {
    toast('Could not open that image.', 'error');
  }
}

// --- splitter control wiring ---
function currentModel() { return $('#bg-model').value || 'isnet_fp16'; }

setupImageInput($('#splitter-drop'), $('#splitter-file'), (files) => loadSplitterFromBlob(files[0]));
$('#splitter-upload').addEventListener('click', () => $('#splitter-file').click());
$('#splitter-change').addEventListener('click', () => {
  $('#splitter-workspace').hidden = true;
  $('#splitter-results').hidden = true;
  $('#splitter-intro').hidden = false;
  SP.src = null; SP.base = null; SP.results = [];
  resetSplitterCaches();
});
$('#splitter-demo').addEventListener('click', () => {
  setSplitterMode('auto'); // the demo showcases Auto-Detect
  $('#ctl-merge').value = 0; $('#out-merge').textContent = '0';
  loadIntoSplitter(makeDemoSheet());
  toast('Loaded a demo sprite sheet — Auto-Detect found the shapes!', 'good');
});

// mode toggle
function setSplitterMode(mode) {
  SP.mode = mode;
  $$('.seg__btn[data-mode]').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
  $('.control-group[data-for="auto"]').hidden = mode !== 'auto';
  $('.control-group[data-for="grid"]').hidden = mode !== 'grid';
}
$$('.seg__btn[data-mode]').forEach((btn) => btn.addEventListener('click', () => {
  setSplitterMode(btn.dataset.mode);
  refreshDetection();
  setTimeout(buildResults, 160);
}));

// grid input toggle
function setGridInput(mode) {
  SP.gridInput = mode;
  $$('.seg__btn[data-grid]').forEach((b) => b.classList.toggle('is-active', b.dataset.grid === mode));
  $('[data-grid-input="count"]').hidden = mode !== 'count';
  $('[data-grid-input="size"]').hidden = mode !== 'size';
}
$$('.seg__btn[data-grid]').forEach((btn) => btn.addEventListener('click', () => {
  setGridInput(btn.dataset.grid);
  refreshDetection();
  setTimeout(buildResults, 160);
}));

// range outputs + live detection
const liveControls = [
  ['#ctl-threshold', '#out-threshold'],
  ['#ctl-minarea', '#out-minarea'],
  ['#ctl-merge', '#out-merge'],
];
liveControls.forEach(([input, out]) => {
  const i = $(input), o = $(out);
  i.addEventListener('input', () => { if (o) o.textContent = i.value; refreshDetection(); });
  i.addEventListener('change', () => setTimeout(buildResults, 60));
});
['#ctl-diag', '#ctl-cols', '#ctl-rows', '#ctl-cellw', '#ctl-cellh', '#ctl-margin', '#ctl-spacing'].forEach((sel) => {
  const node = $(sel);
  node.addEventListener('input', refreshDetection);
  node.addEventListener('change', () => setTimeout(buildResults, 60));
});
['#ctl-trim', '#ctl-pad', '#ctl-uniform'].forEach((sel) => {
  $(sel).addEventListener('change', () => setTimeout(buildResults, 30));
});

// auto-guess grid: detect how many rows/columns of sprites there are, then
// divide the sheet evenly into that many cells. This is much more reliable
// than trying to recover exact pixel margins/spacing (which conflates the
// transparent padding inside a cell with the gutter between cells).
$('#ctl-guess').addEventListener('click', () => {
  if (!SP.src) return;
  const { data, W, H } = ensureImageData();
  const bg = SPL.detectBackgroundColor(data, W, H);
  const mask = SPL.buildMask(data, W, H, { threshold: readControls().threshold, bg });
  const guess = SPL.autoGuessGrid(mask, W, H);
  if (!guess) {
    toast('Couldn’t find a regular grid (sprites may be touching). Use Auto mode, or set rows × columns yourself.', 'warn', 5500);
    return;
  }
  setGridInput('count');
  $('#ctl-cols').value = guess.cols;
  $('#ctl-rows').value = guess.rows;
  $('#ctl-margin').value = 0;
  $('#ctl-spacing').value = 0;
  refreshDetection();
  setTimeout(buildResults, 160);
  toast(`Detected a ${guess.cols} × ${guess.rows} grid. Adjust rows/columns if it’s off, and keep "Trim" on.`, 'good', 5000);
});

// remove bg from whole sheet first
$('#splitter-removebg').addEventListener('click', async () => {
  if (!SP.src) return;
  const statusEl = $('#splitter-bg-status');
  try {
    showOverlay('Removing background from the sheet…');
    const blob = await canvasToBlob(SP.src, 'image/png');
    const out = await removeBackground(blob, { model: currentModel(), onProgress: bgProgress('Sheet'), onStatus: setOverlayProgress });
    const img = await blobToImage(out);
    SP.src = imageToCanvas(img);
    resetSplitterCaches();
    $('#splitter-removebg').disabled = true;
    statusEl.hidden = false; statusEl.className = 'status status--good';
    statusEl.textContent = '✓ Background removed — detection now uses clean transparency.';
    refreshDetection();
    setTimeout(buildResults, 160);
    toast('Background removed from the sheet.', 'good');
  } catch (err) {
    console.error(err);
    statusEl.hidden = false; statusEl.className = 'status status--err';
    statusEl.textContent = err.message || 'Background removal failed.';
  } finally { hideOverlay(); }
});

// results toolbar
$('#results-selectall').addEventListener('click', () => {
  SP.results.forEach((r) => (r.selected = true));
  renderResults(); scheduleZip();
});
$('#results-none').addEventListener('click', () => {
  SP.results.forEach((r) => (r.selected = false));
  renderResults(); scheduleZip();
});
$('#results-removebg').addEventListener('click', async () => {
  const sel = SP.results.filter((r) => r.selected);
  if (!sel.length) { toast('Select some sprites first.', 'warn'); return; }
  showOverlay('Removing backgrounds…');
  let done = 0;
  for (const r of sel) {
    try {
      const src = r.blob || (await canvasToBlob(r.canvas, 'image/png'));
      const out = await removeBackground(src, { model: currentModel(), onProgress: bgProgress(`${done + 1}/${sel.length}`), onStatus: setOverlayProgress });
      const img = await blobToImage(out);
      r.canvas = imageToCanvas(img); r.blob = out; r.bgRemoved = true;
    } catch (err) { console.error(err); }
    done++;
    setOverlayProgress(`Removed ${done}/${sel.length}`, done / sel.length);
  }
  SP.version++;
  renderResults(); scheduleZip();
  hideOverlay();
  toast(`Removed background from ${done} sprite${done === 1 ? '' : 's'}.`, 'good');
});
$('#results-save').addEventListener('click', async () => {
  const items = SP.results.filter((r) => r.selected);
  if (!items.length) { toast('Nothing selected to save.', 'warn'); return; }
  try {
    const useCache = SP.zip.sig === selectionSig() ? SP.zip.blob : null;
    if (!useCache) { showOverlay('Packaging your images…'); await materializeBlobs(items); }
    const payload = items.map((r) => ({ name: r.name, blob: r.blob }));
    const result = await saveAll(payload, { zipName: 'pukking-sprites.zip', zipBlob: useCache });
    hideOverlay();
    notifySave(result);
  } catch (err) {
    hideOverlay();
    console.error(err);
    toast(err.message || 'Save failed.', 'error', 5000);
  }
});

// Consistent, honest save feedback (no false "Saved!" on cancel).
function notifySave(result) {
  if (result === 'shared') toast('Shared — choose "Save to Files".', 'good');
  else if (result === 'downloaded') toast('Saved! Check your downloads / Files.', 'good');
  // 'cancelled' -> stay quiet
}

// ============================================================== BG REMOVER ==
const BG = { items: [], zip: { sig: null, blob: null } }; // items: [{ srcCanvas, srcBlob, name, resultBlob, resultCanvas, status }]

function bgExportItems() {
  return BG.items.filter((it) => it.resultBlob).map((it) => ({ name: it.name, blob: it.resultBlob }));
}
function bgSig() {
  return bgExportItems().map((i) => `${i.name}:${i.blob.size}`).join('|');
}
// Pre-build the cutouts ZIP after processing so the iOS share gesture stays
// intact at save time (mirrors the splitter's scheduleZip).
const scheduleBgZip = debounce(async () => {
  const items = bgExportItems();
  if (items.length < 2) { BG.zip = { sig: null, blob: null }; return; }
  const sig = bgSig();
  try {
    const blob = await buildZip(items);
    BG.zip = { sig, blob };
  } catch { BG.zip = { sig: null, blob: null }; }
}, 450);

function renderBg() {
  const wrap = $('#bg-results');
  const list = $('#bg-list');
  list.innerHTML = '';
  if (!BG.items.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $('#bg-count').textContent = `${BG.items.length} image${BG.items.length === 1 ? '' : 's'}`;

  BG.items.forEach((it, i) => {
    const before = el('div', { class: 'bgcard__half' }, [it.srcCanvas]);
    const afterInner = it.resultCanvas ? [it.resultCanvas] : [el('span', { class: 'muted small', text: it.status || 'not processed' })];
    const after = el('div', { class: 'bgcard__half' }, afterInner);
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'bgcard__row' }, [before, after]),
      el('div', { class: 'card__meta' }, [
        el('span', { text: it.name }),
        el('span', { text: it.resultBlob ? formatBytes(it.resultBlob.size) : '' }),
      ]),
      el('div', { class: 'card__btns' }, [
        el('button', { text: '🪄 Remove BG', onClick: () => runBgOne(i) }),
        el('button', { text: '⬇︎ Save', onClick: () => saveBgOne(i) }),
        el('button', { text: '✕', title: 'Remove', onClick: () => { BG.items.splice(i, 1); renderBg(); } }),
      ]),
    ]);
    list.append(card);
  });
}

async function addBgImages(files) {
  for (const f of files) {
    try {
      const img = await blobToImage(f);
      const srcCanvas = imageToCanvas(img);
      BG.items.push({ srcCanvas, srcBlob: f, name: (f.name || 'image').replace(/\.[^.]+$/, '') + '.png', resultBlob: null, resultCanvas: null, status: null });
    } catch { toast(`Couldn’t open ${f.name || 'an image'}.`, 'error'); }
  }
  renderBg();
}

async function runBgOne(i) {
  const it = BG.items[i];
  try {
    showOverlay('Removing background…');
    const out = await removeBackground(it.srcBlob, { model: currentModel(), onProgress: bgProgress(it.name), onStatus: setOverlayProgress });
    const img = await blobToImage(out);
    it.resultBlob = out; it.resultCanvas = imageToCanvas(img); it.status = 'done';
    renderBg();
    scheduleBgZip();
    toast('Background removed.', 'good');
  } catch (err) {
    console.error(err); it.status = 'failed';
    renderBg();
    toast(err.message || 'Failed.', 'error', 5000);
  } finally { hideOverlay(); }
}

async function saveBgOne(i) {
  const it = BG.items[i];
  if (!it.resultBlob) { toast('Remove the background first.', 'warn'); return; }
  downloadBlob(it.resultBlob, it.name);
}

setupImageInput($('#bg-drop'), $('#bg-file'), addBgImages);
$('#bg-upload').addEventListener('click', () => $('#bg-file').click());
$('#bg-clear').addEventListener('click', () => { BG.items = []; BG.zip = { sig: null, blob: null }; renderBg(); });
$('#bg-runall').addEventListener('click', async () => {
  const todo = BG.items.filter((it) => !it.resultBlob);
  if (!todo.length) { toast('Everything is already done.', 'info'); return; }
  showOverlay('Removing backgrounds…');
  let done = 0;
  for (const it of BG.items) {
    if (it.resultBlob) { done++; continue; }
    try {
      const out = await removeBackground(it.srcBlob, { model: currentModel(), onProgress: bgProgress(`${done + 1}/${BG.items.length}`), onStatus: setOverlayProgress });
      const img = await blobToImage(out);
      it.resultBlob = out; it.resultCanvas = imageToCanvas(img); it.status = 'done';
    } catch (err) { console.error(err); it.status = 'failed'; }
    done++;
    setOverlayProgress(`Processed ${done}/${BG.items.length}`, done / BG.items.length);
    renderBg();
  }
  hideOverlay();
  scheduleBgZip();
  toast('Done removing backgrounds.', 'good');
});
$('#bg-save').addEventListener('click', async () => {
  const items = bgExportItems();
  if (!items.length) { toast('Remove some backgrounds first.', 'warn'); return; }
  try {
    const useCache = BG.zip.sig === bgSig() ? BG.zip.blob : null;
    if (!useCache && items.length > 1) showOverlay('Packaging your images…');
    const result = await saveAll(items, { zipName: 'pukking-cutouts.zip', zipBlob: useCache });
    hideOverlay();
    notifySave(result);
  } catch (err) { hideOverlay(); toast(err.message || 'Save failed.', 'error', 5000); }
});

// ============================================================== PINTEREST ==
const PIN = { canvas: null, tainted: false };
const pinCanvas = $('#pin-canvas');

function renderPinSuggestions(idea) {
  const host = $('#pin-suggestions');
  host.innerHTML = '';
  const qs = idea ? suggestQueries(idea) : ['stickers', 'pixel art', 'cute icons', 'png transparent', 'game sprites'];
  qs.forEach((q) => {
    const chip = el('button', { class: 'chip', text: q, onClick: () => openPinterestSearch(q) });
    host.append(chip);
  });
}
renderPinSuggestions('');

$('#pin-query').addEventListener('input', (e) => renderPinSuggestions(e.target.value));
$('#pin-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pin-search').click(); });
$('#pin-search').addEventListener('click', () => {
  const q = $('#pin-query').value.trim();
  if (!q) { toast('Type what you’re looking for first.', 'warn'); return; }
  openPinterestSearch(q);
});

function showPinPreview(canvas, tainted) {
  PIN.canvas = canvas; PIN.tainted = tainted;
  const ctx = pinCanvas.getContext('2d');
  const maxDim = Math.max(canvas.width, canvas.height);
  const scale = Math.min(1, 900 / maxDim);
  pinCanvas.width = Math.round(canvas.width * scale);
  pinCanvas.height = Math.round(canvas.height * scale);
  ctx.clearRect(0, 0, pinCanvas.width, pinCanvas.height);
  ctx.drawImage(canvas, 0, 0, pinCanvas.width, pinCanvas.height);
  $('#pin-preview').hidden = false;
  const st = $('#pin-status');
  const sendBtns = [$('#pin-to-splitter'), $('#pin-to-bg')];
  if (tainted) {
    st.hidden = false; st.className = 'status status--warn';
    st.textContent = '⚠︎ This image is cross-origin protected, so it can’t be edited or exported. Download it and re-upload to use it.';
    sendBtns.forEach((b) => (b.disabled = true));
  } else {
    st.hidden = true;
    sendBtns.forEach((b) => (b.disabled = false));
  }
}

async function pinFromFile(file) {
  try {
    const img = await blobToImage(file);
    showPinPreview(imageToCanvas(img), false);
  } catch { toast('Couldn’t open that image.', 'error'); }
}

setupImageInput($('#pin-drop'), $('#pin-file'), (files) => pinFromFile(files[0]));
$('#pin-load').addEventListener('click', async () => {
  const url = $('#pin-url').value.trim();
  if (!url) { toast('Paste an image URL first.', 'warn'); return; }
  try {
    showOverlay('Loading image…');
    const { canvas, tainted } = await loadRemoteImage(url);
    hideOverlay();
    showPinPreview(canvas, tainted);
  } catch (err) { hideOverlay(); toast(err.message || 'Could not load that URL.', 'error', 5000); }
});
$('#pin-to-splitter').addEventListener('click', () => {
  if (!PIN.canvas || PIN.tainted) return;
  loadIntoSplitter(PIN.canvas);
  activateTab('splitter');
  toast('Sent to Splitter.', 'good');
});
$('#pin-to-bg').addEventListener('click', async () => {
  if (!PIN.canvas || PIN.tainted) return;
  const blob = await canvasToBlob(PIN.canvas, 'image/png');
  BG.items.push({ srcCanvas: (() => { const c = document.createElement('canvas'); c.width = PIN.canvas.width; c.height = PIN.canvas.height; c.getContext('2d').drawImage(PIN.canvas, 0, 0); return c; })(), srcBlob: blob, name: 'pinterest.png', resultBlob: null, resultCanvas: null, status: null });
  renderBg();
  activateTab('bg');
  toast('Sent to BG Remover.', 'good');
});

// ================================================================== INIT ====
function init() {
  // model select
  const sel = $('#bg-model');
  MODELS.forEach((m) => sel.append(el('option', { value: m.id, text: m.label })));
  sel.value = 'isnet_fp16';
  // engine note
  $('#bg-engine-note').textContent =
    'Runs entirely on your device — the first removal downloads the AI model once (~40–80MB) and may take up to a minute on a phone. After that it’s fast and works offline.';
  // cross-origin isolation note
  const coi = $('#coi-note');
  coi.textContent = isCrossOriginIsolated()
    ? '⚡ Accelerated mode active.'
    : 'Tip: background removal runs faster on a host with cross-origin isolation.';

  // Central clipboard-paste dispatcher: route a pasted image to the ACTIVE
  // tab's flow instead of always hijacking it into the Splitter.
  window.addEventListener('paste', (e) => {
    const files = imageFilesFrom(e.clipboardData?.items);
    if (!files.length) return;
    e.preventDefault();
    const active = document.querySelector('.tab.is-active')?.dataset.tab;
    if (active === 'bg') addBgImages(files);
    else if (active === 'pin') pinFromFile(files[0]);
    else loadSplitterFromBlob(files[0]);
  });
}
init();
