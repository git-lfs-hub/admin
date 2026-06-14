import type { BlobStore } from '@/s3/copy';

// Live R2 (the LFS bucket) as a `BlobStore` — backup's source and restore's destination. A source
// object deleted since listing reads as null (skip, not error).
export function r2Store(env: CloudflareBindings): BlobStore {
  const bucket = env.LFS_BUCKET;
  return {
    async size(key) {
      return (await bucket.head(key))?.size ?? null;
    },

    async read(key) {
      return (await bucket.get(key))?.body ?? null;
    },

    async readRange(key, offset, length) {
      const obj = await bucket.get(key, { range: { offset, length } });
      if (!obj) throw new Error(`R2 range read ${key} @${offset} failed`);
      return obj.body;
    },

    async write(key, body) {
      await bucket.put(key, body);
    },

    async startMultipart(key) {
      const upload = await bucket.createMultipartUpload(key);
      return {
        part: (partNumber, _length, body) => upload.uploadPart(partNumber, body),
        complete: (parts) => upload.complete(parts),
        abort: () => upload.abort(),
      };
    },
  };
}
