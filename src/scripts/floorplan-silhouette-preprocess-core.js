/**
 * DOM-free silhouette JS preprocess (flood-fill bg, morph, crop). Shared by main thread and web workers.
 */

export const MORPH_PREPROCESS_DIM = 1536;
export const MORPH_KERNEL = 10;

function colorsMatch(r1, g1, b1, r2, g2, b2, q = 8, tol = 1) {
  const b1r = (r1 / q) | 0,
    b1g = (g1 / q) | 0,
    b1b = (b1 / q) | 0;
  const b2r = (r2 / q) | 0,
    b2g = (g2 / q) | 0,
    b2b = (b2 / q) | 0;
  return Math.abs(b1r - b2r) <= tol && Math.abs(b1g - b2g) <= tol && Math.abs(b1b - b2b) <= tol;
}

/**
 * Remove floorplan background using flood-fill from edges.
 */
export function removeFloorplanBackground(data) {
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
    const r = d[idx],
      g = d[idx + 1],
      b = d[idx + 2];
    isBackground[y * w + x] = 255;
    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1]
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h || visited[ny * w + nx]) continue;
      const nidx = (ny * w + nx) * 4;
      const nr = d[nidx],
        ng = d[nidx + 1],
        nb = d[nidx + 2];
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

export function downscaleMask(mask, w, h, targetW, targetH) {
  const out = new Uint8Array(targetW * targetH);
  const blockW = w / targetW;
  const blockH = h / targetH;
  for (let ty = 0; ty < targetH; ty++) {
    for (let tx = 0; tx < targetW; tx++) {
      let sum = 0,
        count = 0;
      const y0 = (ty * blockH) | 0,
        y1 = Math.min(h, ((ty + 1) * blockH) | 0);
      const x0 = (tx * blockW) | 0,
        x1 = Math.min(w, ((tx + 1) * blockW) | 0);
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

export function upsampleMask(mask, sw, sh, targetW, targetH) {
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

export function morphologicalOpening(mask, w, h, kernelSize = MORPH_KERNEL) {
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

export function applyRemovalMaskToImageData(data, mask) {
  const out = new Uint8ClampedArray(data.data.length);
  for (let i = 0; i < data.data.length; i += 4) {
    out[i] = data.data[i];
    out[i + 1] = data.data[i + 1];
    out[i + 2] = data.data[i + 2];
    out[i + 3] = mask[i >> 2] > 0 ? 255 : 0;
  }
  return new ImageData(out, data.width, data.height);
}

export function removeLoosePixelsFromFloorplan(data) {
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

export function cropToContentBounds(data, alphaThreshold = 32) {
  const w = data.width;
  const h = data.height;
  const d = data.data;
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
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
 * @param {ImageData} floorplanData
 * @param {boolean} [logTimings]
 * @returns {ImageData}
 */
export function preprocessSilhouetteJsPipelineFromImageData(floorplanData, logTimings = false) {
  const log = (step, ms) => {
    if (logTimings) console.log(`[Silhouette preprocess]   ${step}: ${ms.toFixed(1)}ms`);
  };
  let t = performance.now();
  let floorplanNoBg = removeFloorplanBackground(floorplanData);
  log('removeFloorplanBackground', performance.now() - t);
  const fw0 = floorplanNoBg.width;
  const fh0 = floorplanNoBg.height;
  const useDownscaledMorph = fw0 > MORPH_PREPROCESS_DIM || fh0 > MORPH_PREPROCESS_DIM;
  let floorplanCleaned;
  if (useDownscaledMorph) {
    t = performance.now();
    const bgMask = new Uint8Array(fw0 * fh0);
    for (let i = 0; i < fw0 * fh0; i++) bgMask[i] = floorplanNoBg.data[i * 4 + 3] > 32 ? 255 : 0;
    const scale = MORPH_PREPROCESS_DIM / Math.max(fw0, fh0);
    const sw = Math.max(1, Math.round(fw0 * scale));
    const sh = Math.max(1, Math.round(fh0 * scale));
    const smallMask = downscaleMask(bgMask, fw0, fh0, sw, sh);
    const opened = morphologicalOpening(smallMask, sw, sh, 9);
    const fullMask = upsampleMask(opened, sw, sh, fw0, fh0);
    floorplanCleaned = applyRemovalMaskToImageData(floorplanNoBg, fullMask);
    log(`morph (downscaled mask ${sw}×${sh}, kernel 9 → full res)`, performance.now() - t);
  } else {
    t = performance.now();
    floorplanCleaned = removeLoosePixelsFromFloorplan(floorplanNoBg);
    log('removeLoosePixelsFromFloorplan', performance.now() - t);
  }
  t = performance.now();
  floorplanCleaned = cropToContentBounds(floorplanCleaned);
  log('cropToContentBounds', performance.now() - t);
  return floorplanCleaned;
}
