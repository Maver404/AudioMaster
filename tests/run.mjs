// Zero-dependency test runner.
// Usage: node tests/run.mjs [substring filter for file or test name]
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';

const files = (await readdir(here)).filter((f) => f.endsWith('.test.mjs')).sort();
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
// A test awaiting a promise that never settles empties the event loop and Node would exit
// quietly with status 0, as if everything had passed: report it as a failure instead.
let current = '';
process.on('exit', (code) => {
  // 0 / 13 (unsettled top-level await): the loop drained in a test. Other codes have their own message.
  if (current && (code === 0 || code === 13)) {
    console.log(`\n  ✗ ${current}\n      never finished (a promise that never settles?)`);
    process.exitCode = 1;
  }
});

for (const file of files) {
  const mod = await import(pathToFileURL(join(here, file)).href);
  const tests = mod.tests || {};
  const names = Object.keys(tests).filter((n) => !filter || file.includes(filter) || n.includes(filter));
  if (!names.length) continue;
  console.log(`\n${file}`);
  for (const name of names) {
    const t0 = performance.now();
    current = `${file}: ${name}`;
    try {
      const out = await tests[name]();
      const ms = (performance.now() - t0).toFixed(0);
      if (out === 'skip') {
        skipped++;
        console.log(`  - ${name} (skipped)`);
      } else {
        passed++;
        console.log(`  ✓ ${name} (${ms} ms)${typeof out === 'string' ? ' — ' + out : ''}`);
      }
    } catch (err) {
      failed++;
      failures.push({ file, name, err });
      console.log(`  ✗ ${name}\n      ${String(err && err.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
    } finally {
      current = '';
    }
  }
}

current = '';
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
