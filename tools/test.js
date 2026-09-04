// Runs every tests/*.test.mjs in sequence and reports a summary. No framework:
// each test file is a plain node script that throws on failure.
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = join(root, 'tests');

const run = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(dir, file)], { cwd: root });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('exit', (code) => resolve({ file, code: code ?? 1, out: out.trim() }));
});

const files = (await readdir(dir)).filter((f) => f.endsWith('.test.mjs')).sort();
if (!files.length) { console.log('no tests found'); process.exit(0); }

let failed = 0;
for (const f of files) {
  const r = await run(f);
  const tag = r.code === 0 ? 'PASS' : 'FAIL';
  if (r.code !== 0) failed++;
  const last = r.out.split('\n').filter(Boolean).slice(-1)[0] ?? '';
  console.log(`${tag}  ${f.padEnd(26)} ${last.slice(0, 90)}`);
  if (r.code !== 0) console.log(r.out.split('\n').slice(-25).join('\n'));
}
console.log(failed ? `\n${failed}/${files.length} test files failed` : `\nall ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
