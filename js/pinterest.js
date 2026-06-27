// pinterest.js — the honest, ToS-respecting Pinterest "finder".
//
// A static site cannot use the Pinterest API (OAuth needs a backend secret +
// app review) and cannot scrape pinterest.com (CORS + ToS). So the finder:
//   1. Deep-links to Pinterest's own search UI in a new tab.
//   2. Encourages bringing the image in locally (upload/paste) — this never
//      taints the canvas and always exports cleanly.
//   3. Accepts a pasted image URL as a best-effort fallback, probing for taint
//      up front so export is disabled with a clear message if needed.

export function pinterestSearchUrl(query) {
  return 'https://www.pinterest.com/search/pins/?q=' + encodeURIComponent(query.trim());
}

export function openPinterestSearch(query) {
  if (!query.trim()) return false;
  window.open(pinterestSearchUrl(query), '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * Optionally expand a plain idea into stronger Pinterest search phrases.
 * This is a lightweight, offline "smart suggestions" helper (no API key).
 */
export function suggestQueries(idea) {
  const base = idea.trim().toLowerCase();
  if (!base) return [];
  const modifiers = [
    `${base} aesthetic`,
    `${base} png transparent`,
    `${base} sprite sheet`,
    `${base} icon set`,
    `${base} sticker pack`,
    `cute ${base} illustration`,
    `${base} reference sheet`,
    `${base} game asset`,
  ];
  // De-dupe and keep it tidy.
  return [...new Set(modifiers)].slice(0, 6);
}

/**
 * Try to load a remote image URL into a canvas and detect taint.
 * Resolves with { canvas, tainted }.
 */
export async function loadRemoteImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let settled = false;

    const finish = (crossOk) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      let tainted = false;
      try {
        ctx.getImageData(0, 0, 1, 1);
      } catch {
        tainted = true;
      }
      resolve({ canvas, tainted: tainted || !crossOk });
    };

    img.onload = () => {
      if (settled) return;
      settled = true;
      finish(true);
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      // CORS-mode load failed; retry without crossOrigin so it at least
      // displays (it will be tainted / non-exportable).
      const img2 = new Image();
      img2.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img2.naturalWidth;
        canvas.height = img2.naturalHeight;
        canvas.getContext('2d').drawImage(img2, 0, 0);
        resolve({ canvas, tainted: true });
      };
      img2.onerror = () => reject(new Error('Could not load that image URL.'));
      img2.src = url;
    };
    img.src = url;
  });
}
