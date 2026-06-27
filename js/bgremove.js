// bgremove.js — lazy wrapper around @imgly/background-removal.
//
// The engine is heavy (~40-80MB of model weights on first run) so it is
// dynamically imported only on first use. Everything is isolated behind this
// module so the underlying engine can be swapped without touching callers.

import { importFirst } from './util.js';

// esm.sh first (auto-resolves the onnxruntime-web peer dep); jsDelivr +esm as
// a fallback (also bundles deps).
const ENGINE_URLS = [
  'https://esm.sh/@imgly/background-removal@1.7.0',
  'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm',
];

let _engine = null;
let _loading = null;

export function hasWebGPU() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export function isCrossOriginIsolated() {
  return typeof self !== 'undefined' && self.crossOriginIsolated === true;
}

/** Available model presets, smallest/fastest first. */
export const MODELS = [
  { id: 'isnet_quint8', label: 'Fast (~40MB)', note: 'Quickest, slightly lower quality' },
  { id: 'isnet_fp16', label: 'Balanced (~80MB)', note: 'Recommended default' },
  { id: 'isnet', label: 'Best quality', note: 'Largest model, slowest' },
];

export async function loadEngine(onStatus) {
  if (_engine) return _engine;
  if (_loading) return _loading;
  _loading = (async () => {
    onStatus?.('Loading background-removal engine…');
    let mod;
    try {
      mod = await importFirst(ENGINE_URLS);
    } catch (err) {
      _loading = null;
      throw new Error(
        'Could not load the background-removal engine. Check your network connection and try again.'
      );
    }
    const fn = mod.removeBackground || mod.default;
    if (typeof fn !== 'function') {
      _loading = null;
      throw new Error('Background-removal engine loaded but is missing removeBackground().');
    }
    _engine = fn;
    return _engine;
  })();
  return _loading;
}

/**
 * Remove the background from an image.
 * @param {Blob|File|ImageData|ArrayBuffer|Uint8Array|string|URL} input
 * @param {{model?:string, device?:'cpu'|'gpu', onProgress?:Function, onStatus?:Function}} opts
 * @returns {Promise<Blob>} PNG blob with a transparent background.
 */
export async function removeBackground(input, opts = {}) {
  const { model = 'isnet_fp16', device, onProgress, onStatus } = opts;
  const engine = await loadEngine(onStatus);
  const useDevice = device || (hasWebGPU() ? 'gpu' : 'cpu');

  const config = {
    device: useDevice,
    model,
    output: { format: 'image/png' },
    progress: (key, current, total) => onProgress?.(key, current, total),
  };

  try {
    return await engine(input, config);
  } catch (err) {
    // WebGPU can fail unpredictably on some devices — retry once on CPU.
    if (useDevice === 'gpu') {
      onStatus?.('GPU path failed, retrying on CPU…');
      return engine(input, { ...config, device: 'cpu' });
    }
    throw err;
  }
}
