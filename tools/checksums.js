import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
const dir = resolve(process.argv[2] ?? 'dist');
const files = (await readdir(dir)).filter(f => /^Lunacrust-/.test(f) && /\.(dmg|zip|exe|AppImage|deb|tar\.gz)$/.test(f)).sort();
if (!files.length) throw new Error(`No Lunacrust release artifacts in ${dir}`);
const lines = [];
for (const file of files) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(dir, file))) hash.update(chunk);
  lines.push(`${hash.digest('hex')}  ${file}`);
}
await writeFile(join(dir, 'SHA256SUMS.txt'), lines.join('\n')+'\n');
console.log(lines.join('\n'));
