// Native packaging by default; --cross explicitly enables a cross-build. No implicit publication, signing or application install.
import { build, Platform, Arch } from 'electron-builder';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { verifyPackageSource } from './verify-package-source.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const kind = process.argv[2] ?? ({darwin:'mac',linux:'linux',win32:'win'}[process.platform]);
const platform = {mac:Platform.MAC,linux:Platform.LINUX,win:Platform.WINDOWS}[kind];
if (!platform) throw new Error('Usage: npm run dist -- mac|linux|win [--arm64|--x64]');
if ({mac:'darwin',linux:'linux',win:'win32'}[kind] !== process.platform && !process.argv.includes('--cross')) throw new Error(`Build ${kind} on its native OS, or pass --cross to generate an artifact that still needs native verification.`);
for (const tool of ['vendor.js', 'make-icon.js']) {
  const result = spawnSync(process.execPath, [join(root, 'tools', tool)], { cwd:root, stdio:'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const signed = process.env.LUNACRUST_SIGN === '1';
if (!signed) {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  for (const name of ['CSC_LINK','CSC_KEY_PASSWORD','WIN_CSC_LINK','WIN_CSC_KEY_PASSWORD']) delete process.env[name];
}
const architectures = process.argv.includes('--arm64') ? [Arch.arm64] : process.argv.includes('--x64') ? [Arch.x64] : kind === 'mac' ? [Arch.arm64,Arch.x64] : [Arch.x64];
const suffix = signed ? '' : kind === 'linux' ? '' : '-unsigned';
const config = { artifactName:'${productName}-${version}-${os}-${arch}' + suffix + '.${ext}', publish:null };
if (kind === 'mac') config.mac = signed ? { notarize:true } : { identity:null, notarize:false };
if (kind === 'win' || kind === 'mac') config.forceCodeSigning = signed;
// ASAR records file offsets before streaming data. Building directly from an
// edited checkout can corrupt those offsets if a source file changes size.
// Freeze a private input snapshot and fail freshness verification if the
// checkout subsequently changes; never publish a mixed-version application.
const snapshot = await realpath(await mkdtemp(join(tmpdir(), 'lunacrust-build-')));
const callerCwd=process.cwd();
try {
  for (const entry of ['app','electron','build','tools','package.json','package-lock.json','LICENSE','THIRD_PARTY_NOTICES.md']) {
    await cp(join(root,entry), join(snapshot,entry), {recursive:true});
  }
  await symlink(join(root,'node_modules'), join(snapshot,'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  config.directories = {output:join(root,'dist')};
  process.chdir(snapshot);
  const outputs = await build({ projectDir:snapshot, targets:platform.createTarget(kind === 'mac' ? ['dmg','zip'] : kind === 'linux' ? ['AppImage','deb'] : ['nsis'], ...architectures), config, publish:'never' });
  for(const arch of architectures) {
    const folder=kind === 'mac' ? join(root,'dist',arch === Arch.arm64 ? 'mac-arm64' : 'mac','Lunacrust.app') : join(root,'dist',kind === 'linux' ? 'linux-unpacked' : 'win-unpacked');
    await verifyPackageSource(folder);
  }
  for (const file of outputs) console.log(file);
} finally {
  process.chdir(callerCwd);
  // Unlink the dependency junction explicitly before removing our own snapshot.
  await rm(join(snapshot,'node_modules'),{force:true});
  await rm(snapshot,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
