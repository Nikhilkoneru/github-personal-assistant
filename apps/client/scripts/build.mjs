import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dist = join(root, 'dist');
const publicDir = join(root, 'public');
const tsconfig = join(root, 'tsconfig.build.json');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
execFileSync('pnpm', ['exec', 'tsc', '-p', tsconfig], { cwd: root, stdio: 'inherit' });
cpSync(publicDir, dist, { recursive: true });

const collectFiles = (dir) => {
  const entries = readdirSync(dir).sort();
  const files = [];
  for (const entry of entries) {
    const target = join(dir, entry);
    const stats = statSync(target);
    if (stats.isDirectory()) {
      files.push(...collectFiles(target));
    } else {
      files.push(relative(dist, target).replace(/\\/g, '/'));
    }
  }
  return files;
};

const mimeByExtension = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.webmanifest': 'application/manifest+json',
};

const appFiles = collectFiles(dist)
  .filter((file) => !file.endsWith('service-worker.js'))
  .map((file) => `./${file}`);

writeFileSync(
  join(dist, 'service-worker.js'),
  `const CACHE_NAME = 'github-personal-assistant-v1';\nconst APP_FILES = ${JSON.stringify(appFiles, null, 2)};\n\nself.addEventListener('install', (event) => {\n  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));\n});\n\nself.addEventListener('activate', (event) => {\n  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));\n});\n\nself.addEventListener('fetch', (event) => {\n  if (event.request.method !== 'GET') return;\n\n  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {\n    const url = new URL(event.request.url);\n    if (response.ok && url.origin === self.location.origin) {\n      const cloned = response.clone();\n      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));\n    }\n    return response;\n  }).catch(() => caches.match('./index.html'))));\n});\n`,
);

const indexHtml = join(dist, 'index.html');
if (existsSync(indexHtml)) {
  writeFileSync(join(dist, '404.html'), readFileSync(indexHtml));
}

console.log(`Built static client at ${dist}`);
