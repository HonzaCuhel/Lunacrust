# Lunacrust — Eight worlds. One last signal.

An original 35-second, 1920×1080 trailer authored in HyperFrames 0.8.29.

The footage is captured from the real Lunacrust 1.1 renderer in isolated Creative
worlds using a cinematic camera. The campaign and creature screens are real
product captures. These scenes do not represent an organic campaign completion
or eight simultaneous physical LAN clients. Marketing uses the release-candidate
label; desktop downloads are not presented as a signed stable release.

## Reproduce

From the repository root, install the pinned game dependencies and run `npm run web`.
Then, in another terminal:

```sh
node tools/capture-promo.mjs
node tools/capture-promo.mjs earth mars europa jupiter --clips
node tools/make-promo-score.mjs
cd videos/lunacrust-promo
npm run check
npm run render -- --quality high --fps 30 --workers 1 --low-memory-mode --output renders/lunacrust-trailer.mp4
```

Chrome, Node 24 and FFmpeg are required for capture. HyperFrames uses its own
browser render tooling. The composition has local font and animation dependencies;
no HeyGen account, remote voice/music service, stock video or paid generation is
required. The low-memory render mode streams frames instead of allocating gigabytes of temporary images. The final MP4 is copied to `site/assets/lunacrust-trailer.mp4`.

`BRIEF.md` records production assumptions. `STORYBOARD.md` maps the five scenes.
`frame.md` supplies typography and color. `index.html` assembles the five editable
subcompositions and the score. Each timeline is deterministic and seekable.

## Provenance

- Original game footage, captures, titles, composition code and score: repository MIT license.
- Original music synthesized by `tools/make-promo-score.mjs`; no third-party samples.
- Space Grotesk: SIL Open Font License, copied beside the font in `assets/OFL.txt`.
- GSAP 3.14.2: standard GSAP license, original header preserved; see `assets/GSAP-LICENSE.txt`.
- HyperFrames-generated scaffold and project instructions: Copyright 2026 HeyGen, Inc., Apache-2.0; see `assets/HYPERFRAMES-LICENSE.txt`. The index has been modified for local dependencies, original media and foreground stacking. Its CLI and Studio are not redistributed with the game or website.

These notices document provenance and dependency terms; they are not a trademark
clearance opinion or a guarantee against legal claims.
