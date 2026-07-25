// Embedding vectors MUST be binary-packed as base64-encoded Float32Array
// bytes, never JSON float arrays (Phase-0 gotcha 14 — a naive JSON-array
// delta encoding blew a 48-memory delta up to 530KB, bigger than the
// equivalent 181KB full checkpoint, because mem0's native MemoryVectorStore
// itself stores vectors as packed binary BLOBs
// (`Buffer.from(new Float32Array(v).buffer)`), not JSON text).
//
// packVector/unpackVector below mirror that native on-disk encoding exactly,
// so a spec-format vector round-trips byte-identically through base64.

/** Pack a plain embedding vector into base64-encoded Float32Array bytes. */
export function packVector(vector: readonly number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

/** Unpack a base64-encoded Float32Array back into a plain number[]. */
export function unpackVector(base64: string): number[] {
  const buf = Buffer.from(base64, 'base64');
  const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(floats);
}
