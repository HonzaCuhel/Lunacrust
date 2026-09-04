// Verify native window-close persistence and refusal after a renderer save error.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const profile=await mkdtemp(join(tmpdir(),'lunacrust-close-'));
const env={...process.env,LUNACRUST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app=await electron.launch({args:['.'],env,chromiumSandbox:true});
  const page=await app.firstWindow();
  await page.waitForFunction(()=>window.__space?.game);
  await page.evaluate(()=>{
    const S=window.__space;S.game.hooks.onPointerLost=()=>{};
    S.state.mode='survival';S.selectPlanet('mars');document.getElementById('btn-land').click();
  });
  await page.waitForFunction(()=>window.__space.game.spawned,{},{timeout:60000});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
  await page.waitForEvent('close',{timeout:15000});
  const save=JSON.parse(await readFile(join(profile,'saves','mars.json'),'utf8'));
  assert.equal(save.planetId,'mars');
  console.log('PASS native close waits for a durable world save');
  await app.close();app=null;
  app=await electron.launch({args:['.'],env,chromiumSandbox:true});
  const retry=await app.firstWindow();
  await retry.waitForFunction(()=>window.__space?.game);
  // Inject a failing host snapshot at the application boundary, not a fake IPC.
  await retry.evaluate(()=>{
    const S=window.__space;S.game.hooks.onPointerLost=()=>{};
    S.state.mode='survival';S.selectPlanet('mars');document.getElementById('btn-continue').click();
  });
  await retry.waitForFunction(()=>window.__space.game.spawned,{},{timeout:60000});
  await retry.evaluate(()=>{window.__space.game.snapshot=()=>{throw new Error('Simulated snapshot failure');};});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
  await retry.waitForTimeout(500);
  assert.equal(retry.isClosed(),false);
  console.log('PASS renderer refusal retains the native window');
}finally{
  if(app){app.process().kill('SIGKILL');await new Promise(resolve=>setTimeout(resolve,300));}
  await rm(profile,{recursive:true,force:true});
}
