# Demo website and trailer

The public destination is https://honzacuhel.github.io/Lunacrust/.
The site lives in `site/`, and the playable browser build is copied from `app/`
without changing the game runtime. Links and local assets work under the GitHub
Pages repository prefix. The deployed browser game is the 1.1 release candidate,
not a promise that unsigned desktop draft releases have been published.

## Build and verify

```sh
npm ci
node tools/build-site.mjs
node tools/serve-site.mjs
node tools/check-site.mjs
```

The build writes only under `output/`. It includes no Electron processes, secrets,
source maps, npm dependencies or production credentials. Local Three.js, fonts,
WAV music, license notices and workers are included so the demo has no CDN needs.
`build.json` records version, candidate channel and source revision/dirty status.

`Demo site verification` runs build and browser checks for relevant pull requests.
It does not publish pull-request changes. The separate `gh-pages` branch holds
only the verified static build, with `.nojekyll`, so Pages can publish without
merging the development branch into `main`.

For deployment, commit the tested source, rebuild from that clean revision, copy
`output/site/` into a clean checkout of `gh-pages`, inspect its file list, then
commit and push that branch. Configure Pages to publish from `gh-pages` at `/`.
The official branch publishing contract is documented at
https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site.

After publication, repeat `LUNACRUST_SITE_URL=https://honzacuhel.github.io/Lunacrust/ node tools/check-site.mjs`
and check the trailer URL and `build.json` through the public endpoint. Browser
checks use fresh profiles and never read or modify a player's saved expeditions.

## Video

The 35-second HyperFrames production project is in `videos/lunacrust-promo/`.
Its README records capture/render commands and asset provenance. The website
serves a fast-start H.264/AAC MP4 with native controls and a static poster; it never
autoplays sound. The GitHub README uses a linked poster because GitHub does not
reliably render arbitrary HTML video players in Markdown.

The site is responsive; the game itself remains designed for desktop keyboard
and mouse/trackpad controls. Mobile visitors can browse the site and watch the
trailer. LAN hosting/discovery requires the desktop app.
