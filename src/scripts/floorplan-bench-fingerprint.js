/**
 * Cheap content fingerprint for benchmark session caches (SHA-256 of length + head/tail sample).
 * Same algorithm as former shapeBenchCheapFloorFingerprintHex in floorplan-comparison-opencv.js.
 *
 * @param {string} dataUrl
 * @returns {Promise<string>} lowercase hex digest
 */
const BENCH_FLOOR_FP_HEAD = 4096;
const BENCH_FLOOR_FP_TAIL = 4096;

export async function cheapFloorFingerprintHex(dataUrl) {
  const res = await fetch(dataUrl);
  const buf = await res.arrayBuffer();
  const len = buf.byteLength;
  const u8 = new Uint8Array(buf);
  let payload;
  if (len <= BENCH_FLOOR_FP_HEAD + BENCH_FLOOR_FP_TAIL) {
    payload = u8;
  } else {
    payload = new Uint8Array(BENCH_FLOOR_FP_HEAD + BENCH_FLOOR_FP_TAIL);
    payload.set(u8.subarray(0, BENCH_FLOOR_FP_HEAD), 0);
    payload.set(u8.subarray(len - BENCH_FLOOR_FP_TAIL), BENCH_FLOOR_FP_HEAD);
  }
  const meta = new ArrayBuffer(8);
  new DataView(meta).setBigUint64(0, BigInt(len), true);
  const combined = new Uint8Array(8 + payload.length);
  combined.set(new Uint8Array(meta), 0);
  combined.set(payload, 8);
  const digest = await crypto.subtle.digest('SHA-256', combined);
  const out = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < out.length; i++) {
    hex += out[i].toString(16).padStart(2, '0');
  }
  return hex;
}
