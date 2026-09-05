# Lunacrust 1.1.0 packaging verification

Final native verification for 1.1.0 is in progress. The records below are historical 1.0 evidence and do not establish 1.1 behavior.

# Historical 1.0 packaging verification — 2026-09-05

[CI run 33927997741](https://github.com/HonzaCuhel/Lunacrust/actions/runs/33927997741) passed all five jobs for commit `14b7bfbcd4e653b45875f57eab4b257186cd268d`. The four packages were built on their native OS and architecture with the pinned lockfile: Electron 44.2.0, electron-builder 26.15.3, Playwright 1.62.1 and Node.js 24.19.0. Every native build host passed all 29 deterministic test files and comparison of 65 shipped source/assets plus application metadata.

## Execution coverage

| Package | Installation / execution actually checked | Result |
| --- | --- | --- |
| macOS arm64 DMG / ZIP | Packaged application on Apple Silicon, macOS 15 | 20 runtime checks, graceful exit and profile cleanup pass |
| macOS x64 DMG / ZIP | Built on Intel macOS 15; original ZIP downloaded with SHA verification and run through Rosetta on Apple Silicon | 20 runtime checks, graceful exit and profile cleanup pass; physical Intel GPU unverified |
| Linux x64 DEB | Installed with apt on Ubuntu 24.04, then the installed `/opt/Lunacrust/lunacrust` was source-checked and launched | 20 runtime checks, graceful exit and profile cleanup pass |
| Windows x64 NSIS | Installed silently to a disposable directory on Windows Server 2025, then the installed executable was source-checked and launched | 20 runtime checks, graceful exit and profile cleanup pass |
| Linux x64 AppImage | Built on Ubuntu and included in artifact checksums | Construction verified; AppImage launch not tested |

Linux and Windows used a virtual/software graphics environment, the supported minimum window size, render distance 3 and resolution scale 0.75. Chromium sandboxing remained enabled; no `--no-sandbox` workaround was used. These checks establish startup and playable-world initialization, not consumer GPU performance, Windows 10/11 compatibility or router/firewall behavior.

The 20 runtime checks cover the packaged ASAR, application identity, excluded prototype audio/developer hooks, font/dependency notices, sandbox and context isolation, isolated profile, runtime version, absence of Node globals, WebGL2, all three bundled WAV tracks, save/load/delete, worker-streamed terrain and survival starter kit. Success is printed only after a clean process exit and removal of the temporary profile. Renderer exceptions, forced termination and persistent file locks fail verification. Full local evidence is in `output/ci-native-passing.log`, with the public workflow linked above as the durable build record.

## Artifact integrity

The seven binary downloads in `dist/` are the native CI artifacts, verified against each job's `SHA256SUMS.txt` after download. The final `dist/SHA256SUMS.txt` covers those seven files and the source archive. Documentation-only changes after the build do not change the 65 shipped source/assets; the exported source archive is checked byte-for-byte against the final checkout.

The macOS DMGs additionally undergo checksum verification and read-only mount checks: application executable architecture, Applications symlink, complete resource notices, source equality, and the mounted ASAR matching the original ZIP. No installed application in `/Applications` is overwritten. See `output/native-ci-integrity.json` and `output/native-ci-dmg-verification.json` for local receipts.

Earlier local packages were built and checked on macOS 26.2 / Apple Silicon, including x64 execution through Rosetta, all 20 runtime checks on both Mac variants and both DMG mount checks. Those pre-CI installers are retained separately under `output/pre-ci-artifacts/`; they are not the current release downloads. Existing local unpacked applications may still be from that earlier build.

## Problems reproduced and resolved

- A clean `npm ci` initially failed on macOS because Electron 44 downloads its runtime lazily, after our preparation hook expected it. The preparation tool now invokes the pinned install script, validates the executable and repairs the framework link only when needed. Clean-install, repeat-install and failure-transparency tests pass on the native hosts.
- Tests used a Mac-specific temporary directory and non-portable URL path conversion. They now use a project output directory and `fileURLToPath`; all 29 test files pass on every build host.
- Windows ASAR lookup required native separators. Source and license checks now normalize paths at the appropriate boundary and pass against the installed package.
- The Windows runtime passed its gameplay checks but cleanup raced database locks. The verifier now waits for graceful process exit, bounds failure cleanup and retries transient filesystem locks. The final installed run exits successfully and removes its profile.
- The hosted Intel VM failed to create WebGL2. Locally, its SwiftShader flags reproduced a missing Vulkan-loader failure, and a diagnostic copy with the loader proved that dependency. The distributed application was not modified for this comparison. CI now verifies the original Intel ZIP through Rosetta in a separately named dependent job. Physical Intel GPU execution remains unverified.

## Remaining boundaries

The local keychain has no Developer ID Application distribution identity. macOS and Windows downloads are explicitly `-unsigned`; macOS is not notarized. Signing and notarization require the owner's credentials and a successful signing run. Checksums do not establish publisher identity. See `RELEASING.md`.

The three-process LAN and eight-player protocol-capacity probes ran on one computer. A physical two-computer Wi-Fi session, firewall prompts, target GPU performance and intended consumer OS versions remain outstanding. The AppImage is an alternative for systems supporting Chromium's sandbox; Ubuntu users should prefer the installed-and-tested DEB.

An earlier Ubuntu 24.04.4 VPS preflight found that unprivileged user-namespace mapping failed with `EPERM`; it stopped before upload, installation or launch and changed no host settings. That unpacked-application prerequisite failure was not an installer defect. The later native CI DEB installation and sandboxed runtime check supersede the previous lack of native Linux execution evidence.

## Packaging and license safeguards

The builder uses an immutable private input snapshot and rejects packages that no longer match the checkout. This prevents the reproduced ASAR corruption caused by files changing between archive-header generation and data streaming. Invalid provisional files were replaced.

The lunar wayfinder icon and WAV score are original generated assets. Space Grotesk and its full OFL are local. Prototype MP3s and developer probe hooks are excluded. `LICENSE`, `THIRD_PARTY_NOTICES.md`, Three.js' MIT license, Electron's MIT license and platform-specific Chromium notices are included and checked. See `ASSET_PROVENANCE.md` for the limits of the provenance and preliminary name review.
