import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dist = join(root, 'dist');
const port = Number(process.env.PORT || 8080);

let buildProcess = null;
let pending = false;

const build = () => {
  if (buildProcess) {
    pending = true;
    return;
  }

  buildProcess = spawn('node', [join(__dirname, 'build.mjs')], { cwd: root, stdio: 'inherit' });
  buildProcess.on('exit', () => {
    buildProcess = null;
    if (pending) {
      pending = false;
      build();
    }
  });
};

build();

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = normalize(requestPath).replace(/^\.\.(\/|\\|$)+/, '');
  let filePath = join(dist, safePath);
  if (!existsSync(filePath) || (existsSync(filePath) && statSync(filePath).isDirectory())) {
    filePath = join(dist, 'index.html');
  }

  try {
    const body = readFileSync(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypes[extname(filePath)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
});

for (const watched of [join(root, 'src'), join(root, 'public')]) {
  watch(watched, { recursive: true }, () => build());
}

server.listen(port, () => {
  console.log(`Client dev server running at http://127.0.0.1:${port}`);
});
