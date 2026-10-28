// Single-file build.
//   node tools/build.mjs [--out=<dir>]   (default dist/)
// → dist/index.html   standalone page (open from disk or host anywhere; no server needed)
// The engine worker is bundled separately and handed to the app as a Blob URL through
// globalThis.__AM_WORKER_URL__, so the output is one self-contained file. GitHub Pages
// deploys dist/ through .github/workflows/pages.yml.
//
// Optional: --embed-adapter=<file> [--embed-head=<file>] also writes dist/embed.html, the
// same app as an HTML fragment for a host that wraps pages in its own <!doctype>/<head>/
// <body>. The adapter (bundled as an IIFE) runs before the app and must assign
// globalThis.__AM_HOST__ (see src/export/save.js); the head file, if given, adds extra
// <meta> tags at the top of the fragment. Without the flag no embed.html is left behind.
import { build, transform } from 'esbuild';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const outArg = process.argv.find((a) => a.startsWith('--out='));
const embedAdapter = arg('embed-adapter');
const embedHead = arg('embed-head');
const dist = outArg ? resolve(outArg.slice(6)) : join(root, 'dist');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

// Inline <script> content must never contain a closing script tag or an HTML comment
// opener (both switch the HTML tokenizer out of script data). In minified output they can
// only occur inside string/regex literals, where the escaped forms are equivalent.
const safeScript = (code) => code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '\\x3C!--');

async function bundle(entry, extra = {}) {
  const res = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: 'iife',
    target: ['chrome100', 'safari15', 'firefox100'],
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
    // client.js only reaches `new URL('./worker.js', import.meta.url)` when no bundled
    // worker URL is present, which never happens in this build.
    logOverride: { 'empty-import-meta': 'silent' },
    ...extra,
  });
  return res.outputFiles[0].text;
}

const workerCode = await bundle('src/engine/worker.js');
const bootstrap =
  `(function(){try{globalThis.__AM_WORKER_URL__=URL.createObjectURL(new Blob([${JSON.stringify(workerCode)}],{type:'text/javascript'}));}catch(e){}})();` +
  `globalThis.__AM_VERSION__=${JSON.stringify(pkg.version)};`;
const appCode = await bundle('src/main.js', { banner: { js: bootstrap } });

const css = (await transform(await readFile(join(root, 'src/ui/styles.css'), 'utf8'), { loader: 'css', minify: true })).code;

const html = await readFile(join(root, 'index.html'), 'utf8');
const pick = (re) => (html.match(re) || [])[0] || '';
const title = pick(/<title>[\s\S]*?<\/title>/i) || '<title>AudioMaster</title>';
const metas = (html.match(/<meta\s+name="(?:description|theme-color)"[^>]*>/gi) || []).join('\n');
const fontLinks = (html.match(/<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>/gi) || []).join('\n');
let body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, ''])[1];
// Drop dev-only scripts and stylesheet links; the bundle replaces them.
body = body.replace(/<script\b[^>]*\bsrc=["'][^"']*["'][^>]*>\s*<\/script>/gi, '').trim();
const bodyAttrs = (html.match(/<body([^>]*)>/i) || [, ''])[1];

const styleTag = `<style>${css}</style>`;
const scriptTag = `<script>${safeScript(appCode)}</script>`;

const standalone = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${title}
${metas}
${fontLinks}
${styleTag}
</head>
<body${bodyAttrs}>
${body}
${scriptTag}
</body>
</html>
`;

await mkdir(dist, { recursive: true });
// A failed or skipped embed build never leaves the fragment of an older build behind.
await rm(join(dist, 'embed.html'), { force: true });
await writeFile(join(dist, 'index.html'), standalone);
const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0) + ' KB';
const shown = outArg ? dist : 'dist';
let line = `${shown}/index.html ${kb(standalone)} · worker ${kb(workerCode)}`;

if (embedAdapter) {
  // Bundled as an IIFE: imports are inlined (or the build fails), and an adapter that does
  // not assign globalThis.__AM_HOST__ is a build error, not a silent page without a host.
  const res = await build({ entryPoints: [resolve(embedAdapter)], bundle: true, format: 'iife', platform: 'browser', target: 'es2019', minify: true, write: false, logLevel: 'warning' });
  const adapter = res.outputFiles[0].text;
  if (!/__AM_HOST__/.test(adapter)) throw new Error(`${embedAdapter} must assign globalThis.__AM_HOST__`);
  const hostHead = embedHead ? (await readFile(resolve(embedHead), 'utf8')).trim() + '\n' : '';
  // Fragment: title + meta first (hosts often scan only the first few KB), then styles,
  // markup, the adapter and the app.
  const embed = `${title}
${hostHead}${metas}
${fontLinks}
${styleTag}
${body}
<script>${safeScript(adapter)}</script>
${scriptTag}
`;
  await writeFile(join(dist, 'embed.html'), embed);
  line += ` · ${shown}/embed.html ${kb(embed)}`;
}
console.log(line);
