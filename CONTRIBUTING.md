# Contributing / Development guide

Thanks for your interest in improving **dsh-usage-dashboard**! This doc covers the development loop.

## Requirements

- Node.js ≥ 22.15 / 24 in the environment where `dsh` runs (built-in zstd decompression)
- `pnpm` (the `dsh plugin` command forwards to it)
- A `dsh` 0.1.5-rc.1+ deployment using the **web** profile

## Project layout

```
cordis.patch.yml      the loader row this bundle inserts (mount path configurable here)
lib/plugin.js         host half: registers the /usage-dashboard prefix route on dsh's webServer
lib/aggregate.js      session-log parser + aggregation (shared by plugin & standalone modes)
lib/client.js         browser half: registers the Settings "Usage dashboard" section (iframe embed)
public/               dashboard front-end (vanilla HTML/CSS/JS, hand-rolled SVG charts)
server.js             standalone mode (no dsh plugin machinery needed)
```

There is **no build step** — everything runs from source.

## Development loop

1. Edit code. Check changes fast with the standalone server (auto-picks up `public/` edits on refresh):

   ```bash
   node server.js   # http://localhost:7900
   ```

2. Install your local checkout into the web profile (repeat after every edit — local installs are **copied**, not linked):

   ```bash
   dsh plugin --profile web add file:/path/to/dsh-usage-dashboard
   ```

3. Restart `dsh web` — bundles and their client modules load at boot.

Reload semantics:

| What you changed | What to do |
| --- | --- |
| `public/*` (front-end assets) | reinstall + Ctrl+F5 in the browser (no restart needed) |
| `lib/*`, `cordis.patch.yml`, `package.json` | reinstall + restart `dsh web` |

### Windows maintainer shortcut

`update.cmd "commit message"` does commit → push (with proxy fallback) → reinstall in one go. Restart `dsh web` manually afterwards.

## Debugging tips

- `GET <prefix>/api/data` returns the raw aggregated JSON; its `dirty` array lists discarded bad-timestamp events.
- The client bundle is served at `/plugins/??dsh-usage-dashboard/client.js&rev=<rev>` — the `rev` query is required; take the exact URL from the `window.__DSH_BOOT__` graph in the page source.
- Boot failures from plugin rows fail **loud**: if `dsh web` exits at boot, the stderr trace names the offending loader entry.
- When testing host-side changes, run a second instance on another port (`dsh web --no-open --port 3081`) instead of restarting your daily one.

## Releasing

```bash
git tag vX.Y.Z && git push --tags
```

Users pin a release with `dsh plugin --profile web add github:<owner>/dsh-usage-dashboard#vX.Y.Z`.

## Notes on the log format

See the "Data extraction notes" section in [README.md](README.md) before touching `lib/aggregate.js` — the dual old/v3 format and the double-counting pitfalls are easy to trip over.
