# Lunacrust 1.1.0 — release candidate

**The Last Signal** adds an original survival campaign with eight chapters and an ending. Start on Earth, gather and craft relay supplies, unlock the Moon, Mars, Venus, Europa, Io, Titan and Jupiter, then restore the final signal. Creative opens every destination. Up to 50 named checkpoints preserve complete expeditions, including story progress and all visited worlds. Shift or Ctrl sprints forward; C sneaks.

[Native CI run 33933865210](https://github.com/HonzaCuhel/Lunacrust/actions/runs/33933865210) passed all five jobs for build commit `5042ad1c3cfc43d72c31fc5041a33a91cca39c5e`. Final downloads are collected in `dist/1.1.0/`, with `SHA256SUMS.txt` and matching source. macOS and Windows installers are unsigned; macOS is not notarized. A public stable release has not been published.

## Stable-release decision

The supported verdict is **release candidate / public beta**, not a polished stable
release. A bounded source audit found no campaign soft-lock; recipe inputs and
harvest tiers support the ordered progression. Automated completion injects
resources and does not establish real play time, balance or first-time usability.

Two observed onboarding issues remain in the 1.1 binaries:

- The Fabricator shows an unaffordable recipe's output but no ingredient preview.
  Earth progression needs a Stone Pickaxe: three rocks and two rods. This is a
  discoverability gap; the item can be crafted.
- The in-game field guide does not qualify flight and R-respawn as Creative-only;
  the README controls do. Those keys are correctly gated in the game.

The campaign is driven by journal chapters and resource-paid menu repairs. It
does not contain physical relay encounters. Death keeps equipment and progress;
these are intentional forgiving-survival mechanics, not evidence of a harsh
survival simulation.

Public `main` and the candidate development branch have not yet been merged.
Both desktop releases remain drafts. The promotional website presents the 1.1
browser candidate and clearly distinguishes browser single-player from desktop
LAN. Its trailer uses actual Creative camera footage and actual product screens.

## Verified behavior

- **34/34 deterministic test files pass on all four native build hosts.** New tests cover campaign locks/completion, actual terrain/recipe material reachability, atomic resource payment, browser and desktop checkpoints, world travel inventory preservation, sprint behavior and simulation isolation during persistence.
- **98 browser campaign checks pass**, with zero runtime/resource errors. Includes complete eight-world travel and ending, paid relay repairs, direct lock enforcement, checkpoint creation/rename/delete/rollback, visited terrain and current equipment retention, save/reload, creative isolation, quota failure rollback and actual Shift+W movement measured against walking. Resources are injected to skip mining time; separate domain tests verify material reachability. This is not a timed organic survival playthrough.
- **26 browser transaction checks pass**, including delayed/failed writes, simulation/input freeze, competing repair/travel/restore/save/native-close actions, exactly one replacement entry, stale death-card cleanup, and explicit confirmation before replacing an unreadable campaign.
- **20 browser shell checks pass**: settings live/persisted/defaults, movement, inventory, pause, save/continue and replacement confirmation. Campaign, checkpoint and ending dialogs were visually checked at 1440×900 and 960×600. The installed web-game skill client also completed two input/screenshot rounds.
- **24 actual three-process LAN checks pass** after the new join/transition locking: discovery, shared edits/creatures/loot/smelters, guest isolation, reconnect and host closure. Each process uses a temporary profile on one Mac.
- **25 campaign LAN checks pass** in two real Electron instances: relay repair while connected, a desktop checkpoint, canceled/confirmed travel, guest return to orbit, Moon rehosting/rejoin, equipment transfer and byte-identical guest-owned campaign/creative saves. Both processes exit gracefully and their test profiles are removed. Receipt: `output/campaign-lan-specific/report.json`.
- **22 packaged runtime checks pass on four execution targets**: native Apple Silicon, installed Ubuntu DEB, installed Windows NSIS and the original Intel ZIP through Rosetta. Includes source/asset notices, sandboxed WebGL2, local audio, world startup, starter kit, campaign identity, desktop checkpoint persistence, graceful process exit and profile cleanup.

Local receipts: `output/campaign-unit-tests.log`, `output/ui/report.json`, `output/playwright/campaign/report.json`, `output/playwright/transactions/report.json`, `artifacts/lan/checks.json`, and `output/releases/1.1.0/native-ci.log`.

## Downloads and boundaries

Seven binaries: Apple Silicon and Intel DMG/ZIP, Windows x64 NSIS, Linux x64 DEB/AppImage. macOS requires 13 or newer. CI used macOS 15, Windows Server 2025 and Ubuntu 24.04. Windows/Linux used software WebGL with the Chromium sandbox enabled. The hosted Intel GPU could not create WebGL2, so the unchanged Intel ZIP is tested through Rosetta on Apple Silicon. The AppImage is built and hashed but has not had a runtime launch test; Ubuntu users should prefer the installed-and-tested DEB.

Physical two-computer Wi-Fi, firewall prompts, consumer GPUs/OS versions, signing/notarization and formal trademark clearance remain outside this automated evidence. Source and original assets remain MIT with third-party notices. See [packaging verification](PACKAGING_VERIFICATION.md), [provenance](ASSET_PROVENANCE.md) and [release instructions](RELEASING.md).
