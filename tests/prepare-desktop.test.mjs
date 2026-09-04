import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../tools/prepare-desktop.js', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'lunacrust-prepare-test-'));
const executable = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
  : process.platform === 'win32' ? 'electron.exe' : 'electron';
const framework = 'Electron.app/Contents/Frameworks/Electron Framework.framework';

async function fixture(name, installer) {
  const dir = join(root, name);
  await mkdir(join(dir, 'tools'), { recursive: true });
  await mkdir(join(dir, 'node_modules/electron'), { recursive: true });
  await copyFile(source, join(dir, 'tools/prepare-desktop.js'));
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await writeFile(join(dir, 'node_modules/electron/package.json'), '{"name":"electron","version":"44.2.0"}');
  await writeFile(join(dir, 'node_modules/electron/install.js'), installer);
  return dir;
}

function run(dir) {
  return spawnSync(process.execPath, [join(dir, 'tools/prepare-desktop.js')], {
    cwd: dir, encoding: 'utf8', timeout: 10_000,
  });
}

// Like Electron 44's npm package, the fixture has no runtime before install.js runs.
const installRuntime = `
const fs = require('node:fs');
const path = require('node:path');
const executable = path.join(__dirname, 'dist', ${JSON.stringify(executable)});
fs.mkdirSync(path.dirname(executable), { recursive: true });
if (!fs.existsSync(executable)) fs.writeFileSync(executable, 'runtime');
fs.writeFileSync(path.join(__dirname, 'path.txt'), ${JSON.stringify(executable)});
`;
const installFramework = `
const framework = path.join(__dirname, 'dist', ${JSON.stringify(framework)});
fs.mkdirSync(path.join(framework, 'Versions/A'), { recursive: true });
fs.writeFileSync(path.join(framework, 'Versions/A/Electron Framework'), 'framework');
if (!fs.existsSync(path.join(framework, 'Versions/Current')))
  fs.symlinkSync('A', path.join(framework, 'Versions/Current'));
`;

try {
  const cold = await fixture('cold', installRuntime + (process.platform === 'darwin' ? installFramework : ''));
  const first = run(cold);
  assert.equal(first.status, 0, `cold installation must install Electron first:\n${first.stderr}`);
  const binary = join(cold, 'node_modules/electron/dist', executable);
  assert.equal(await readFile(binary, 'utf8'), 'runtime');
  const originalInode = (await stat(binary)).ino;
  const repeated = run(cold);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal((await stat(binary)).ino, originalInode, 'a valid runtime must not be replaced');
  if (process.platform === 'darwin') {
    const link = join(cold, 'node_modules/electron/dist', framework, 'Electron Framework');
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readFile(link, 'utf8'), 'framework', 'restored link must resolve to the actual binary');
  }

  const failed = run(await fixture('installer-failure', "console.error('fixture download failed'); process.exit(23);"));
  assert.notEqual(failed.status, 0, 'installer failure must fail postinstall');
  assert.match(failed.stderr, /fixture download failed/, 'original installer diagnostics must remain visible');

  const absent = run(await fixture('installer-without-runtime', ''));
  assert.notEqual(absent.status, 0, 'installer success without a runtime must still fail');

  if (process.platform === 'darwin') {
    const incomplete = run(await fixture('missing-framework', installRuntime));
    assert.notEqual(incomplete.status, 0, 'missing framework data must fail instead of creating a dangling link');
    const broken = run(await fixture('dangling-framework', installRuntime + installFramework + `
fs.symlinkSync('Versions/Missing/Electron Framework', path.join(framework, 'Electron Framework'));
`));
    assert.notEqual(broken.status, 0, 'an existing dangling framework link must fail validation');
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('desktop cold installation, idempotence and failure transparency passed');
