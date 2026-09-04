// LAN menu: the join lobby browser, the manual IP:port field, and the in-game
// roster + chat line. Plain DOM, in the register of screens.js - the game
// itself never touches this file, main.js wires it to `spaceAPI.net`.
//
// Every string that reaches this module from the network - a lobby name, a
// host name, a peer name, a chat line - is attacker-controlled the moment a
// second machine can dial in, so it only ever reaches the DOM through
// `textContent`. `innerHTML` does not appear anywhere below.

import { contentHash } from './protocol.js';

const div = (cls, parent) => { const d = document.createElement('div'); if (cls) d.className = cls; parent?.appendChild(d); return d; };
const span = (cls, parent, text) => { const s = document.createElement('span'); if (cls) s.className = cls; if (text != null) s.textContent = text; parent?.appendChild(s); return s; };
const btn = (cls, parent, text, onClick) => {
  const b = document.createElement('button');
  b.type = 'button';
  if (cls) b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  parent?.appendChild(b);
  return b;
};

/**
 * Pure-ish: given one beacon record and the local build's hash, describes
 * whether joining it makes sense and, if not, exactly why - the greyed-row
 * reason the spec calls for ("different build") rather than a bare refusal.
 */
export function describeLobby(lobby, localHash = contentHash()) {
  if (!lobby || typeof lobby !== 'object') return { joinable: false, reason: 'invalid' };
  if (lobby.hash !== localHash) return { joinable: false, reason: 'different build' };
  if (lobby.locked) return { joinable: false, reason: 'locked' };
  if (Number.isFinite(lobby.players) && Number.isFinite(lobby.max) && lobby.players >= lobby.max) {
    return { joinable: false, reason: 'full' };
  }
  return { joinable: true, reason: null };
}

const JOIN_ERROR_TEXT = {
  refused: 'The host refused the connection.',
  timeout: 'No response - check the address and port.',
  blocked: 'Could not reach that address on your network.',
};

/**
 * The "Join" panel: a live lobby list plus a manual IP:port fallback, because
 * guest and hotel wifi routinely drop broadcast traffic. `net` is
 * `spaceAPI.net` (undefined on a browser build without it - the panel then
 * renders the manual field only, with discovery controls hidden).
 */
export class LanMenu {
  /**
   * @param {HTMLElement} container
   * @param {object|undefined} net spaceAPI.net
   * @param {{onJoin:(info:{address:string,port:number})=>void, toast?:(msg:string)=>void}} hooks
   */
  constructor(container, net, hooks) {
    this.container = container;
    this.net = net;
    this.hooks = hooks ?? {};
    this._lobbies = [];
    this._unsubLobbies = null;
    this._build();
  }

  _build() {
    this.container.textContent = '';
    this.list = div('lan-lobby-list', this.container);
    this.empty = span('lan-lobby-empty', this.container, this.net ? 'Searching your network...' : '');
    this.empty.hidden = !this.net;

    const manual = div('lan-manual', this.container);
    span('lan-manual-label', manual, 'Direct connect');
    this.addrInput = document.createElement('input');
    this.addrInput.type = 'text';
    this.addrInput.setAttribute('aria-label', 'Host IP address');
    this.addrInput.autocomplete = 'off';
    this.addrInput.spellcheck = false;
    this.addrInput.placeholder = '192.168.1.42';
    this.addrInput.className = 'lan-manual-addr';
    manual.appendChild(this.addrInput);
    this.portInput = document.createElement('input');
    this.portInput.type = 'number';
    this.portInput.setAttribute('aria-label', 'Host port');
    this.portInput.min = '1'; this.portInput.max = '65535'; this.portInput.step = '1';
    this.portInput.placeholder = '25710';
    this.portInput.className = 'lan-manual-port';
    manual.appendChild(this.portInput);
    btn('lan-manual-go', manual, 'Connect', () => this._joinManual());
    for (const input of [this.addrInput, this.portInput]) input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); this._joinManual(); }
    });

    if (this.net) {
      this._unsubLobbies = this.net.onLobbies((lobbies) => this.setLobbies(lobbies));
      this.net.discover(true);
    }
  }

  _joinManual() {
    let address = this.addrInput.value.trim();
    let port = this.portInput.value.trim() ? Number(this.portInput.value) : 25710;
    const pasted = address.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/);
    if (pasted) { address = pasted[1]; port = Number(pasted[2]); }
    if (!address) return;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.hooks.toast?.('Enter a port from 1 to 65535.'); return;
    }
    this.hooks.onJoin?.({ address, port });
  }

  setLobbies(lobbies) {
    this._lobbies = Array.isArray(lobbies) ? lobbies : [];
    this._render();
  }

  _render() {
    this.list.textContent = '';
    this.empty.hidden = this._lobbies.length > 0;
    for (const lobby of this._lobbies) {
      const { joinable, reason } = describeLobby(lobby);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'lan-lobby-row' + (joinable ? '' : ' disabled');
      row.disabled = !joinable;
      row.setAttribute('aria-label', `${joinable ? 'Join' : 'Unavailable'} ${lobby.name ?? 'world'} on ${lobby.planetId ?? 'planet'}${reason ? ': ' + reason : ''}`);
      row.addEventListener('keydown', (event) => event.stopPropagation());
      this.list.appendChild(row);

      const name = span('lan-lobby-name', row);
      name.textContent = typeof lobby.name === 'string' ? lobby.name.slice(0, 32) : 'Unnamed world';

      span('lan-lobby-planet', row, typeof lobby.planetId === 'string' ? lobby.planetId : '?');
      span('lan-lobby-mode', row, lobby.mode === 'creative' ? 'Creative' : 'Survival');
      span('lan-lobby-players', row, `${lobby.players ?? '?'}/${lobby.max ?? '?'}`);
      if (lobby.locked) span('lan-lobby-lock', row, '\u{1F512}');
      if (!joinable) span('lan-lobby-reason', row, reason);

      row.addEventListener('click', () => {
        if (!joinable) return;
        this.hooks.onJoin?.({ address: lobby.address, port: lobby.port });
      });
    }
  }

  dispose() {
    this._unsubLobbies?.();
    this.net?.discover(false);
  }
}

/**
 * The in-game roster: everyone currently connected, plus a `T`-opened chat
 * line. Reads straight off `session.players` (id -> {name,...}) rather than
 * keeping its own copy, so it can never drift from who is actually here.
 */
export class Roster {
  /**
   * @param {HTMLElement} container
   * @param {{hostName:string, selfId:number|null, isHost:boolean}} info
   * @param {{onDisconnect:()=>void, onChat:(text:string)=>void}} hooks
   */
  constructor(container, info, hooks) {
    this.container = container;
    this.info = info;
    this.hooks = hooks ?? {};
    this._build();
  }

  _build() {
    this.container.textContent = '';
    this.rows = div('lan-roster-rows', this.container);
    const actions = div('lan-roster-actions', this.container);
    btn('lan-roster-disconnect', actions, 'Disconnect', () => this.hooks.onDisconnect?.());
    btn('lan-roster-chat', actions, 'Chat', () => this.openChat());

    this.chatLog = div('lan-chat-log', this.container);
    this.chatInput = document.createElement('input');
    this.chatInput.type = 'text';
    this.chatInput.maxLength = 200;
    this.chatInput.className = 'lan-chat-input';
    this.chatInput.hidden = true;
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.chatInput.value.trim();
        if (text) this.hooks.onChat?.(text);
        this.chatInput.value = '';
        this.closeChat();
      } else if (e.key === 'Escape') {
        this.closeChat();
      }
    });
    this.container.appendChild(this.chatInput);
  }

  openChat() {
    this.chatInput.hidden = false;
    this.chatInput.focus();
  }

  closeChat() {
    this.chatInput.hidden = true;
    this.chatInput.blur();
  }

  /** @param {Map<number,{name:string}>} players remote players, from session.players */
  render(players) {
    this.rows.textContent = '';
    const you = span('lan-roster-row lan-roster-you', this.rows);
    you.textContent = 'You' + (this.info.isHost ? ' (host)' : '');
    for (const [id, rec] of players) {
      const row = span('lan-roster-row', this.rows);
      const name = typeof rec.name === 'string' && rec.name ? rec.name : ('Player ' + id);
      row.textContent = name + (id === 0 ? ' (host)' : '');
    }
  }

  update(players, selfId) {
    this.info.selfId = selfId;
    this.render(players);
  }

  /** @param {number} id @param {string} text */
  addChatLine(id, text) {
    const line = div('lan-chat-line', this.chatLog);
    span('lan-chat-who', line, id === this.info.selfId ? 'You' : ('#' + id));
    span('lan-chat-text', line, text);
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
    while (this.chatLog.childElementCount > 40) this.chatLog.removeChild(this.chatLog.firstChild);
  }

  addSystemLine(text) {
    span('lan-chat-system', this.chatLog, text);
  }
}

export { JOIN_ERROR_TEXT };
