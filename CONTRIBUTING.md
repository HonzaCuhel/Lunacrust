# Contributing to Lunacrust

Use Node.js22+, run npm ci and npm test. Keep gameplay changes deterministic and cover multiplayer ownership boundaries. Run the Electron LAN probe for protocol/session edits and test the actual UI for input/settings changes. Use LUNACRUST_USER_DATA with an absolute temporary path when probing Electron; never modify real saves.

Keep stable block/item IDs and backward-compatible saves. A network content change must update compatibility hashing or the protocol. No telemetry, analytics, outside services or new privileges without a clear user-facing reason.

Submit only code/assets you can license. Document the origin and license of every imported asset, font, sound or library. No extracted commercial game assets, unclear music rights or third-party branding. Original contributions use MIT; retain third-party license files.

Describe what changes, reproduction steps, tests and known platform limitations. Avoid generated binaries, personal saves, local credentials, caches and debug artifacts in source changes. A release must state which OS/architectures actually ran tests and whether artifacts were signed and notarized.
