// A partially extracted macOS Electron archive can omit this framework link
// while retaining the actual binary. Restore only the known in-package link.
import { lstat, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
if (process.platform === 'darwin') {
  const electronDir=dirname(createRequire(import.meta.url).resolve('electron/package.json'));
  const framework=join(electronDir,'dist','Electron.app','Contents','Frameworks','Electron Framework.framework');
  const target=join(framework,'Electron Framework');
  try { await lstat(target); }
  catch(e) {
    if(e.code!=='ENOENT') throw e;
    const binary=await lstat(join(framework,'Versions','A','Electron Framework'));
    if(!binary.isFile()) throw new Error('Electron framework binary is missing; reinstall dependencies');
    await symlink('Versions/Current/Electron Framework',target);
    console.log('[desktop] restored the Electron framework link');
  }
}
