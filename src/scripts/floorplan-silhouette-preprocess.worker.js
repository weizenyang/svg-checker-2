/**
 * Web worker: runs silhouette JS preprocess off the main thread (parallelize across floorplan images).
 */
import { preprocessSilhouetteJsPipelineFromImageData } from './floorplan-silhouette-preprocess-core.js';

self.onmessage = (ev) => {
  const { id, width, height, buffer, logTimings } = ev.data;
  try {
    const pixels = new Uint8ClampedArray(buffer);
    const input = new ImageData(pixels, width, height);
    const t0 = performance.now();
    const out = preprocessSilhouetteJsPipelineFromImageData(input, !!logTimings);
    const buf = out.data.buffer;
    self.postMessage(
      {
        id,
        ok: true,
        width: out.width,
        height: out.height,
        buffer: buf,
        workerMs: performance.now() - t0
      },
      [buf]
    );
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
};
