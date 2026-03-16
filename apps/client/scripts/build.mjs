import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = join(__dirname, '..');
const dist = join(root, 'dist');
const publicDir = join(root, 'public');
const tsconfig = join(root, 'tsconfig.build.json');
const defaultApiUrl =
  process.env.CLIENT_DEFAULT_API_URL?.trim() ||
  process.env.TAILSCALE_API_URL?.trim() ||
  process.env.PUBLIC_API_URL?.trim() ||
  '';

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const tscEntrypoint = require.resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tscEntrypoint, '-p', tsconfig], { cwd: root, stdio: 'inherit' });
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

const appFiles = collectFiles(dist)
  .filter((file) => !file.endsWith('service-worker.js'))
  .map((file) => `./${file}`);

const externalRuntimeFiles = [
  'https://esm.sh/react@19.2.0',
  'https://esm.sh/react@19.2.0/jsx-runtime',
  'https://esm.sh/react-dom@19.2.0/client',
  'https://esm.sh/fflate@0.8.2',
  'https://esm.sh/react-markdown@10.1.0',
  'https://esm.sh/remark-gfm@4.0.1',
];
const cacheVersion = (() => {
  const hash = createHash('sha1');
  hash.update(defaultApiUrl);
  for (const file of appFiles) {
    const relativePath = file.replace(/^\.\//, '');
    hash.update(file);
    hash.update(readFileSync(join(dist, relativePath)));
  }
  for (const file of externalRuntimeFiles) {
    hash.update(file);
  }
  return hash.digest('hex').slice(0, 10);
})();

writeFileSync(
  join(dist, 'service-worker.js'),
  `const SHELL_CACHE = 'github-personal-assistant-shell-${cacheVersion}';\nconst RUNTIME_CACHE = 'github-personal-assistant-runtime-${cacheVersion}';\nconst APP_FILES = ${JSON.stringify(appFiles, null, 2)};\nconst EXTERNAL_RUNTIME_FILES = ${JSON.stringify(externalRuntimeFiles, null, 2)};\n\nconst warmCache = async (cacheName, urls) => {\n  const cache = await caches.open(cacheName);\n  await Promise.allSettled(urls.map((url) => cache.add(url)));\n};\n\nconst staleWhileRevalidate = async (request, cacheName) => {\n  const cache = await caches.open(cacheName);\n  const cached = await cache.match(request);\n  const network = fetch(request)\n    .then((response) => {\n      if (response.ok) {\n        void cache.put(request, response.clone());\n      }\n      return response;\n    })\n    .catch(() => null);\n\n  if (cached) {\n    void network;\n    return cached;\n  }\n\n  const response = await network;\n  if (response) {\n    return response;\n  }\n\n  throw new Error('Network unavailable');\n};\n\nconst networkFirst = async (request) => {\n  const cache = await caches.open(SHELL_CACHE);\n  try {\n    const response = await fetch(request);\n    if (response.ok && request.method === 'GET') {\n      await cache.put(request, response.clone());\n    }\n    return response;\n  } catch {\n    const cached = await cache.match(request);\n    if (cached) {\n      return cached;\n    }\n    const fallback = await cache.match('./index.html');\n    if (fallback) {\n      return fallback;\n    }\n    throw new Error('Offline and no cached fallback available');\n  }\n};\n\nself.addEventListener('install', (event) => {\n  event.waitUntil(\n    Promise.all([warmCache(SHELL_CACHE, APP_FILES), warmCache(RUNTIME_CACHE, EXTERNAL_RUNTIME_FILES)]).then(() => self.skipWaiting()),\n  );\n});\n\nself.addEventListener('activate', (event) => {\n  event.waitUntil(\n    caches\n      .keys()\n      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE).map((key) => caches.delete(key))))\n      .then(() => self.clients.claim())\n      .then(() => self.clients.matchAll({ type: 'window' }))\n      .then((clients) => Promise.all(clients.map((client) => client.postMessage({ type: 'FORCE_RELOAD' })))),\n  );\n});\n\nself.addEventListener('fetch', (event) => {\n  if (event.request.method !== 'GET') {\n    return;\n  }\n\n  const url = new URL(event.request.url);\n\n  if (url.origin === self.location.origin && event.request.mode === 'navigate') {\n    event.respondWith(networkFirst(event.request));\n    return;\n  }\n\n  if (url.origin === self.location.origin) {\n    event.respondWith(staleWhileRevalidate(event.request, SHELL_CACHE));\n    return;\n  }\n\n  if (url.hostname === 'esm.sh') {\n    event.respondWith(staleWhileRevalidate(event.request, RUNTIME_CACHE));\n  }\n});\n`,
);

const indexHtml = join(dist, 'index.html');
if (existsSync(indexHtml)) {
  const hydratedIndexHtml = readFileSync(indexHtml, 'utf8')
    .replaceAll('__GPA_DEFAULT_API_URL_VALUE__', defaultApiUrl)
    .replaceAll('__GPA_BUILD_VERSION_VALUE__', cacheVersion);
  writeFileSync(indexHtml, hydratedIndexHtml);
  writeFileSync(join(dist, '404.html'), hydratedIndexHtml);
}

console.log(`Built static client at ${dist}`);
