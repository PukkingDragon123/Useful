// exporter.js — bundle images into a ZIP and deliver them to the device.
//
// Strategy (see research brief):
//  - Always bundle many images into ONE .zip (iOS Safari cannot fire many
//    sequential downloads). STORE compression (images are already compressed).
//  - Deliver via Web Share API on iOS (share sheet -> "Save to Files"),
//    falling back to an <a download> blob click on Android/desktop.

import { importFirst } from './util.js';

const JSZIP_URLS = [
  'https://esm.sh/jszip@3.10.1',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm',
];

let _JSZip = null;
export async function loadJSZip() {
  if (_JSZip) return _JSZip;
  let mod;
  try {
    mod = await importFirst(JSZIP_URLS);
  } catch {
    throw new Error('Could not load the ZIP library. Check your network connection.');
  }
  _JSZip = mod.default || mod;
  return _JSZip;
}

function dedupeName(name, used) {
  if (!used.has(name)) {
    used.set(name, 0);
    return name;
  }
  const count = used.get(name) + 1;
  used.set(name, count);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-${count}${name.slice(dot)}` : `${name}-${count}`;
}

/** Build a ZIP Blob from [{name, blob}] items. */
export async function buildZip(items) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const used = new Map();
  for (const { name, blob } of items) {
    zip.file(dedupeName(name, used), blob);
  }
  // STORE (no compression): PNG/JPEG are already compressed.
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * Share or download a single blob. Tries the Web Share API first (best for
 * "Save to Files" on iOS), then falls back to a download.
 * @returns {'shared'|'cancelled'|'downloaded'}
 */
export async function shareOrDownload(blob, filename, type) {
  if (navigator.canShare && typeof File !== 'undefined') {
    const file = new File([blob], filename, { type });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return 'shared';
      } catch (err) {
        // The user dismissing the share sheet surfaces as AbortError, or as
        // NotAllowedError on some iOS versions. Treat both as a cancel rather
        // than silently downloading and falsely reporting success.
        if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
          return 'cancelled';
        }
        // any other error: fall through to the download path
      }
    }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}

/**
 * Save many images at once.
 *  - 1 image  -> shared/downloaded directly.
 *  - N images -> zipped, then shared/downloaded.
 *
 * Pass a pre-built `zipBlob` (generated while results rendered) to keep the
 * user-gesture intact on iOS; otherwise it is built on demand.
 */
export async function saveAll(items, { zipName = 'pukking-tools.zip', zipBlob = null } = {}) {
  if (!items.length) throw new Error('Nothing to save.');
  if (items.length === 1) {
    const it = items[0];
    return shareOrDownload(it.blob, it.name, it.blob.type || 'image/png');
  }
  const blob = zipBlob || (await buildZip(items));
  return shareOrDownload(blob, zipName, 'application/zip');
}
