// Build a self-contained GitHub Pages site and the real browser game.
// No npm dependencies are added to the game runtime by the promotional site.
import {
  cp,
  mkdir,
  readFile,
  writeFile,
  stat,
  readdir,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, process.argv[2] || "output/site");
if (out === root || !out.startsWith(join(root, "output") + "/"))
  throw Error("Site output must be inside output/");
const required = [
  "index.html",
  "styles.css",
  "main.js",
  "assets/lunacrust-trailer.mp4",
  "assets/trailer-poster.jpg",
  "assets/SpaceGrotesk.ttf",
];
for (const file of required) await stat(join(root, "site", file));
await stat(join(root, "app/vendor/three.module.js"));
await mkdir(out, { recursive: true });
await cp(join(root, "site"), out, { recursive: true });
await cp(join(root, "app"), join(out, "demo"), {
  recursive: true,
  filter: (source) => !source.endsWith(".DS_Store") && !source.endsWith(".mp3"),
});
await cp(join(root, "LICENSE"), join(out, "LICENSE"));
await cp(
  join(root, "THIRD_PARTY_NOTICES.md"),
  join(out, "THIRD_PARTY_NOTICES.md"),
);
await cp(join(root, "docs/RELEASE_STATUS.md"), join(out, "RELEASE_STATUS.md"));
await writeFile(join(out, ".nojekyll"), "");
const version = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
).version;
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const dirty = Boolean(
  execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
);
await writeFile(
  join(out, "build.json"),
  JSON.stringify(
    {
      version,
      channel: "release-candidate",
      sourceCommit,
      dirty,
      browserMode: "single-player",
      desktopLANMaxPlayers: 8,
    },
    null,
    2,
  ) + "\n",
);
let files = 0,
  bytes = 0;
async function count(dir) {
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) await count(p);
    else {
      files++;
      bytes += (await stat(p)).size;
    }
  }
}
await count(out);
console.log(
  `Built ${files} files (${(bytes / 1024 / 1024).toFixed(1)} MiB) → ${out}`,
);
