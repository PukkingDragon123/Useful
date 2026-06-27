// util.js — small shared helpers (DOM, images, toasts).

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== null && v !== undefined && v !== false) {
      node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

let toastHost = null;
export function toast(message, type = 'info', timeout = 3600) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host' });
    document.body.appendChild(toastHost);
  }
  const node = el('div', { class: `toast toast--${type}`, text: message });
  toastHost.appendChild(node);
  requestAnimationFrame(() => node.classList.add('toast--show'));
  const remove = () => {
    node.classList.remove('toast--show');
    setTimeout(() => node.remove(), 240);
  };
  if (timeout) setTimeout(remove, timeout);
  node.addEventListener('click', remove);
  return remove;
}

/** Load an HTMLImageElement from any src (object URL, data URL, remote). */
export function loadImage(src, { crossOrigin = null } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = src;
  });
}

/** Decode a Blob/File into an HTMLImageElement. */
export async function blobToImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    return await loadImage(url);
  } finally {
    // Safe to revoke: the image is fully decoded once onload fired, and can
    // still be drawn to a canvas after revocation.
    URL.revokeObjectURL(url);
  }
}

/** Draw an image onto a fresh canvas at natural resolution. */
export function imageToCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
  return c;
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
      type,
      quality
    );
  });
}

/** Probe whether a canvas is tainted (cross-origin without CORS). */
export function isCanvasTainted(canvas) {
  try {
    canvas.getContext('2d').getImageData(0, 0, 1, 1);
    return false;
  } catch {
    return true;
  }
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function debounce(fn, ms = 180) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/**
 * Dynamically import the first URL that succeeds. Gives the app resilience
 * against a single CDN being slow or unavailable.
 */
export async function importFirst(urls) {
  let lastErr;
  for (const url of urls) {
    try {
      return await import(/* @vite-ignore */ url);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All module sources failed to load.');
}

/**
 * Wire a drop zone + hidden file input + clipboard paste to a callback.
 * Returns a function to programmatically open the file picker.
 */
export function setupImageInput(dropZone, input, onFiles, { paste = true } = {}) {
  const handleFiles = (fileList) => {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
    if (files.length) onFiles(files);
  };

  input.addEventListener('change', () => {
    handleFiles(input.files);
    input.value = '';
  });

  if (dropZone) {
    dropZone.addEventListener('click', (e) => {
      if (e.target.closest('a, button.no-pick')) return;
      input.click();
    });
    ['dragenter', 'dragover'].forEach((ev) =>
      dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropZone.classList.add('dropzone--over');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropZone.classList.remove('dropzone--over');
      })
    );
    dropZone.addEventListener('drop', (e) => handleFiles(e.dataTransfer?.files));
  }

  if (paste) {
    window.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        onFiles(files);
      }
    });
  }

  return () => input.click();
}
