# Lunacrust 1.0.0 — release candidate

This is a locally prepared release candidate. No public repository, public release upload, developer signature or notarization has been created by this task. Generated installers are available in the local `dist/` directory; native cross-platform CI is prepared for a future hosted repository.

## Verified behavior

- **28/28 deterministic test files pass.** This includes crafting/progression across all eight planets, survival, body collision, inventory, creature AI/rendering, network framing/session ownership, settings validation and desktop security/storage.
- **20/20 browser UI checks pass** at 1440×900 and minimum 960×600. Settings apply live and persist through restart; restore defaults, move, hotbar, inventory, Escape, save/continue, cancellation and explicit confirmation of world replacement work. No console/runtime/resource errors in this run. Evidence: `output/ui/report.json`, screenshots in `output/ui/`.
- **38/38 native survival checks pass**, including life support, oxygen, equipment, combat, crafting, smelting and saves. The harness waits for observable outcomes rather than assuming a fixed rendering speed.
- **Native mechanics probe passes across all eight worlds**: grounded spawn, walking, jumping, mining and placement; chunk unload/reload persistence, step-up along both axes and palette controls also pass.
- **24/24 real LAN integration checks pass**, using three separate Electron44 processes and isolated temporary profiles. Automatic UDP discovery, joining over the Mac's LAN address, direct third join, bidirectional and simultaneous conflicting edits, shared creatures/combat, single-grant loot pickup, exclusive smelter access, smelting while host menus are open, world resync, namespaced guest saves, disconnect/rejoin and host-close behavior. No skipped checks or renderer exceptions. Evidence: `artifacts/lan/checks.json`.
- Native LAN lobby and host roster inspected at 1440×900 and 960×600: discovered games, direct-connect controls and host address are visible, keyboard Enter joins, and both clients report zero runtime errors. Evidence: `output/ui/lan-layout-checks.json`.
- **13/13 packaged-host capacity checks pass** with seven headless game sessions over actual TCP. The host admits eight players including itself, refuses the ninth, broadcasts chat and movement, converges after 70 edit requests, and admits a replacement with the edited world after a slot is freed. The eight-player roster was visually inspected. This is one renderer and seven protocol clients on one computer, not eight rendering computers or a long-duration hardware load test. Evidence: `output/capacity/checks.json` and `eight-player-roster.png`.
- Creature integration: natural spawning on actual generated terrain for all eight planets; real game slam decreases health20→14; targeting kill drops loot; zero browser JavaScript errors. Evidence: `output/creatures/gameplay-result.json` and `docs/creatures.png`.
- Asset review: old unverified MP3s excluded; reproducible original WAV compositions and local OFL font; license notices included. See `ASSET_PROVENANCE.md`.
- `npm audit` reported zero known dependency vulnerabilities after updating to pinned Electron44.2.0 / builder26.15.3 / Playwright1.62.1. This is the tool's advisory database result, not a proof of security.

## Artifacts and platform verification

Seven final binary downloads have been created: macOS arm64 and x64 DMG/ZIP, Linux AppImage/DEB, and Windows NSIS. All four unpacked platform builds passed exact checks of 65 shipped source/assets plus runtime metadata; both final macOS applications passed all 20 packaged runtime checks. Both DMGs passed checksum verification, read-only mounting, architecture and Applications-link checks, and their ASAR files match the corresponding source-verified applications. See `PACKAGING_VERIFICATION.md`, `dist/SHA256SUMS.txt` and `RELEASING.md` for results, integrity hashes and reproduction.

macOS requires 13 or newer. Both native Apple Silicon execution and Intel x64 execution through Rosetta on this Mac have been checked with isolated application probes. Rosetta execution is not a physical Intel Mac test. Linux AppImage/DEB and Windows NSIS files are cross-built on macOS; native Linux/Windows execution and installation remain unverified. An Ubuntu 24.04.4 VPS preflight stopped before upload or launch because sandbox prerequisites were unavailable to an unpacked application. Inspection confirmed the DEB includes installer sandbox setup; this was not an observed installer defect. See `PACKAGING_VERIFICATION.md` for the evidence and limits.

## Release gates still requiring external evidence

- Developer signing and Apple notarization for seamless downloads. Local macOS/Windows artifacts are explicitly named `-unsigned`.
- A physical two-computer Wi-Fi session, platform firewall prompts and the eight-player limit under real load. Three local processes validate networking code, not all routers and operating systems.
- Native Windows/Linux installer and runtime checks, plus target GPUs and intended OS versions. The GitHub Actions matrix exists but has not run in a hosted repository.
- Formal trademark and jurisdiction-specific legal clearance if required. Preliminary web/asset checks cannot guarantee freedom from claims.

The browser preview is single-player. LAN assumes trusted peers; no encrypted internet matchmaking, dedicated remote server or anti-cheat promise. The host continues simulating while menus are open. The source is licensed MIT and ready for publication; no upload has occurred.
