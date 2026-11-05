// The built client is a handful of small files, so it is read into memory once
// at startup. Requests can only ever resolve to a key of this map, which rules
// out path traversal by construction.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep, extname } from 'node:path';

export interface StaticFile {
  body: Buffer;
  type: string;
  immutable: boolean;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

export async function loadStatic(root: string): Promise<Map<string, StaticFile>> {
  const files = new Map<string, StaticFile>();
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const urlPath = '/' + relative(root, full).split(sep).join('/');
    const type = TYPES[extname(entry.name).toLowerCase()];
    if (!type) continue;
    files.set(urlPath, {
      body: await readFile(full),
      type,
      // Vite fingerprints everything under /assets/.
      immutable: urlPath.startsWith('/assets/'),
    });
  }
  if (!files.has('/index.html')) throw new Error(`no index.html in ${root}`);
  return files;
}
