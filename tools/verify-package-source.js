// Compare every shipped application source/asset byte with the current checkout.
// A successful boot alone cannot detect a stale but otherwise working package.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
export async function verifyPackageSource(target) {
  target=resolve(target);
  if((await stat(target)).isFile()) target=dirname(target);
  const resources=target.endsWith('.app')?join(target,'Contents','Resources'):join(target,'resources');
  const archive=join(resources,'app.asar');
  const mismatches=[];let checked=0;
  const currentPackage=JSON.parse(await readFile(join(root,'package.json')));
  const builtPackage=JSON.parse(extractFile(archive,'package.json'));
  for(const key of ['name','version','description','homepage','license','main','type','desktopName']) {
    if(currentPackage[key]!==builtPackage[key]) mismatches.push(`package.json:${key}`);
  }
  if(!target.endsWith('.app')) {
    const componentNotices=await readFile(join(target,'LICENSES.chromium.html'));
    if(!componentNotices.equals(await readFile(join(resources,'licenses','LICENSES.chromium.html')))) mismatches.push('platform-specific Chromium notices');
  }
  async function walk(dir){
    for(const entry of await readdir(dir,{withFileTypes:true})){
      const path=join(dir,entry.name),rel=relative(root,path).replaceAll('\\','/');
      if(entry.name==='.DS_Store'||/\.mp3$/i.test(rel)||/^electron\/(probe[^/]*|smoke)\.js$/.test(rel))continue;
      if(entry.isDirectory()){await walk(path);continue;}
      if(!entry.isFile())throw new Error(`Unexpected source symlink: ${rel}`);
      const current=await readFile(path);
      try{if(!current.equals(extractFile(archive,rel)))mismatches.push(rel);}
      catch{mismatches.push(`${rel} (missing)`);}
      checked++;
    }
  }
  await walk(join(root,'app'));await walk(join(root,'electron'));
  for(const file of ['LICENSE','THIRD_PARTY_NOTICES.md']){
    if(!(await readFile(join(root,file))).equals(await readFile(join(resources,'licenses',file))))mismatches.push(file);
    checked++;
  }
  if(mismatches.length)throw new Error(`Stale package ${target}:\n${mismatches.join('\n')}`);
  console.log(`PASS ${checked} packaged source/assets match the checkout: ${target}`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.argv[2])throw new Error('Usage: node tools/verify-package-source.js <app bundle or unpacked directory>');
  await verifyPackageSource(process.argv[2]);
}
