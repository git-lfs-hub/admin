// Object store implemented by both live R2 (`r2Store`) and cold S3 (`s3Store`), so backup (R2 → S3)
// and restore (S3 → R2) are one `copyObject` with the stores swapped. Direction quirks live in the
// stores (source-missing null vs throw; Glacier storage class on writes).
export interface BlobStore {
  // Object size, or null if absent. As a source: null ⇒ skip the copy.
  size(key: string): Promise<number | null>;
  // Body stream, or null if it vanished since `size` (raced deletion ⇒ skip).
  read(key: string): Promise<ReadableStream | null>;
  // One byte range (throws if unreadable — the range was just listed).
  readRange(key: string, offset: number, length: number): Promise<ReadableStream>;
  write(key: string, body: ReadableStream, size: number): Promise<void>;
  startMultipart(key: string): Promise<MultipartWriter>;
}

export type Part = { partNumber: number; etag: string };

export interface MultipartWriter {
  part(partNumber: number, length: number, body: ReadableStream): Promise<Part>;
  complete(parts: Part[]): Promise<unknown>;
  abort(): Promise<unknown>;
}

// Single-transfer cap (both R2's binding and S3's single PUT cap at 5 GiB); larger objects stream
// through multipart in 1 GiB parts (≤10k parts → up to ~10 TiB).
const SINGLE_PUT_MAX = 5 * 1024 ** 3;
const PART_SIZE = 1 * 1024 ** 3;
const PART_CONCURRENCY = 4;

// Copy `src` → `dst`, streamed so nothing buffers in the Worker's 128 MB. Idempotent via a
// size-matched HEAD-skip: a same-size `dst` object is a complete copy (content-addressed oid + atomic
// writes ⇒ never partial), so a resumed page skips it.
export async function copyObject(key: string, src: BlobStore, dst: BlobStore): Promise<void> {
  const size = await src.size(key);
  if (size == null) return; // source vanished since listing
  if ((await dst.size(key)) === size) return; // complete copy already present

  if (size <= SINGLE_PUT_MAX) {
    const body = await src.read(key);
    if (!body) return; // raced deletion between `size` and `read`
    await dst.write(key, body, size);
    return;
  }

  await multipartCopy(key, size, src, await dst.startMultipart(key));
}

// Stream every 1 GiB part of `src` (bounded concurrency) into `writer`, order, then `complete`.
// Aborts on any failure so partial uploads don't linger — a resumed page re-creates and refills.
// Parts number from 1 (both R2 and S3).
async function multipartCopy(
  key: string,
  size: number,
  src: BlobStore,
  writer: MultipartWriter,
): Promise<void> {
  const partCount = Math.ceil(size / PART_SIZE);
  const parts: Part[] = [];
  try {
    for (let i = 0; i < partCount; i += PART_CONCURRENCY) {
      const batch = Array.from(
        { length: Math.min(PART_CONCURRENCY, partCount - i) },
        async (_, j) => {
          const index = i + j;
          const offset = index * PART_SIZE;
          const length = Math.min(size - offset, PART_SIZE);
          return writer.part(index + 1, length, await src.readRange(key, offset, length));
        },
      );
      parts.push(...(await Promise.all(batch)));
    }
    parts.sort((a, b) => a.partNumber - b.partNumber);
    await writer.complete(parts);
  } catch (e) {
    await writer.abort().catch(() => {});
    throw e;
  }
}
