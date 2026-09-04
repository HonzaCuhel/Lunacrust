import { join, relative, isAbsolute } from 'node:path';

// Keep the original private origin stable across the application rename.
export const APP_URL = 'app://space/index.html';
const trustedContents = new WeakSet();
export function trustWebContents(contents) { trustedContents.add(contents); }
export function isAppDocument(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'app:' && url.hostname === 'space' && !url.port &&
      !url.username && !url.password && url.pathname === '/index.html' && !url.search;
  } catch { return false; }
}
export function isTrustedSender(event) {
  try {
    return trustedContents.has(event.sender) && !event.sender.isDestroyed() &&
      event.senderFrame === event.sender.mainFrame && isAppDocument(event.senderFrame.url);
  } catch { return false; }
}
export function assertTrustedSender(event) {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
}
export function resolveAsset(root, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'app:' || url.hostname !== 'space' || url.port || url.username || url.password) return null;
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(p => p === '..')) return null;
    const file = join(root, decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, ''));
    const rel = relative(root, file);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? file : null;
  } catch { return null; }
}
