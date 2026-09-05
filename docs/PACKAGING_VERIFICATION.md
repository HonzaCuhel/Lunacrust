# Lunacrust 1.1.0 packaging verification — 2026-09-05

[CI run 33933865210](https://github.com/HonzaCuhel/Lunacrust/actions/runs/33933865210) passed all five jobs for `5042ad1c3cfc43d72c31fc5041a33a91cca39c5e`. Native builds use the pinned lockfile, Electron 44.2.0, electron-builder 26.15.3, Playwright 1.62.1 and Node.js 24. Every native build host passed all **34 test files** and exact comparison of **69 shipped source/assets** plus application metadata.

| Package | Installation/execution checked | Result |
| --- | --- | --- |
| macOS arm64 DMG/ZIP | Packaged app on Apple Silicon, macOS 15 | 22 runtime checks, graceful exit and profile cleanup pass |
| macOS x64 DMG/ZIP | Built on Intel macOS 15; original SHA-verified ZIP run through Rosetta on Apple Silicon | 22 runtime checks, graceful exit and profile cleanup pass |
| Linux x64 DEB | Installed with apt on Ubuntu 24.04; installed application source-checked and launched | 22 runtime checks, graceful exit and profile cleanup pass |
| Windows x64 NSIS | Installer run silently on Windows Server 2025; installed executable source-checked and launched | 22 runtime checks, graceful exit and profile cleanup pass |
| Linux x64 AppImage | Built on Ubuntu and hashed | Construction verified; launch not tested |

Linux/Windows use virtual/software graphics with Chromium sandboxing enabled, render distance 3 and resolution scale 0.75. Intel execution uses Rosetta because the hosted Intel VM cannot provide WebGL2; this does not verify a physical Intel GPU. No Vulkan loader was added and no sandbox was disabled. Consumer GPU performance, Windows 10/11 and actual router/firewall behavior are not established by these checks.

Runtime checks cover the ASAR, identity, excluded prototype audio/probe hooks, notices, sandbox and context isolation, isolated profile, runtime version, no Node globals, WebGL2, all three WAV tracks, desktop save/load/delete, worker terrain, starter kit, Earth campaign identity and a named campaign checkpoint round trip. A forced termination, renderer exception or persistent temporary-profile lock fails verification.

## Artifact integrity

Downloads are collected under `dist/1.1.0/`. Each is checked against its native job's SHA256SUMS before collection; the final manifest covers seven binaries and the source archive. macOS DMG checks additionally verify the image checksum and read-only mount, executable architecture, Applications symlink, all five runtime notices, exact source equality and an ASAR matching the paired ZIP. No user application is overwritten.

Source-only documentation/test updates after the build do not alter the 69 shipped runtime files. The final source archive is compared with the final checkout. Local receipts are under `output/releases/1.1.0/`; the public workflow above is the durable native execution record. The earlier 1.0 candidate remains separate.

## Distribution boundaries

macOS requires 13 or newer. macOS/Windows filenames explicitly include `-unsigned`; macOS is not notarized. Signing needs publisher credentials, and hashes do not prove publisher identity. See RELEASING.md. The AppImage is for systems supporting Chromium's sandbox; Ubuntu users should prefer the tested DEB.

The source build retains the immutable packaging input snapshot, platform-correct Chromium notices and clean Electron installation safeguards. Game art, the wayfinder icon, soundtrack and campaign text are original source-generated/authored material; Space Grotesk's OFL and dependency licenses are included. See ASSET_PROVENANCE.md for the precise provenance and legal-review limits.
