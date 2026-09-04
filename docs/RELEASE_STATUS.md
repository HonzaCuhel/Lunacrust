# Lunacrust 1.0.0 — release candidate

This is an MIT-licensed release candidate with successful native builds and installed-application checks. [CI run 33927997741](https://github.com/HonzaCuhel/Lunacrust/actions/runs/33927997741) passed all five jobs for build commit `14b7bfbcd4e653b45875f57eab4b257186cd268d`. The source and workflow are in [HonzaCuhel/Lunacrust](https://github.com/HonzaCuhel/Lunacrust). Installer files are available in `dist/`; macOS and Windows downloads are unsigned and macOS is not notarized. A public stable release has not been published.

## Verified behavior

- **29/29 deterministic test files pass on all four native build hosts.** This includes crafting/progression across all eight planets, survival, body collision, inventory, creature AI/rendering, network framing/session ownership, settings validation, desktop security/storage and clean Electron installation.
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

Seven binary downloads were built in CI: macOS arm64 and x64 DMG/ZIP, Linux AppImage/DEB, and Windows NSIS. All four platform builds passed exact checks of 65 shipped source/assets plus runtime metadata. The Apple Silicon app, installed Ubuntu DEB, installed Windows NSIS app, and unchanged Intel ZIP through Rosetta each passed all 20 runtime checks, graceful process shutdown and temporary-profile removal. See `PACKAGING_VERIFICATION.md`, `dist/SHA256SUMS.txt` and `RELEASING.md` for artifact integrity and reproduction.

macOS requires 13 or newer. CI used macOS 15, Ubuntu 24.04 and Windows Server 2025. Linux and Windows runtime checks used software WebGL with the Chromium sandbox enabled. The hosted Intel VM could not create WebGL2, so its original ZIP was tested through Rosetta on Apple Silicon in a separately named dependent job. This does not verify a physical Intel GPU. The AppImage was built and hashed but was not launched; Ubuntu users should prefer the installed-and-tested DEB.

## Release gates still requiring external evidence

- Developer signing and Apple notarization for seamless downloads. Local macOS/Windows artifacts are explicitly named `-unsigned`.
- A physical two-computer Wi-Fi session, platform firewall prompts and the eight-player limit under real load. Three local processes validate networking code, not all routers and operating systems.
- Physical target GPUs and intended consumer OS versions, especially Windows 10/11 and an Intel Mac. Hosted software rendering and Rosetta do not establish performance on those devices.
- Formal trademark and jurisdiction-specific legal clearance if required. Preliminary web/asset checks cannot guarantee freedom from claims.

The browser preview is single-player. LAN assumes trusted peers; no encrypted internet matchmaking, dedicated remote server or anti-cheat promise. The host continues simulating while menus are open. License and provenance checks are documented in `ASSET_PROVENANCE.md`.
