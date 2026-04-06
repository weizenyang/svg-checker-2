/**
 * Floorplan Comparison Tool - Web-based implementation
 *
 * Compares a path cutout (from tower floorplate) to a matched floorplan image.
 * Returns three scores: Silhouette, Direct Image, and Line/Edge matching.
 *
 * Handles: scale mismatch, resolution mismatch, different compositions,
 * dimension overlays on floorplan (morphological opening), rotation alignment.
 *
 * Usage:
 *   import { runFloorplanComparison } from './floorplan-comparison.js';
 *   const scores = await runFloorplanComparison(svgElement, pathElement, floorplanDataUrl);
 *   // scores: { silhouette: 0-100, direct: 0-100, edge: 0-100, bestRotation: 0|90|180|270 }
 */

import JSZip from 'jszip';
import { cheapFloorFingerprintHex } from './floorplan-bench-fingerprint.js';
import {
  MORPH_PREPROCESS_DIM,
  downscaleMask,
  upsampleMask,
  morphologicalOpening,
  removeFloorplanBackground,
  applyRemovalMaskToImageData,
  removeLoosePixelsFromFloorplan,
  cropToContentBounds,
  preprocessSilhouetteJsPipelineFromImageData
} from './floorplan-silhouette-preprocess-core.js';
import SilhouettePreprocessWorker from './floorplan-silhouette-preprocess.worker.js?worker';

const NEUTRAL_BG = 0x80;       // Gray background for compositing (0-255)
const MAX_COMPARE_DIM = 512;   // Max dimension to avoid perf issues; no downscale to small fixed size
const THRESHOLD_OTSU_APPROX = 128; // Simple threshold fallback (Otsu would be better)

/** Default max( floorAR/cutAR, cutAR/floorAR ) — match Shape/Silhouette bench gate (AR = width÷height after crop). */
export const FLOORPLAN_CUTOUT_DEFAULT_MAX_ASPECT_SPAN = 2.5;

const SILHOUETTE_JS_CROPPED_PREPROCESS_CACHE_MAX = 200;
const SILHOUETTE_FP_PREPROCESS_CACHE_MAX = 200;
export const SILHOUETTE_PREPROCESS_CACHE_ZIP_KIND = 'silhouette-bench-js-preprocess-v1';

/** @type {Map<string, ImageData>} LRU: floorplan data URL → cropped JS preprocess (same pipeline as silhouette compare). */
const silhouetteJsCroppedPreprocessCache = new Map();
/** @type {Map<string, ImageData>} LRU: cheap floor fingerprint hex → cropped ImageData (for ZIP restore + cross-session reuse). */
const silhouettePreprocessByFingerprint = new Map();

function cloneImageData(src) {
  return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
}

function silhouetteJsCroppedCacheGet(url) {
  const hit = silhouetteJsCroppedPreprocessCache.get(url);
  if (!hit) return undefined;
  silhouetteJsCroppedPreprocessCache.delete(url);
  silhouetteJsCroppedPreprocessCache.set(url, hit);
  return hit;
}

function silhouetteJsCroppedCacheSet(url, imageData) {
  if (silhouetteJsCroppedPreprocessCache.has(url)) silhouetteJsCroppedPreprocessCache.delete(url);
  silhouetteJsCroppedPreprocessCache.set(url, imageData);
  while (silhouetteJsCroppedPreprocessCache.size > SILHOUETTE_JS_CROPPED_PREPROCESS_CACHE_MAX) {
    const oldest = silhouetteJsCroppedPreprocessCache.keys().next().value;
    silhouetteJsCroppedPreprocessCache.delete(oldest);
  }
}

function silhouetteFpCacheGet(fp) {
  const hit = silhouettePreprocessByFingerprint.get(fp);
  if (!hit) return undefined;
  silhouettePreprocessByFingerprint.delete(fp);
  silhouettePreprocessByFingerprint.set(fp, hit);
  return hit;
}

function silhouetteFpCacheSet(fp, imageData) {
  if (silhouettePreprocessByFingerprint.has(fp)) silhouettePreprocessByFingerprint.delete(fp);
  silhouettePreprocessByFingerprint.set(fp, imageData);
  while (silhouettePreprocessByFingerprint.size > SILHOUETTE_FP_PREPROCESS_CACHE_MAX) {
    const oldest = silhouettePreprocessByFingerprint.keys().next().value;
    silhouettePreprocessByFingerprint.delete(oldest);
  }
}

/** @type {false | Array<{ worker: Worker; busy: boolean }> | null} null = not initialized */
let silhouetteWorkerPool = null;
const silhouetteWorkerJobQueue = [];
let silhouetteWorkerJobIdSeq = 0;
/** @type {Map<number, { resolve: (im: ImageData) => void; reject: (e: Error) => void; slot: { worker: Worker; busy: boolean }; logTimings: boolean }>} */
const silhouetteWorkerPending = new Map();

function ensureSilhouetteWorkerPool() {
  if (silhouetteWorkerPool !== null) return silhouetteWorkerPool;
  if (typeof Worker === 'undefined') {
    silhouetteWorkerPool = false;
    return silhouetteWorkerPool;
  }
  try {
    const hc =
      typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
        ? navigator.hardwareConcurrency
        : 4;
    const n = Math.min(4, Math.max(1, hc - 1));
    const pool = [];
    for (let i = 0; i < n; i++) {
      const w = new SilhouettePreprocessWorker();
      const slot = { worker: w, busy: false };
      w.onmessage = (ev) => onSilhouetteWorkerMessage(slot, ev);
      w.onerror = (e) => onSilhouetteWorkerError(slot, e);
      pool.push(slot);
    }
    silhouetteWorkerPool = pool;
    return silhouetteWorkerPool;
  } catch (err) {
    console.warn('[Silhouette preprocess] worker pool init failed:', err);
    silhouetteWorkerPool = false;
    return silhouetteWorkerPool;
  }
}

function onSilhouetteWorkerMessage(slot, ev) {
  const data = ev.data;
  if (!data || typeof data.id !== 'number') return;
  const pend = silhouetteWorkerPending.get(data.id);
  if (!pend) return;
  silhouetteWorkerPending.delete(data.id);
  slot.busy = false;
  if (!data.ok) {
    pend.reject(new Error(data.error || 'silhouette worker failed'));
  } else {
    const im = new ImageData(new Uint8ClampedArray(data.buffer), data.width, data.height);
    if (pend.logTimings && typeof data.workerMs === 'number') {
      console.log(`[Silhouette preprocess]   worker total: ${data.workerMs.toFixed(1)}ms`);
    }
    pend.resolve(im);
  }
  pumpSilhouetteWorkerQueue();
}

function onSilhouetteWorkerError(slot, err) {
  slot.busy = false;
  for (const [id, pend] of silhouetteWorkerPending) {
    if (pend.slot === slot) {
      silhouetteWorkerPending.delete(id);
      pend.reject(new Error(err.message || 'silhouette worker error'));
      break;
    }
  }
  pumpSilhouetteWorkerQueue();
}

function pumpSilhouetteWorkerQueue() {
  const pool = silhouetteWorkerPool;
  if (!pool || pool === false || silhouetteWorkerJobQueue.length === 0) return;
  const idle = pool.find((s) => !s.busy);
  if (!idle) return;
  const job = silhouetteWorkerJobQueue.shift();
  startSilhouetteWorkerJob(idle, job);
}

function startSilhouetteWorkerJob(slot, job) {
  const id = ++silhouetteWorkerJobIdSeq;
  silhouetteWorkerPending.set(id, {
    resolve: job.resolve,
    reject: job.reject,
    slot,
    logTimings: job.logTimings
  });
  try {
    const copy = new Uint8ClampedArray(job.imageData.data);
    slot.busy = true;
    slot.worker.postMessage(
      {
        id,
        width: job.imageData.width,
        height: job.imageData.height,
        buffer: copy.buffer,
        logTimings: job.logTimings
      },
      [copy.buffer]
    );
  } catch (e) {
    silhouetteWorkerPending.delete(id);
    slot.busy = false;
    job.reject(e instanceof Error ? e : new Error(String(e)));
    pumpSilhouetteWorkerQueue();
  }
}

/**
 * Run silhouette JS preprocess in a worker pool job (parallel across floorplans). Falls back via caller.
 * @param {ImageData} imageData
 * @param {boolean} logTimings
 * @returns {Promise<ImageData>}
 */
function runSilhouettePreprocessWithWorkerPool(imageData, logTimings) {
  return new Promise((resolve, reject) => {
    const pool = ensureSilhouetteWorkerPool();
    if (!pool || pool === false) {
      reject(new Error('silhouette workers unavailable'));
      return;
    }
    const job = { imageData, logTimings, resolve, reject };
    const idle = pool.find((s) => !s.busy);
    if (idle) startSilhouetteWorkerJob(idle, job);
    else silhouetteWorkerJobQueue.push(job);
  });
}

/**
 * JS silhouette preprocess (crop after bg/morph), session-cached by data URL and cheap file fingerprint.
 * @param {string} floorplanDataUrl
 * @param {Object} [opts]
 * @param {boolean} [opts.bypassCache]
 * @param {boolean} [opts.logTimings] - console [Silhouette preprocess] cache/load/fingerprint/steps
 * @param {boolean} [opts.useWorker] - default true in browsers with Worker; set false to force main-thread pipeline
 * @returns {Promise<ImageData>}
 */
export async function getSilhouetteJsCroppedFloorplanForUrl(floorplanDataUrl, opts = {}) {
  const bypassCache = opts.bypassCache === true;
  const logTimings = opts.logTimings === true;
  const logTop = (msg) => {
    if (logTimings) console.log(`[Silhouette preprocess] ${msg}`);
  };
  let fpKnown = null;
  if (!bypassCache) {
    const urlHit = silhouetteJsCroppedCacheGet(floorplanDataUrl);
    if (urlHit) {
      logTop('cache HIT (same data URL) — skipped decode + pipeline');
      return cloneImageData(urlHit);
    }
    let t = performance.now();
    fpKnown = await cheapFloorFingerprintHex(floorplanDataUrl);
    if (logTimings) logTop(`cheapFingerprint: ${(performance.now() - t).toFixed(1)}ms`);
    const fpHit = silhouetteFpCacheGet(fpKnown);
    if (fpHit) {
      silhouetteJsCroppedCacheSet(floorplanDataUrl, cloneImageData(fpHit));
      logTop('cache HIT (fingerprint) — skipped decode + pipeline');
      return cloneImageData(fpHit);
    }
  }
  let t = performance.now();
  const floorplanData = await loadFloorplanImageData(floorplanDataUrl);
  if (logTimings) logTop(`loadFloorplanImageData (${floorplanData.width}×${floorplanData.height}): ${(performance.now() - t).toFixed(1)}ms`);
  if (logTimings) console.log(`[Silhouette preprocess] JS pipeline (bg / morph / crop):`);
  const useWorker = opts.useWorker !== false;
  let cropped;
  if (useWorker) {
    try {
      cropped = await runSilhouettePreprocessWithWorkerPool(floorplanData, logTimings);
    } catch (e) {
      if (logTimings) console.warn('[Silhouette preprocess] worker path failed, using main thread:', e);
      cropped = preprocessSilhouetteJsPipelineFromImageData(floorplanData, logTimings);
    }
  } else {
    cropped = preprocessSilhouetteJsPipelineFromImageData(floorplanData, logTimings);
  }
  if (!bypassCache) {
    let tf = performance.now();
    const fp = fpKnown ?? (await cheapFloorFingerprintHex(floorplanDataUrl));
    if (logTimings && fpKnown === null) logTop(`cheapFingerprint (for cache store): ${(performance.now() - tf).toFixed(1)}ms`);
    const stored = cloneImageData(cropped);
    silhouetteJsCroppedCacheSet(floorplanDataUrl, cloneImageData(stored));
    silhouetteFpCacheSet(fp, cloneImageData(stored));
    if (logTimings) logTop('store LRU caches (URL + fingerprint)');
  }
  return cropped;
}

function imageDataToPngBlob(imageData) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext('2d').putImageData(imageData, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG encode failed'));
    }, 'image/png');
  });
}

function decodeImageBufferToImageData(buf) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buf]);
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        const im = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(im);
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode image from ZIP'));
    };
    img.src = url;
  });
}

/** Clear silhouette JS preprocess maps (session + imported fingerprints). */
export function clearSilhouetteJsPreprocessCaches() {
  silhouetteJsCroppedPreprocessCache.clear();
  silhouettePreprocessByFingerprint.clear();
}

export function getSilhouettePreprocessCacheStats() {
  return {
    byUrl: silhouetteJsCroppedPreprocessCache.size,
    byFingerprint: silhouettePreprocessByFingerprint.size
  };
}

/** @returns {Promise<Blob | null>} null if fingerprint cache is empty */
export async function exportSilhouettePreprocessCacheZipBlob() {
  if (silhouettePreprocessByFingerprint.size === 0) return null;
  const zip = new JSZip();
  const entries = [];
  for (const [fp, im] of silhouettePreprocessByFingerprint) {
    const path = `cropped/${fp}.png`;
    const png = await imageDataToPngBlob(im);
    zip.file(path, png);
    entries.push({ fp, w: im.width, h: im.height, path });
  }
  zip.file(
    'manifest.json',
    JSON.stringify({ version: 1, kind: SILHOUETTE_PREPROCESS_CACHE_ZIP_KIND, entries }, null, 2)
  );
  return zip.generateAsync({ type: 'blob' });
}

/**
 * Load preprocess PNGs from a ZIP produced by exportSilhouettePreprocessCacheZipBlob into the fingerprint LRU.
 * @param {ArrayBuffer} buf
 * @returns {Promise<{ imported: number, totalInManifest: number }>}
 */
export async function importSilhouettePreprocessCacheFromZipArrayBuffer(buf) {
  const zip = await JSZip.loadAsync(buf);
  const mf = zip.file('manifest.json');
  if (!mf) throw new Error('ZIP has no manifest.json');
  const manifest = JSON.parse(await mf.async('string'));
  if (manifest.kind !== SILHOUETTE_PREPROCESS_CACHE_ZIP_KIND || !Array.isArray(manifest.entries)) {
    throw new Error('Not a silhouette bench preprocess cache ZIP');
  }
  let imported = 0;
  for (const e of manifest.entries) {
    if (!e.fp || !e.path) continue;
    const rel = String(e.path).replace(/^\//, '');
    const zf = zip.file(rel);
    if (!zf) continue;
    const ab = await zf.async('arraybuffer');
    const im = await decodeImageBufferToImageData(ab);
    silhouetteFpCacheSet(e.fp, im);
    imported += 1;
  }
  return { imported, totalInManifest: manifest.entries.length };
}

/**
 * Aspect “span” between cutout and cropped floorplan: max(floorAR/cutAR, cutAR/floorAR), AR = width/height.
 * @param {number} cutoutW
 * @param {number} cutoutH
 * @param {number} floorCroppedW
 * @param {number} floorCroppedH
 * @returns {number}
 */
export function floorplanCutoutAspectSpan(cutoutW, cutoutH, floorCroppedW, floorCroppedH) {
  const cw = Math.max(cutoutW, 1);
  const ch = Math.max(cutoutH, 1);
  const fw = Math.max(floorCroppedW, 1);
  const fh = Math.max(floorCroppedH, 1);
  const cutAR = cw / ch;
  const floorAR = fw / fh;
  return Math.max(floorAR / cutAR, cutAR / floorAR);
}

/**
 * Same as floorplanCutoutAspectSpan but allows the floor crop to be interpreted as rotated by 90° (swap w/h).
 * 0° and 180° share one bbox aspect; 90° and 270° share the swapped aspect — this is the min span over those two, matching cardinal rotation search in silhouette/compare.
 * @param {number} cutoutW
 * @param {number} cutoutH
 * @param {number} floorCroppedW
 * @param {number} floorCroppedH
 * @returns {number}
 */
export function floorplanCutoutMinAspectSpanAllowingFloor90(cutoutW, cutoutH, floorCroppedW, floorCroppedH) {
  const s0 = floorplanCutoutAspectSpan(cutoutW, cutoutH, floorCroppedW, floorCroppedH);
  const s90 = floorplanCutoutAspectSpan(cutoutW, cutoutH, floorCroppedH, floorCroppedW);
  return Math.min(s0, s90);
}

/**
 * @param {Object} opts
 * @param {number|false} [opts.maxAspectSpan]
 * @param {number|false} [opts.shapeBenchMaxAspectRatio]
 * @param {number|false} [opts.shapeBenchMaxDimensionRatio]
 * @param {boolean} [opts.skipAspectRatioCheck]
 * @returns {number|null} null = disabled
 */
function resolveMaxAspectSpanForCompare(opts) {
  if (opts.skipAspectRatioCheck === true) return null;
  const v = opts.maxAspectSpan ?? opts.shapeBenchMaxAspectRatio ?? opts.shapeBenchMaxDimensionRatio;
  if (v === false) return null;
  if (typeof v === 'number' && v > 1) return v;
  return FLOORPLAN_CUTOUT_DEFAULT_MAX_ASPECT_SPAN;
}

/**
 * @param {ImageData} pathCutoutData
 * @param {ImageData} floorplanCropped
 * @param {Object} opts
 */
function assertFloorplanCutoutAspectAllowed(pathCutoutData, floorplanCropped, opts) {
  const maxSpan = resolveMaxAspectSpanForCompare(opts);
  if (maxSpan == null) return;
  const span = floorplanCutoutMinAspectSpanAllowingFloor90(
    pathCutoutData.width,
    pathCutoutData.height,
    floorplanCropped.width,
    floorplanCropped.height
  );
  if (span > maxSpan) {
    const cw = pathCutoutData.width;
    const ch = pathCutoutData.height;
    const fw = floorplanCropped.width;
    const fh = floorplanCropped.height;
    throw new Error(
      `Aspect ratio mismatch: cutout ${cw}×${ch} vs floorplan (cropped) ${fw}×${fh} — span ${span.toFixed(2)} > ${maxSpan} (min over 0°/90° floor crop orientation). Use a floorplan with similar proportions, or pass maxAspectSpan:false to compare anyway.`
    );
  }
}

/**
 * Extract path cutout from SVG: the region of the tower floorplate behind the path.
 * Renders at the source image's pixel density (no quality loss from SVG coordinate resolution).
 * @param {SVGElement} svgElement - The SVG containing background image + paths
 * @param {SVGPathElement} pathElement - The path to extract
 * @returns {Promise<ImageData>} RGBA image data of the cutout
 */
export async function extractPathCutout(svgElement, pathElement) {
  const bbox = pathElement.getBBox();
  if (bbox.width <= 0 || bbox.height <= 0) {
    throw new Error('Path has invalid bounds');
  }

  const viewBox = parseViewBox(svgElement.getAttribute('viewBox') || '0 0 4096 4096');
  const bgImage = svgElement.querySelector('image');
  if (!bgImage || !bgImage.getAttribute('href')) {
    throw new Error('No tower floorplate background in SVG. Load tower floorplate images first.');
  }

  const href = bgImage.getAttribute('href');
  const imgWidth = parseFloat(bgImage.getAttribute('width') || viewBox.w);
  const imgHeight = parseFloat(bgImage.getAttribute('height') || viewBox.h);
  const imgX = parseFloat(bgImage.getAttribute('x') || 0);
  const imgY = parseFloat(bgImage.getAttribute('y') || 0);

  const pathD = pathElement.getAttribute('d') || '';
  if (!pathD) throw new Error('Path has no d attribute');

  const nat = await new Promise((resolve, reject) => {
    const tmp = new Image();
    tmp.onload = () => resolve({ w: tmp.naturalWidth, h: tmp.naturalHeight });
    tmp.onerror = () => reject(new Error('Failed to load background image for cutout resolution'));
    tmp.src = href;
  });

  const scaleX = nat.w / imgWidth;
  const scaleY = nat.h / imgHeight;
  const outW = Math.max(1, Math.round(bbox.width * scaleX));
  const outH = Math.max(1, Math.round(bbox.height * scaleY));

  const clipTransform = `translate(${-bbox.x}, ${-bbox.y})`;
  const imageOffsetX = imgX - bbox.x;
  const imageOffsetY = imgY - bbox.y;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${bbox.width} ${bbox.height}" width="${outW}" height="${outH}">
      <defs>
        <clipPath id="pathClip">
          <path d="${escapeSvgAttr(pathD)}" transform="${clipTransform}"/>
        </clipPath>
      </defs>
      <g clip-path="url(#pathClip)">
        <image href="${href}" x="${imageOffsetX}" y="${imageOffsetY}" width="${imgWidth}" height="${imgHeight}"/>
      </g>
    </svg>
  `;

  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      resolve(data);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load path cutout SVG'));
    };
    img.src = url;
  });
}

function escapeSvgAttr(s) {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;');
}

function parseViewBox(vb) {
  const parts = vb.trim().split(/\s+/).map(Number);
  return { x: parts[0] || 0, y: parts[1] || 0, w: parts[2] || 4096, h: parts[3] || 4096 };
}

export function imageDataToDataUrl(data, mime = 'image/png') {
  const canvas = document.createElement('canvas');
  canvas.width = data.width;
  canvas.height = data.height;
  canvas.getContext('2d').putImageData(data, 0, 0);
  return canvas.toDataURL(mime);
}

function grayToDataUrl(gray, w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return imageDataToDataUrl(new ImageData(rgba, w, h));
}

/**
 * Load floorplan image from data URL.
 * @param {string} dataUrl - Base64 or blob data URL
 * @returns {Promise<ImageData>}
 */
export async function loadFloorplanImageData(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = () => reject(new Error('Failed to load floorplan image'));
    img.src = dataUrl;
  });
}

/**
 * Read decoded intrinsic size only (no canvas / getImageData). Cheaper than loadFloorplanImageData when pixels are not needed.
 * @param {string} dataUrl
 * @returns {Promise<{ width: number, height: number }>}
 */
export async function getImageNaturalSizeFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Failed to read image dimensions'));
    img.src = dataUrl;
  });
}

/**
 * Downscale ImageData so max dimension is maxDim. Returns new ImageData.
 */
function downscaleImageDataToMaxDim(source, maxDim) {
  const sw = source.width, sh = source.height;
  if (sw <= maxDim && sh <= maxDim) return source;
  const scale = maxDim / Math.max(sw, sh);
  const targetW = Math.max(1, Math.round(sw * scale));
  const targetH = Math.max(1, Math.round(sh * scale));
  return resizeImageData(source, targetW, targetH);
}

/**
 * Downscale an edge map to smaller dimensions. Uses max in block (preserves thin edges).
 */
function downscaleEdgeMap(edges, w, h, targetW, targetH) {
  const out = new Uint8Array(targetW * targetH);
  const blockW = w / targetW;
  const blockH = h / targetH;
  for (let ty = 0; ty < targetH; ty++) {
    for (let tx = 0; tx < targetW; tx++) {
      let maxVal = 0;
      const y0 = (ty * blockH) | 0, y1 = Math.min(h, ((ty + 1) * blockH) | 0);
      const x0 = (tx * blockW) | 0, x1 = Math.min(w, ((tx + 1) * blockW) | 0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = edges[y * w + x];
          if (v > maxVal) maxVal = v;
        }
      }
      out[ty * targetW + tx] = maxVal > 127 ? 255 : 0;
    }
  }
  return out;
}

/**
 * Uniformly scale binary mask to fit inside cw×ch, center with 0 padding (letterbox).
 * Preserves aspect ratio (no non-uniform stretch onto the cutout grid).
 */
function fitMaskUniformPad(mask, sw, sh, cw, ch) {
  if (sw === cw && sh === ch) return mask;
  const scale = Math.min(cw / sw, ch / sh);
  const tw = Math.max(1, Math.min(cw, Math.round(sw * scale)));
  const th = Math.max(1, Math.min(ch, Math.round(sh * scale)));
  let scaled;
  if (tw === sw && th === sh) {
    scaled = mask;
  } else if (scale <= 1) {
    scaled = downscaleMask(mask, sw, sh, tw, th);
  } else {
    scaled = upsampleMask(mask, sw, sh, tw, th);
  }
  const out = new Uint8Array(cw * ch);
  const ox = ((cw - tw) / 2) | 0;
  const oy = ((ch - th) / 2) | 0;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      out[(oy + y) * cw + (ox + x)] = scaled[y * tw + x];
    }
  }
  return out;
}

function resizeGrayToSize(gray, sw, sh, tw, th) {
  if (sw === tw && sh === th) return gray;
  const scaleW = tw / sw;
  const scaleH = th / sh;
  if (scaleW <= 1 + 1e-9 && scaleH <= 1 + 1e-9) return resizeGray(gray, sw, sh, tw, th);
  const out = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(sw - 1, (x * sw / tw) | 0);
      const sy = Math.min(sh - 1, (y * sh / th) | 0);
      out[y * tw + x] = gray[sy * sw + sx];
    }
  }
  return out;
}

/**
 * Independent scale X/Y: stretch binary mask from sw×sh to exactly cw×ch (fills frame; no letterboxing).
 * Uses block vote when shrinking both axes; nearest pixel when enlarging either axis (same helpers as uniform path).
 */
function fitMaskStretchFill(mask, sw, sh, cw, ch) {
  if (sw === cw && sh === ch) return mask;
  if (cw <= sw && ch <= sh) return downscaleMask(mask, sw, sh, cw, ch);
  return upsampleMask(mask, sw, sh, cw, ch);
}

/** Stretch grayscale to exactly cw×ch (non-uniform scale; matches floor mask alignment). */
function fitGrayStretchFill(gray, sw, sh, cw, ch) {
  if (sw === cw && sh === ch) return gray;
  return resizeGrayToSize(gray, sw, sh, cw, ch);
}

/** Stretch edge map to exactly cw×ch (non-uniform scale; matches floor mask alignment). */
function fitEdgeStretchFill(edges, sw, sh, cw, ch) {
  if (sw === cw && sh === ch) return edges;
  return resizeEdgeToSize(edges, sw, sh, cw, ch);
}

/**
 * Uniformly scale grayscale to fit inside cw×ch, center with 0 padding.
 */
function fitGrayUniformPad(gray, sw, sh, cw, ch) {
  if (sw === cw && sh === ch) return gray;
  const scale = Math.min(cw / sw, ch / sh);
  const tw = Math.max(1, Math.min(cw, Math.round(sw * scale)));
  const th = Math.max(1, Math.min(ch, Math.round(sh * scale)));
  const scaled = resizeGrayToSize(gray, sw, sh, tw, th);
  const out = new Uint8Array(cw * ch);
  const ox = ((cw - tw) / 2) | 0;
  const oy = ((ch - th) / 2) | 0;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      out[(oy + y) * cw + (ox + x)] = scaled[y * tw + x];
    }
  }
  return out;
}

function resizeEdgeToSize(edges, sw, sh, tw, th) {
  if (sw === tw && sh === th) return edges;
  const scaleW = tw / sw;
  const scaleH = th / sh;
  if (scaleW <= 1 + 1e-9 && scaleH <= 1 + 1e-9) return downscaleEdgeMap(edges, sw, sh, tw, th);
  const out = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(sw - 1, (x * sw / tw) | 0);
      const sy = Math.min(sh - 1, (y * sh / th) | 0);
      out[y * tw + x] = edges[sy * sw + sx];
    }
  }
  return out;
}

/**
 * Uniformly scale edge map to fit inside cw×ch, center with 0 padding.
 */
function fitEdgeUniformPad(edges, sw, sh, cw, ch) {
  if (sw === cw && sh === ch) return edges;
  const scale = Math.min(cw / sw, ch / sh);
  const tw = Math.max(1, Math.min(cw, Math.round(sw * scale)));
  const th = Math.max(1, Math.min(ch, Math.round(sh * scale)));
  const scaled = resizeEdgeToSize(edges, sw, sh, tw, th);
  const out = new Uint8Array(cw * ch);
  const ox = ((cw - tw) / 2) | 0;
  const oy = ((ch - th) / 2) | 0;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      out[(oy + y) * cw + (ox + x)] = scaled[y * tw + x];
    }
  }
  return out;
}

/**
 * Resize ImageData to target dimensions (stretch).
 */
function resizeImageData(source, targetW, targetH) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(source, 0, 0);
  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const outCtx = out.getContext('2d');
  outCtx.drawImage(canvas, 0, 0, source.width, source.height, 0, 0, targetW, targetH);
  return outCtx.getImageData(0, 0, targetW, targetH);
}

/**
 * Fit ImageData into target dimensions, preserving aspect ratio. Letterbox with neutral bg.
 */
function resizeImageDataFit(source, targetW, targetH, bgGray = NEUTRAL_BG) {
  const sw = source.width, sh = source.height;
  if (sw === targetW && sh === targetH) return source;
  const scale = Math.min(targetW / sw, targetH / sh);
  const fitW = Math.round(sw * scale), fitH = Math.round(sh * scale);
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(source, 0, 0);
  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const outCtx = out.getContext('2d');
  outCtx.fillStyle = `rgb(${bgGray},${bgGray},${bgGray})`;
  outCtx.fillRect(0, 0, targetW, targetH);
  const x = (targetW - fitW) / 2;
  const y = (targetH - fitH) / 2;
  outCtx.drawImage(canvas, 0, 0, sw, sh, x, y, fitW, fitH);
  return outCtx.getImageData(0, 0, targetW, targetH);
}

/**
 * Fit ImageData into target dimensions, preserving aspect ratio and alpha.
 * Transparent areas stay transparent (unlike resizeImageDataFit which uses gray).
 */
function resizeImageDataFitPreserveAlpha(source, targetW, targetH) {
  const sw = source.width, sh = source.height;
  if (sw === targetW && sh === targetH) return new ImageData(new Uint8ClampedArray(source.data), sw, sh);
  const scale = Math.min(targetW / sw, targetH / sh);
  const fitW = Math.round(sw * scale), fitH = Math.round(sh * scale);
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(source, 0, 0);
  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const outCtx = out.getContext('2d');
  outCtx.clearRect(0, 0, targetW, targetH);
  const x = (targetW - fitW) / 2;
  const y = (targetH - fitH) / 2;
  outCtx.drawImage(canvas, 0, 0, sw, sh, x, y, fitW, fitH);
  return outCtx.getImageData(0, 0, targetW, targetH);
}

/**
 * Composite image onto neutral background. Treats low-alpha as background.
 */
function compositeOnNeutralBg(data, bgGray = NEUTRAL_BG) {
  const out = new Uint8ClampedArray(data.data.length);
  for (let i = 0; i < data.data.length; i += 4) {
    const a = data.data[i + 3] / 255;
    out[i] = data.data[i] * a + bgGray * (1 - a);
    out[i + 1] = data.data[i + 1] * a + bgGray * (1 - a);
    out[i + 2] = data.data[i + 2] * a + bgGray * (1 - a);
    out[i + 3] = 255;
  }
  return new ImageData(new Uint8ClampedArray(out), data.width, data.height);
}

/**
 * Convert to grayscale.
 */
function toGrayscale(data) {
  const out = new Uint8ClampedArray(data.width * data.height);
  for (let i = 0; i < data.data.length; i += 4) {
    out[i / 4] = (data.data[i] * 0.299 + data.data[i + 1] * 0.587 + data.data[i + 2] * 0.114) | 0;
  }
  return out;
}

/**
 * Simple Otsu-like threshold to produce binary mask.
 * Uses a simplified approach: threshold at level that maximizes between-class variance.
 */
function thresholdOtsu(gray, w, h) {
  const hist = new Int32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  let sum = 0, sumB = 0, wB = 0, wF, mB, mF, max = 0, thresh = THRESHOLD_OTSU_APPROX;
  const total = gray.length;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    mB = sumB / wB;
    mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > max) {
      max = between;
      thresh = t;
    }
  }
  const mask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) mask[i] = gray[i] < thresh ? 0 : 255;
  return mask;
}

/**
 * Invert mask: floorplan often has white bg, cutout has content as foreground.
 * We want foreground=255 for both. Floorplan: dark lines on light bg -> invert so lines=255.
 */
function normalizeMaskForFloorplan(mask) {
  const sum = mask.reduce((a, b) => a + b, 0);
  const mean = sum / mask.length;
  if (mean > 127) {
    for (let i = 0; i < mask.length; i++) mask[i] = 255 - mask[i];
  }
  return mask;
}

/**
 * Cutout silhouette: use entire image (alpha-based). The path cutout has transparent
 * regions outside the path. Foreground = any pixel with alpha > threshold (the whole cutout region).
 */
function cutoutSilhouetteFromAlpha(data, targetW, targetH) {
  const w = data.width, h = data.height;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data.data[i * 4 + 3];
    mask[i] = a > 32 ? 255 : 0;
  }
  if (w === targetW && h === targetH) return mask;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const imgData = new ImageData(new Uint8ClampedArray(mask.length * 4), w, h);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i];
    imgData.data[i * 4] = imgData.data[i * 4 + 1] = imgData.data[i * 4 + 2] = v;
    imgData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const outCtx = out.getContext('2d');
  outCtx.drawImage(canvas, 0, 0, w, h, 0, 0, targetW, targetH);
  const resized = outCtx.getImageData(0, 0, targetW, targetH);
  const outMask = new Uint8Array(targetW * targetH);
  for (let i = 0; i < outMask.length; i++) {
    outMask[i] = resized.data[i * 4] > 128 ? 255 : 0;
  }
  return outMask;
}

/**
 * Compute silhouette (IoU) score between two binary masks.
 */
function silhouetteScore(maskA, maskB) {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < maskA.length; i++) {
    const a = maskA[i] > 127 ? 1 : 0;
    const b = maskB[i] > 127 ? 1 : 0;
    intersection += a & b;
    union += a | b;
  }
  return union > 0 ? intersection / union : 0;
}

/**
 * Intersection / union counts for the same binary masks as silhouetteScore().
 * @returns {{ intersection: number, union: number, iou: number, cutoutPixels: number, floorPixels: number }}
 */
function silhouetteIouComponents(maskA, maskB) {
  let intersection = 0;
  let union = 0;
  let cutoutPixels = 0;
  let floorPixels = 0;
  for (let i = 0; i < maskA.length; i++) {
    const a = maskA[i] > 127 ? 1 : 0;
    const b = maskB[i] > 127 ? 1 : 0;
    intersection += a & b;
    union += a | b;
    cutoutPixels += a;
    floorPixels += b;
  }
  const iou = union > 0 ? intersection / union : 0;
  return { intersection, union, iou, cutoutPixels, floorPixels };
}

/** Foreground pixels with a 4-neighbor outside foreground (or image edge). */
function extractBinaryBoundaryIndices(mask, w, h) {
  const out = [];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (mask[i] <= 127) continue;
      const left = x > 0 ? mask[i - 1] : 0;
      const right = x < w - 1 ? mask[i + 1] : 0;
      const up = y > 0 ? mask[i - w] : 0;
      const down = y < h - 1 ? mask[i + w] : 0;
      if (left <= 127 || right <= 127 || up <= 127 || down <= 127) out.push(i);
    }
  }
  return out;
}

/** Cost off seeds in squared EDT (must be ≫ max useful squared distance on grid). */
const EDT_OFF_SEED_COST = 1e20;

/**
 * 1D squared distance transform: output[i] = min_j input[j] + (i−j)² (Felzenszwalb–Huttenlocher).
 * v length ≥ n, z length ≥ n + 1.
 */
function edt1dSquaredInto(input, output, n, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    do {
      const r = v[k];
      s = (input[q] + q * q - input[r] - r * r) / (2 * q - 2 * r);
    } while (s <= z[k] && --k >= 0);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    output[q] = input[r] + (q - r) * (q - r);
  }
}

/**
 * Squared Euclidean distance to nearest seed pixel. Returns Float64Array of squared distances.
 */
function edtSquaredEuclideanMultiSource(w, h, seeds) {
  const n = w * h;
  const img = new Float64Array(n);
  img.fill(EDT_OFF_SEED_COST);
  for (let s = 0; s < seeds.length; s++) img[seeds[s]] = 0;

  const pass1 = new Float64Array(n);
  const m = Math.max(w, h);
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  const rowIn = new Float64Array(w);
  const rowOut = new Float64Array(w);
  const colIn = new Float64Array(h);
  const colOut = new Float64Array(h);

  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) rowIn[x] = img[o + x];
    edt1dSquaredInto(rowIn, rowOut, w, v, z);
    for (let x = 0; x < w; x++) pass1[o + x] = rowOut[x];
  }

  const out = new Float64Array(n);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) colIn[y] = pass1[y * w + x];
    edt1dSquaredInto(colIn, colOut, h, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = colOut[y];
  }
  return out;
}

/**
 * Per-edge Euclidean distances to nearest opposite boundary (from squared DT).
 * @returns {{ mean: number, std: number }} std = population σ of sqrt distances; 0 if one edge pixel.
 */
function edgeEuclideanMeanStd(dtSq, indices) {
  const n = indices.length;
  if (n === 0) return { mean: CHAMFER_DIST_INF, std: 0 };
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const t = dtSq[indices[k]];
    if (t >= EDT_OFF_SEED_COST * 0.5) return { mean: CHAMFER_DIST_INF, std: 0 };
    sum += Math.sqrt(Math.max(0, t));
  }
  const mean = sum / n;
  if (n < 2) return { mean, std: 0 };
  let vsum = 0;
  for (let k = 0; k < n; k++) {
    const t = dtSq[indices[k]];
    const d = Math.sqrt(Math.max(0, t)) - mean;
    vsum += d * d;
  }
  const std = Math.sqrt(vsum / n);
  return { mean, std };
}

/**
 * Symmetric Chamfer stats on grid (comparison resolution, Euclidean DT in grid pixels).
 * @param {number} varWeight - effective = meanSym + varWeight × stdSym
 * @returns {{ meanSym: number, stdSym: number, effective: number }}
 */
function symmetricBoundaryChamferStats(maskFloor, w, h, edgeCutout, edgeFloor, varWeight) {
  const bad = { meanSym: CHAMFER_DIST_INF, stdSym: 0, effective: CHAMFER_DIST_INF };
  if (edgeCutout.length === 0 || edgeFloor.length === 0) return bad;
  const dtSqToFloor = edtSquaredEuclideanMultiSource(w, h, edgeFloor);
  const dtSqToCutout = edtSquaredEuclideanMultiSource(w, h, edgeCutout);
  const ca = edgeEuclideanMeanStd(dtSqToFloor, edgeCutout);
  const cb = edgeEuclideanMeanStd(dtSqToCutout, edgeFloor);
  if (
    !Number.isFinite(ca.mean) ||
    !Number.isFinite(cb.mean) ||
    ca.mean >= CHAMFER_DIST_INF - 1 ||
    cb.mean >= CHAMFER_DIST_INF - 1
  ) {
    return bad;
  }
  const meanSym = (ca.mean + cb.mean) * 0.5;
  const stdSym = (ca.std + cb.std) * 0.5;
  const effective = meanSym + varWeight * stdSym;
  return { meanSym, stdSym, effective };
}

/**
 * Symmetric Chamfer on grid: mean edge distance + varWeight × mean σ across edges
 * (prefers consistent alignment — low spread — over the same mean with uneven local gaps).
 * @param {number} varWeight - multiply averaged std and add to averaged mean (0 = mean only).
 */
function symmetricBoundaryChamferEffective(maskFloor, w, h, edgeCutout, edgeFloor, varWeight) {
  return symmetricBoundaryChamferStats(maskFloor, w, h, edgeCutout, edgeFloor, varWeight)
    .effective;
}

/**
 * Map mean boundary distance to [0,1]. Stricter: lower normFrac and/or exponent &gt; 1
 * (penalizes (meanDist/d0)^exponent so moderate misalignment loses more score).
 */
function chamferMeanToSimilarity(meanDist, gridDiag, normFrac, exponent = 1) {
  if (!Number.isFinite(meanDist) || meanDist >= CHAMFER_DIST_INF - 1) return 0;
  const d0 = gridDiag * normFrac;
  if (d0 <= 1e-9) return 0;
  const ratio = meanDist / d0;
  const exp = Math.max(1, exponent);
  const penalized = exp === 1 ? ratio : Math.min(1, ratio) ** exp;
  return Math.max(0, Math.min(1, 1 - penalized));
}

/** RGBA image: yellow = overlap, blue = cutout-only, red = floor-only, dark = neither. */
function composeIouOverlapRgba(maskCutout, maskFloor, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  const bg = [26, 26, 26];
  const cutOnly = [80, 130, 255];
  const floorOnly = [255, 75, 75];
  const both = [255, 220, 60];
  for (let i = 0; i < w * h; i++) {
    const a = maskCutout[i] > 127;
    const b = maskFloor[i] > 127;
    const c = a && b ? both : a ? cutOnly : b ? floorOnly : bg;
    const o = i * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = 255;
  }
  return new ImageData(data, w, h);
}

/** Grayscale mask preview (floorplan-style: light fill on dark). */
function maskToPreviewRgba(mask, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = mask[i] > 127 ? 235 : 45;
    const o = i * 4;
    data[o] = data[o + 1] = data[o + 2] = v;
    data[o + 3] = 255;
  }
  return new ImageData(data, w, h);
}

/**
 * Simple SSIM-like structural similarity. Simplified version.
 * Uses luminance, contrast, structure terms at 8x8 windows.
 */
function directImageScore(grayA, grayB, w, h) {
  const size = w * h;
  const meanA = grayA.reduce((a, b) => a + b, 0) / size;
  const meanB = grayB.reduce((a, b) => a + b, 0) / size;
  let varA = 0, varB = 0, cov = 0;
  for (let i = 0; i < size; i++) {
    const da = grayA[i] - meanA;
    const db = grayB[i] - meanB;
    varA += da * da;
    varB += db * db;
    cov += da * db;
  }
  varA /= size;
  varB /= size;
  cov /= size;
  const c1 = 6.5025, c2 = 58.5225;
  const ssim = ((2 * meanA * meanB + c1) * (2 * cov + c2)) /
    ((meanA * meanA + meanB * meanB + c1) * (varA + varB + c2));
  return Math.max(0, Math.min(1, (ssim + 1) / 2));
}

/**
 * Simple Sobel edge detection on grayscale image (actual content edges, not silhouette).
 */
function sobelEdges(gray, w, h) {
  const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  const out = new Uint8Array(gray.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let sx = 0, sy = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const idx = (y + ky) * w + (x + kx);
          sx += gray[idx] * gx[(ky + 1) * 3 + (kx + 1)];
          sy += gray[idx] * gy[(ky + 1) * 3 + (kx + 1)];
        }
      }
      const mag = Math.sqrt(sx * sx + sy * sy) | 0;
      out[y * w + x] = Math.min(255, mag);
    }
  }
  const threshold = 50;
  for (let i = 0; i < out.length; i++) out[i] = out[i] > threshold ? 255 : 0;
  return out;
}

/**
 * Chamfer-like edge overlap score. Normalized overlap of edge pixels within tolerance.
 */
function edgeScore(edgesA, edgesB, w, h, tolerance = 2) {
  let match = 0;
  let total = 0;
  const t2 = tolerance * tolerance;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (edgesA[idx] > 127) {
        total++;
        let found = false;
        for (let dy = -tolerance; dy <= tolerance && !found; dy++) {
          for (let dx = -tolerance; dx <= tolerance && !found; dx++) {
            if (dx * dx + dy * dy > t2) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h && edgesB[ny * w + nx] > 127) {
              found = true;
            }
          }
        }
        if (found) match++;
      }
    }
  }
  return total > 0 ? match / total : 0;
}

/**
 * Rotate Uint8Array (1-channel: mask, gray, edges) by 90*deg.
 * deg: 0,1,2,3 = 0°, 90°CW, 180°, 270°CW. Returns { data, width, height }.
 * (Earlier indexing was only valid for square grids and caused stripes on rectangles.)
 */
function rotateUint8Array90(arr, w, h, deg) {
  if (deg === 0) return { data: arr, width: w, height: h };
  let outW = w;
  let outH = h;
  if (deg === 1 || deg === 3) {
    outW = h;
    outH = w;
  }
  const out = new Uint8Array(outW * outH);
  // Row-major source: index = iy * w + ix. Match OpenCV ROTATE_90_CLOCKWISE / ROTATE_90_COUNTERCLOCKWISE.
  if (deg === 1) {
    // 90° CW: out is h×w; sample (oy, ox) from src (h-1-ox, oy)
    for (let oy = 0; oy < outH; oy++) {
      for (let ox = 0; ox < outW; ox++) {
        const ix = oy;
        const iy = h - 1 - ox;
        out[oy * outW + ox] = arr[iy * w + ix];
      }
    }
  } else if (deg === 2) {
    for (let oy = 0; oy < outH; oy++) {
      for (let ox = 0; ox < outW; ox++) {
        const ix = w - 1 - ox;
        const iy = h - 1 - oy;
        out[oy * outW + ox] = arr[iy * w + ix];
      }
    }
  } else {
    // 270° CW (90° CCW): out is h×w; sample (oy, ox) from src (ox, w-1-oy)
    for (let oy = 0; oy < outH; oy++) {
      for (let ox = 0; ox < outW; ox++) {
        const ix = w - 1 - oy;
        const iy = ox;
        out[oy * outW + ox] = arr[iy * w + ix];
      }
    }
  }
  return { data: out, width: outW, height: outH };
}

/** Horizontal flip of a row-major w×h binary mask. */
function flipMaskH(arr, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + (w - 1 - x)] = arr[y * w + x];
    }
  }
  return out;
}

/** Default longest edge for silhouette IoU search (smaller = faster). */
const SILHOUETTE_ONLY_DEFAULT_MAX_DIM = 256;
/** Weight of boundary Chamfer in combined score (remainder = IoU). Higher = outline match matters more. */
const SILHOUETTE_CHAMFER_BLEND_DEFAULT = 0.52;
/** Chamfer: effective dist at normFrac×diagonal maps to ~0 similarity (smaller = minute errors swing score more). */
const SILHOUETTE_CHAMFER_DIAG_FRAC_DEFAULT = 0.15;
/** Chamfer: apply (dist/d0)^exponent before 1−… (larger = stricter). */
const SILHOUETTE_CHAMFER_EXPONENT_DEFAULT = 1.35;
/** Added to mean edge distance: effectiveDist = mean + varWeight × σ̄ (reward low spread across edge samples). */
const SILHOUETTE_CHAMFER_VAR_WEIGHT_DEFAULT = 1.2;
/** Scale effective Chamfer distance before similarity curve (amplifies sub-pixel-grid differences in ranking). */
const SILHOUETTE_CHAMFER_DIST_AMPLIFY_DEFAULT = 2.4;
const CHAMFER_DIST_INF = 0x3fffffff;

/**
 * Resize Uint8Array (grayscale) to target dimensions. Block average.
 */
function resizeGray(gray, w, h, targetW, targetH) {
  const out = new Uint8Array(targetW * targetH);
  const blockW = w / targetW;
  const blockH = h / targetH;
  for (let ty = 0; ty < targetH; ty++) {
    for (let tx = 0; tx < targetW; tx++) {
      let sum = 0, count = 0;
      const y0 = (ty * blockH) | 0, y1 = Math.min(h, ((ty + 1) * blockH) | 0);
      const x0 = (tx * blockW) | 0, x1 = Math.min(w, ((tx + 1) * blockW) | 0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += gray[y * w + x];
          count++;
        }
      }
      out[ty * targetW + tx] = count > 0 ? (sum / count) | 0 : 0;
    }
  }
  return out;
}

/**
 * Rotate floorplan ImageData by 90*deg (0,1,2,3 = 0°, 90°CW, 180°, 270°CW).
 */
function rotateImageData90(data, deg) {
  if (deg === 0) return data;
  const { width: w, height: h } = data;
  const src = data.data;
  let outW = w;
  let outH = h;
  if (deg === 1 || deg === 3) {
    outW = h;
    outH = w;
  }
  const out = new ImageData(outW, outH);
  const dst = out.data;
  const copyPix = (sidx, didx) => {
    dst[didx] = src[sidx];
    dst[didx + 1] = src[sidx + 1];
    dst[didx + 2] = src[sidx + 2];
    dst[didx + 3] = src[sidx + 3];
  };
  if (deg === 1) {
    for (let oy = 0; oy < outH; oy++) {
      for (let ox = 0; ox < outW; ox++) {
        const ix = oy;
        const iy = h - 1 - ox;
        copyPix((iy * w + ix) * 4, (oy * outW + ox) * 4);
      }
    }
  } else if (deg === 2) {
    for (let oy = 0; oy < outH; oy++) {
      for (let ox = 0; ox < outW; ox++) {
        const ix = w - 1 - ox;
        const iy = h - 1 - oy;
        copyPix((iy * w + ix) * 4, (oy * outW + ox) * 4);
      }
    }
  } else {
    for (let oy = 0; oy < outH; oy++) {
      for (let ox = 0; ox < outW; ox++) {
        const ix = w - 1 - oy;
        const iy = ox;
        copyPix((iy * w + ix) * 4, (oy * outW + ox) * 4);
      }
    }
  }
  return out;
}

/**
 * Resolved Chamfer knobs for silhouette-only compare (same defaults as compareSilhouetteOnlyToCutout).
 * Spread onto each bench row for table/CSV columns.
 *
 * @param {Object} [opts]
 * @returns {{ chamferBlend: number, chamferDiagFrac: number, chamferExponent: number, chamferVarWeight: number, chamferDistAmplify: number }}
 */
export function resolveSilhouetteChamferOpts(opts = {}) {
  return {
    chamferBlend:
      typeof opts.silhouetteChamferBlend === 'number'
        ? Math.max(0, Math.min(1, opts.silhouetteChamferBlend))
        : SILHOUETTE_CHAMFER_BLEND_DEFAULT,
    chamferDiagFrac:
      typeof opts.silhouetteChamferDiagFrac === 'number' && opts.silhouetteChamferDiagFrac > 0
        ? opts.silhouetteChamferDiagFrac
        : SILHOUETTE_CHAMFER_DIAG_FRAC_DEFAULT,
    chamferExponent:
      typeof opts.silhouetteChamferExponent === 'number' && opts.silhouetteChamferExponent >= 1
        ? opts.silhouetteChamferExponent
        : SILHOUETTE_CHAMFER_EXPONENT_DEFAULT,
    chamferVarWeight:
      typeof opts.silhouetteChamferVarWeight === 'number' && opts.silhouetteChamferVarWeight >= 0
        ? opts.silhouetteChamferVarWeight
        : SILHOUETTE_CHAMFER_VAR_WEIGHT_DEFAULT,
    chamferDistAmplify:
      typeof opts.silhouetteChamferDistAmplify === 'number' && opts.silhouetteChamferDistAmplify > 0
        ? opts.silhouetteChamferDistAmplify
        : SILHOUETTE_CHAMFER_DIST_AMPLIFY_DEFAULT
  };
}

/**
 * Silhouette-only match: binary filled masks + best pose over 4 rotations × 2 (unflipped + horizontal flip).
 * Floorplan mask is stretched (non-uniform) to the cutout comparison grid before IoU/Chamfer so it fills the frame.
 * Scores with IoU and Chamfer on Euclidean edge distances (L₂ DT): effective dist = mean + varWeight·σ̄ (both
 * directions), × amplify, then similarity curve; combined = (1−w)·IoU + w·ChamferSim (default w≈0.52).
 * Faster than full compare (no gray/interior edges for legacy direct/edge scores).
 *
 * @param {ImageData} pathCutoutData
 * @param {string} floorplanDataUrl
 * @param {Object} [opts]
 * @param {number} [opts.maxCompareDim] - longest edge for comparison grid (default 256)
 * @param {boolean} [opts.shapeBenchTiming] - log total match ms as [Silhouette bench]
 * @param {boolean} [opts.skipAspectRatioCheck] - if true, skip cutout vs cropped-floorplan AR gate (batch already gated)
 * @param {number|false} [opts.maxAspectSpan] - max AR span (default 2.5); false disables
 * @param {boolean} [opts.includeSilhouetteVisual] - if true, add silhouetteVisual: masks + IoU counts (for UI)
 * @param {boolean} [opts.bypassSilhouettePreprocessCache] - if true, always re-run JS preprocess (ignore session / ZIP cache)
 * @param {number} [opts.silhouetteChamferBlend] - weight of Chamfer in 0–1 (default ~0.52); 0 = IoU only
 * @param {number} [opts.silhouetteChamferDiagFrac] - scale: sim ~0 when effective dist ≥ this × hypot(grid) (default 0.15)
 * @param {number} [opts.silhouetteChamferExponent] - ≥1; (dist/scale)^exp (default 1.35)
 * @param {number} [opts.silhouetteChamferVarWeight] - ≥0; add this × σ̄ to mean edge distance (default 1.2); 0 = ignore spread
 * @param {number} [opts.silhouetteChamferDistAmplify] - multiply effective dist before similarity (default 2.4; higher = Chamfer louder)
 */
export async function compareSilhouetteOnlyToCutout(pathCutoutData, floorplanDataUrl, opts = {}) {
  const shapeBenchTiming = !!opts.shapeBenchTiming;
  const maxDim = opts.maxCompareDim ?? SILHOUETTE_ONLY_DEFAULT_MAX_DIM;
  const chamferOptsResolved = resolveSilhouetteChamferOpts(opts);
  const {
    chamferBlend,
    chamferDiagFrac,
    chamferExponent,
    chamferVarWeight,
    chamferDistAmplify
  } = chamferOptsResolved;
  const tStart = performance.now();
  let t = performance.now();

  const floorplanCleaned = await getSilhouetteJsCroppedFloorplanForUrl(floorplanDataUrl, {
    bypassCache: opts.bypassSilhouettePreprocessCache === true,
    logTimings: shapeBenchTiming
  });
  const msPreprocessTotal = performance.now() - t;

  t = performance.now();
  assertFloorplanCutoutAspectAllowed(pathCutoutData, floorplanCleaned, opts);
  const msAspect = performance.now() - t;

  t = performance.now();
  const cutoutComp = compositeOnNeutralBg(pathCutoutData);
  const floorplanComp = compositeOnNeutralBg(floorplanCleaned);
  const msComposite = performance.now() - t;

  t = performance.now();
  let cw = pathCutoutData.width;
  let ch = pathCutoutData.height;
  if (cw > maxDim || ch > maxDim) {
    const s = Math.min(maxDim / cw, maxDim / ch);
    cw = Math.round(cw * s);
    ch = Math.round(ch * s);
  }
  const cutoutWork =
    cw === pathCutoutData.width && ch === pathCutoutData.height
      ? cutoutComp
      : resizeImageData(cutoutComp, cw, ch);
  const cutoutLongest = Math.max(cw, ch);
  const fpOrigW = floorplanComp.width;
  const fpOrigH = floorplanComp.height;
  const fpOrigLongest = Math.max(fpOrigW, fpOrigH);
  const scale = cutoutLongest / fpOrigLongest;
  const fpW = Math.max(1, Math.round(fpOrigW * scale));
  const fpH = Math.max(1, Math.round(fpOrigH * scale));
  const floorplanScaled = resizeImageData(floorplanComp, fpW, fpH);
  const floorplanCleanedScaled = resizeImageData(floorplanCleaned, fpW, fpH);
  const msResizeWorkGrid = performance.now() - t;

  t = performance.now();
  const maskCutout = cutoutSilhouetteFromAlpha(pathCutoutData, cw, ch);
  const edgeCutout = extractBinaryBoundaryIndices(maskCutout, cw, ch);
  const gridDiag = Math.hypot(cw, ch);
  const msCutoutMask = performance.now() - t;

  t = performance.now();
  const maskFloorRaw = new Uint8Array(fpW * fpH);
  for (let i = 0; i < fpW * fpH; i++) {
    maskFloorRaw[i] = floorplanCleanedScaled.data[i * 4 + 3] > 32 ? 255 : 0;
  }
  const maskFloorFull = morphologicalOpening(maskFloorRaw, fpW, fpH, 7);
  const msFloorMaskMorph = performance.now() - t;

  let bestCombined = -1;
  let bestIou = 0;
  let bestChamferSim = 0;
  /** Symmetric mean boundary distance (grid px) for winning pose */
  let bestChamferMeanPx = NaN;
  /** Symmetric σ of per-edge distances (grid px) for winning pose */
  let bestChamferStdPx = NaN;
  let bestRot = 0;
  let bestFlipped = false;
  const bestMaskFloor = new Uint8Array(cw * ch);

  const tryAllRotations = (baseMask, bw, bh, flipped) => {
    for (let rot = 0; rot < 4; rot++) {
      const maskRot = rotateUint8Array90(baseMask, bw, bh, rot);
      const maskFloor = fitMaskStretchFill(maskRot.data, maskRot.width, maskRot.height, cw, ch);
      const iou = silhouetteScore(maskCutout, maskFloor);
      const edgeFloor = extractBinaryBoundaryIndices(maskFloor, cw, ch);
      const chSt = symmetricBoundaryChamferStats(
        maskFloor,
        cw,
        ch,
        edgeCutout,
        edgeFloor,
        chamferVarWeight
      );
      const dChamferEff = chSt.effective;
      const dForSim = dChamferEff * chamferDistAmplify;
      const chamferSim = chamferMeanToSimilarity(dForSim, gridDiag, chamferDiagFrac, chamferExponent);
      const combined =
        chamferBlend > 0 ? (1 - chamferBlend) * iou + chamferBlend * chamferSim : iou;
      if (
        combined > bestCombined + 1e-15 ||
        (Math.abs(combined - bestCombined) <= 1e-15 && iou > bestIou)
      ) {
        bestCombined = combined;
        bestIou = iou;
        bestChamferSim = chamferSim;
        const chFinite =
          Number.isFinite(chSt.meanSym) &&
          Number.isFinite(chSt.stdSym) &&
          chSt.meanSym < CHAMFER_DIST_INF - 1;
        bestChamferMeanPx = chFinite ? chSt.meanSym : NaN;
        bestChamferStdPx = chFinite ? chSt.stdSym : NaN;
        bestRot = rot;
        bestFlipped = flipped;
        bestMaskFloor.set(maskFloor);
      }
    }
  };

  t = performance.now();
  tryAllRotations(maskFloorFull, fpW, fpH, false);
  const flippedMask = flipMaskH(maskFloorFull, fpW, fpH);
  tryAllRotations(flippedMask, fpW, fpH, true);
  const msIouSearch = performance.now() - t;

  if (shapeBenchTiming) {
    const total = performance.now() - tStart;
    console.log(
      `%c[Silhouette bench]%c match phases (grid ${cw}×${ch}, floor mask ${fpW}×${fpH})`,
      'font-weight:bold',
      'font-weight:normal'
    );
    console.log(
      `  preprocess (incl. cache/fingerprint/load): ${msPreprocessTotal.toFixed(1)}ms | aspect check: ${msAspect.toFixed(1)}ms | composite: ${msComposite.toFixed(1)}ms | resize work grid: ${msResizeWorkGrid.toFixed(1)}ms | cutout mask: ${msCutoutMask.toFixed(1)}ms | floor α→mask+morph(7): ${msFloorMaskMorph.toFixed(1)}ms | IoU+Chamfer 8 poses: ${msIouSearch.toFixed(1)}ms | TOTAL: ${total.toFixed(1)}ms`
    );
  }

  const pct = Math.min(100, Math.round(bestCombined * 100));
  const iouPct = Math.min(100, Math.round(bestIou * 100));
  const chamferPct = Math.min(100, Math.round(bestChamferSim * 100));
  const out = {
    silhouette: pct,
    silhouetteIou: iouPct,
    silhouetteChamfer: chamferPct,
    /** Symmetric mean Chamfer distance at best pose; comparison grid pixels (L₂ DT on edges). */
    silhouetteChamferMeanPx: Number.isFinite(bestChamferMeanPx) ? bestChamferMeanPx : undefined,
    /** Population σ of edge distances (both directions averaged); grid pixels. */
    silhouetteChamferStdPx: Number.isFinite(bestChamferStdPx) ? bestChamferStdPx : undefined,
    bestRotation: bestRot * 90,
    bestFlipped,
    direct: 0,
    edge: 0,
    chamferOptsResolved
  };

  if (opts.includeSilhouetteVisual) {
    const comp = silhouetteIouComponents(maskCutout, bestMaskFloor);
    const overlay = composeIouOverlapRgba(maskCutout, bestMaskFloor, cw, ch);
    const cutPrev = maskToPreviewRgba(maskCutout, cw, ch);
    const floorPrev = maskToPreviewRgba(bestMaskFloor, cw, ch);
    const blendNote =
      chamferBlend > 0
        ? `Score ${pct}% ≈ ${((1 - chamferBlend) * 100).toFixed(0)}%·IoU + ${(chamferBlend * 100).toFixed(0)}%·Chamfer (${iouPct}% / ${chamferPct}%). `
        : `Score ${pct}% = IoU only (${iouPct}%). `;
    out.silhouetteVisual = {
      gridPx: { w: cw, h: ch },
      intersection: comp.intersection,
      union: comp.union,
      cutoutPixels: comp.cutoutPixels,
      floorPixels: comp.floorPixels,
      iou: comp.iou,
      cutoutMaskUrl: imageDataToDataUrl(cutPrev),
      floorMaskUrl: imageDataToDataUrl(floorPrev),
      overlapUrl: imageDataToDataUrl(overlay),
      formula: `${blendNote}Fill IoU = intersection ÷ union = ${comp.intersection.toLocaleString()} ÷ ${comp.union.toLocaleString()}`
    };
  }

  return out;
}

/**
 * Main comparison: find best rotation and return three scores.
 * @param {Object} [opts] - options
 * @param {boolean} [opts.includeIntermediates] - if true, return { label, dataUrl }[] in result.intermediates
 * @param {boolean} [opts.shapeBenchTiming] - if true, suppress [Floorplan] preprocess logs; only log legacy match phase as [Shape bench]
 * @param {boolean} [opts.skipAspectRatioCheck] - skip AR gate (rare)
 * @param {number|false} [opts.maxAspectSpan] - max AR span; false disables
 */
export async function compareFloorplanToCutout(pathCutoutData, floorplanDataUrl, opts = {}) {
  const shapeBenchTiming = !!opts.shapeBenchTiming;
  const log = (step, ms) => {
    if (shapeBenchTiming) {
      if (step === '6. rotationLoop (4 rotations)') {
        console.log(`[Shape bench]   legacy match (4× rotation, sil/dir/edge): ${ms.toFixed(1)}ms`);
      }
      return;
    }
    console.log(`[Floorplan] ${step}: ${ms.toFixed(1)}ms`);
  };
  let t;

  t = performance.now();
  const floorplanData = await loadFloorplanImageData(floorplanDataUrl);
  log('1. loadFloorplanImageData', performance.now() - t);

  t = performance.now();
  let floorplanNoBg = removeFloorplanBackground(floorplanData);
  log('2a. removeFloorplanBackground (full res)', performance.now() - t);

  t = performance.now();
  const fw = floorplanNoBg.width, fh = floorplanNoBg.height;
  const useDownscaledMorph = fw > MORPH_PREPROCESS_DIM || fh > MORPH_PREPROCESS_DIM;
  let floorplanCleaned;
  if (useDownscaledMorph) {
    const bgMask = new Uint8Array(fw * fh);
    for (let i = 0; i < fw * fh; i++) bgMask[i] = floorplanNoBg.data[i * 4 + 3] > 32 ? 255 : 0;
    const scale = MORPH_PREPROCESS_DIM / Math.max(fw, fh);
    const sw = Math.max(1, Math.round(fw * scale));
    const sh = Math.max(1, Math.round(fh * scale));
    const smallMask = downscaleMask(bgMask, fw, fh, sw, sh);
    const opened = morphologicalOpening(smallMask, sw, sh, 9);
    const fullMask = upsampleMask(opened, sw, sh, fw, fh);
    floorplanCleaned = applyRemovalMaskToImageData(floorplanNoBg, fullMask);
  } else {
    floorplanCleaned = removeLoosePixelsFromFloorplan(floorplanNoBg);
  }
  log('2b. removeLoosePixels', performance.now() - t);

  t = performance.now();
  floorplanCleaned = cropToContentBounds(floorplanCleaned);
  log('3. cropToContentBounds', performance.now() - t);

  assertFloorplanCutoutAspectAllowed(pathCutoutData, floorplanCleaned, opts);

  t = performance.now();
  const cutoutComp = compositeOnNeutralBg(pathCutoutData);
  const floorplanComp = compositeOnNeutralBg(floorplanCleaned);
  log('4. compositeOnNeutralBg', performance.now() - t);

  t = performance.now();
  let cw = pathCutoutData.width, ch = pathCutoutData.height;
  if (cw > MAX_COMPARE_DIM || ch > MAX_COMPARE_DIM) {
    const s = Math.min(MAX_COMPARE_DIM / cw, MAX_COMPARE_DIM / ch);
    cw = Math.round(cw * s);
    ch = Math.round(ch * s);
  }
  const cutoutWork = cw === pathCutoutData.width && ch === pathCutoutData.height
    ? cutoutComp
    : resizeImageData(cutoutComp, cw, ch);
  const cutoutLongest = Math.max(cw, ch);
  const fpOrigW = floorplanComp.width, fpOrigH = floorplanComp.height;
  const fpOrigLongest = Math.max(fpOrigW, fpOrigH);
  const scale = cutoutLongest / fpOrigLongest;
  const fpW = Math.max(1, Math.round(fpOrigW * scale));
  const fpH = Math.max(1, Math.round(fpOrigH * scale));
  const floorplanScaled = resizeImageData(floorplanComp, fpW, fpH);
  const floorplanCleanedScaled = resizeImageData(floorplanCleaned, fpW, fpH);
  log('5. resizeCutout + floorplan to match longest edge', performance.now() - t);

  t = performance.now();
  const maskCutout = cutoutSilhouetteFromAlpha(pathCutoutData, cw, ch);
  const grayCutout = toGrayscale(cutoutWork);
  const edgesCutout = sobelEdges(grayCutout, cw, ch);
  log('5a. cutout: mask + gray + edges', performance.now() - t);

  t = performance.now();
  const maskFloorRaw = new Uint8Array(fpW * fpH);
  for (let i = 0; i < fpW * fpH; i++) {
    maskFloorRaw[i] = floorplanCleanedScaled.data[i * 4 + 3] > 32 ? 255 : 0;
  }
  const maskFloorFull = morphologicalOpening(maskFloorRaw, fpW, fpH, 7);
  const grayFloorFull = toGrayscale(floorplanScaled);
  const edgesFloorFull = sobelEdges(grayFloorFull, fpW, fpH);
  log('5b. floorplan: mask + gray + edges (after resize to longest edge)', performance.now() - t);

  t = performance.now();
  let best = { silhouette: 0, direct: 0, edge: 0, rotation: 0, rot: 0 };
  for (let rot = 0; rot < 4; rot++) {
    const maskRot = rotateUint8Array90(maskFloorFull, fpW, fpH, rot);
    const grayRot = rotateUint8Array90(grayFloorFull, fpW, fpH, rot);
    const edgesRot = rotateUint8Array90(edgesFloorFull, fpW, fpH, rot);

    const maskFloor = fitMaskStretchFill(maskRot.data, maskRot.width, maskRot.height, cw, ch);
    const grayFloor = fitGrayStretchFill(grayRot.data, grayRot.width, grayRot.height, cw, ch);
    const edgesFloor = fitEdgeStretchFill(edgesRot.data, edgesRot.width, edgesRot.height, cw, ch);

    const silScore = silhouetteScore(maskCutout, maskFloor);
    const dirScore = directImageScore(grayCutout, grayFloor, cw, ch);
    const edgeScoreVal = (edgeScore(edgesCutout, edgesFloor, cw, ch) +
      edgeScore(edgesFloor, edgesCutout, cw, ch)) / 2;
    const combined = silScore * 0.4 + dirScore * 0.3 + edgeScoreVal * 0.3;
    const bestCombined = best.silhouette * 0.4 + best.direct * 0.3 + best.edge * 0.3;
    if (combined > bestCombined) {
      best = { silhouette: silScore, direct: dirScore, edge: edgeScoreVal, rotation: rot * 90, rot };
    }
  }
  log('6. rotationLoop (4 rotations)', performance.now() - t);

  const result = {
    silhouette: Math.round(best.silhouette * 100),
    direct: Math.round(best.direct * 100),
    edge: Math.round(best.edge * 100),
    bestRotation: best.rotation
  };

  if (opts.includeIntermediates) {
    t = performance.now();
    const fp = rotateImageData90(floorplanScaled, best.rot);
    const maskRotBest = rotateUint8Array90(maskFloorFull, fpW, fpH, best.rot);
    const grayRotBest = rotateUint8Array90(grayFloorFull, fpW, fpH, best.rot);
    const edgesRotBest = rotateUint8Array90(edgesFloorFull, fpW, fpH, best.rot);
    const maskFloor = fitMaskStretchFill(maskRotBest.data, maskRotBest.width, maskRotBest.height, cw, ch);
    const grayFloor = fitGrayStretchFill(grayRotBest.data, grayRotBest.width, grayRotBest.height, cw, ch);
    const edgesFloor = fitEdgeStretchFill(edgesRotBest.data, edgesRotBest.width, edgesRotBest.height, cw, ch);
    const maskCutoutImg = new ImageData(
      new Uint8ClampedArray(maskCutout.length * 4).map((_, i) => {
        const v = maskCutout[Math.floor(i / 4)];
        return i % 4 === 3 ? 255 : v;
      }),
      cw,
      ch
    );
    const maskFloorImg = new ImageData(
      new Uint8ClampedArray(maskFloor.length * 4).map((_, i) => {
        const v = maskFloor[Math.floor(i / 4)];
        return i % 4 === 3 ? 255 : v;
      }),
      cw,
      ch
    );
    const scaleNoBg = cutoutLongest / Math.max(floorplanNoBg.width, floorplanNoBg.height);
    const fpNoBgW = Math.max(1, Math.round(floorplanNoBg.width * scaleNoBg));
    const fpNoBgH = Math.max(1, Math.round(floorplanNoBg.height * scaleNoBg));
    const floorplanNoBgScaled = resizeImageData(floorplanNoBg, fpNoBgW, fpNoBgH);
    result.intermediates = [
      { label: '1. Path cutout (raw)', dataUrl: imageDataToDataUrl(pathCutoutData) },
      { label: '2. Path cutout (native)', dataUrl: imageDataToDataUrl(cutoutWork) },
      { label: '3. Floorplan (bg removed)', dataUrl: imageDataToDataUrl(floorplanNoBgScaled) },
      { label: '4. Floorplan (loose pixels removed)', dataUrl: imageDataToDataUrl(floorplanCleanedScaled) },
      { label: '5. Floorplan (scaled to longest edge)', dataUrl: imageDataToDataUrl(floorplanScaled) },
      { label: '6. Floorplan (best rotation)', dataUrl: imageDataToDataUrl(fp) },
      { label: '7. Cutout silhouette', dataUrl: imageDataToDataUrl(maskCutoutImg) },
      { label: '8. Floorplan silhouette', dataUrl: imageDataToDataUrl(maskFloorImg) },
      { label: '9. Cutout edges', dataUrl: grayToDataUrl(edgesCutout, cw, ch) },
      { label: '10. Floorplan edges', dataUrl: grayToDataUrl(edgesFloor, cw, ch) }
    ];
    log('7. buildIntermediates', performance.now() - t);
  }

  return result;
}

/**
 * High-level: extract cutout, compare, return scores.
 * Call this from the hover handler or a "Compare" button.
 * @param {Object} [opts] - passed to compareFloorplanToCutout (e.g. includeIntermediates: true)
 */
export async function runFloorplanComparison(svgElement, pathElement, floorplanDataUrl, opts = {}) {
  const totalStart = performance.now();
  const t = performance.now();
  const cutout = await extractPathCutout(svgElement, pathElement);
  console.log(`[Floorplan] 0. extractPathCutout: ${(performance.now() - t).toFixed(1)}ms`);
  const result = await compareFloorplanToCutout(cutout, floorplanDataUrl, opts);
  console.log(`[Floorplan] TOTAL: ${(performance.now() - totalStart).toFixed(1)}ms`);
  return result;
}
