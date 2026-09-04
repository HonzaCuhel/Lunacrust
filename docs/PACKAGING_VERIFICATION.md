# Packaging verification — 2026-09-04

Lunacrust 1.0.0 was built locally on macOS 26.2 / Apple Silicon using Electron 44.2.0, electron-builder 26.15.3, Node.js 22.17.0 and the pinned lockfile. All final platform builds completed successfully. No artifacts were published and no application was installed over an existing copy.

## Actual outputs

| File in `dist/` | Bytes | Size |
| --- | ---: | ---: |
| `Lunacrust-1.0.0-linux-amd64.deb` | 117788828 | 112.3 MiB |
| `Lunacrust-1.0.0-linux-x86_64.AppImage` | 148742172 | 141.9 MiB |
| `Lunacrust-1.0.0-mac-arm64-unsigned.dmg` | 154813448 | 147.6 MiB |
| `Lunacrust-1.0.0-mac-arm64-unsigned.zip` | 154011964 | 146.9 MiB |
| `Lunacrust-1.0.0-mac-x64-unsigned.dmg` | 158508500 | 151.2 MiB |
| `Lunacrust-1.0.0-mac-x64-unsigned.zip` | 157742184 | 150.4 MiB |
| `Lunacrust-1.0.0-win-x64-unsigned.exe` | 129121226 | 123.1 MiB |

The source archive includes the final documentation and probe updates. `SHA256SUMS.txt` covers every final Lunacrust binary plus the source archive.

## Verified

- All four unpacked application trees (macOS arm64, macOS x64, Linux x64, Windows x64) passed byte-for-byte checks of 65 shipped source/assets and project notices, plus application metadata. Linux and Windows also passed comparison of their actual target Chromium license list with the bundled license copy.
- Both final macOS applications passed all 20 checks in `tools/verify-bundle.js`: packaged ASAR, original identity, source exclusions, complete font/dependency notices, sandbox, context isolation, disposable profile, Electron version, absence of Node globals in the renderer, WebGL2, all three WAV tracks, save/load/delete, a streamed world, and survival starter kit.
- Intel execution was tested through Rosetta on Apple Silicon, not on a physical Intel Mac. A fresh translated launch took about 56 seconds before the inspector became available; the smoke test allows a 90-second launch bound. Prefer the arm64 download on Apple Silicon.
- Native close testing passed: closing the window persisted the world before exit, and a simulated snapshot failure kept the window open. Protocol/IPC sender restrictions, non-overwriting legacy migration, serialized writes, backup fallback, and non-resurrection after deletion passed the desktop storage/security test.
- Both final DMGs passed `hdiutil verify` and read-only mount checks. Each contains `Lunacrust.app` and the correct Applications symlink, the expected arm64/x86_64 executable architecture, and all five resource notices. Each mounted ASAR hash matched its corresponding source-verified unpacked application; both mounts were detached. Evidence: `output/dmg-verification.json`.
- Windows NSIS and the unpacked game executable both had an empty Authenticode certificate directory, confirming the explicitly unsigned status.
- AppImage was identified as an ELF x86-64 executable, the Debian package as Debian format 2.0, and the Windows setup file as a Nullsoft installer.

## Evidence limits

Linux and Windows files were cross-built on macOS. Their runtimes and installation flows were not executed on native target systems. An Ubuntu 24.04.4 x64 VPS preflight found that unprivileged user-namespace mapping failed with `EPERM`, AppArmor restricted unprivileged user namespaces, and the unpacked sandbox helper was mode `0755`. The attempt stopped before upload or launch; no host settings were changed. This was a failed host prerequisite, not an observed application launch failure. Evidence: `output/linux-native-verification.md` and `.json`.

Inspection of the actual DEB confirmed that its installer tests user-namespace support, sets the sandbox helper to `4755` when that test fails, and installs/loads the bundled AppArmor profile on supported systems. That profile is scoped to `/opt/Lunacrust/lunacrust` and grants `userns`. The installer supplies sandbox setup absent from an unpacked temporary copy; the preflight does not establish an installer defect. Installation and profile loading remain untested at runtime.

The committed CI workflow prepares native builds and smoke tests, but no remote workflow has run in this session. Its unpacked Linux smoke check also depends on the runner permitting the Chromium sandbox. Installer construction and source equality are not native runtime verification.

macOS and Windows downloads are unsigned, and macOS downloads are not notarized. A maintainer-side keychain check found no Developer ID Application identity suitable for distribution. Signing/notarization require the owner's credentials and a separate successful signing run; see `RELEASING.md`.

## Packaging integrity

The builder operates on a private immutable input snapshot and fails its final source check if the checkout changed afterward. This prevents a reproduced ASAR corruption case where a live CSS edit changed file sizes between header generation and data streaming. Invalid provisional artifacts from that earlier attempt were replaced by the final successful builds listed above.

The executable resource/icon is original procedural artwork. Original generated WAV files and Space Grotesk's full OFL are bundled. Prototype MP3s and developer probe hooks are excluded. `LICENSE`, `THIRD_PARTY_NOTICES.md`, Three.js' MIT license, Electron's MIT license and platform-specific Chromium component notices are present in application resources.
