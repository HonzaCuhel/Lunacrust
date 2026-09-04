// Preload runs with contextIsolation on: the renderer only ever sees this tiny,
// explicitly-shaped API surface, never Node itself.
const { contextBridge, ipcRenderer } = require('electron');

/** Subscribe helper: hands the renderer an unsubscribe function, never the event. */
const sub = (channel, cb) => {
  if (typeof cb !== 'function') throw new TypeError('Expected an event callback');
  const handler = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('spaceAPI', {
  isDesktop: true,
  platform: process.platform,

  onBeforeClose: (cb) => {
    const unsubscribe = sub('app:before-close', cb);
    ipcRenderer.send('app:close-ready');
    return unsubscribe;
  },
  confirmClose: (ok) => ipcRenderer.invoke('app:confirm-close', ok === true),

  // LAN co-op. Sockets live in the main process; this is the whole surface the
  // renderer is allowed to reach them through.
  net: {
    host: (o) => ipcRenderer.invoke('net:host', o),
    unhost: (o) => ipcRenderer.invoke('net:unhost', o ?? {}),
    join: (o) => ipcRenderer.invoke('net:join', o),
    leave: () => ipcRenderer.invoke('net:leave'),
    discover: (on) => ipcRenderer.invoke('net:discover', !!on),
    info: () => ipcRenderer.invoke('net:info'),
    kick: (id, reason) => ipcRenderer.invoke('net:kick', id, reason),
    send: (to, msg) => ipcRenderer.send('net:send', to, msg),
    beacon: (record) => ipcRenderer.send('net:beacon', record),
    onMessage: (cb) => sub('net:message', cb),
    onPeer: (cb) => sub('net:peer', cb),
    onLobbies: (cb) => sub('net:lobbies', cb),
  },
  saveWorld: (id, payload) => ipcRenderer.invoke('save:write', id, payload),
  loadWorld: (id) => ipcRenderer.invoke('save:read', id),
  listWorlds: () => ipcRenderer.invoke('save:list'),
  deleteWorld: (id) => ipcRenderer.invoke('save:delete', id),
});
