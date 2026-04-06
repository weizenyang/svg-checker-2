/**
 * Floorplan Comparison using OpenCV.js - ORB + Contour Analysis
 *
 * Alternative comparison pipeline:
 * - ORB: Rotation/scale-invariant feature matching for flips/rotations
 * - Contour: Shape matching (Hu moments) for balcony/unit outline similarity
 *
 * Requires OpenCV.js to be loaded (e.g. script src before use).
 */

import {
  extractPathCutout,
  loadFloorplanImageData,
  compareFloorplanToCutout,
  compareSilhouetteOnlyToCutout,
  resolveSilhouetteChamferOpts,
  floorplanCutoutMinAspectSpanAllowingFloor90,
  FLOORPLAN_CUTOUT_DEFAULT_MAX_ASPECT_SPAN
} from './floorplan-comparison.js';
import { cheapFloorFingerprintHex } from './floorplan-bench-fingerprint.js';

/** Keys expected by compareSilhouetteOnlyToCutout from resolveSilhouetteChamferOpts output. */
function silhouetteChamferOptsForCompare(cols) {
  return {
    silhouetteChamferBlend: cols.chamferBlend,
    silhouetteChamferDiagFrac: cols.chamferDiagFrac,
    silhouetteChamferExponent: cols.chamferExponent,
    silhouetteChamferVarWeight: cols.chamferVarWeight,
    silhouetteChamferDistAmplify: cols.chamferDistAmplify
  };
}

const MAX_COMPARE_DIM = 512;
const MIN_CONTOUR_AREA = 100;
const MORPH_PREPROCESS_DIM = 384;

// Cache resized OpenCV preprocess per (floorplan URL + cutout dimensions) — scale depends on cutout longest edge
const floorplanProcessedCache = new Map(); // key: cacheKey(url,cutout), value: ImageData

function floorplanProcessedCacheKey(floorplanDataUrl, cutout) {
  return `${floorplanDataUrl}\0${cutout.width}x${cutout.height}`;
}

/**
 * Cropped OpenCV preprocess before resize-to-cutout. Key = data URL + variant (blur vs silhouette no-blur).
 * Shape bench / Compare use Gaussian blur; Silhouette bench aspect gate uses skipGaussianBlur.
 */
const FLOORPLAN_CROPPED_PREPROCESS_CACHE_MAX = 200;
const floorplanCroppedPreprocessCache = new Map();

/** @param {boolean} skipGaussianBlur */
function floorplanCroppedPreprocessCacheKey(floorplanDataUrl, skipGaussianBlur) {
  return `${floorplanDataUrl}\0cvCrop:${skipGaussianBlur ? 'noGauss' : 'gauss'}`;
}

let cvReady = false;
let cvLoadPromise = null;

/**
 * Load OpenCV.js lazily. Call before using cv.
 * @returns {Promise<void>}
 */
export function loadOpenCV() {
  if (cvReady && typeof cv !== 'undefined') return Promise.resolve();
  if (cvLoadPromise) return cvLoadPromise;
  cvLoadPromise = new Promise((resolve, reject) => {
    if (typeof cv !== 'undefined' && cv.Mat) {
      cvReady = true;
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://docs.opencv.org/4.5.5/opencv.js';
    script.onload = () => {
      const checkCv = () => {
        if (typeof cv === 'undefined') {
          setTimeout(checkCv, 50);
          return;
        }
        if (cv.Mat) {
          cvReady = true;
          resolve();
          return;
        }
        cv['onRuntimeInitialized'] = () => {
          cvReady = true;
          resolve();
        };
      };
      setTimeout(checkCv, 0);
    };
    script.onerror = () => reject(new Error('Failed to load OpenCV.js'));
    document.head.appendChild(script);
  });
  return cvLoadPromise;
}

/**
 * Convert cv.Mat to data URL for carousel display.
 */
function matToDataUrl(mat) {
  const canvas = document.createElement('canvas');
  canvas.width = mat.cols;
  canvas.height = mat.rows;
  canvas.id = 'opencv-temp-' + Math.random().toString(36).slice(2);
  document.body.appendChild(canvas);
  cv.imshow(canvas.id, mat);
  const dataUrl = canvas.toDataURL('image/png');
  canvas.remove();
  return dataUrl;
}

/**
 * Detect ORB keypoints and draw them on image. Returns new Mat with keypoints drawn.
 */
function drawOrbKeypoints(srcMat) {
  const gray = new cv.Mat();
  cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
  const orb = cv.ORB_create ? cv.ORB_create(300) : new cv.ORB(300);
  const kp = new cv.KeyPointVector();
  const desc = new cv.Mat();
  orb.detectAndCompute(gray, new cv.Mat(), kp, desc);
  const count = kp.size();
  const out = new cv.Mat();
  try {
    const color = new cv.Scalar(0, 255, 0, 255);
    cv.drawKeypoints(srcMat, kp, out, color, cv.DRAW_MATCHES_FLAGS_DRAW_RICH_KEYPOINTS);
  } catch (e) {
    cv.drawKeypoints(srcMat, kp, out);
  }
  gray.delete();
  orb.delete();
  kp.delete();
  desc.delete();
  return { mat: out, keypointCount: count };
}

/**
 * Convert ImageData to cv.Mat (BGR). Caller must delete the mat.
 */
function imageDataToMat(imgData) {
  const canvas = document.createElement('canvas');
  canvas.width = imgData.width;
  canvas.height = imgData.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(imgData, 0, 0);
  const mat = cv.imread(canvas);
  return mat;
}

/**
 * Resize Mat to fit within maxDim. Returns new mat; caller deletes.
 */
function resizeMatFit(mat, maxDim) {
  const w = mat.cols;
  const h = mat.rows;
  if (w <= maxDim && h <= maxDim) {
    const out = new cv.Mat();
    mat.copyTo(out);
    return out;
  }
  const scale = maxDim / Math.max(w, h);
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const out = new cv.Mat();
  cv.resize(mat, out, new cv.Size(tw, th), 0, 0, cv.INTER_LINEAR);
  return out;
}

/**
 * Flip mat horizontally or vertically. flipCode: 0=vertical, 1=horizontal. Caller deletes returned mat.
 */
function flipMat(mat, flipCode) {
  const out = new cv.Mat();
  cv.flip(mat, out, flipCode);
  return out;
}

/**
 * Rotate mat by 90*deg degrees. deg in 0,1,2,3. Caller deletes returned mat.
 */
function rotateMat90(mat, deg) {
  if (deg === 0) {
    const out = new cv.Mat();
    mat.copyTo(out);
    return out;
  }
  const rotCode = deg === 1 ? cv.ROTATE_90_CLOCKWISE : deg === 2 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE;
  const out = new cv.Mat();
  cv.rotate(mat, out, rotCode);
  return out;
}

const MIN_INLIER_RATIO = 0.2;

/**
 * Preprocess gray image for ORB: CLAHE, sharpen, edge enhancement.
 * Improves keypoint detection on floorplans. Returns new Mat; caller must delete.
 * @param {cv.Mat} grayMat - Single-channel gray image (CV_8UC1)
 * @returns {cv.Mat} Preprocessed gray mat
 */
function preprocessGrayForOrb(grayMat) {
  let out = new cv.Mat();
  try {
    // 1. CLAHE - enhance local contrast (fallback to equalizeHist if CLAHE not available)
    const claheOut = new cv.Mat();
    if (typeof cv.createCLAHE === 'function') {
      const clahe = cv.createCLAHE(2.0, new cv.Size(8, 8));
      clahe.apply(grayMat, claheOut);
      clahe.delete();
    } else {
      cv.equalizeHist(grayMat, claheOut);
    }
    // 2. Unsharp mask - sharpen edges (out = 1.5 * clahe - 0.5 * blur)
    const blurred = new cv.Mat();
    cv.GaussianBlur(claheOut, blurred, new cv.Size(3, 3), 0);
    cv.addWeighted(claheOut, 1.5, blurred, -0.5, 0, out);
    blurred.delete();
    claheOut.delete();

    // 3. Edge enhancement blend - Sobel magnitude, blend 0.7 * sharp + 0.3 * edges
    const gradX = new cv.Mat();
    const gradY = new cv.Mat();
    const gradXAbs = new cv.Mat();
    const gradYAbs = new cv.Mat();
    const edges = new cv.Mat();
    cv.Sobel(out, gradX, cv.CV_16S, 1, 0, 3, 1, 0, cv.BORDER_DEFAULT);
    cv.Sobel(out, gradY, cv.CV_16S, 0, 1, 3, 1, 0, cv.BORDER_DEFAULT);
    cv.convertScaleAbs(gradX, gradXAbs);
    cv.convertScaleAbs(gradY, gradYAbs);
    cv.addWeighted(gradXAbs, 0.5, gradYAbs, 0.5, 0, edges);

    const result = new cv.Mat();
    cv.addWeighted(out, 0.7, edges, 0.3, 0, result);
    out.delete();
    out = result;

    gradX.delete();
    gradY.delete();
    gradXAbs.delete();
    gradYAbs.delete();
    edges.delete();
  } catch (e) {
    out.delete();
    const fallback = new cv.Mat();
    grayMat.copyTo(fallback);
    return fallback;
  }
  return out;
}

/**
 * ORB match with geometric verification. Returns { inliers, inlierRatio, score }.
 * - inlierRatio = inliers / goodMatches (geometric consistency)
 * - score = inlierRatio when >= MIN_INLIER_RATIO, else 0 (filters weak orientations)
 * Wrong orientations tend to have low inlier ratio.
 * @param {cv.Mat} mat1 - Cutout gray
 * @param {cv.Mat} mat2 - Floorplan gray
 * @param {{ rot?: number, flipped?: boolean, includeDrawData?: boolean }} [logCtx] - Optional context; includeDrawData=true returns inlier data for drawing
 */
function orbMatchWithInlierRatio(mat1, mat2, logCtx = {}) {
  let orb, matcher;
  const prep1 = preprocessGrayForOrb(mat1);
  const prep2 = preprocessGrayForOrb(mat2);
  try {
    // Slightly fewer keypoints for speed
    orb = cv.ORB_create ? cv.ORB_create(150) : new cv.ORB(150);
  } catch (e) {
    prep1.delete();
    prep2.delete();
    return { inliers: 0, inlierRatio: 0, parallelness: 1, horizontalness: 1, crossingPenalty: 0, score: 0 };
  }
  const kp1 = new cv.KeyPointVector();
  const kp2 = new cv.KeyPointVector();
  const desc1 = new cv.Mat();
  const desc2 = new cv.Mat();
  try {
    orb.detectAndCompute(prep1, new cv.Mat(), kp1, desc1);
    orb.detectAndCompute(prep2, new cv.Mat(), kp2, desc2);
  } catch (e) {
    prep1.delete();
    prep2.delete();
    kp1.delete();
    kp2.delete();
    desc1.delete();
    desc2.delete();
    orb.delete();
    return { inliers: 0, inlierRatio: 0, parallelness: 1, horizontalness: 1, crossingPenalty: 0, score: 0 };
  }

  if (kp1.size() === 0 || kp2.size() === 0) {
    prep1.delete();
    prep2.delete();
    kp1.delete();
    kp2.delete();
    desc1.delete();
    desc2.delete();
    orb.delete();
    return { inliers: 0, inlierRatio: 0, parallelness: 1, horizontalness: 1, crossingPenalty: 0, score: 0 };
  }

  const RATIO = 0.6;
  const MAX_DIST = 45;
  const goodMatches = [];
  const goodMatchDMatches = [];

  let matches;
  try {
    matcher = cv.BFMatcher_create ? cv.BFMatcher_create(cv.NORM_HAMMING, false) : new cv.BFMatcher(cv.NORM_HAMMING, false);
    matches = new cv.DMatchVectorVector();
    matcher.knnMatch(desc1, desc2, matches, 2);
    for (let i = 0; i < matches.size(); i++) {
      const m = matches.get(i);
      if (m.size() >= 2) {
        const d1 = m.get(0).distance;
        const d2 = m.get(1).distance;
        if (d1 < RATIO * d2 && d1 <= MAX_DIST) {
          goodMatches.push({ qi: m.get(0).queryIdx, ti: m.get(0).trainIdx, dist: d1 });
          goodMatchDMatches.push(m.get(0));
        }
      } else if (m.size() === 1) {
        const d = m.get(0).distance;
        if (d <= MAX_DIST) {
          goodMatches.push({ qi: m.get(0).queryIdx, ti: m.get(0).trainIdx, dist: d });
          goodMatchDMatches.push(m.get(0));
        }
      }
    }
  } catch (e) {
    if (typeof matches !== 'undefined' && matches) matches.delete();
    prep1.delete();
    prep2.delete();
    if (matcher) matcher.delete();
    kp1.delete();
    kp2.delete();
    desc1.delete();
    desc2.delete();
    orb.delete();
    return { inliers: 0, inlierRatio: 0, parallelness: 1, horizontalness: 1, crossingPenalty: 0, score: 0 };
  }
  if (matcher) matcher.delete();

  let inliers = 0;
  const includeDrawData = logCtx.includeDrawData ?? false;
  const inlierIndices = [];
  if (goodMatches.length >= 4 && typeof cv.findHomography === 'function') {
    try {
      const pts1 = [];
      const pts2 = [];
      for (const gm of goodMatches) {
        const pt1 = kp1.get(gm.qi).pt;
        const pt2 = kp2.get(gm.ti).pt;
        pts1.push(pt1.x, pt1.y);
        pts2.push(pt2.x, pt2.y);
      }
      const srcMat = cv.matFromArray(goodMatches.length, 2, cv.CV_32F, pts1);
      const dstMat = cv.matFromArray(goodMatches.length, 2, cv.CV_32F, pts2);
      const mask = new cv.Mat();
      cv.findHomography(srcMat, dstMat, cv.RANSAC, 5, mask);
      const len = mask.rows * mask.cols;
      for (let i = 0; i < len; i++) {
        if (mask.data[i] > 0) {
          inliers++;
          inlierIndices.push(i);
        }
      }
      srcMat.delete();
      dstMat.delete();
      mask.delete();
    } catch (_) {
      inliers = 0;
    }
  }

  const inlierRatio = goodMatches.length > 0 ? inliers / goodMatches.length : 0;

  let parallelness = 1;
  let horizontalness = 1; // 1 = lines horizontal in inlier image, 0 = vertical
  let crossingPenalty = 0;
  const W = mat1.cols; // cutout width - matches drawMatches side-by-side layout

  if (inlierIndices.length >= 2) {
    const segments = [];
    for (const i of inlierIndices) {
      const gm = goodMatches[i];
      const p1 = kp1.get(gm.qi).pt;
      const p2 = kp2.get(gm.ti).pt;
      const vx = W + p2.x - p1.x;
      const vy = p2.y - p1.y;
      segments.push({
        ax: p1.x,
        ay: p1.y,
        bx: W + p2.x,
        by: p2.y,
        vx,
        vy
      });
    }

    let sumCos = 0;
    let sumSin = 0;
    let sumAbsCos = 0;
    for (const s of segments) {
      const theta = Math.atan2(s.vy, s.vx);
      sumCos += Math.cos(theta);
      sumSin += Math.sin(theta);
      sumAbsCos += Math.abs(Math.cos(theta));
    }
    const n = segments.length;
    const R = Math.hypot(sumCos, sumSin) / n;
    parallelness = Math.max(0, R);
    horizontalness = sumAbsCos / n;

    // Crossing penalty: pairs that cross incur penalty; steeper crossing = heavier penalty
    // Segment a: p to p+r, segment b: q to q+s. Intersect when p + t*r = q + u*s.
    // t = (q-p)×s / (r×s), u = (q-p)×r / (r×s). Cross: ax*by - ay*bx.
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const a = segments[i];
        const b = segments[j];
        const r = { x: a.bx - a.ax, y: a.by - a.ay };
        const s = { x: b.bx - b.ax, y: b.by - b.ay };
        const qmp = { x: b.ax - a.ax, y: b.ay - a.ay };
        const cross = (u, v) => u.x * v.y - u.y * v.x;
        const denom = cross(r, s);
        if (Math.abs(denom) < 1e-9) continue; // parallel
        const t = cross(qmp, s) / denom;
        const u = cross(qmp, r) / denom;
        if (t > 0 && t < 1 && u > 0 && u < 1) {
          const mag1 = Math.hypot(r.x, r.y) || 1;
          const mag2 = Math.hypot(s.x, s.y) || 1;
          const cosAngle = (r.x * s.x + r.y * s.y) / (mag1 * mag2);
          const sinAngle = Math.sqrt(Math.max(0, 1 - cosAngle * cosAngle));
          crossingPenalty += 0.4 * sinAngle;
        }
      }
    }
  }

  // Parallelness and horizontalness; crossing lines incur heavy penalties
  const baseScore =
    inlierRatio >= MIN_INLIER_RATIO
      ? 0.5 * parallelness + 0.5 * horizontalness
      : 0;
  const score = Math.max(0, baseScore - crossingPenalty);

  prep1.delete();
  desc1.delete();
  desc2.delete();
  orb.delete();

  const drawData =
    includeDrawData && inlierIndices.length > 0
      ? { kp1, kp2, goodMatchDMatches, inlierIndices, matches }
      : null;
  if (!drawData) {
    matches.delete();
    prep2.delete();
    kp1.delete();
    kp2.delete();
  } else {
    prep2.delete();
  }

  const out = { inliers, inlierRatio, parallelness, horizontalness, crossingPenalty, score, drawData };
  console.log('[ORB]', { rotation: (logCtx.rot ?? -1) * 90, flipped: logCtx.flipped ?? false, ...out });
  return out;
}

/**
 * Draw inlier matches using precomputed data (same inliers as scoring). Caller deletes returned mat.
 * drawData is consumed and cleaned up by this function.
 */
function drawOrbInliersFromData(mat1, mat2, drawData) {
  if (!drawData || !drawData.kp1 || !drawData.kp2) return null;
  let bgr1, bgr2;
  if (mat1.channels() === 4) {
    bgr1 = new cv.Mat();
    cv.cvtColor(mat1, bgr1, cv.COLOR_RGBA2BGR);
  } else {
    bgr1 = new cv.Mat();
    mat1.copyTo(bgr1);
  }
  if (mat2.channels() === 4) {
    bgr2 = new cv.Mat();
    cv.cvtColor(mat2, bgr2, cv.COLOR_RGBA2BGR);
  } else {
    bgr2 = new cv.Mat();
    mat2.copyTo(bgr2);
  }
  const inlierMatches = new cv.DMatchVector();
  for (const i of drawData.inlierIndices) {
    inlierMatches.push_back(drawData.goodMatchDMatches[i]);
  }
  let out = null;
  try {
    out = new cv.Mat();
    cv.drawMatches(bgr1, drawData.kp1, bgr2, drawData.kp2, inlierMatches, out);
  } catch (e) {
    console.error('[drawOrbInliersFromData]', e);
    if (out) out.delete();
    out = null;
  }
  inlierMatches.delete();
  bgr1.delete();
  bgr2.delete();
  drawData.kp1.delete();
  drawData.kp2.delete();
  if (drawData.matches) drawData.matches.delete();
  return out;
}

/**
 * Draw inlier matches between two mats (cutout left, floorplan right). Returns new mat; caller deletes.
 * Runs ORB + homography - use drawOrbInliersFromData when you have precomputed inliers for consistency.
 */
function drawOrbInliers(mat1, mat2) {
  const gray1 = new cv.Mat();
  const gray2 = new cv.Mat();
  cv.cvtColor(mat1, gray1, cv.COLOR_RGBA2GRAY);
  cv.cvtColor(mat2, gray2, cv.COLOR_RGBA2GRAY);

  const prep1 = preprocessGrayForOrb(gray1);
  const prep2 = preprocessGrayForOrb(gray2);

  let orb;
  try {
    orb = cv.ORB_create ? cv.ORB_create(150) : new cv.ORB(150);
  } catch (e) {
    gray1.delete();
    gray2.delete();
    prep1.delete();
    prep2.delete();
    return null;
  }
  const kp1 = new cv.KeyPointVector();
  const kp2 = new cv.KeyPointVector();
  const desc1 = new cv.Mat();
  const desc2 = new cv.Mat();
  try {
    orb.detectAndCompute(prep1, new cv.Mat(), kp1, desc1);
    orb.detectAndCompute(prep2, new cv.Mat(), kp2, desc2);
  } catch (e) {
    gray1.delete();
    gray2.delete();
    prep1.delete();
    prep2.delete();
    kp1.delete();
    kp2.delete();
    desc1.delete();
    desc2.delete();
    orb.delete();
    return null;
  }

  const RATIO = 0.6;
  const MAX_DIST = 45;
  const goodMatchDMatches = [];
  const goodMatchesForPts = [];
  let matcher;
  let matches;
  try {
    matcher = cv.BFMatcher_create ? cv.BFMatcher_create(cv.NORM_HAMMING, false) : new cv.BFMatcher(cv.NORM_HAMMING, false);
    matches = new cv.DMatchVectorVector();
    matcher.knnMatch(desc1, desc2, matches, 2);
    for (let i = 0; i < matches.size(); i++) {
      const m = matches.get(i);
      if (m.size() >= 2) {
        const d1 = m.get(0).distance;
        const d2 = m.get(1).distance;
        if (d1 < RATIO * d2 && d1 <= MAX_DIST) {
          goodMatchDMatches.push(m.get(0));
          goodMatchesForPts.push({ qi: m.get(0).queryIdx, ti: m.get(0).trainIdx });
        }
      } else if (m.size() === 1) {
        const d = m.get(0).distance;
        if (d <= MAX_DIST) {
          goodMatchDMatches.push(m.get(0));
          goodMatchesForPts.push({ qi: m.get(0).queryIdx, ti: m.get(0).trainIdx });
        }
      }
    }
    if (matcher) matcher.delete();
  } catch (e) {
    prep1.delete();
    prep2.delete();
    if (matcher) matcher.delete();
    gray1.delete();
    gray2.delete();
    kp1.delete();
    kp2.delete();
    desc1.delete();
    desc2.delete();
    orb.delete();
    return null;
  }

  const inlierIndices = [];
  if (goodMatchesForPts.length >= 4 && typeof cv.findHomography === 'function') {
    try {
      const pts1 = [];
      const pts2 = [];
      for (const gm of goodMatchesForPts) {
        const pt1 = kp1.get(gm.qi).pt;
        const pt2 = kp2.get(gm.ti).pt;
        pts1.push(pt1.x, pt1.y);
        pts2.push(pt2.x, pt2.y);
      }
      const srcMat = cv.matFromArray(goodMatchesForPts.length, 2, cv.CV_32F, pts1);
      const dstMat = cv.matFromArray(goodMatchesForPts.length, 2, cv.CV_32F, pts2);
      const mask = new cv.Mat();
      cv.findHomography(srcMat, dstMat, cv.RANSAC, 5, mask);
      const len = mask.rows * mask.cols;
      for (let i = 0; i < len; i++) {
        if (mask.data[i] > 0) inlierIndices.push(i);
      }
      srcMat.delete();
      dstMat.delete();
      mask.delete();
    } catch (_) {}
  }

  const bgr1 = new cv.Mat();
  const bgr2 = new cv.Mat();
  cv.cvtColor(mat1, bgr1, cv.COLOR_RGBA2BGR);
  cv.cvtColor(mat2, bgr2, cv.COLOR_RGBA2BGR);

  const inlierMatches = new cv.DMatchVector();
  for (const i of inlierIndices) {
    inlierMatches.push_back(goodMatchDMatches[i]);
  }

  const out = new cv.Mat();
  try {
    cv.drawMatches(bgr1, kp1, bgr2, kp2, inlierMatches, out);
  } catch (e) {
    out.delete();
  }

  inlierMatches.delete();
  if (matches) matches.delete();
  prep1.delete();
  prep2.delete();
  bgr1.delete();
  bgr2.delete();
  gray1.delete();
  gray2.delete();
  kp1.delete();
  kp2.delete();
  desc1.delete();
  desc2.delete();
  orb.delete();

  return out;
}

/**
 * Contour-based shape similarity. Lower = more similar.
 * Uses cv.matchShapes (Hu moments). Returns 0-1 score where 1 = best match.
 * If captureLog is true, returns { score, items } with carousel-ready items.
 */
function contourMatchScore(mat1, mat2, captureLog = false) {
  const gray1 = new cv.Mat();
  const gray2 = new cv.Mat();
  cv.cvtColor(mat1, gray1, cv.COLOR_RGBA2GRAY);
  cv.cvtColor(mat2, gray2, cv.COLOR_RGBA2GRAY);

  const thresh1 = new cv.Mat();
  const thresh2 = new cv.Mat();
  cv.threshold(gray1, thresh1, 127, 255, cv.THRESH_BINARY);
  cv.threshold(gray2, thresh2, 127, 255, cv.THRESH_BINARY);

  const contours1 = new cv.MatVector();
  const contours2 = new cv.MatVector();
  const hierarchy1 = new cv.Mat();
  const hierarchy2 = new cv.Mat();
  cv.findContours(thresh1, contours1, hierarchy1, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  cv.findContours(thresh2, contours2, hierarchy2, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let bestScore = 0;
  let bestPair = null;
  const minArea = MIN_CONTOUR_AREA;

  for (let i = 0; i < contours1.size(); i++) {
    const c1 = contours1.get(i);
    const a1 = cv.contourArea(c1);
    if (a1 < minArea) continue;

    for (let j = 0; j < contours2.size(); j++) {
      const c2 = contours2.get(j);
      const a2 = cv.contourArea(c2);
      if (a2 < minArea) continue;

      const areaRatio = Math.min(a1, a2) / Math.max(a1, a2);
      if (areaRatio < 0.3) continue;

      try {
        const d = cv.matchShapes(c1, c2, cv.CONTOURS_MATCH_I1, 0);
        const similarity = Math.max(0, 1 - Math.min(d, 1));
        const weighted = similarity * areaRatio;
        if (weighted > bestScore) {
          bestScore = weighted;
          bestPair = captureLog ? { i, j, a1, a2, similarity, areaRatio } : null;
        }
      } catch (_) {}
    }
  }

  const score = Math.round(bestScore * 100) / 100;

  if (!captureLog) {
    contours1.delete();
    contours2.delete();
    hierarchy1.delete();
    hierarchy2.delete();
    thresh1.delete();
    thresh2.delete();
    gray1.delete();
    gray2.delete();
    return score;
  }

  const items = [];

  const draw1 = new cv.Mat();
  mat1.copyTo(draw1);
  cv.cvtColor(draw1, draw1, cv.COLOR_RGBA2BGR);
  const green = new cv.Scalar(0, 255, 0);
  for (let i = 0; i < contours1.size(); i++) {
    const c = contours1.get(i);
    if (cv.contourArea(c) >= minArea) {
      cv.drawContours(draw1, contours1, i, green, 2);
    }
  }
  items.push({ label: `Cutout contours (${contours1.size()} found, ${score * 100}% best match)`, dataUrl: matToDataUrl(draw1) });
  draw1.delete();

  const draw2 = new cv.Mat();
  mat2.copyTo(draw2);
  cv.cvtColor(draw2, draw2, cv.COLOR_RGBA2BGR);
  const green2 = new cv.Scalar(0, 255, 0);
  for (let j = 0; j < contours2.size(); j++) {
    const c = contours2.get(j);
    if (cv.contourArea(c) >= minArea) {
      cv.drawContours(draw2, contours2, j, green2, 2);
    }
  }
  const bestInfo = bestPair ? ` best pair: areaRatio=${bestPair.areaRatio.toFixed(2)} similarity=${bestPair.similarity.toFixed(2)}` : '';
  items.push({ label: `Floorplan contours (${contours2.size()} found)${bestInfo}`, dataUrl: matToDataUrl(draw2) });
  draw2.delete();

  contours1.delete();
  contours2.delete();
  hierarchy1.delete();
  hierarchy2.delete();
  thresh1.delete();
  thresh2.delete();
  gray1.delete();
  gray2.delete();

  return { score, items };
}

/**
 * Check if two RGB pixels match exactly (single colour - no tolerance).
 * Less aggressive than the main pipeline's colorsMatch which uses bucket tolerance.
 */
function colorsMatchExact(r1, g1, b1, r2, g2, b2) {
  return r1 === r2 && g1 === g2 && b1 === b2;
}

/**
 * Remove floorplan background using flood-fill from edges.
 * Single colour only: only removes pixels that exactly match edge colours.
 * Less aggressive than the main pipeline - preserves more content.
 */
function removeFloorplanBackgroundStrict(data) {
  const d = data.data;
  const w = data.width;
  const h = data.height;
  const isBackground = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);
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
      if (colorsMatchExact(r, g, b, nr, ng, nb)) {
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

function morphologicalOpening(mask, w, h, kernelSize) {
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
 * Convert ImageData to data URL.
 */
function imageDataToDataUrl(imgData) {
  const canvas = document.createElement('canvas');
  canvas.width = imgData.width;
  canvas.height = imgData.height;
  canvas.getContext('2d').putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Very slight 3x3 Gaussian blur (sigma≈0.5) on ImageData. Reduces noise before cropping. */
function gaussianBlurSlight(imgData) {
  const w = imgData.width;
  const h = imgData.height;
  const d = imgData.data;
  const out = new Uint8ClampedArray(d.length);
  const k = [
    0.0751, 0.1238, 0.0751,
    0.1238, 0.2042, 0.1238,
    0.0751, 0.1238, 0.0751
  ];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = ((y + dy) * w + (x + dx)) * 4;
          const wg = k[(dy + 1) * 3 + (dx + 1)];
          r += d[i] * wg;
          g += d[i + 1] * wg;
          b += d[i + 2] * wg;
          a += d[i + 3] * wg;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r);
      out[o + 1] = Math.round(g);
      out[o + 2] = Math.round(b);
      out[o + 3] = Math.round(a);
    }
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 4;
      d[o] = out[o];
      d[o + 1] = out[o + 1];
      d[o + 2] = out[o + 2];
      d[o + 3] = out[o + 3];
    }
  }
  return imgData;
}

/**
 * Preprocess floorplan: strict single-colour flood fill bg removal, loose pixels, crop (no resize).
 * Uses the same pipeline as floorplan-comparison but with less aggressive bg removal.
 * @param {ImageData} imgData
 * @param {boolean} [captureIntermediates] - if true, returns { final, intermediates }
 * @param {boolean} [logTimings] - console [OpenCV preprocess] per-step ms (skipped when captureIntermediates)
 * @param {boolean} [skipGaussianBlur] - if true (silhouette OpenCV path), use raw copy instead of gaussianBlurSlight
 */
function preprocessFloorplanForOpencv(
  imgData,
  captureIntermediates = false,
  logTimings = false,
  skipGaussianBlur = false
) {
  const log = (step, ms) => {
    if (logTimings && !captureIntermediates) {
      console.log(`[OpenCV preprocess]   ${step}: ${ms.toFixed(1)}ms`);
    }
  };
  const intermediates = [];
  let t = performance.now();
  const srcCopy = new ImageData(new Uint8ClampedArray(imgData.data), imgData.width, imgData.height);
  let floorplanBlurred = skipGaussianBlur ? srcCopy : gaussianBlurSlight(srcCopy);
  log(
    skipGaussianBlur ? 'gaussianBlurSlight (skipped — silhouette)' : 'gaussianBlurSlight',
    performance.now() - t
  );
  t = performance.now();
  let floorplanNoBg = removeFloorplanBackgroundStrict(floorplanBlurred);
  log('removeFloorplanBackgroundStrict', performance.now() - t);
  if (captureIntermediates) intermediates.push({ label: 'Floorplan (bg removed, strict flood fill)', data: floorplanNoBg });

  t = performance.now();
  const fw = floorplanNoBg.width;
  const fh = floorplanNoBg.height;
  const bgMask = new Uint8Array(fw * fh);
  for (let i = 0; i < fw * fh; i++) bgMask[i] = floorplanNoBg.data[i * 4 + 3] > 32 ? 255 : 0;
  const scale = Math.min(1, MORPH_PREPROCESS_DIM / Math.max(fw, fh));
  const sw = Math.max(1, Math.round(fw * scale));
  const sh = Math.max(1, Math.round(fh * scale));
  const smallMask = downscaleMask(bgMask, fw, fh, sw, sh);
  const opened = morphologicalOpening(smallMask, sw, sh, 10);
  const fullMask = upsampleMask(opened, sw, sh, fw, fh);
  let floorplanCleaned = applyRemovalMaskToImageData(floorplanNoBg, fullMask);
  log(`morph (downscale mask ${sw}×${sh}, kernel 10 → full res)`, performance.now() - t);
  if (captureIntermediates) intermediates.push({ label: 'Floorplan (loose pixels removed)', data: floorplanCleaned });

  t = performance.now();
  floorplanCleaned = cropToContentBounds(floorplanCleaned);
  log('cropToContentBounds', performance.now() - t);
  if (captureIntermediates) intermediates.push({ label: 'Floorplan (cropped)', data: floorplanCleaned });

  if (captureIntermediates) return { final: floorplanCleaned, intermediates };
  return floorplanCleaned;
}

/**
 * Same as OpenCV floorplan path before resize-to-cutout: load, preprocessFloorplanForOpencv (strict bg, morph, crop).
 * LRU by data URL so Shape bench gate and getProcessedFloorplanImageDataForCutout share one preprocess per file.
 * @param {string} floorplanDataUrl
 * @param {Object} [options]
 * @param {boolean} [options.captureAndFlash] - bypass cache read; decode raw + run preprocess with intermediates; call onPreprocessStep for raw then each step
 * @param {(info: { label: string, imageData: ImageData, candidateName: string, stepIndex: number, stepTotal: number, floorplanDataUrl: string }) => void | Promise<void>} [options.onPreprocessStep]
 * @param {number} [options.stepDwellMs] - ms to pause after each step (default 550)
 * @param {string} [options.candidateName] - for UI
 * @param {boolean} [options.logTimings] - console [OpenCV preprocess] decode + sub-steps (no-op with captureAndFlash)
 * @param {boolean} [options.skipGaussianBlur] - silhouette bench: skip blur before strict bg removal (default false)
 * @returns {Promise<ImageData>}
 */
async function getFloorplanCroppedPreprocessedImageData(floorplanDataUrl, options = {}) {
  const {
    captureAndFlash = false,
    onPreprocessStep = null,
    stepDwellMs = 550,
    candidateName = '',
    logTimings = false,
    skipGaussianBlur = false
  } = options;
  const bypassCache = !!captureAndFlash;
  const wantLog = logTimings === true && !captureAndFlash;
  const nameTag = candidateName ? ` ${candidateName}` : '';
  const cropCacheKey = floorplanCroppedPreprocessCacheKey(floorplanDataUrl, skipGaussianBlur);

  if (!bypassCache) {
    const hit = floorplanCroppedPreprocessCache.get(cropCacheKey);
    if (hit) {
      floorplanCroppedPreprocessCache.delete(cropCacheKey);
      floorplanCroppedPreprocessCache.set(cropCacheKey, hit);
      if (wantLog) {
        console.log(`[OpenCV preprocess]${nameTag} cache HIT (cropped LRU) — skipped decode + pipeline`);
      }
      return hit;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (captureAndFlash && typeof onPreprocessStep === 'function') {
    const floorplanRaw = await loadFloorplanImageData(floorplanDataUrl);
    const { final, intermediates } = preprocessFloorplanForOpencv(
      floorplanRaw,
      true,
      false,
      skipGaussianBlur
    );
    const stepTotal = 1 + intermediates.length;
    let stepIndex = 0;
    const emit = async (label, imageData) => {
      await onPreprocessStep({
        label,
        imageData,
        candidateName,
        stepIndex,
        stepTotal,
        floorplanDataUrl
      });
      stepIndex += 1;
      await sleep(stepDwellMs);
    };
    await emit('1. Raw decoded (full resolution)', floorplanRaw);
    for (const step of intermediates) {
      await emit(step.label, step.data);
    }
    const cropped = final;
    if (floorplanCroppedPreprocessCache.has(cropCacheKey)) {
      floorplanCroppedPreprocessCache.delete(cropCacheKey);
    }
    floorplanCroppedPreprocessCache.set(cropCacheKey, cropped);
    while (floorplanCroppedPreprocessCache.size > FLOORPLAN_CROPPED_PREPROCESS_CACHE_MAX) {
      const oldest = floorplanCroppedPreprocessCache.keys().next().value;
      floorplanCroppedPreprocessCache.delete(oldest);
    }
    return cropped;
  }

  let t = performance.now();
  const floorplanRaw = await loadFloorplanImageData(floorplanDataUrl);
  if (wantLog) {
    console.log(
      `[OpenCV preprocess]${nameTag} loadFloorplanImageData (${floorplanRaw.width}×${floorplanRaw.height}): ${(performance.now() - t).toFixed(1)}ms`
    );
    console.log(`[OpenCV preprocess]${nameTag} pipeline steps (strict bg / morph / crop):`);
  }
  const pre = preprocessFloorplanForOpencv(floorplanRaw, false, wantLog, skipGaussianBlur);
  const cropped = pre && typeof pre === 'object' && 'final' in pre ? pre.final : pre;
  if (floorplanCroppedPreprocessCache.has(cropCacheKey)) {
    floorplanCroppedPreprocessCache.delete(cropCacheKey);
  }
  floorplanCroppedPreprocessCache.set(cropCacheKey, cropped);
  while (floorplanCroppedPreprocessCache.size > FLOORPLAN_CROPPED_PREPROCESS_CACHE_MAX) {
    const oldest = floorplanCroppedPreprocessCache.keys().next().value;
    floorplanCroppedPreprocessCache.delete(oldest);
  }
  return cropped;
}

/** Resize ImageData to target dimensions and apply WebP re-encode for lower bitdepth. Returns Promise<ImageData>. */
function resizeWithWebP(imgData, targetW, targetH, quality = 0.82) {
  const resized = resizeImageData(imgData, targetW, targetH);
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  canvas.getContext('2d').putImageData(resized, 0, 0);
  return new Promise((resolve, reject) => {
    const dataUrl = canvas.toDataURL('image/webp', quality);
    const img = new Image();
    img.onload = () => {
      const out = document.createElement('canvas');
      out.width = targetW;
      out.height = targetH;
      out.getContext('2d').drawImage(img, 0, 0);
      resolve(out.getContext('2d').getImageData(0, 0, targetW, targetH));
    };
    img.onerror = () => reject(new Error('WebP decode failed'));
    img.src = dataUrl;
  });
}

/**
 * Scale cropped preprocess to match cutout longest edge (same as getProcessedFloorplanImageDataForCutout).
 * @param {ImageData} floorplanCropped
 * @param {ImageData} cutout
 */
async function resizeFloorplanCroppedToCutoutLongestEdge(floorplanCropped, cutout) {
  const cw = cutout.width;
  const ch = cutout.height;
  const cutoutLongest = Math.max(cw, ch);
  const fw = floorplanCropped.width;
  const fh = floorplanCropped.height;
  const scale = cutoutLongest / Math.max(fw, fh);
  const targetW = Math.max(1, Math.round(fw * scale));
  const targetH = Math.max(1, Math.round(fh * scale));
  return resizeWithWebP(floorplanCropped, targetW, targetH);
}

/**
 * Cropped preprocess vs cutout: aspect ratio (w/h), not absolute size; min span over floor crop 0° and 90° (bbox w/h swap). Uses same cropped image as OpenCV pre-resize.
 * @param {string} dataUrl
 * @param {ImageData} cutout
 * @param {number} maxAspectSpan - reject if max(floorAR/cutAR, cutAR/floorAR) exceeds this (> 1)
 * @returns {Promise<null | { reason: string, fw: number, fh: number, cw: number, ch: number, floorAspect: number, cutoutAspect: number, aspectSpan: number, maxAspectRatio: number }>}
 */
async function shapeBenchFloorplanFailsAspectGate(dataUrl, cutout, maxAspectSpan, getCroppedOptions = {}) {
  const cw = cutout.width;
  const ch = cutout.height;
  if (cw < 1 || ch < 1) return null;
  const cutoutAspect = cw / ch;
  let cropped;
  try {
    cropped = await getFloorplanCroppedPreprocessedImageData(dataUrl, getCroppedOptions);
  } catch {
    return {
      reason: 'decode',
      fw: 0,
      fh: 0,
      cw,
      ch,
      floorAspect: 0,
      cutoutAspect,
      aspectSpan: Infinity,
      maxAspectRatio: maxAspectSpan
    };
  }
  const fw = cropped.width;
  const fh = cropped.height;
  if (fw < 1 || fh < 1) {
    return {
      reason: 'badSize',
      fw,
      fh,
      cw,
      ch,
      floorAspect: 0,
      cutoutAspect,
      aspectSpan: Infinity,
      maxAspectRatio: maxAspectSpan
    };
  }
  const floorAspect = fw / fh;
  const aspectSpan = floorplanCutoutMinAspectSpanAllowingFloor90(cw, ch, fw, fh);
  if (aspectSpan > maxAspectSpan) {
    return {
      reason: 'aspectRatio',
      fw,
      fh,
      cw,
      ch,
      floorAspect,
      cutoutAspect,
      aspectSpan,
      maxAspectRatio: maxAspectSpan
    };
  }
  return null;
}

/**
 * Main OpenCV comparison. Returns ORB score, contour score, best rotation.
 * @param {SVGElement} svgElement
 * @param {SVGPathElement} pathElement
 * @param {string} floorplanDataUrl
 * @param {Object} [opts]
 * @param {boolean} [opts.includeIntermediates]
 * @param {boolean} [opts.skipAspectRatioCheck] - skip cutout vs cropped-floorplan AR gate
 * @param {number|false} [opts.maxAspectSpan] - max AR span (default 2.5); false disables
 * @param {number|false} [opts.shapeBenchMaxAspectRatio] - alias for maxAspectSpan
 * @param {number|false} [opts.shapeBenchMaxDimensionRatio] - deprecated alias
 */
export async function runFloorplanComparisonOpencv(svgElement, pathElement, floorplanDataUrl, opts = {}) {
  await loadOpenCV();

  const cutout = await extractPathCutout(svgElement, pathElement);

  const aspectOpt = opts.shapeBenchMaxAspectRatio ?? opts.shapeBenchMaxDimensionRatio ?? opts.maxAspectSpan;
  let maxAspectSpan = FLOORPLAN_CUTOUT_DEFAULT_MAX_ASPECT_SPAN;
  if (opts.skipAspectRatioCheck === true) maxAspectSpan = null;
  else if (aspectOpt === false) maxAspectSpan = null;
  else if (typeof aspectOpt === 'number' && aspectOpt > 1) {
    maxAspectSpan = aspectOpt;
  }

  let floorplanProcessed;
  let floorplanRaw = null;
  let preprocessResult = null;

  if (opts.includeIntermediates) {
    // When intermediates are requested, always recompute so we have floorplanRaw and logs
    floorplanRaw = await loadFloorplanImageData(floorplanDataUrl);
    preprocessResult = preprocessFloorplanForOpencv(floorplanRaw, true);
    const floorplanCropped = preprocessResult?.final ?? preprocessResult;

    if (maxAspectSpan != null) {
      const span = floorplanCutoutMinAspectSpanAllowingFloor90(
        cutout.width,
        cutout.height,
        floorplanCropped.width,
        floorplanCropped.height
      );
      if (span > maxAspectSpan) {
        throw new Error(
          `Aspect ratio mismatch: cutout ${cutout.width}×${cutout.height} vs floorplan (cropped) ${floorplanCropped.width}×${floorplanCropped.height} — span ${span.toFixed(2)} > ${maxAspectSpan} (min over 0°/90° floor crop orientation). Use a floorplan with similar proportions, or pass maxAspectSpan:false to compare anyway.`
        );
      }
    }

    const cw = cutout.width;
    const ch = cutout.height;
    const cutoutLongest = Math.max(cw, ch);
    const fw = floorplanCropped.width;
    const fh = floorplanCropped.height;
    const scale = cutoutLongest / Math.max(fw, fh);
    const targetW = Math.max(1, Math.round(fw * scale));
    const targetH = Math.max(1, Math.round(fh * scale));
    floorplanProcessed = await resizeWithWebP(floorplanCropped, targetW, targetH);
  } else {
    const cacheKey = floorplanProcessedCacheKey(floorplanDataUrl, cutout);
    if (floorplanProcessedCache.has(cacheKey)) {
      floorplanProcessed = floorplanProcessedCache.get(cacheKey);
    } else {
      if (maxAspectSpan != null) {
        const gate = await shapeBenchFloorplanFailsAspectGate(floorplanDataUrl, cutout, maxAspectSpan, {});
        if (gate) {
          const arNote =
            gate.reason === 'aspectRatio'
              ? ` cropped ${gate.fw}×${gate.fh} vs cutout ${gate.cw}×${gate.ch} (span ${gate.aspectSpan.toFixed(2)} > ${gate.maxAspectRatio})`
              : ` (${gate.reason})`;
          throw new Error(`Floorplan skipped${arNote}. Pass maxAspectSpan:false to compare anyway.`);
        }
      }
      const floorplanCropped = await getFloorplanCroppedPreprocessedImageData(floorplanDataUrl);
      floorplanProcessed = await resizeFloorplanCroppedToCutoutLongestEdge(floorplanCropped, cutout);
      floorplanProcessedCache.set(cacheKey, floorplanProcessed);
    }
  }

  const cutoutMat = imageDataToMat(cutout);
  const cutoutGray = new cv.Mat();
  cv.cvtColor(cutoutMat, cutoutGray, cv.COLOR_RGBA2GRAY);

  const floorplanMat = imageDataToMat(floorplanProcessed);
  const floorplanForRot = new cv.Mat();
  floorplanMat.copyTo(floorplanForRot);

  const rotations = [0, 1, 2, 3];
  let bestScore = 0;
  let bestOrbRot = 0;
  let bestOrbFlipped = false;
  let bestOrbMat = null;
  /** @type {Array<{ rot: number, flipped: boolean, inliers: number, inlierRatio: number, parallelness: number, horizontalness: number, crossingPenalty: number, score: number }>} */
  const orientationLog = [];

  const tryOrientations = (sourceMat, flipped) => {
    for (const rot of rotations) {
      const fpRot = rotateMat90(sourceMat, rot);
      const fpGray = new cv.Mat();
      cv.cvtColor(fpRot, fpGray, cv.COLOR_RGBA2GRAY);

      const r = orbMatchWithInlierRatio(cutoutGray, fpGray, { rot, flipped, includeDrawData: !!opts.includeIntermediates });
      orientationLog.push({
        rot,
        flipped,
        inliers: r.inliers,
        inlierRatio: r.inlierRatio,
        parallelness: r.parallelness ?? 1,
        horizontalness: r.horizontalness ?? 1,
        crossingPenalty: r.crossingPenalty ?? 0,
        score: r.score,
        drawData: r.drawData ?? null
      });

      if (r.score > bestScore) {
        bestScore = r.score;
        bestOrbRot = rot;
        bestOrbFlipped = flipped;
        bestOrbMat?.delete();
        bestOrbMat = new cv.Mat();
        fpRot.copyTo(bestOrbMat);
      }

      fpGray.delete();
      fpRot.delete();
    }
  };

  tryOrientations(floorplanForRot, false);

  const floorplanFlipped = flipMat(floorplanForRot, 1);
  tryOrientations(floorplanFlipped, true);
  floorplanFlipped.delete();

  const orbScoreNorm = Math.min(100, Math.round(bestScore * 100));

  let contourScore = 0;
  let contourLog = null;
  if (bestOrbMat) {
    if (opts.includeIntermediates) {
      const res = contourMatchScore(cutoutMat, bestOrbMat, true);
      contourScore = res.score;
      contourLog = res.items;
    } else {
      contourScore = contourMatchScore(cutoutMat, bestOrbMat);
    }
  }

  const bestLog = orientationLog.find((o) => o.rot === bestOrbRot && o.flipped === bestOrbFlipped);
  const result = {
    orb: orbScoreNorm,
    contour: Math.round(contourScore * 100),
    bestRotation: bestOrbRot * 90,
    bestOrbFlipped,
    rawOrbInliers: bestLog?.inliers ?? 0,
    inlierRatio: bestLog?.inlierRatio ?? 0
  };

  const pathId = pathElement?.id ?? pathElement?.getAttribute?.('data-path-id') ?? 'unknown';
  console.log(`[ORB orientations] ${pathId}`, orientationLog);
  console.log(`[ORB best] ${pathId}`, { bestOrbRot, bestOrbFlipped, bestScore, bestLog });
  console.log(`[Floorplan comparison result] ${pathId}`, result);

  if (opts.includeIntermediates) {
    const items = [];

    items.push({ label: '1. Cutout (native)', dataUrl: imageDataToDataUrl(cutout) });
    items.push({ label: '2. Floorplan (raw)', dataUrl: imageDataToDataUrl(floorplanRaw) });

    if (preprocessResult?.intermediates) {
      for (const step of preprocessResult.intermediates) {
        items.push({ label: `${items.length + 1}. ${step.label}`, dataUrl: imageDataToDataUrl(step.data) });
      }
    }

    items.push({ label: `${items.length + 1}. Floorplan (resized + WebP)`, dataUrl: imageDataToDataUrl(floorplanProcessed) });

    for (let i = 0; i < orientationLog.length; i++) {
      const { rot, flipped, inliers, inlierRatio, parallelness, horizontalness, crossingPenalty, score } = orientationLog[i];
      const label = `${rot * 90}°${flipped ? ' (flip H)' : ''}`;
      let fpAtRot;
      if (flipped) {
        const f = flipMat(floorplanForRot, 1);
        fpAtRot = rotateMat90(f, rot);
        f.delete();
      } else {
        fpAtRot = rotateMat90(floorplanForRot, rot);
      }
      const parallelPct = Math.round((parallelness ?? 1) * 100);
      const horizPct = Math.round((horizontalness ?? 1) * 100);
      const crossStr = (crossingPenalty ?? 0) > 0 ? `, -${(crossingPenalty * 100).toFixed(0)}% cross` : '';
      const isBest = rot === bestOrbRot && flipped === bestOrbFlipped;
      items.push({
        label: `${items.length + 1}. ${label}: ${inliers} inl, ${parallelPct}% par, ${horizPct}% horiz${crossStr}${isBest ? ' ★ BEST' : ''}`,
        dataUrl: matToDataUrl(fpAtRot)
      });
      const inlierDraw = orientationLog[i].drawData
        ? drawOrbInliersFromData(cutoutMat, fpAtRot, orientationLog[i].drawData)
        : drawOrbInliers(cutoutMat, fpAtRot);
      if (inlierDraw) {
        items.push({ label: `${items.length + 1}. ${label} inliers (${inliers})`, dataUrl: matToDataUrl(inlierDraw) });
        inlierDraw.delete();
      }
      orientationLog[i].drawData = null;
      fpAtRot.delete();
    }

    const cutoutKp = drawOrbKeypoints(cutoutMat);
    items.push({ label: `${items.length + 1}. Cutout keypoints (${cutoutKp.keypointCount} pts)`, dataUrl: matToDataUrl(cutoutKp.mat) });
    cutoutKp.mat.delete();

    let fpBestRot;
    if (bestOrbMat) {
      fpBestRot = bestOrbMat;
    } else if (bestOrbFlipped) {
      const flipped = flipMat(floorplanForRot, 1);
      fpBestRot = rotateMat90(flipped, bestOrbRot);
      flipped.delete();
    } else {
      fpBestRot = rotateMat90(floorplanForRot, bestOrbRot);
    }
    const fpKp = drawOrbKeypoints(fpBestRot);
    const rotLabel = bestOrbFlipped ? `${bestOrbRot * 90}° (flipped)` : `${bestOrbRot * 90}°`;
    items.push({ label: `${items.length + 1}. Floorplan @ ${rotLabel} keypoints (${fpKp.keypointCount} pts)`, dataUrl: matToDataUrl(fpKp.mat) });
    fpKp.mat.delete();
    items.push({ label: `${items.length + 1}. Floorplan best (${rotLabel})`, dataUrl: matToDataUrl(fpBestRot) });

    if (contourLog && contourLog.length > 0) {
      for (const item of contourLog) {
        items.push({ label: `${items.length + 1}. ${item.label}`, dataUrl: item.dataUrl });
      }
    }

    cutoutMat.delete();
    cutoutGray.delete();
    floorplanMat.delete();
    floorplanForRot.delete();
    fpBestRot.delete();

    result.intermediates = items;
  } else {
    cutoutMat.delete();
    cutoutGray.delete();
    floorplanMat.delete();
    floorplanForRot.delete();
    if (bestOrbMat) bestOrbMat.delete();
  }

  return result;
}

/**
 * ORB composite scores (0–100) in one pass over all 8 poses. Cutout fixed; floorplan rotated/flipped.
 * orbProduction and orbMax8 both use the best score over unflipped + H-flip (same rule as runFloorplanComparisonOpencv).
 * @param {cv.Mat} cutoutGray - CV_8UC1
 * @param {cv.Mat} floorRgba - CV_8UC4
 * @returns {{ orbProduction: number, orbMax8: number }}
 */
function orbProductionAndMax8Percents(cutoutGray, floorRgba) {
  const maxOverFourRots = (src) => {
    let m = 0;
    for (const rot of [0, 1, 2, 3]) {
      const fpRot = rotateMat90(src, rot);
      const fpGray = new cv.Mat();
      cv.cvtColor(fpRot, fpGray, cv.COLOR_RGBA2GRAY);
      const r = orbMatchWithInlierRatio(cutoutGray, fpGray, {});
      if (r.score > m) m = r.score;
      fpGray.delete();
      fpRot.delete();
    }
    return m;
  };
  const floorForRot = new cv.Mat();
  floorRgba.copyTo(floorForRot);
  const bestUnflipped = maxOverFourRots(floorForRot);
  const flipped = flipMat(floorForRot, 1);
  const bestFlipped = maxOverFourRots(flipped);
  flipped.delete();
  floorForRot.delete();

  const orbMax8Raw = Math.max(bestUnflipped, bestFlipped);
  const orbProductionRaw = orbMax8Raw;

  return {
    orbProduction: Math.min(100, Math.round(orbProductionRaw * 100)),
    orbMax8: Math.min(100, Math.round(orbMax8Raw * 100))
  };
}

/**
 * Contour (Hu) scores. Cutout is fixed; only the floorplan is rotated/flipped.
 * contour0 = as-stored floorplan vs cutout; contourMax8 = best over 4×90° × H-flip.
 * @param {cv.Mat} cutoutMat - RGBA
 * @param {cv.Mat} floorRgba - RGBA
 * @returns {{ contour0: number, contourMax8: number }}
 */
function contourScoresFixedVsMax8(cutoutMat, floorRgba) {
  const floorBase = new cv.Mat();
  floorRgba.copyTo(floorBase);
  const contour0 = contourMatchScore(cutoutMat, floorBase, false);

  let contourMax8 = contour0;
  for (const flipped of [false, true]) {
    let base;
    if (flipped) {
      base = flipMat(floorBase, 1);
    } else {
      base = new cv.Mat();
      floorBase.copyTo(base);
    }
    for (let rot = 0; rot < 4; rot++) {
      const m = rotateMat90(base, rot);
      const s = contourMatchScore(cutoutMat, m, false);
      if (s > contourMax8) contourMax8 = s;
      m.delete();
    }
    base.delete();
  }
  floorBase.delete();
  return { contour0, contourMax8 };
}

/**
 * Async: resized floorplan ImageData aligned to cutout (same as runFloorplanComparisonOpencv).
 * @param {string} floorplanDataUrl
 * @param {ImageData} cutout
 */
async function getProcessedFloorplanImageDataForCutout(floorplanDataUrl, cutout, options = {}) {
  const logTimings = options.logTimings === true;
  const cacheKey = floorplanProcessedCacheKey(floorplanDataUrl, cutout);
  if (floorplanProcessedCache.has(cacheKey)) {
    if (logTimings) {
      console.log(`[OpenCV preprocess] cache HIT (resized-to-cutout) — skipped crop fetch + WebP resize`);
    }
    return floorplanProcessedCache.get(cacheKey);
  }
  const t0 = performance.now();
  const floorplanCropped = await getFloorplanCroppedPreprocessedImageData(floorplanDataUrl, {
    logTimings,
    candidateName: options.candidateName
  });
  const t1 = performance.now();
  const floorplanProcessed = await resizeFloorplanCroppedToCutoutLongestEdge(floorplanCropped, cutout);
  if (logTimings) {
    console.log(
      `[OpenCV preprocess] resizeFloorplanCroppedToCutoutLongestEdge (WebP): ${(performance.now() - t1).toFixed(1)}ms | cropped→sized total: ${(performance.now() - t0).toFixed(1)}ms`
    );
  }
  floorplanProcessedCache.set(cacheKey, floorplanProcessed);
  return floorplanProcessed;
}

/**
 * SHA-256 hex of raw image bytes from a data URL (identical files → same hash).
 * @param {string} dataUrl
 * @returns {Promise<string>}
 */
async function sha256HexFromDataUrl(dataUrl) {
  const res = await fetch(dataUrl);
  const buf = await res.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Blend rank score: ORB max8 + contour max8 + legacy silhouette (7 parts: 3 + 3 + 1).
 * Matches full Compare (OpenCV) feature set for Shape bench ranking.
 */
function shapeBenchBlendRankScore(contourMax8Pct, orbMax8Pct, legacySilhouette) {
  return Math.round((contourMax8Pct * 3 + orbMax8Pct * 3 + legacySilhouette) / 7);
}

/** Ranked carousel slice from current row list (same sort as final batch result). */
/** Same ordering as ranked table / carousel (best rankScore first). */
export function shapeBenchCompareRowsForRank(a, b) {
  if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
  if ((b.silhouetteIou ?? 0) !== (a.silhouetteIou ?? 0)) return (b.silhouetteIou ?? 0) - (a.silhouetteIou ?? 0);
  if ((b.silhouetteChamfer ?? 0) !== (a.silhouetteChamfer ?? 0))
    return (b.silhouetteChamfer ?? 0) - (a.silhouetteChamfer ?? 0);
  if (b.orbMax8 !== a.orbMax8) return b.orbMax8 - a.orbMax8;
  if (b.contourMax8 !== a.contourMax8) return b.contourMax8 - a.contourMax8;
  if (b.legacySilhouette !== a.legacySilhouette) return b.legacySilhouette - a.legacySilhouette;
  if (b.contour0 !== a.contour0) return b.contour0 - a.contour0;
  return a.name.localeCompare(b.name);
}

function shapeBenchRankedCarouselFromRows(rows) {
  return [...rows]
    .sort(shapeBenchCompareRowsForRank)
    .map((r, i) => ({
      rank: i + 1,
      name: r.name,
      data: r.data,
      rankScore: r.rankScore,
      orbProduction: r.orbProduction,
      orbMax8: r.orbMax8,
      contourMax8: r.contourMax8,
      legacySilhouette: r.legacySilhouette,
      ...(r.bestPoseLabel != null ? { bestPoseLabel: r.bestPoseLabel } : {}),
      ...(r.silhouetteVisual ? { silhouetteVisual: r.silhouetteVisual } : {}),
      ...(r.silhouetteIou != null ? { silhouetteIou: r.silhouetteIou } : {}),
      ...(r.silhouetteChamfer != null ? { silhouetteChamfer: r.silhouetteChamfer } : {}),
      ...(typeof r.silhouetteChamferMeanPx === 'number'
        ? { silhouetteChamferMeanPx: r.silhouetteChamferMeanPx }
        : {}),
      ...(typeof r.silhouetteChamferStdPx === 'number'
        ? { silhouetteChamferStdPx: r.silhouetteChamferStdPx }
        : {})
    }));
}

const SHAPE_BENCH_RESULT_CACHE_MAX = 500;

/** Cutout side of session cache key: path id + raster size (no pixel hash). */
function shapeBenchCutoutSessionKey(pathId, cutout) {
  return `${pathId}\0${cutout.width}x${cutout.height}`;
}

/**
 * Cached scores per (cheap floor fingerprint + path id + cutout width×height).
 * Keys use prefix sbOC1 so entries without ORB (older generations) are not reused.
 * LRU: get refreshes entry; overflow drops oldest inserts.
 * @type {Map<string, { contour0: number, contourMax8: number, orbProduction: number, orbMax8: number, legacySilhouette: number, legacyDirect: number, legacyEdge: number }>}
 */
const shapeBenchmarkResultCache = new Map();

function shapeBenchResultCacheGet(key) {
  const v = shapeBenchmarkResultCache.get(key);
  if (!v) return undefined;
  shapeBenchmarkResultCache.delete(key);
  shapeBenchmarkResultCache.set(key, v);
  return v;
}

function shapeBenchResultCacheSet(key, value) {
  if (shapeBenchmarkResultCache.has(key)) shapeBenchmarkResultCache.delete(key);
  shapeBenchmarkResultCache.set(key, value);
  while (shapeBenchmarkResultCache.size > SHAPE_BENCH_RESULT_CACHE_MAX) {
    const oldest = shapeBenchmarkResultCache.keys().next().value;
    shapeBenchmarkResultCache.delete(oldest);
  }
}

/** Clear cached Shape bench scores (e.g. after SVG reload if desired). */
export function clearShapeBenchmarkResultCache() {
  shapeBenchmarkResultCache.clear();
}

const SILHOUETTE_BENCH_RESULT_CACHE_MAX = 500;

/** Cutout + grid for Silhouette bench result cache key. */
function silhouetteBenchCutoutSessionKey(pathId, cutout, maxCompareDim) {
  return `${pathId}\0${cutout.width}x${cutout.height}\0${maxCompareDim}`;
}

/**
 * Cached Silhouette bench rows per (cheap floor fp + path + cutout size + maxCompareDim).
 * Prefix silSB7: floorplan stretched to fill cutout grid (non-uniform); invalidates silSB6 scores.
 * @type {Map<string, { rankScore: number, orbMax8: number, bestPoseLabel: string, silhouetteIou: number, silhouetteChamfer: number, silhouetteChamferMeanPx?: number, silhouetteChamferStdPx?: number }>}
 */
const silhouetteBenchmarkResultCache = new Map();

function silhouetteBenchResultCacheGet(key) {
  const v = silhouetteBenchmarkResultCache.get(key);
  if (!v) return undefined;
  silhouetteBenchmarkResultCache.delete(key);
  silhouetteBenchmarkResultCache.set(key, v);
  return v;
}

function silhouetteBenchResultCacheSet(key, value) {
  if (silhouetteBenchmarkResultCache.has(key)) silhouetteBenchmarkResultCache.delete(key);
  silhouetteBenchmarkResultCache.set(key, value);
  while (silhouetteBenchmarkResultCache.size > SILHOUETTE_BENCH_RESULT_CACHE_MAX) {
    const oldest = silhouetteBenchmarkResultCache.keys().next().value;
    silhouetteBenchmarkResultCache.delete(oldest);
  }
}

/** Clear cached Silhouette bench scores. */
export function clearSilhouetteBenchmarkResultCache() {
  silhouetteBenchmarkResultCache.clear();
}

/**
 * Group candidates with identical decoded image bytes. Within each group, keep the one with the
 * shortest filename (ties broken by localeCompare). Drops the rest before benchmarking.
 *
 * @param {Array<{ name: string, data: string }>} candidates
 * @returns {Promise<{ kept: typeof candidates, dropped: Array<{ droppedName: string, keptName: string }>, originalCount: number }>}
 */
export async function dedupeBenchmarkCandidatesByIdenticalContent(candidates) {
  /** @type {Map<string, Array<{ name: string, data: string }>>} */
  const groups = new Map();
  for (const c of candidates) {
    const hex = await sha256HexFromDataUrl(c.data);
    if (!groups.has(hex)) groups.set(hex, []);
    groups.get(hex).push(c);
  }

  const kept = [];
  /** @type {Array<{ droppedName: string, keptName: string }>} */
  const dropped = [];

  for (const list of groups.values()) {
    list.sort((a, b) => {
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.name.localeCompare(b.name);
    });
    kept.push(list[0]);
    for (let i = 1; i < list.length; i++) {
      dropped.push({ droppedName: list[i].name, keptName: list[0].name });
    }
  }

  return { kept, dropped, originalCount: candidates.length };
}

/**
 * Shape bench detection pipeline (high level):
 * 1. [UI] dedupeBenchmarkCandidatesByIdenticalContent — same bytes → keep shortest filename (not here).
 * 2. loadOpenCV.js
 * 3. extractPathCutout → result cache key uses path id + cutout width×height (no cutout pixel hash)
 * 4. cutout → cv.Mat RGBA (fixed; floorplan is rotated/flipped in contour scoring)
 * 5. Per candidate:
 *    a. Cheap floor fingerprint (head/tail sample SHA-256) + path id + cutout width×height → session result cache hit? return row.
 *    b. Else: aspect gate — cropped preprocess vs cutout width÷height only (scale ignored); span is min over floor bbox as-is and w/h swapped (0°/90°). opts.shapeBenchMaxAspectRatio default 2.5, false disables (shapeBenchMaxDimensionRatio is a deprecated alias)
 *    c. Else: getProcessedFloorplanImageDataForCutout — strict flood-fill bg, morph, crop, resize to cutout longest edge, WebP — timings under [OpenCV preprocess] when opts.logTimings
 *    d. orbProductionAndMax8Percents — ORB inlier match vs cutout (production rule + max over 8 poses, same as Compare OpenCV)
 *    e. contourScoresFixedVsMax8 — Hu matchShapes, best over 4×90° + H-flip
 *    f. compareFloorplanToCutout — legacy JS (4× rotation): silhouette / direct / edge; timed as “legacy match” when opts.logTimings
 * 6. rankScore = blend(round((3×Cnt max8 + 3×Orb max8 + Leg sil) / 7)); sort rankedCarousel. Session caches: floorplanProcessedCache (URL+cutout size), shapeBenchmarkResultCache (sbOC1 + cheap floor fp + path + cutout dims).
 *
 * Benchmark multiple floorplan candidates against one SVG path cutout.
 * The cutout is treated as canonical (no rotation/flip). Each candidate floorplan is scored
 * after searching its pose (90° steps and optional horizontal flip). Higher score ⇒ better match
 * for that metric; compare scores across rows to rank which floorplan fits the cutout best.
 * Does not mutate path attributes or reuse Compare / Compare (OpenCV) UI.
 *
 * @param {SVGElement} svgElement
 * @param {SVGPathElement} pathElement
 * @param {Array<{ name: string, data: string }>} candidates - data URLs
 * @param {Object} [opts]
 * @param {boolean} [opts.logTimings] - default true: console [Shape bench] candidate timings + [OpenCV preprocess] decode/blur/bg/morph/crop/resize lines (aspect gate reuses cropped cache — may log cache HIT)
 * @param {number | false} [opts.shapeBenchMaxAspectRatio] - default 2.5: reject if max(croppedAR/cutAR,cutAR/croppedAR) exceeds this (AR = width/height). false disables.
 * @param {number | false} [opts.shapeBenchMaxDimensionRatio] - deprecated alias for shapeBenchMaxAspectRatio
 * @param {boolean} [opts.shapeBenchFlashPreprocessSteps] - if true, show each preprocess step (raw + OpenCV intermediates) in UI via onPreprocessFlashStep before aspect gate
 * @param {number} [opts.shapeBenchFlashPreprocessDelayMs] - dwell per step (default 550)
 * @param {(info: { label: string, imageData: ImageData, candidateName: string, stepIndex: number, stepTotal: number, floorplanDataUrl: string }) => void | Promise<void>} [opts.onPreprocessFlashStep]
 * @param {(info: { done: number, total: number, name?: string, phase?: string }) => void} [opts.onProgress] - done runs 0..total (0 after cutout ready, +1 per candidate including size-filter skips)
 * @param {(snap: { pathId: string, rows: object[], rankedCarousel: object[], benchCache: { hits: number, misses: number }, candidatesHandled: number, filteredOut: object[] }) => void} [opts.onPartialResult] - after cutout (0 rows) and after each candidate; rankedCarousel reflects current partial ranking
 * @returns {Promise<{ pathId: string, rows: Array<object>, rankedCarousel: Array<{
 *   rank: number, name: string, data: string, rankScore: number,
 *   orbProduction: number, orbMax8: number, contourMax8: number, legacySilhouette: number
 * }>, benchCache: { hits: number, misses: number }, filteredOut: Array<{ name: string, reason: string, fw: number, fh: number, cw: number, ch: number, floorAspect: number, cutoutAspect: number, aspectSpan: number, maxAspectRatio: number }>, candidatesHandled: number }>}
 * Note: dedupeBenchmarkCandidatesByIdenticalContent still uses full-file SHA-256; session cache uses cheap fingerprint only.
 */
export async function runShapeBenchmarkBatch(svgElement, pathElement, candidates, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const onPartialResult = typeof opts.onPartialResult === 'function' ? opts.onPartialResult : null;
  const logTimings = opts.logTimings !== false;
  const total = candidates.length;
  const aspectOpt = opts.shapeBenchMaxAspectRatio ?? opts.shapeBenchMaxDimensionRatio;
  let maxAspectSpan = FLOORPLAN_CUTOUT_DEFAULT_MAX_ASPECT_SPAN;
  if (aspectOpt === false) maxAspectSpan = null;
  else if (typeof aspectOpt === 'number' && aspectOpt > 1) {
    maxAspectSpan = aspectOpt;
  }

  await loadOpenCV();
  onProgress?.({ done: 0, total, phase: 'cutout' });
  const pathId = pathElement?.id ?? pathElement?.getAttribute?.('id') ?? 'unknown';
  const tCutout0 = performance.now();
  const cutout = await extractPathCutout(svgElement, pathElement);
  const cutoutSessionKey = shapeBenchCutoutSessionKey(pathId, cutout);
  const cutoutSetupMs = performance.now() - tCutout0;

  /** @type {cv.Mat | null} */
  let cutoutMat = null;
  const ensureCutoutMat = () => {
    if (!cutoutMat) {
      cutoutMat = imageDataToMat(cutout);
    }
    return cutoutMat;
  };

  /** @type {cv.Mat | null} */
  let cutoutGrayForOrb = null;
  const ensureCutoutGrayForOrb = () => {
    if (!cutoutGrayForOrb) {
      cutoutGrayForOrb = new cv.Mat();
      cv.cvtColor(ensureCutoutMat(), cutoutGrayForOrb, cv.COLOR_RGBA2GRAY);
    }
    return cutoutGrayForOrb;
  };

  if (logTimings) {
    console.log(
      '%c[Shape bench] Pipeline%c see JSDoc on runShapeBenchmarkBatch. Timings exclude OpenCV floor preprocess+resize (step 5b).',
      'font-weight:bold',
      'font-weight:normal'
    );
    console.log(
      `[Shape bench] cutout extract: ${cutoutSetupMs.toFixed(1)}ms (path: ${pathId}, session key ${cutout.width}×${cutout.height}; cv.Mat deferred until first scored candidate)`
    );
    if (maxAspectSpan != null) {
      console.log(
        `[Shape bench] Aspect gate: min over floor 0°/90° (bbox w×h vs h×w) of max(floor AR÷cut AR, cut AR÷floor AR) ≤ ${maxAspectSpan} (AR = width÷height; cropped = preprocess before resize; cutout ${cutout.width}×${cutout.height})`
      );
    }
  }
  const rows = [];
  /** @type {Map<string, Awaited<ReturnType<typeof compareFloorplanToCutout>>>} */
  const legacyByFloorplanDataUrl = new Map();
  let benchCacheHits = 0;
  let benchCacheMisses = 0;
  let candidatesHandled = 0;
  /** @type {Array<{ name: string, reason: string, fw: number, fh: number, cw: number, ch: number, floorAspect: number, cutoutAspect: number, aspectSpan: number, maxAspectRatio: number }>} */
  const filteredOut = [];

  const emitPartial = () => {
    onPartialResult?.({
      pathId,
      rows: [...rows],
      rankedCarousel: shapeBenchRankedCarouselFromRows(rows),
      benchCache: { hits: benchCacheHits, misses: benchCacheMisses },
      candidatesHandled,
      filteredOut: filteredOut.map((f) => ({ ...f }))
    });
  };

  emitPartial();

  /** @type {Map<string, string>} */
  const floorFpByDataUrl = new Map();

  for (const c of candidates) {
    const tKey0 = performance.now();
    let floorFp = floorFpByDataUrl.get(c.data);
    if (floorFp === undefined) {
      floorFp = await cheapFloorFingerprintHex(c.data);
      floorFpByDataUrl.set(c.data, floorFp);
    }
    const cacheKey = `sbOC1\0${floorFp}\0${cutoutSessionKey}`;
    const keyMs = performance.now() - tKey0;
    const cached = shapeBenchResultCacheGet(cacheKey);
    if (cached) {
      benchCacheHits += 1;
      if (logTimings) {
        console.log(
          `[Shape bench] ${c.name} | result cache HIT (floor fp ${keyMs.toFixed(1)}ms) — skipped ORB/contour/legacy`
        );
      }
      const rankScore = shapeBenchBlendRankScore(
        cached.contourMax8,
        cached.orbMax8,
        cached.legacySilhouette
      );
      rows.push({
        name: c.name,
        data: c.data,
        contour0: cached.contour0,
        contourMax8: cached.contourMax8,
        orbProduction: cached.orbProduction,
        orbMax8: cached.orbMax8,
        legacySilhouette: cached.legacySilhouette,
        legacyDirect: cached.legacyDirect,
        legacyEdge: cached.legacyEdge,
        rankScore
      });
      candidatesHandled += 1;
      onProgress?.({
        done: candidatesHandled,
        total,
        name: `${c.name} (cached)`,
        phase: 'candidate'
      });
      emitPartial();
      continue;
    }

    const preprocessFlashOpts =
      opts.shapeBenchFlashPreprocessSteps && typeof opts.onPreprocessFlashStep === 'function'
        ? {
            captureAndFlash: true,
            onPreprocessStep: opts.onPreprocessFlashStep,
            stepDwellMs: opts.shapeBenchFlashPreprocessDelayMs ?? 550,
            candidateName: c.name
          }
        : null;

    if (maxAspectSpan != null) {
      const gate = await shapeBenchFloorplanFailsAspectGate(
        c.data,
        cutout,
        maxAspectSpan,
        preprocessFlashOpts
          ? { ...preprocessFlashOpts }
          : logTimings
            ? { logTimings: true, candidateName: c.name }
            : {}
      );
      if (gate) {
        filteredOut.push({
          name: c.name,
          reason: gate.reason,
          fw: gate.fw,
          fh: gate.fh,
          cw: gate.cw,
          ch: gate.ch,
          floorAspect: gate.floorAspect,
          cutoutAspect: gate.cutoutAspect,
          aspectSpan: gate.aspectSpan,
          maxAspectRatio: gate.maxAspectRatio
        });
        if (logTimings) {
          const arNote =
            gate.reason === 'aspectRatio'
              ? ` cropped AR ${gate.floorAspect.toFixed(4)} vs cutout AR ${gate.cutoutAspect.toFixed(4)} (min 0°/90° span ${gate.aspectSpan.toFixed(2)} > ${gate.maxAspectRatio})`
              : '';
          console.log(
            `[Shape bench] ${c.name} | skipped (aspect gate): ${gate.reason} cropped ${gate.fw}×${gate.fh} vs cutout ${gate.cw}×${gate.ch}${arNote}`
          );
        }
        candidatesHandled += 1;
        onProgress?.({
          done: candidatesHandled,
          total,
          name: `${c.name} (aspect filter)`,
          phase: 'candidate'
        });
        emitPartial();
        continue;
      }
    } else if (preprocessFlashOpts) {
      await getFloorplanCroppedPreprocessedImageData(c.data, preprocessFlashOpts);
    }

    benchCacheMisses += 1;
    const floorplanProcessed = await getProcessedFloorplanImageDataForCutout(c.data, cutout, {
      logTimings,
      candidateName: c.name
    });
    const floorplanMat = imageDataToMat(floorplanProcessed);

    const tOrb = performance.now();
    const { orbProduction, orbMax8 } = orbProductionAndMax8Percents(ensureCutoutGrayForOrb(), floorplanMat);
    const orbMs = performance.now() - tOrb;

    const tContour = performance.now();
    const { contour0, contourMax8 } = contourScoresFixedVsMax8(ensureCutoutMat(), floorplanMat);
    const contourMs = performance.now() - tContour;

    floorplanMat.delete();

    const hadLegacyMemo = legacyByFloorplanDataUrl.has(c.data);
    let legacy = legacyByFloorplanDataUrl.get(c.data);
    if (!legacy) {
      legacy = await compareFloorplanToCutout(cutout, c.data, {
        shapeBenchTiming: logTimings,
        ...(maxAspectSpan != null ? { skipAspectRatioCheck: true } : { maxAspectSpan: false })
      });
      legacyByFloorplanDataUrl.set(c.data, legacy);
    }
    if (logTimings) {
      const memo = hadLegacyMemo ? ' | legacy (batch memo)' : '';
      console.log(
        `[Shape bench] ${c.name} | fp ${keyMs.toFixed(1)}ms | ORB: ${orbMs.toFixed(1)}ms | contour(Hu×8): ${contourMs.toFixed(1)}ms${memo}`
      );
    }

    const contourMax8Pct = Math.round(contourMax8 * 100);
    const rankScore = shapeBenchBlendRankScore(contourMax8Pct, orbMax8, legacy.silhouette);

    const row = {
      name: c.name,
      data: c.data,
      contour0: Math.round(contour0 * 100),
      contourMax8: contourMax8Pct,
      orbProduction,
      orbMax8,
      legacySilhouette: legacy.silhouette,
      legacyDirect: legacy.direct,
      legacyEdge: legacy.edge,
      rankScore
    };
    rows.push(row);
    shapeBenchResultCacheSet(cacheKey, {
      contour0: row.contour0,
      contourMax8: row.contourMax8,
      orbProduction: row.orbProduction,
      orbMax8: row.orbMax8,
      legacySilhouette: row.legacySilhouette,
      legacyDirect: row.legacyDirect,
      legacyEdge: row.legacyEdge
    });
    candidatesHandled += 1;
    onProgress?.({ done: candidatesHandled, total, name: c.name, phase: 'candidate' });
    emitPartial();
  }

  if (cutoutGrayForOrb) {
    cutoutGrayForOrb.delete();
  }
  if (cutoutMat) {
    cutoutMat.delete();
  }

  const rankedCarousel = shapeBenchRankedCarouselFromRows(rows);

  return {
    pathId,
    rows,
    rankedCarousel,
    benchCache: { hits: benchCacheHits, misses: benchCacheMisses },
    filteredOut,
    candidatesHandled
  };
}

/**
 * Benchmark candidates with silhouette IoU only (no ORB/SIFT/OpenCV scoring loop).
 * Same dedupe/aspect-gate flow as Shape bench; scoring via compareSilhouetteOnlyToCutout (pure JS, smaller raster).
 *
 * @param {SVGElement} svgElement
 * @param {SVGPathElement} pathElement
 * @param {Array<{ name: string, data: string }>} candidates
 * @param {Object} [opts] - onProgress, onPartialResult, shapeBench* aspect/flash, silhouetteMaxCompareDim (default 256)
 * @param {boolean} [opts.logTimings] - default true: [Silhouette bench] + [Silhouette preprocess] + [OpenCV preprocess] timing lines (aspect gate uses OpenCV crop path; scoring uses JS preprocess)
 * @param {number} [opts.silhouetteVisualFirstN] - top N rows by bench rank (same sort as the results table) get silhouetteVisual (default 20); 0 disables
 * @param {number} [opts.silhouetteVisualTopN] - deprecated alias for silhouetteVisualFirstN
 */
export async function runSilhouetteBenchmarkBatch(svgElement, pathElement, candidates, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const onPartialResult = typeof opts.onPartialResult === 'function' ? opts.onPartialResult : null;
  const logTimings = opts.logTimings !== false;
  const total = candidates.length;
  const maxCompareDim = opts.silhouetteMaxCompareDim ?? 256;
  const aspectOpt = opts.shapeBenchMaxAspectRatio ?? opts.shapeBenchMaxDimensionRatio;
  let maxAspectSpan = FLOORPLAN_CUTOUT_DEFAULT_MAX_ASPECT_SPAN;
  if (aspectOpt === false) maxAspectSpan = null;
  else if (typeof aspectOpt === 'number' && aspectOpt > 1) {
    maxAspectSpan = aspectOpt;
  }

  await loadOpenCV();

  onProgress?.({ done: 0, total, phase: 'cutout' });
  const pathId = pathElement?.id ?? pathElement?.getAttribute?.('id') ?? 'unknown';
  const tCutout0 = performance.now();
  const cutout = await extractPathCutout(svgElement, pathElement);
  const cutoutSetupMs = performance.now() - tCutout0;

  if (logTimings) {
    console.log(
      `%c[Silhouette bench] cutout: ${cutoutSetupMs.toFixed(1)}ms (path ${pathId}, ${cutout.width}×${cutout.height}; grid max ${maxCompareDim})`,
      'font-weight:bold'
    );
  }

  const rows = [];
  let benchCacheHits = 0;
  let benchCacheMisses = 0;
  let candidatesHandled = 0;
  /** @type {Array<{ name: string, reason: string, fw: number, fh: number, cw: number, ch: number, floorAspect: number, cutoutAspect: number, aspectSpan: number, maxAspectRatio: number }>} */
  const filteredOut = [];
  const silhouetteVisualFirstN =
    typeof opts.silhouetteVisualFirstN === 'number'
      ? Math.max(0, opts.silhouetteVisualFirstN)
      : typeof opts.silhouetteVisualTopN === 'number'
        ? Math.max(0, opts.silhouetteVisualTopN)
        : 20;
  const silhouetteVisualCache = new Map();
  const chamferCols = resolveSilhouetteChamferOpts(opts);

  const applyFirstNSilhouetteVisuals = async () => {
    if (silhouetteVisualFirstN <= 0 || rows.length === 0) {
      for (const row of rows) delete row.silhouetteVisual;
      return;
    }
    for (const row of rows) delete row.silhouetteVisual;

    const rankedForVisual = [...rows].sort(shapeBenchCompareRowsForRank);
    const topForVisual = rankedForVisual.slice(
      0,
      Math.min(silhouetteVisualFirstN, rankedForVisual.length)
    );

    const silOpts = {
      shapeBenchTiming: logTimings,
      maxCompareDim,
      includeSilhouetteVisual: true,
      ...silhouetteChamferOptsForCompare(chamferCols),
      ...(maxAspectSpan != null ? { skipAspectRatioCheck: true } : { maxAspectSpan: false })
    };

    for (const row of topForVisual) {
      const cached = silhouetteVisualCache.get(row.data);
      if (cached) {
        row.silhouetteVisual = cached;
        continue;
      }
      const sil = await compareSilhouetteOnlyToCutout(cutout, row.data, silOpts);
      if (sil.silhouetteVisual) silhouetteVisualCache.set(row.data, sil.silhouetteVisual);
      row.silhouetteVisual = sil.silhouetteVisual;
    }
  };

  const emitPartial = async () => {
    await applyFirstNSilhouetteVisuals();
    onPartialResult?.({
      pathId,
      rows: [...rows],
      rankedCarousel: shapeBenchRankedCarouselFromRows(rows),
      benchCache: { hits: benchCacheHits, misses: benchCacheMisses },
      candidatesHandled,
      filteredOut: filteredOut.map((f) => ({ ...f }))
    });
  };

  await emitPartial();

  const silCutoutSessionKey = silhouetteBenchCutoutSessionKey(pathId, cutout, maxCompareDim);
  /** @type {Map<string, string>} */
  const floorFpByDataUrl = new Map();

  for (const c of candidates) {
    const preprocessFlashOpts =
      opts.shapeBenchFlashPreprocessSteps && typeof opts.onPreprocessFlashStep === 'function'
        ? {
            captureAndFlash: true,
            onPreprocessStep: opts.onPreprocessFlashStep,
            stepDwellMs: opts.shapeBenchFlashPreprocessDelayMs ?? 550,
            candidateName: c.name,
            skipGaussianBlur: true
          }
        : null;

    if (maxAspectSpan != null) {
      const gate = await shapeBenchFloorplanFailsAspectGate(
        c.data,
        cutout,
        maxAspectSpan,
        preprocessFlashOpts
          ? { ...preprocessFlashOpts }
          : { skipGaussianBlur: true, ...(logTimings ? { logTimings: true, candidateName: c.name } : {}) }
      );
      if (gate) {
        filteredOut.push({
          name: c.name,
          reason: gate.reason,
          fw: gate.fw,
          fh: gate.fh,
          cw: gate.cw,
          ch: gate.ch,
          floorAspect: gate.floorAspect,
          cutoutAspect: gate.cutoutAspect,
          aspectSpan: gate.aspectSpan,
          maxAspectRatio: gate.maxAspectRatio
        });
        if (logTimings) {
          const arNote =
            gate.reason === 'aspectRatio'
              ? ` cropped AR ${gate.floorAspect.toFixed(4)} vs cutout AR ${gate.cutoutAspect.toFixed(4)} (min 0°/90° span ${gate.aspectSpan.toFixed(2)} > ${gate.maxAspectRatio})`
              : '';
          console.log(
            `[Silhouette bench] ${c.name} | skipped (aspect gate): ${gate.reason} cropped ${gate.fw}×${gate.fh} vs cutout ${gate.cw}×${gate.ch}${arNote}`
          );
        }
        candidatesHandled += 1;
        onProgress?.({
          done: candidatesHandled,
          total,
          name: `${c.name} (aspect filter)`,
          phase: 'candidate'
        });
        await emitPartial();
        continue;
      }
    } else if (preprocessFlashOpts) {
      await getFloorplanCroppedPreprocessedImageData(c.data, preprocessFlashOpts);
    }

    let floorFp = floorFpByDataUrl.get(c.data);
    if (floorFp === undefined) {
      floorFp = await cheapFloorFingerprintHex(c.data);
      floorFpByDataUrl.set(c.data, floorFp);
    }
    const silResultKey = `silSB7\0${floorFp}\0${silCutoutSessionKey}`;
    const cachedSil = silhouetteBenchResultCacheGet(silResultKey);
    if (cachedSil) {
      benchCacheHits += 1;
      if (logTimings) {
        console.log(`[Silhouette bench] ${c.name} | result cache HIT — skipped IoU search`);
      }
      rows.push({
        name: c.name,
        data: c.data,
        rankScore: cachedSil.rankScore,
        orbProduction: 0,
        orbMax8: cachedSil.orbMax8,
        contour0: 0,
        contourMax8: 0,
        legacySilhouette: 0,
        legacyDirect: 0,
        legacyEdge: 0,
        bestPoseLabel: cachedSil.bestPoseLabel,
        silhouetteIou: cachedSil.silhouetteIou ?? cachedSil.rankScore,
        silhouetteChamfer: cachedSil.silhouetteChamfer ?? 0,
        ...(typeof cachedSil.silhouetteChamferMeanPx === 'number'
          ? { silhouetteChamferMeanPx: cachedSil.silhouetteChamferMeanPx }
          : {}),
        ...(typeof cachedSil.silhouetteChamferStdPx === 'number'
          ? { silhouetteChamferStdPx: cachedSil.silhouetteChamferStdPx }
          : {}),
        ...chamferCols
      });
      candidatesHandled += 1;
      onProgress?.({
        done: candidatesHandled,
        total,
        name: `${c.name} (cached)`,
        phase: 'candidate'
      });
      await emitPartial();
      continue;
    }

    benchCacheMisses += 1;
    const sil = await compareSilhouetteOnlyToCutout(cutout, c.data, {
      shapeBenchTiming: logTimings,
      maxCompareDim,
      includeSilhouetteVisual: false,
      ...silhouetteChamferOptsForCompare(chamferCols),
      ...(maxAspectSpan != null ? { skipAspectRatioCheck: true } : { maxAspectSpan: false })
    });
    const pct = sil.silhouette;
    const iouPct = sil.silhouetteIou ?? pct;
    const chamferPct = sil.silhouetteChamfer ?? 0;
    const bestPoseLabel = `${sil.bestRotation}°${sil.bestFlipped ? ' (flip)' : ''}`;

    silhouetteBenchResultCacheSet(silResultKey, {
      rankScore: pct,
      orbMax8: pct,
      bestPoseLabel,
      silhouetteIou: iouPct,
      silhouetteChamfer: chamferPct,
      ...(typeof sil.silhouetteChamferMeanPx === 'number'
        ? { silhouetteChamferMeanPx: sil.silhouetteChamferMeanPx }
        : {}),
      ...(typeof sil.silhouetteChamferStdPx === 'number'
        ? { silhouetteChamferStdPx: sil.silhouetteChamferStdPx }
        : {})
    });

    const row = {
      name: c.name,
      data: c.data,
      rankScore: pct,
      orbProduction: 0,
      orbMax8: pct,
      contour0: 0,
      contourMax8: 0,
      legacySilhouette: 0,
      legacyDirect: 0,
      legacyEdge: 0,
      bestPoseLabel,
      silhouetteIou: iouPct,
      silhouetteChamfer: chamferPct,
      ...(typeof sil.silhouetteChamferMeanPx === 'number'
        ? { silhouetteChamferMeanPx: sil.silhouetteChamferMeanPx }
        : {}),
      ...(typeof sil.silhouetteChamferStdPx === 'number'
        ? { silhouetteChamferStdPx: sil.silhouetteChamferStdPx }
        : {}),
      ...(sil.chamferOptsResolved ?? chamferCols)
    };
    rows.push(row);

    candidatesHandled += 1;
    onProgress?.({ done: candidatesHandled, total, name: c.name, phase: 'candidate' });
    await emitPartial();
  }

  const rankedCarousel = shapeBenchRankedCarouselFromRows(rows);

  return {
    pathId,
    rows,
    rankedCarousel,
    benchCache: { hits: benchCacheHits, misses: benchCacheMisses },
    filteredOut,
    candidatesHandled
  };
}
