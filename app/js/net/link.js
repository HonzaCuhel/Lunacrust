// The bridge between NetSession (game logic, renderer) and the sockets that
// live in the main process. Everything crosses as plain JSON over the four
// channels preload.cjs exposes; nothing here knows what a message means.

/**
 * @param {(from:number, msg:object)=>void} onMessage
 * @param {(ev:{kind:string,id:number,reason?:string})=>void} onPeer
 * @returns {{send:Function, close:Function, dispose:Function}}
 */
export function ipcLink(onMessage, onPeer) {
  const net = globalThis.spaceAPI?.net;
  if (!net) throw new Error('LAN play needs the desktop build');

  const offMessage = net.onMessage((from, msg) => onMessage(from, msg));
  const offPeer = net.onPeer((ev) => onPeer(ev));

  return {
    /** `to` is always a numeric peer id; the host is 0. */
    send(to, msg) { net.send(to, msg); },
    close() { return net.leave(); },
    dispose() { offMessage?.(); offPeer?.(); },
  };
}

/** Is this build able to host or join at all? */
export const lanAvailable = () => !!globalThis.spaceAPI?.net;
