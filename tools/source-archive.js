// Export only known source roots; never include profiles, dependencies or builds.
import { mkdir, mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(await readFile(join(root,'package.json')));
const temp = await mkdtemp(join(tmpdir(), 'lunacrust-source-'));
const name = `Lunacrust-${version}-source`;
const dest = join(temp,name);
const entries = ['app','electron','build','tools','tests','docs','.github','.gitignore','package.json','package-lock.json','README.md','CONTRIBUTING.md','PRODUCT.md','DESIGN.md','LICENSE','THIRD_PARTY_NOTICES.md'];
try {
  await mkdir(dest);
  for (const entry of entries) await cp(join(root,entry), join(dest,entry), { recursive:true,
    filter:path => !['.DS_Store','progress.md'].includes(basename(path)) && !/\.mp3$/i.test(path) });
  await mkdir(join(root,'dist'), { recursive:true });
  const result = spawnSync('tar', ['-czf', join(root,'dist',`${name}.tar.gz`), '-C', temp, name], {stdio:'inherit',env:{...process.env,COPYFILE_DISABLE:'1'}});
  if (result.status !== 0) throw new Error('Source archive failed (tar must be available)');
  console.log(join(root,'dist',`${name}.tar.gz`));
} finally { await rm(temp,{recursive:true,force:true}); }
