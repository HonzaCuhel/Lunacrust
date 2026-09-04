import { constants } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, rename, rm, copyFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_SAVE_BYTES = 32 * 1024 * 1024;
export function saveId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(value)) throw new Error('Invalid world ID');
  return value;
}
// Copy validated saves, never move or overwrite existing Lunacrust data.
export async function migrateLegacySaves(legacyDir, saveDir) {
  const marker = join(saveDir, '.legacy-migration-v1');
  try { await readFile(marker); return 0; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let entries;
  try { entries = await readdir(legacyDir, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  await mkdir(saveDir, { recursive: true });
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-z0-9_-]{1,64}(\.bak)?\.json$/i.test(entry.name)) continue;
    const from = join(legacyDir, entry.name), to = join(saveDir, entry.name);
    try {
      const stat = await lstat(from);
      if (!stat.isFile() || stat.size > MAX_SAVE_BYTES) continue;
      JSON.parse(await readFile(from, 'utf8'));
      await copyFile(from, to, constants.COPYFILE_EXCL);
      copied++;
    } catch (e) {
      if (e.code === 'EEXIST' || e.code === 'ENOENT' || e instanceof SyntaxError) continue;
      throw e;
    }
  }
  await writeFile(marker, 'Legacy saves copied; originals retained.\n', { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  return copied;
}
export function createSaveStore(dir) {
  const pending = new Map();
  const serial = (id, operation) => {
    const next = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    pending.set(id, next);
    next.finally(() => { if (pending.get(id) === next) pending.delete(id); }).catch(() => {});
    return next;
  };
  return {
    write(id, payload) {
      id = saveId(id);
      const body = JSON.stringify(payload);
      if (!body || typeof payload !== 'object' || payload === null || Array.isArray(payload) || Buffer.byteLength(body) > MAX_SAVE_BYTES) throw new Error('Invalid or oversized world save');
      return serial(id, async () => {
        await mkdir(dir, { recursive: true });
        const target = join(dir, `${id}.json`), tmp = join(dir, `${id}.${randomUUID()}.tmp`);
        try {
          await writeFile(tmp, body, { encoding: 'utf8', flag: 'wx' });
          try {
            const previous = await readFile(target, 'utf8');
            JSON.parse(previous);
            await writeFile(join(dir, `${id}.bak.json`), previous, 'utf8');
          } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
          await rename(tmp, target);
          return true;
        } finally { await rm(tmp, { force: true }); }
      });
    },
    async read(id) {
      id = saveId(id);
      await pending.get(id)?.catch(() => {});
      for (const file of [`${id}.json`, `${id}.bak.json`]) {
        try { return JSON.parse(await readFile(join(dir, file), 'utf8')); }
        catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
      }
      return null;
    },
    async list() {
      try { return (await readdir(dir)).filter(f => /^[a-z0-9_-]{1,64}\.json$/i.test(f)).map(f => f.slice(0, -5)); }
      catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    },
    delete(id) {
      id = saveId(id);
      return serial(id, async () => {
        await Promise.all([`${id}.json`, `${id}.bak.json`].map(f => rm(join(dir, f), { force: true })));
        return true;
      });
    },
    async flush() { await Promise.allSettled([...pending.values()]); },
  };
}
