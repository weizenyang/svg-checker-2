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

const COMPARE_SIZE = 128;      // Normalized size for comparison
const NEUTRAL_BG = 0x80;       // Gray background for compositing (0-255)
const MORPH_KERNEL = 2;        // Morphological opening kernel size (removes dimension lines)
const THRESHOLD_OTSU_APPROX = 128; // Simple threshold fallback (Otsu would be better)

/**
 * Extract path cutout from SVG: the region of the tower floorplate behind the path.
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

  const clipTransform = `translate(${-bbox.x}, ${-bbox.y})`;
  const imageOffsetX = imgX - bbox.x;
  const imageOffsetY = imgY - bbox.y;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${bbox.width} ${bbox.height}" width="${bbox.width}" height="${bbox.height}">
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
      canvas.width = Math.max(1, Math.round(bbox.width));
      canvas.height = Math.max(1, Math.round(bbox.height));
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
 * Resize ImageData to target dimensions using canvas.
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
 * Simple Sobel edge detection.
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
 */
export async function compareFloorplanToCutout(pathCutoutData, floorplanDataUrl) {
  const floorplanData = await loadFloorplanImageData(floorplanDataUrl);

  const cutoutComp = compositeOnNeutralBg(pathCutoutData);
  const floorplanComp = compositeOnNeutralBg(floorplanData);

  const cutoutResized = resizeImageData(cutoutComp, COMPARE_SIZE, COMPARE_SIZE);
  let best = { silhouette: 0, direct: 0, edge: 0, rotation: 0 };

  for (let rot = 0; rot < 4; rot++) {
    let fp = resizeImageData(floorplanComp, COMPARE_SIZE, COMPARE_SIZE);
    fp = rotateImageData90(fp, rot);

    const grayCutout = toGrayscale(cutoutResized);
    const grayFloor = toGrayscale(fp);

    let maskCutout = thresholdOtsu(grayCutout, COMPARE_SIZE, COMPARE_SIZE);
    maskCutout = morphologicalOpening(maskCutout, COMPARE_SIZE, COMPARE_SIZE);
    maskCutout = normalizeMaskForFloorplan(maskCutout);

    let maskFloor = thresholdOtsu(grayFloor, COMPARE_SIZE, COMPARE_SIZE);
    maskFloor = morphologicalOpening(maskFloor, COMPARE_SIZE, COMPARE_SIZE);
    maskFloor = normalizeMaskForFloorplan(maskFloor);

    const silScore = silhouetteScore(maskCutout, maskFloor);
    const dirScore = directImageScore(grayCutout, grayFloor, COMPARE_SIZE, COMPARE_SIZE);
    const edgesCutout = sobelEdges(grayCutout, COMPARE_SIZE, COMPARE_SIZE);
    const edgesFloor = sobelEdges(grayFloor, COMPARE_SIZE, COMPARE_SIZE);
    const edgeScoreVal = (edgeScore(edgesCutout, edgesFloor, COMPARE_SIZE, COMPARE_SIZE) +
      edgeScore(edgesFloor, edgesCutout, COMPARE_SIZE, COMPARE_SIZE)) / 2;

    const combined = silScore * 0.5 + dirScore * 0.3 + edgeScoreVal * 0.2;
    const bestCombined = best.silhouette * 0.5 + best.direct * 0.3 + best.edge * 0.2;
    if (combined > bestCombined) {
      best = { silhouette: silScore, direct: dirScore, edge: edgeScoreVal, rotation: rot * 90 };
    }
  }

  return {
    silhouette: Math.round(best.silhouette * 100),
    direct: Math.round(best.direct * 100),
    edge: Math.round(best.edge * 100),
    bestRotation: best.rotation
  };
}

/**
 * High-level: extract cutout, compare, return scores.
 * Call this from the hover handler or a "Compare" button.
 */
export async function runFloorplanComparison(svgElement, pathElement, floorplanDataUrl) {
  const cutout = await extractPathCutout(svgElement, pathElement);
  return compareFloorplanToCutout(cutout, floorplanDataUrl);
}
