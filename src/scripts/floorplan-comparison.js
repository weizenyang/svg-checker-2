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

const NEUTRAL_BG = 0x80;       // Gray background for compositing (0-255)
const MAX_COMPARE_DIM = 512;   // Max dimension to avoid perf issues; no downscale to small fixed size
const MORPH_PREPROCESS_DIM = 1536;  // Higher res for loose-pixel mask (preserves detail, avoids aggressive removal)
const MORPH_KERNEL = 10;        // Morphological opening kernel size (removes dimension lines)
const THRESHOLD_OTSU_APPROX = 128; // Simple threshold fallback (Otsu would be better)

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

function imageDataToDataUrl(data, mime = 'image/png') {
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
 * Downscale a binary mask to smaller dimensions. Uses block sampling (majority wins per block).
 */
function downscaleMask(mask, w, h, targetW, targetH) {
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
          sum += mask[y * w + x] > 127 ? 1 : 0;
          count++;
        }
      }
      out[ty * targetW + tx] = count > 0 && sum > count / 2 ? 255 : 0;
    }
  }
  return out;
}

/**
 * Upsample a mask (Uint8Array) from small size to target size. Nearest-neighbor.
 */
function upsampleMask(mask, sw, sh, targetW, targetH) {
  const out = new Uint8Array(targetW * targetH);
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(sw - 1, (x * sw / targetW) | 0);
      const sy = Math.min(sh - 1, (y * sh / targetH) | 0);
      out[y * targetW + x] = mask[sy * sw + sx];
    }
  }
  return out;
}

/**
 * Apply removal mask to full-res image. Where mask is 0, set alpha=0.
 */
function applyRemovalMaskToImageData(data, mask) {
  const out = new Uint8ClampedArray(data.data.length);
  for (let i = 0; i < data.data.length; i += 4) {
    out[i] = data.data[i];
    out[i + 1] = data.data[i + 1];
    out[i + 2] = data.data[i + 2];
    out[i + 3] = mask[i >> 2] > 0 ? 255 : 0;
  }
  return new ImageData(out, data.width, data.height);
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
 * Check if two RGB pixels match within bucket tolerance.
 */
function colorsMatch(r1, g1, b1, r2, g2, b2, q = 8, tol = 1) {
  const b1r = (r1 / q) | 0, b1g = (g1 / q) | 0, b1b = (b1 / q) | 0;
  const b2r = (r2 / q) | 0, b2g = (g2 / q) | 0, b2b = (b2 / q) | 0;
  return Math.abs(b1r - b2r) <= tol && Math.abs(b1g - b2g) <= tol && Math.abs(b1b - b2b) <= tol;
}

/**
 * Remove floorplan background using flood-fill from edges.
 * Only removes pixels connected to the image perimeter - colors contained within
 * or surrounded by other colors (e.g. room fills) are preserved.
 */
function removeFloorplanBackground(data) {
  const d = data.data;
  const w = data.width;
  const h = data.height;
  const isBackground = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);
  const q = 8;
  const tol = 1;
  const stack = [];

  const push = (x, y) => {
    if (x >= 0 && x < w && y >= 0 && y < h && !visited[y * w + x]) {
      visited[y * w + x] = 1;
      stack.push(x, y);
    }
  };

  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }

  while (stack.length > 0) {
    const y = stack.pop();
    const x = stack.pop();
    const idx = (y * w + x) * 4;
    const r = d[idx], g = d[idx + 1], b = d[idx + 2];
    isBackground[y * w + x] = 255;
    const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h || visited[ny * w + nx]) continue;
      const nidx = (ny * w + nx) * 4;
      const nr = d[nidx], ng = d[nidx + 1], nb = d[nidx + 2];
      if (colorsMatch(r, g, b, nr, ng, nb, q, tol)) {
        visited[ny * w + nx] = 1;
        stack.push(nx, ny);
      }
    }
  }

  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = d[i * 4];
    out[i * 4 + 1] = d[i * 4 + 1];
    out[i * 4 + 2] = d[i * 4 + 2];
    out[i * 4 + 3] = isBackground[i] ? 0 : 255;
  }
  return new ImageData(out, w, h);
}

/**
 * Remove loose/isolated pixels after background removal using morphological opening on alpha.
 */
function removeLoosePixelsFromFloorplan(data) {
  const w = data.width;
  const h = data.height;
  const d = data.data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    mask[i] = d[i * 4 + 3] > 32 ? 255 : 0;
  }
  const opened = morphologicalOpening(mask, w, h, 7);
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = d[i * 4];
    out[i * 4 + 1] = d[i * 4 + 1];
    out[i * 4 + 2] = d[i * 4 + 2];
    out[i * 4 + 3] = opened[i];
  }
  return new ImageData(out, w, h);
}

/**
 * Crop ImageData to the bounding box of non-transparent pixels (alpha > threshold).
 */
function cropToContentBounds(data, alphaThreshold = 32) {
  const w = data.width;
  const h = data.height;
  const d = data.data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = d[(y * w + x) * 4 + 3];
      if (a > alphaThreshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX > maxX || minY > maxY) return data;
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const out = new Uint8ClampedArray(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const srcIdx = ((minY + y) * w + (minX + x)) * 4;
      const dstIdx = (y * cropW + x) * 4;
      out[dstIdx] = d[srcIdx];
      out[dstIdx + 1] = d[srcIdx + 1];
      out[dstIdx + 2] = d[srcIdx + 2];
      out[dstIdx + 3] = d[srcIdx + 3];
    }
  }
  return new ImageData(out, cropW, cropH);
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
 * Morphological opening: erode then dilate with small kernel.
 * Removes thin structures (dimension lines, text) while keeping main shape.
 */
function morphologicalOpening(mask, w, h, kernelSize = MORPH_KERNEL) {
  const k = kernelSize;
  const half = (k / 2) | 0;
  const eroded = new Uint8Array(mask.length);
  const dilated = new Uint8Array(mask.length);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let minVal = 255;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const v = mask[ny * w + nx];
            if (v < minVal) minVal = v;
          }
        }
      }
      eroded[y * w + x] = minVal;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let maxVal = 0;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const v = eroded[ny * w + nx];
            if (v > maxVal) maxVal = v;
          }
        }
      }
      dilated[y * w + x] = maxVal;
    }
  }
  return dilated;
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
 * Returns { data, width, height }.
 */
function rotateUint8Array90(arr, w, h, deg) {
  if (deg === 0) return { data: arr, width: w, height: h };
  let outW = w, outH = h;
  if (deg === 1 || deg === 3) {
    outW = h;
    outH = w;
  }
  const out = new Uint8Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let sx, sy;
      if (deg === 1) {
        sx = y;
        sy = w - 1 - x;
      } else if (deg === 2) {
        sx = w - 1 - x;
        sy = h - 1 - y;
      } else {
        sx = h - 1 - y;
        sy = x;
      }
      out[y * outW + x] = arr[sy * w + sx];
    }
  }
  return { data: out, width: outW, height: outH };
}

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
 * Rotate floorplan ImageData by 90*deg (0,1,2,3 = 0°, 90°, 180°, 270°).
 */
function rotateImageData90(data, deg) {
  if (deg === 0) return data;
  const { width: w, height: h } = data;
  const src = data.data;
  let outW = w, outH = h;
  if (deg === 1 || deg === 3) {
    outW = h;
    outH = w;
  }
  const out = new ImageData(outW, outH);
  const dst = out.data;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let sx, sy;
      if (deg === 1) {
        sx = y;
        sy = w - 1 - x;
      } else if (deg === 2) {
        sx = w - 1 - x;
        sy = h - 1 - y;
      } else if (deg === 3) {
        sx = h - 1 - y;
        sy = x;
      }
      const sidx = (sy * w + sx) * 4;
      const didx = (y * outW + x) * 4;
      dst[didx] = src[sidx];
      dst[didx + 1] = src[sidx + 1];
      dst[didx + 2] = src[sidx + 2];
      dst[didx + 3] = src[sidx + 3];
    }
  }
  return out;
}

/**
 * Main comparison: find best rotation and return three scores.
 * @param {Object} [opts] - options
 * @param {boolean} [opts.includeIntermediates] - if true, return { label, dataUrl }[] in result.intermediates
 */
export async function compareFloorplanToCutout(pathCutoutData, floorplanDataUrl, opts = {}) {
  const log = (step, ms) => console.log(`[Floorplan] ${step}: ${ms.toFixed(1)}ms`);
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

    const maskFloor = maskRot.width === cw && maskRot.height === ch
      ? maskRot.data
      : downscaleMask(maskRot.data, maskRot.width, maskRot.height, cw, ch);
    const grayFloor = grayRot.width === cw && grayRot.height === ch
      ? grayRot.data
      : resizeGray(grayRot.data, grayRot.width, grayRot.height, cw, ch);
    const edgesFloor = edgesRot.width === cw && edgesRot.height === ch
      ? edgesRot.data
      : downscaleEdgeMap(edgesRot.data, edgesRot.width, edgesRot.height, cw, ch);

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
    const maskFloor = downscaleMask(maskRotBest.data, maskRotBest.width, maskRotBest.height, cw, ch);
    const grayFloor = resizeGray(grayRotBest.data, grayRotBest.width, grayRotBest.height, cw, ch);
    const edgesFloor = downscaleEdgeMap(edgesRotBest.data, edgesRotBest.width, edgesRotBest.height, cw, ch);
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
      { label: '10. Floorplan edges', dataUrl: grayToDataUrl(edgesRotBest.data, edgesRotBest.width, edgesRotBest.height) }
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
