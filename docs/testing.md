# Testing

chokidar4bare's suites are chokidar v6's own suites, ported to brittle. They are the executable
specification of the port: `test/v6.js` (96 cases), `test/index.js` (the 131-case shared suite run
under the native, recursive-preferred and owned-polling backends), `test/architecture.js` (7
cases), plus chokidar4bare's own `test/read-dir.js`, `test/bare-facts.js`, `test/bare-hardening.js`,
`test/enospc.js`, `test/scaffold.js` and `test/smoke.js`.

## The oracle

Under Node the `imports` map resolves `fs` to Node's own `fs`, so the translated engine runs on
the same `fs.watch` upstream runs on. That makes upstream's suite a differential oracle:

```
# 1. the ported tests against the upstream chokidar build they were ported from
git clone https://github.com/paulmillr/chokidar ../chokidar-upstream
git -C ../chokidar-upstream checkout --detach e4021d8 && (cd ../chokidar-upstream && npm ci && npm run build)
CHOKIDAR4BARE_ORACLE=$PWD/../chokidar-upstream npx brittle-node "test/*.js"

# 2. the same tests against chokidar4bare on Node — the numbers must match step 1
npx brittle-node "test/*.js"

# 3. and under Bare
npx brittle-bare "test/*.js"
```

Any difference between steps 1 and 2 is a translation bug: fix the translation, never the test.
Differences between 2 and 3 are confined to `lib/backend.js`, `lib/read-dir.js` and the Bare
defences, and to cases marked `{ skip: isBare }` (they need `process.env`, `process.chdir`,
`child_process` or `fs.watchFile`).

Recorded numbers at the 6.0.0 sync (`e4021d8`, 2026-11-13; macOS arm64, Node 24.19, Bare 1.33.4;
Linux arm64 in Docker `node:22-slim`, Node 22.23, Bare 1.33.4):

| Suite                  | oracle (Node, macOS) | chokidar4bare (Node, macOS) | (Bare, macOS)  | (Node, Linux)  | (Bare, Linux) |
| ---------------------- | -------------------- | --------------------------- | -------------- | -------------- | ------------- |
| `test/v6.js`           | 97/97, 316 asserts   | 97/97, 316                  | 97/97, 301     | 97/97, 312     | 97/97, 287    |
| `test/index.js`        | 395/395, 1,087       | 395/395, 1,087              | 395/395, 1,051 | 395/395, 1,095 | 264/264, 707  |
| `test/architecture.js` | 8/8, 35              | 8/8, 35                     | 8/8, 35        | 8/8, 35        | 8/8, 35       |
| all of `test/*.js`     | 539/539, 1,502       | 539/539, 1,502              | 539/539, 1,472 |                |               |

chokidar4bare's own suites (`read-dir`, `bare-facts`, `bare-hardening`, `scaffold`, `smoke`,
`enospc`) also pass on Linux under both runtimes, as does `scripts/linux-enospc.sh` with the lowered
limits. Windows has not been run since the sync (CI). The 0.1.0 baseline (2026-09-25, `74adf65`) was
75 v6 cases and 359 index cases (240 on Linux under Bare).

On Linux under Bare the recursive-preferred label does not register (264 = 2 × 131 + 2; 2 × 119 + 2 at
0.1.0): libuv ignores the recursive flag there and bare-fs cannot report it, so chokidar4bare pre-latches recursive
as unsupported (DV11) and the harness's `canUseRecursiveWatch` says no.

## CI (2026-09-25, `ok/chokidar4bare`, `.github/workflows/integrate.yml`)

| Job                                                                    | Result (run 36181023033, `4076026`, bare-fs 4.8.2)                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Test / linux (Node + Bare)                                             | green                                                                       |
| Test / linux inotify limits (`test/enospc.js` with the limits lowered) | green                                                                       |
| Test / win32 (Node + Bare)                                             | green: Bare 478/478 (1,163 asserts), Node 478/478 — burst test and F15 live |
| Test / darwin (Node + Bare)                                            | green: Bare 478/478 (1,316), Node 478/478                                   |
| Lint, Security                                                         | green                                                                       |

Windows needed two things the local runs could not show: bare-fs 4.8.2 (before it, a burst
overflowed libuv's 4 KB ReadDirectoryChangesW buffer, libuv passed a NULL filename and bare-fs
crashed on it: [holepunchto/bare-fs#52](https://github.com/holepunchto/bare-fs/issues/52), fixed
the day it was filed), and watch paths are resolved with
`realpathSync.native` on Node (the runner's temp directory is an 8.3 short name; libuv's fs-event
assertion fires when the callback's long name does not share the watched spelling — the same
assertion that has kept chokidar's own CI red).

**Known runner flakes on darwin under Bare** (each once, on different runs; all pass locally ×3;
both are verbatim upstream assertions with no macOS guard upstream either):

- `fs.watch (non-polling) › watch individual files › should detect unlink and re-add`
- `fs.watch (recursive preferred) › watch individual files › should detect safe-edit` (exact count
  of three `change` events for three rename-over saves 300 ms apart)

Seen locally during the 6.0.0 sync on macOS (each once; all pass on immediate re-runs, 8 clean
consecutive `test/index.js` runs across both runtimes afterwards; each waits on a single FSEvents
callback shortly after a subscription starts, the drop the first-callback rescan only covers when a
later callback arrives):

- `fs.watch (non-polling) › watch a directory › should emit \`unlinkDir\` and \`add\` when dir is replaced by file` (Node)
- `fs.watch (recursive preferred) › watch individual files › should not error on sockets (#1391)` (Bare)
- `race regressions › should fall back when a recursive handle fails while replaying its initial buffer` (Bare)

They are tracked here by name. A case that fails twice gets investigated, not re-run.

## Linux locally

Docker is enough. `scripts/linux-run.sh` copies the checkout into a `node:22-slim` container with a
cached `node_modules` volume and runs the given files under Node, Bare or both:

```
scripts/linux-run.sh both test/v6.js test/index.js
```

`scripts/linux-enospc.sh` runs `test/enospc.js` in a privileged container after lowering
`fs.inotify.max_user_watches` to 1024 and `max_queued_events` to 16, the way the CI job does, and
restores them afterwards. Those limits are kernel-global inside Docker Desktop's VM: never run it
alongside another Linux test run.

## Timing

Tests wait on conditions, never on fixed sleeps; `CHOKIDAR4BARE_TEST_TIMEOUT_SCALE=2` stretches every
timeout on a slow machine. macOS FSEvents coalesces and duplicates events, so counts there are
asserted only where upstream asserts them. brittle never bails: one flake fails one test, not the
run.
