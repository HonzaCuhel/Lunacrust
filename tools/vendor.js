// Copies the ESM build of three.js out of node_modules into app/vendor/ so the
// renderer can import it over the app:// protocol without shipping node_modules.
import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'node_modules', 'three', 'build');
const dest = join(root, 'app', 'vendor');

if (!existsSync(src)) {
  throw new Error('three.js is missing; run npm ci before building.');
}
await mkdir(dest, { recursive: true });
await cp(join(root, 'node_modules', 'three', 'LICENSE'), join(dest, 'LICENSE'));
for (const f of await readdir(src)) {
  if (f === 'three.module.js' || f === 'three.core.js') {
    await cp(join(src, f), join(dest, f));
    console.log('[vendor] ->', f);
  }
}
