# 🧰 Pukking's Useful Tools

A fast, **100% in-browser** toolbox for working with images you find on Pinterest (and anywhere else):

- ✂️ **Sprite-sheet Splitter** — slice a sprite sheet into individual images.
  - **Smart Auto-Detect** finds every sprite for you using connected-component
    detection — no need to know the grid.
  - **Grid mode** for evenly-spaced sheets, with one-tap **Auto-guess grid**.
  - Live preview overlay, per-sprite selection, trim / pad / uniform-size options.
- 🪄 **Background Remover** — high-quality cutouts that run entirely on your
  device. Use it on a whole sheet *before* splitting, or on individual sprites
  *after*. Batch-process many images at once.
- 📥 **Save all to Files** — bundles everything into a single ZIP and hands it to
  your device. On iOS the share sheet offers **Save to Files**; elsewhere it
  downloads straight away.
- 📌 **Find on Pinterest** — search Pinterest in a new tab, then drop the image
  back here to split or cut out.

> 🔒 **Private by design.** Every image is processed locally in your browser.
> Nothing is ever uploaded to a server.

---

## Use it

Open `index.html` in a browser — that's it, there's no build step. Or deploy it
(see below) and use it from your phone.

1. Go to **Splitter** and tap **Try an example** to see Auto-Detect in action.
2. Drop / paste / upload your own sprite sheet.
3. Tweak sensitivity (or switch to Grid mode) until the red boxes look right.
4. Optionally **🪄 Remove background** from the sheet or from selected sprites.
5. Tap **📥 Save all to Files**.

---

## Deploy

This is a fully static site, so any static host works.

### GitHub Pages (simplest)
Settings → **Pages** → *Deploy from a branch* → pick this branch, folder `/ (root)`.
It works as-is. Background removal runs single-threaded here (slower on the first
big image, fine after that).

### Cloudflare Pages / Netlify (recommended — faster background removal)
These honour the included `_headers` / `netlify.toml`, which set
`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`. That enables
`SharedArrayBuffer` → multithreaded WASM → **much faster** background removal.

- **Cloudflare Pages:** connect the repo, framework preset **None**, build command
  empty, output directory `/`.
- **Netlify:** connect the repo, build command empty, publish directory `/`.

---

## How it works

| Feature | Tech | Loaded |
|---|---|---|
| Sprite detection | Union-find connected components + projection on a single `getImageData` | built in |
| Background removal | [`@imgly/background-removal`](https://github.com/imgly/background-removal-js) (ONNX Runtime Web, WebGPU/WASM) | lazily from CDN on first use |
| ZIP packaging | [JSZip](https://stuk.github.io/jszip/) | lazily from CDN on first export |
| Save to device | Web Share API (iOS) with `<a download>` fallback | built in |

The two heavy libraries are loaded only when you first use the feature
(esm.sh, with jsDelivr as an automatic fallback). The first background removal
downloads a model (~40–80 MB) once; the browser caches it afterwards.

### About Pinterest

A static site **cannot** call the Pinterest API (it needs a server-side secret +
app review) or scrape Pinterest (CORS + their Terms forbid it). So the finder
does the honest thing: it **deep-links you to Pinterest's own search** in a new
tab, and the reliable way to bring an image in is to **upload, paste, or drag**
it (this keeps full quality and always exports). Pasting an `i.pinimg.com` image
URL is offered as a best-effort fallback — if the image is cross-origin
protected, the app detects it up front and tells you to download + re-upload
instead of failing silently later.

---

## Credits & licensing

- Background removal is powered by **`@imgly/background-removal`**, which is
  licensed **AGPL-3.0**. It is loaded at runtime from a CDN and is not bundled or
  redistributed by this repository. If you plan a **closed-source or commercial**
  deployment, review IMG.LY's license (a commercial license is available) — or
  swap the engine: it is fully isolated behind `js/bgremove.js` (`removeBackground`),
  so replacing it touches only that one file.
- ZIP packaging by **JSZip** (MIT).

Made for Pukking. 🧡
