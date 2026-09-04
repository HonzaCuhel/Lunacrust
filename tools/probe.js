// Real Electron mechanics/screenshot probe; every run gets an empty profile.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const profile = await mkdtemp(join(tmpdir(), 'lunacrust-probe-'));
const mode = process.argv[2] ?? 'mechanics';
const env = { ...process.env, LUNACRUST_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SPACEMC_PROBE;
delete env.SPACEMC_SMOKE;
if (mode === 'smoke') {
  env.SPACEMC_SMOKE = resolve(process.argv[3] ?? 'dist/smoke.png');
  await mkdir(dirname(env.SPACEMC_SMOKE), {recursive:true});
} else env.SPACEMC_PROBE = mode === 'survival' ? 'survival' : '1';
const child = spawn(createRequire(import.meta.url)('electron'), [root], { cwd:root, env, stdio:'inherit' });
const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
const stop = () => child.kill('SIGTERM');
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} finally {
  clearTimeout(timer);
  await rm(profile, { recursive:true, force:true });
}
