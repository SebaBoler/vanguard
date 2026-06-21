import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeQuotaSnapshot, type QuotaSnapshot } from '../sandbox/llm-proxy-rewrite.mjs';

export type { QuotaSnapshot };

/** A quota pool. Many models may draw from one bucket. */
export type BucketId = string;

function bucketPath(cacheDir: string, bucket: BucketId): string {
  return join(cacheDir, `${bucket}.json`);
}

/** Read a bucket's last snapshot; undefined when absent or unparseable. */
export function readSnapshot(cacheDir: string, bucket: BucketId): QuotaSnapshot | undefined {
  const path = bucketPath(cacheDir, bucket);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as QuotaSnapshot;
  } catch {
    return undefined;
  }
}

/** Write a bucket's snapshot (one file per bucket → single writer, no lock). */
export function writeSnapshot(cacheDir: string, bucket: BucketId, snap: QuotaSnapshot): void {
  mkdirSync(cacheDir, { recursive: true });
  writeQuotaSnapshot(bucketPath(cacheDir, bucket), snap);
}
