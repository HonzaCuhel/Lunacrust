# Lunacrust

**Eight worlds. One last signal.** An open-source voxel adventure across the Solar System.

**[Play the demo](https://honzacuhel.github.io/Lunacrust/demo/) · [Interactive 3D worlds](https://honzacuhel.github.io/Lunacrust/#worlds) · [Website & trailer](https://honzacuhel.github.io/Lunacrust/)**

[![Watch the Lunacrust trailer](https://honzacuhel.github.io/Lunacrust/assets/trailer-preview.gif)](https://honzacuhel.github.io/Lunacrust/#trailer)

## Explore, build, survive

The public demo previews the [1.1 release candidate](https://github.com/HonzaCuhel/Lunacrust/pull/1):

- **Survival campaign:** restore a lost relay network, from Earth to Jupiter.
- **Creative:** build freely on eight worlds with distinct terrain and gravity.
- **Desktop LAN:** explore together with up to eight players on the same network.
- **Your expedition:** craft equipment, sprint, and keep up to 50 named checkpoints.

The browser game is single-player and needs a keyboard, mouse/trackpad and WebGL2. No account required.

## Release status

**Beta testing, not a stable release.** Desktop packages for macOS, Windows and Linux remain draft releases; macOS/Windows builds are unsigned. Physical two-computer Wi-Fi and a complete survival playthrough still need verification. [Release evidence and remaining checks](https://github.com/HonzaCuhel/Lunacrust/blob/feat/promo-demo/docs/RELEASE_STATUS.md).

## Run locally

Requires Node.js 22.17+ and npm:

```sh
npm ci
npm start        # desktop app
npm run web      # browser: http://127.0.0.1:5178
```

[Controls, saves & LAN setup](https://github.com/HonzaCuhel/Lunacrust/blob/feat/promo-demo/docs/PLAYER_GUIDE.md) · [Build & release](docs/RELEASING.md) · [Contributing](CONTRIBUTING.md)

## Open source

Game code and original generated assets: **[MIT](LICENSE)**. Dependencies retain their own licenses; see [asset provenance](docs/ASSET_PROVENANCE.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
