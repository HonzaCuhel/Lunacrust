# Building and releasing Lunacrust

The repository is MIT licensed. Dependencies and the Space Grotesk font keep their own licenses; see `THIRD_PARTY_NOTICES.md`. No account, API key or server is needed to play. LAN sessions run between players on the same trusted network. Internet matchmaking and automatic updates are not implemented.

## Reproducible setup

Use Node.js 24 LTS (minimum 22.17) and npm. Run `npm ci` from a fresh checkout, then `npm test`. The lockfile pins Electron 44.2.0, electron-builder 26.15.3, Playwright 1.62.1 and Three.js 0.170.0. `npm ci` vendors Three.js and its license. The checked-in original WAVs and font ship without network access. `node tools/make-soundtrack.js` regenerates the audio; `npm run icon` regenerates the lunar wayfinder icon.

Electron 44.2.0 was the newest stable release on 2026-09-04, verified against https://releases.electronjs.org/release?channel=stable. Electron supports its latest three stable major versions: https://www.electronjs.org/docs/latest/tutorial/electron-timelines. Recheck this before subsequent releases and run the complete desktop verification after any runtime upgrade.

## Native packages

| Build host | Command | Output in `dist/` |
| --- | --- | --- |
| macOS, either architecture | `npm run dist:mac` | arm64 and x64 DMG + ZIP |
| macOS, one architecture | `npm run dist:mac -- --arm64` or `--x64` | Selected DMG + ZIP |
| Linux x64 | `npm run dist:linux` | AppImage + Debian package |
| Windows x64 | `npm run dist:win` | NSIS installer |

Native builds are the default. An explicit `--cross` permits a supported cross-build, for example `npm run dist:linux -- --cross`; it still requires verification on the target OS. Windows cross-builds may require Wine, and Linux package tooling may require a compatible fpm environment.

Packaging freezes its input in a temporary directory and verifies all shipped files against the checkout afterward. If files change during a build, fix the change and rebuild; do not distribute artifacts from a failed freshness check.

Package names include product, version, OS and architecture. macOS and Windows builds include `-unsigned` by default. Packaging does not install into `/Applications`, overwrite an installed app, upload a release or publish a package. On macOS, drag the app from the mounted DMG into Applications yourself. Keep several GB free when building both architectures.

The native matrix in `.github/workflows/desktop-release.yml` produces all four OS/architecture combinations and verifies the unpacked application from each package build on that host. The Linux check uses a virtual display and software WebGL; it does not demonstrate hardware GPU performance. Artifacts are downloadable from the workflow run after the repository is hosted and the workflow actually runs. The workflow does not create public GitHub Releases. Review the resulting binaries and manually publish a release only when ready.

This project currently targets macOS 13+, Windows 10/11 x64, and Linux x64 with a desktop environment compatible with Electron 44. The CI build hosts are macOS 15, Windows Server 2025 and Ubuntu 24.04. Installer creation alone does not verify installation, Gatekeeper, SmartScreen, every OS version, real LAN hardware or all GPU drivers. Check those manually on intended release systems.

## Verification and profiles

Run `node tools/verify-bundle.js dev` before packaging, then run it against the actual output:

```sh
node tools/verify-bundle.js dist/mac-arm64/Lunacrust.app
node tools/verify-bundle.js dist/mac/Lunacrust.app
node tools/verify-bundle.js dist/linux-unpacked/lunacrust
node tools/verify-bundle.js dist/win-unpacked/Lunacrust.exe
```

Run only the command for the host OS. Run `node tools/verify-package-source.js <bundle-or-unpacked-directory>` to compare every shipped source/asset byte with the checkout. This rejects stale packages after late code changes. `npm run probe:close` separately exercises native save-before-close and refusal after a save error.

`node tools/probe-capacity.js <app-bundle-or-executable>` launches one packaged host and seven headless game sessions over actual TCP, checks the player cap, chat, movement, edits and replacement joins, then removes its temporary profile. Its 13 checks passed against the final macOS arm64 application. This does not replace tests on separate physical computers or establish eight-client rendering performance.

On Linux hosts that restrict unprivileged user namespaces, an unpacked application may lack the required sandbox setup. The DEB installer includes a user-namespace check, conditional sandbox-helper permissions and an application-specific AppArmor profile; extracting an AppImage or running the unpacked directory does not run that installer. Keep the Chromium sandbox enabled when validating a target host. The current native Linux preflight and unverified installation boundary are documented in `PACKAGING_VERIFICATION.md`.

The runtime check validates the private asset origin, sandbox, context isolation, renderer APIs, runtime version, WebGL, bundled audio, save/load/delete and world worker startup. It launches with a temporary `LUNACRUST_USER_DATA` profile and cleans that profile afterward. `npm run probe`, `npm run probe:survival`, `npm run probe:smoke` and `npm run probe:lan` also isolate their profiles. Never run a bespoke destructive test against a normal profile.

Normal desktop saves are under the platform's application-data directory, in `Lunacrust/saves`. On the first launch that finds an old `Space Minecraft/saves` directory, valid JSON worlds and backups are copied without overwriting existing Lunacrust files. Original saves are never moved or deleted. A marker prevents subsequent launches from resurrecting deleted imported worlds. Invalid or oversized legacy files remain untouched in their original folder. Browser storage and old preference settings are not imported. An explicit absolute `LUNACRUST_USER_DATA` path bypasses migration entirely.

## Optional signing and notarization

The default local packages have no verified developer signature or notarization. Gatekeeper and Windows SmartScreen may prevent or warn about launch. A checksum establishes integrity against a checksum you trust, not developer identity.

Signing requires credentials supplied securely by the release owner. Do not commit them or place them in the app. Set `LUNACRUST_SIGN=1` explicitly only for a signing run. Signed mode fails if a suitable signing identity is unavailable.

For macOS, provide an Apple Developer ID Application identity through a local keychain or electron-builder's `CSC_LINK` and `CSC_KEY_PASSWORD`. Notarization additionally requires `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`, or the supported App Store Connect API-key variables. The packaging script enables notarization in signed mode. Verify the resulting app with `codesign --verify --deep --strict` and `spctl --assess --type execute`, and verify the stapled ticket with `xcrun stapler validate`. Apple Developer credentials and successful notarization are required before describing a build as notarized.

For Windows, configure a supported signing provider/certificate using electron-builder's Windows signing options and `CSC_LINK` / `CSC_KEY_PASSWORD` where applicable, then set `LUNACRUST_SIGN=1`. Hardware-token/cloud certificates may need provider-specific configuration. The checked-in workflow intentionally receives no signing secrets. Configure an explicitly approved signing job separately.

Official packaging and signing documentation: https://www.electron.build/docs/ and https://www.electron.build/docs/configuration/.

## Source and integrity

`npm run source:archive` creates `dist/Lunacrust-1.0.0-source.tar.gz` from known source directories without dependencies, build outputs, profiles, private local notes or prototype MP3s. Run `npm run checksums` after the final package and source files exist to produce `dist/SHA256SUMS.txt`. Regenerate checksums after any rebuild. Keep the source archive and matching version next to the binaries when publishing.

Before a public release, complete an actual two-computer co-op session, exercise an installer on each target OS, confirm save/reload and disconnect behavior, and review the licenses in the produced package. Do not label an unexecuted CI configuration or a locally cross-built binary as a tested platform release.
