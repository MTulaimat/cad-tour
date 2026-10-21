// Small fetch helpers: JSON with retries, and file downloads verified by md5.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { USER_AGENT } from '../assets.config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      lastErr = err;
      await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr;
}

export async function getJson(url) {
  const res = await fetchWithRetry(url);
  return res.json();
}

export async function md5File(file) {
  const hash = crypto.createHash('md5');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

/**
 * Download `url` to `dest` unless it already exists with the expected md5.
 * @returns {Promise<'cached'|'downloaded'>}
 */
export async function downloadFile(url, dest, expectedMd5) {
  try {
    await fs.access(dest);
    if (!expectedMd5 || (await md5File(dest)) === expectedMd5) return 'cached';
  } catch {
    // not there yet
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetchWithRetry(url);
  const buf = Buffer.from(await res.arrayBuffer());
  if (expectedMd5) {
    const got = crypto.createHash('md5').update(buf).digest('hex');
    if (got !== expectedMd5) throw new Error(`md5 mismatch for ${url}: expected ${expectedMd5}, got ${got}`);
  }
  const tmp = `${dest}.part`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, dest);
  return 'downloaded';
}

export const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
