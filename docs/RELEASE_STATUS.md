# Lunacrust 1.1.0 — release candidate

The release adds **The Last Signal**, an original eight-world survival campaign with an ending, up to 50 named checkpoints, and Shift/Ctrl sprint with C sneak. Creative opens all eight destinations. Existing standalone saves and guest characters remain separate.

## Verification in progress

- All 33 deterministic test files pass locally, including campaign unlocks and resource reachability, checkpoint browser/desktop storage, world travel inventory preservation, and sprint input.
- Browser integration and final native installer builds are being verified for this version. Their completed evidence will replace this section before final delivery.

The native release workflow builds macOS arm64/x64 DMG and ZIP, Windows x64 NSIS, Linux x64 DEB and AppImage. macOS requires 13 or newer. Downloaded macOS and Windows installers are unsigned; macOS is not notarized. Developer signing requires publisher credentials.

See [packaging verification](PACKAGING_VERIFICATION.md) for platform coverage. Physical multi-computer Wi-Fi, consumer GPU performance and formal trademark clearance remain outside the automated evidence. The [1.0 native run](https://github.com/HonzaCuhel/Lunacrust/actions/runs/33927997741) records the previous release only.
