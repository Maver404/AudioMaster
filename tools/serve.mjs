// Tiny static dev server (ES modules and workers need http://, not file://).
// Usage: node tools/serve.mjs [port] [--host=<address>]   → http://localhost:5173
//        npm run dev -- --host=0.0.0.0
//
// Listens on 127.0.0.1 only. To try the app on a phone on the same Wi-Fi, opt in with
// --host=0.0.0.0 (the repo, minus dot-paths, is then readable from the LAN). A flag, not
// the HOST variable, which some shells export with the machine's name.
// Never served: any path segment starting with '.' (.git/, .env, editor settings, local test files,
// .env…), anything outside the repo (traversal, symlinks pointing out), methods other than
// GET/HEAD, and — while bound to loopback — requests whose Host is not a loopback name
// (DNS rebinding: a web page cannot read the repo through a name it controls).
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.md': 'text/markdown; charset=utf-8',
};

const isInside = (root, file) => {
  const rel = relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Map a request path to a file under `root`, or null when it must not be served: bad
 * percent-encoding, NUL bytes, any segment starting with '.' (dotfiles, dot-directories,
 * '.' and '..'), or a result outside `root`. Pure (no file system access); directories
 * are resolved to index.html by the caller.
 * @param {string} root absolute repo directory
 * @param {string} urlPath request path, e.g. '/src/main.js' (query/hash allowed)
 * @returns {string|null} absolute file path
 */
export function resolveRequestPath(root, urlPath) {
  let pathname;
  try {
    // Not new URL(): it would read '//x/…' as a host and fold '..' before we can refuse it.
    pathname = decodeURIComponent(String(urlPath).split(/[?#]/)[0]);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  // Split on both separators: a '\' must not smuggle '..' past the check on Windows.
  const segments = pathname.split(/[/\\]+/).filter(Boolean);
  if (segments.some((s) => s.startsWith('.') || s.includes(':'))) return null;
  const file = join(root, ...segments);
  return isInside(root, file) ? file : null;
}

/** Is a Host header a loopback name (localhost, *.localhost, 127.x, [::1])? */
export function isLoopbackHost(hostHeader) {
  const h = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(h) || h === '[::1]';
}

const isLoopbackBind = (host) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

/**
 * Start the server.
 * @param {{ root?: string, port?: number, host?: string }} [opts]
 * @returns {import('node:http').Server}
 */
export function startServer({ root = ROOT, port = 5173, host = '127.0.0.1' } = {}) {
  const loopback = isLoopbackBind(host);
  let realRoot = null;
  const send = (res, code, text) => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(text);
  };
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (loopback && !isLoopbackHost(req.headers.host)) return send(res, 403, 'Forbidden');
    try {
      let file = resolveRequestPath(root, req.url);
      if (!file) return send(res, 404, 'Not found');
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      // Symlinks must not lead out of the repo either.
      realRoot ??= await realpath(root);
      const real = await realpath(file);
      if (!isInside(realRoot, real) || relative(realRoot, real).split(sep).some((s) => s.startsWith('.'))) return send(res, 404, 'Not found');
      const body = await readFile(real);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(real).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      send(res, 404, 'Not found');
    }
  });
  server.listen(port, host, () => {
    const shown = loopback ? 'localhost' : host;
    console.log(`AudioMaster dev server → http://${shown}:${port}${loopback ? '' : '  (reachable from your network)'}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const hostArg = args.find((a) => a.startsWith('--host='));
  const portArg = args.find((a) => /^\d+$/.test(a));
  startServer({ port: Number(portArg || process.env.PORT || 5173), host: hostArg ? hostArg.slice(7) || '127.0.0.1' : '127.0.0.1' });
}
