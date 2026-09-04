import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAsset, isAppDocument, trustWebContents, isTrustedSender, assertTrustedSender } from '../electron/security.js';
import { createSaveStore, migrateLegacySaves, saveId } from '../electron/saves.js';
const root=join(tmpdir(),'lunacrust-assets');
assert.equal(resolveAsset(root,'app://space/index.html'),join(root,'index.html'));
for(const url of ['app://evil/index.html','https://space/index.html','app://space/%2e%2e%2fsecret','app://space/%5c..%5csecret','app://space/%00','app://space/%zz','app://user@space/index.html']) assert.equal(resolveAsset(root,url),null,url);
assert.equal(isAppDocument('app://space/index.html#menu'),true);
assert.equal(isAppDocument('app://space/other.html'),false);
const sender={isDestroyed:()=>false,mainFrame:{url:'app://space/index.html'}};
trustWebContents(sender);
const event={sender,senderFrame:sender.mainFrame};
assert.equal(isTrustedSender(event),true);
assert.throws(()=>assertTrustedSender({...event,senderFrame:{url:'app://space/index.html'}}));
assert.equal(isTrustedSender({sender:{...sender},senderFrame:sender.mainFrame}),false);
for(const id of ['../mars','',undefined,{},'a'.repeat(65)]) assert.throws(()=>saveId(id));
const dir=await mkdtemp(join(tmpdir(),'lunacrust-storage-test-'));
try{
 const legacy=join(dir,'legacy'),current=join(dir,'current');
 await mkdir(legacy);await mkdir(current);
 await writeFile(join(legacy,'mars.json'),'{"legacy":true}');
 await writeFile(join(legacy,'earth.json'),'{"legacy":true}');
 await writeFile(join(legacy,'broken.json'),'{');
 await writeFile(join(current,'earth.json'),'{"newer":true}');
 // Windows unprivileged accounts may not permit symlink creation.
 try {await symlink(join(legacy,'mars.json'),join(legacy,'escape.json'));}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;}
 assert.equal(await migrateLegacySaves(legacy,current),1);
 assert.deepEqual(JSON.parse(await readFile(join(current,'earth.json'))),{newer:true});
 assert.equal(await readFile(join(legacy,'mars.json'),'utf8'),'{"legacy":true}');
 const store=createSaveStore(current);
 await Promise.all([store.write('mars',{n:1}),store.write('mars',{n:2}),store.write('mars',{n:3})]);
 assert.deepEqual(await store.read('mars'),{n:3});
 assert.deepEqual(JSON.parse(await readFile(join(current,'mars.bak.json'))),{n:2});
 await writeFile(join(current,'mars.json'),'{');
 assert.deepEqual(await store.read('mars'),{n:2});
 await store.delete('mars');assert.equal(await store.read('mars'),null);
 assert.equal(await migrateLegacySaves(legacy,current),0,'migration must not resurrect deleted worlds');
 assert.equal(await store.read('mars'),null);
 assert.throws(()=>store.write('mars','bad payload'));
 await store.flush();
}finally{await rm(dir,{recursive:true,force:true});}
console.log('desktop protocol, IPC sender, migration, atomic saves and backup deletion passed');
