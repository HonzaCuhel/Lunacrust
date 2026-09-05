// Validate saved configuration before it reaches the renderer or WebAudio.
export const DEFAULT_SETTINGS = Object.freeze({
  renderDistance: 6, fov: 74, sensitivity: 1, volume: 0.45, musicVolume: 0.35,
  renderScale: 1.5, invertY: false, reducedMotion: false, playerName: 'Explorer',
  mode: 'survival', volumeSet: true,
});
const numeric = (v, fallback, min, max) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
export function normalizeSettings(raw = {}) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    renderDistance: Math.round(numeric(s.renderDistance, 6, 3, 12)),
    fov: numeric(s.fov, 74, 60, 100), sensitivity: numeric(s.sensitivity, 1, 0.3, 2.5),
    volume: numeric(s.volume, 0.45, 0, 1), musicVolume: numeric(s.musicVolume, 0.35, 0, 1),
    renderScale: numeric(s.renderScale, 1.5, 0.75, 2),
    invertY: s.invertY === true, reducedMotion: s.reducedMotion === true,
    playerName: typeof s.playerName === 'string' ? s.playerName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) || 'Explorer' : 'Explorer',
    mode: s.mode === 'creative' ? 'creative' : 'survival', volumeSet: true,
  };
}
