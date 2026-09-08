import { CAMPAIGN_STAGES } from './campaign.js';
import { PLANET_BY_ID } from './planets.js';

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text, className = 'ghost', id) => {
  const node = element('button', `btn ${className}`, text);
  node.type = 'button';
  if (id) node.id = id;
  return node;
};
const planetName = id => PLANET_BY_ID.get(id)?.name ?? id ?? 'Unknown world';

/** Native modal views. Game state, persistence and ownership stay in callbacks. */
export class ExpeditionUI {
  constructor(hooks) {
    this.hooks = hooks;
    this._busy = new Set();
    this._statuses = new Map();
    this._checkpointRefresh = 0;
    this._missionRefresh = 0;
    this._checkpointCount = 0;
    this._confirmResolve = null;
    this._buildCheckpoints();
    this._buildMission();
    this._buildConfirm();
    // Replacing a focused checkpoint row can temporarily leave focus on body.
    // Catch Escape before game handlers even in that native-dialog edge case.
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      const dialog = [this.confirmDialog, this.checkpointDialog, this.missionDialog].find(node => node.open);
      if (!dialog) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this._escapeKeyup = true;
      if (dialog === this.confirmDialog) this._finishConfirm(false);
      else dialog.close();
    }, true);
    document.addEventListener('keyup', event => {
      if (event.key === 'Escape' && this._escapeKeyup) {
        this._escapeKeyup = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  _dialog(id, title, kicker) {
    const dialog = element('dialog', 'expedition-dialog');
    dialog.id = id;
    const heading = element('h2', 'dialog-heading', title);
    heading.id = `${id}-title`;
    dialog.setAttribute('aria-labelledby', heading.id);
    dialog.append(element('p', 'dialog-kicker', kicker), heading);
    // Leave native Escape dismissal intact, while keeping the same key from
    // reaching the game's pause/resume handlers underneath the modal.
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('keyup', event => event.stopPropagation());
    dialog.addEventListener('cancel', event => event.stopPropagation());
    document.body.append(dialog);
    return dialog;
  }

  _status(dialog) {
    const status = element('p', 'dialog-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    dialog.append(status);
    this._statuses.set(dialog, status);
    return status;
  }

  _setStatus(dialog, text = '') {
    this._statuses.get(dialog).textContent = text;
  }

  _error(dialog, error) {
    const message = error?.message || 'The operation could not be completed. Please try again.';
    this._setStatus(dialog, message);
    this.hooks.toast?.(message);
  }

  _show(dialog) {
    if (document.pointerLockElement) document.exitPointerLock();
    if (!dialog.open) dialog.showModal();
  }

  async _perform(dialog, operation) {
    if (this._busy.has(dialog)) return;
    this._busy.add(dialog);
    this._setStatus(dialog);
    const controls = [...dialog.querySelectorAll('button, input')].map(node => [node, node.disabled]);
    for (const [node] of controls) node.disabled = true;
    try { await operation(); }
    catch (error) { this._error(dialog, error); }
    finally {
      this._busy.delete(dialog);
      for (const [node, disabled] of controls) if (node.isConnected) node.disabled = disabled;
      if (dialog === this.checkpointDialog) this._updateSaveAccess();
      if (dialog === this.missionDialog) this._updateMissionActions();
    }
  }

  _buildCheckpoints() {
    const dialog = this.checkpointDialog = this._dialog('checkpoint-dialog', 'Your checkpoints', 'Keep a position. Return to it.');
    dialog.append(element('p', 'dialog-copy', 'Keep up to 50 named checkpoints, including your inventory and campaign progress. Saving the same name creates a separate position. Delete a checkpoint to make room when the library is full.'));
    const form = element('form', 'checkpoint-create');
    const label = element('label', '', 'Checkpoint name');
    label.htmlFor = 'checkpoint-name';
    this.checkpointName = element('input');
    this.checkpointName.id = 'checkpoint-name';
    this.checkpointName.type = 'text';
    this.checkpointName.maxLength = 80;
    this.checkpointName.required = true;
    this.checkpointName.placeholder = 'Before the next relay';
    this.checkpointName.autocomplete = 'off';
    this.checkpointSave = button('Save checkpoint', 'primary', 'checkpoint-save');
    this.checkpointSave.type = 'submit';
    this.checkpointAccess = element('p', 'dialog-copy');
    form.append(label, this.checkpointName, this.checkpointSave);
    form.addEventListener('submit', event => {
      event.preventDefault();
      event.stopPropagation();
      void this._perform(dialog, async () => {
        if (!this.hooks.canSave?.()) throw new Error('Enter your own world to create a checkpoint.');
        if (await this.hooks.saveCheckpoint(this.checkpointName.value) === false) throw new Error('The checkpoint could not be saved.');
        this.checkpointName.value = '';
        await this._refreshCheckpoints();
        this._setStatus(dialog, 'Checkpoint saved.');
      });
    });
    this.checkpointList = element('div');
    this.checkpointList.id = 'checkpoint-list';
    dialog.append(form, this.checkpointAccess, this.checkpointList);
    this._status(dialog);
    const actions = element('div', 'dialog-actions');
    const close = button('Close', 'ghost', 'checkpoint-close');
    close.addEventListener('click', () => dialog.close());
    actions.append(close);
    dialog.append(actions);
  }

  _updateSaveAccess() {
    const allowed = Boolean(this.hooks.canSave?.());
    const full = this._checkpointCount >= 50;
    this.checkpointName.disabled = !allowed || full || this._busy.has(this.checkpointDialog);
    this.checkpointSave.disabled = this.checkpointName.disabled;
    this.checkpointAccess.textContent = !allowed
      ? 'Enter your own world to save a new checkpoint. Saved positions can be loaded from this library.'
      : full ? 'All 50 checkpoint slots are in use. Delete one before creating another.'
        : `${this._checkpointCount} / 50 checkpoint slots used.`;
  }

  async _refreshCheckpoints() {
    const request = ++this._checkpointRefresh;
    const entries = await this.hooks.listCheckpoints();
    if (request !== this._checkpointRefresh) return;
    this._checkpointCount = entries.length;
    this.checkpointList.replaceChildren();
    if (!entries.length) this.checkpointList.append(element('p', 'dialog-copy', 'No checkpoints yet. Give your current position a name to save it here.'));
    for (const entry of entries) this.checkpointList.append(this._checkpointRow(entry));
    this._updateSaveAccess();
  }

  _checkpointRow(entry) {
    const row = element('div', 'checkpoint-row');
    row.dataset.checkpointId = entry.id;
    const fields = element('div', 'checkpoint-fields');
    const name = element('input');
    name.type = 'text';
    name.value = entry.name;
    name.maxLength = 80;
    name.setAttribute('aria-label', `Name for checkpoint ${entry.name}`);
    const mode = entry.mode === 'campaign' ? 'Campaign' : entry.mode === 'creative' ? 'Creative' : 'Survival';
    const date = new Date(entry.savedAt);
    const when = Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unknown date';
    fields.append(name, element('p', 'dialog-copy', `${planetName(entry.planetId)} · ${mode} · ${when}`));
    const actions = element('div', 'checkpoint-actions');
    const rename = button('Rename');
    const remove = button('Delete', 'danger');
    const load = button('Load', 'primary');
    const renamePosition = () => this._perform(this.checkpointDialog, async () => {
      if (await this.hooks.renameCheckpoint(entry.id, name.value) === false) throw new Error('The checkpoint could not be renamed.');
      await this._refreshCheckpoints();
      this._setStatus(this.checkpointDialog, 'Checkpoint renamed.');
    });
    rename.addEventListener('click', () => { void renamePosition(); });
    name.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); void renamePosition(); }
    });
    remove.addEventListener('click', () => { void this._perform(this.checkpointDialog, async () => {
      if (!await this.confirm('Delete checkpoint?', `Delete “${entry.name}” and its saved backup? This cannot be undone.`, 'Delete checkpoint')) return;
      if (await this.hooks.deleteCheckpoint(entry.id) === false) throw new Error('The checkpoint could not be deleted.');
      await this._refreshCheckpoints();
      this._setStatus(this.checkpointDialog, 'Checkpoint deleted.');
    }); });
    load.addEventListener('click', () => { void this._perform(this.checkpointDialog, async () => {
      if (!await this.confirm('Load checkpoint?', `Load “${entry.name}”? This replaces the current session with the saved position. Unsaved progress will be lost, and any LAN session will disconnect.`, 'Load checkpoint')) return;
      if (await this.hooks.loadCheckpoint(entry.id) === false) throw new Error('The checkpoint could not be loaded.');
      this.checkpointDialog.close();
    }); });
    actions.append(rename, remove, load);
    row.append(fields, actions);
    return row;
  }

  async openCheckpoints() {
    this.missionDialog.close();
    this._updateSaveAccess();
    this._show(this.checkpointDialog);
    this._setStatus(this.checkpointDialog, 'Loading checkpoints…');
    try { await this._refreshCheckpoints(); this._setStatus(this.checkpointDialog); }
    catch (error) { this._error(this.checkpointDialog, error); }
  }

  _buildMission() {
    const dialog = this.missionDialog = this._dialog('mission-dialog', 'Mission journal', 'The Last Signal');
    dialog.append(element('p', 'dialog-copy', 'Esc > Mission journal opens this journal whenever you need your next objective.'));
    this.missionContent = element('div', 'mission-content');
    dialog.append(this.missionContent);
    this._status(dialog);
    const actions = element('div', 'dialog-actions');
    this.missionRepair = button('Repair relay', 'primary', 'mission-repair');
    this.missionTravel = button('Travel to next world', 'primary', 'mission-travel');
    const close = button('Close journal', 'ghost', 'mission-close');
    close.addEventListener('click', () => dialog.close());
    this.missionRepair.addEventListener('click', () => { void this._perform(dialog, async () => {
      if (!this._mission?.canRepair) throw new Error('Gather the listed resources before repairing this relay.');
      if (await this.hooks.repair() === false) throw new Error('The relay could not be repaired.');
      await this.refreshMission();
    }); });
    this.missionTravel.addEventListener('click', () => { void this._perform(dialog, async () => {
      if (!this._mission?.canTravel || !this._mission.nextPlanet) throw new Error('Repair the relay to unlock the next destination.');
      if (await this.hooks.travel(this._mission.nextPlanet) === false) throw new Error('Travel could not be completed.');
      dialog.close();
    }); });
    actions.append(this.missionRepair, this.missionTravel, close);
    dialog.append(actions);
    this._updateMissionActions();
  }

  _updateMissionActions() {
    const mission = this._mission;
    const done = mission?.campaign?.completed;
    const repaired = mission?.campaign?.repaired?.includes(mission.campaign.activePlanet);
    this.missionRepair.hidden = !mission || Boolean(done || repaired);
    this.missionRepair.disabled = !mission?.canRepair || this._busy.has(this.missionDialog);
    this.missionTravel.hidden = !mission?.nextPlanet || Boolean(done);
    this.missionTravel.disabled = !mission?.canTravel || this._busy.has(this.missionDialog);
    this.missionTravel.textContent = mission?.nextPlanet ? `Travel to ${planetName(mission.nextPlanet)}` : 'Travel to next world';
  }

  _missionRoute(campaign) {
    const route = element('ol', 'mission-route');
    route.setAttribute('aria-label', 'Eight-world mission route');
    for (const stage of CAMPAIGN_STAGES) {
      const current = stage.planetId === campaign?.activePlanet;
      const repaired = campaign?.repaired?.includes(stage.planetId);
      const visited = campaign?.visited?.includes(stage.planetId);
      const step = element('li', 'mission-step');
      step.classList.toggle('is-current', current);
      step.classList.toggle('is-complete', Boolean(repaired));
      step.classList.toggle('is-locked', !visited);
      if (current) step.setAttribute('aria-current', 'step');
      const state = repaired ? 'Relay restored' : current ? 'Current destination' : visited ? 'Visited' : 'Locked';
      step.append(element('strong', '', planetName(stage.planetId)), element('span', '', state));
      route.append(step);
    }
    return route;
  }

  async refreshMission() {
    if (!this.missionDialog.open) return;
    const request = ++this._missionRefresh;
    try {
      const mission = await this.hooks.getMission();
      if (request !== this._missionRefresh || !this.missionDialog.open) return;
      this._mission = mission;
      this.missionContent.replaceChildren();
      this._setStatus(this.missionDialog);
      if (!mission) {
        this.missionContent.append(element('p', 'dialog-copy', 'Start a survival campaign to follow The Last Signal across eight worlds.'));
      } else {
        const { campaign, stage, requirements = [] } = mission;
        const progress = `${campaign.repaired.length} / ${CAMPAIGN_STAGES.length} relays restored`;
        this.missionContent.append(element('p', 'mission-progress', `${mission.planetName ?? planetName(campaign.activePlanet)} · ${progress}`));
        if (campaign.completed) {
          const ending = element('section', 'campaign-ending');
          ending.append(element('p', 'dialog-kicker', 'Network restored'), element('h3', '', 'The Last Signal · Complete'),
            element('p', 'dialog-copy', CAMPAIGN_STAGES[CAMPAIGN_STAGES.length - 1].completionText));
          this.missionContent.append(ending);
        } else if (stage) {
          this.missionContent.append(element('h3', '', stage.title), element('p', 'dialog-copy', stage.story), element('p', 'mission-objective', stage.objective));
          if (campaign.repaired.includes(stage.planetId)) {
            this.missionContent.append(element('p', 'mission-progress', stage.completionText));
          } else {
            const costs = element('ul', 'mission-requirements');
            costs.setAttribute('aria-label', 'Relay repair resources');
            for (const requirement of requirements) {
              const cost = element('li', 'mission-cost');
              cost.classList.toggle('is-ready', requirement.have >= requirement.count);
              cost.append(element('span', '', requirement.label), element('strong', '', `${requirement.have} / ${requirement.count}`));
              costs.append(cost);
            }
            this.missionContent.append(costs, element('p', 'dialog-copy', 'Repairing the relay consumes the listed resources from your inventory.'));
          }
        }
      }
      this.missionContent.append(this._missionRoute(mission?.campaign));
      this._updateMissionActions();
    } catch (error) { this._error(this.missionDialog, error); }
  }

  async openMission() {
    this.checkpointDialog.close();
    this._show(this.missionDialog);
    await this.refreshMission();
  }

  _buildConfirm() {
    const dialog = this.confirmDialog = this._dialog('expedition-confirm-dialog', 'Continue?', 'Confirm action');
    this.confirmHeading = dialog.querySelector('.dialog-heading');
    this.confirmMessage = element('p', 'dialog-copy');
    dialog.append(this.confirmMessage);
    const actions = element('div', 'dialog-actions');
    const cancel = button('Cancel', 'ghost', 'expedition-confirm-cancel');
    this.confirmAccept = button('Continue', 'primary', 'expedition-confirm-accept');
    cancel.addEventListener('click', () => this._finishConfirm(false));
    this.confirmAccept.addEventListener('click', () => this._finishConfirm(true));
    dialog.addEventListener('cancel', event => { event.preventDefault(); this._finishConfirm(false); });
    dialog.addEventListener('close', () => { if (!dialog.open) this._finishConfirm(false); });
    actions.append(cancel, this.confirmAccept);
    dialog.append(actions);
  }

  _finishConfirm(result) {
    const resolve = this._confirmResolve;
    this._confirmResolve = null;
    if (this.confirmDialog.open) this.confirmDialog.close();
    resolve?.(result);
  }

  confirm(title, message, actionLabel = 'Continue') {
    this._confirmResolve?.(false);
    this.confirmHeading.textContent = title;
    this.confirmMessage.textContent = message;
    this.confirmAccept.textContent = actionLabel;
    return new Promise(resolve => {
      this._confirmResolve = resolve;
      this._show(this.confirmDialog);
      this.confirmDialog.querySelector('#expedition-confirm-cancel').focus();
    });
  }

  closeAll() {
    this._finishConfirm(false);
    this.checkpointDialog.close();
    this.missionDialog.close();
  }
}
