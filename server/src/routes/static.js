// Production static hosting (DESIGN.md §1): serve the built React app from
// web/dist. Registered from index.js ONLY when the build exists, so dev mode
// (vite dev server, no dist) is completely unaffected. The SPA fallback lives
// in index.js's not-found handler (a plugin at prefix '/' cannot set its own).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fastifyStatic from '@fastify/static';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DIST_DIR = path.resolve(here, '..', '..', '..', 'web', 'dist');

export function hasWebBuild() {
  return existsSync(path.join(DIST_DIR, 'index.html'));
}

export default async function staticRoutes(app) {
  await app.register(fastifyStatic, { root: DIST_DIR });
}
