import { lstat, readFile, stat, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Electron 44 downloads its runtime on first use, not during npm installation.
// Install the pinned package's binary before inspecting it or packaging notices.
const electronDir=dirname(createRequire(import.meta.url).resolve('electron/package.json'));
const installation=spawnSync(process.execPath,[join(electronDir,'install.js')],{stdio:'inherit'});
if(installation.error) throw installation.error;
if(installation.status!==0) {
  throw new Error(`Electron installation failed (${installation.signal ?? `exit ${installation.status}`})`);
}
const executable=join(electronDir,'dist',await readFile(join(electronDir,'path.txt'),'utf8'));
if(!(await stat(executable)).isFile()) throw new Error('Electron executable is missing; reinstall dependencies');

// A partially extracted macOS archive can omit this framework link while
// retaining the actual binary. Restore only the known, resolving package link.
if (process.platform === 'darwin') {
  const framework=join(electronDir,'dist','Electron.app','Contents','Frameworks','Electron Framework.framework');
  const target=join(framework,'Electron Framework');
  try { await lstat(target); }
  catch(e) {
    if(e.code!=='ENOENT') throw e;
    const binary=await stat(join(framework,'Versions','Current','Electron Framework'));
    if(!binary.isFile()) throw new Error('Electron framework binary is missing; reinstall dependencies');
    await symlink('Versions/Current/Electron Framework',target);
    console.log('[desktop] restored the Electron framework link');
  }
  if(!(await stat(target)).isFile()) throw new Error('Electron framework binary is missing; reinstall dependencies');
}
