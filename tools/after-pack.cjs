// Keep the platform-specific Electron/Chromium notices with the packaged app.
// Cross-builds must not substitute the build host's component license list.
const {copyFile}=require('node:fs/promises');
const {join}=require('node:path');
module.exports=async context=>{
  if(context.electronPlatformName==='darwin')return;
  const dest=join(context.appOutDir,'resources','licenses');
  await copyFile(join(context.appOutDir,'LICENSES.chromium.html'),join(dest,'LICENSES.chromium.html'));
  await copyFile(join(context.appOutDir,'LICENSE.electron.txt'),join(dest,'electron-LICENSE'));
};
