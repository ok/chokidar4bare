# Changelog

## Versioning

From 6.0.0 on, chokidar4bare's **major version is chokidar's major version**: chokidar4bare 6.x
is a port of chokidar 6.x. The minor and patch numbers are chokidar4bare's own and do not match
chokidar's: an upstream sync that brings new features is a minor release, and chokidar4bare's own
fixes or an upstream sync that only brings fixes are patch releases. The exact chokidar commit each
release is ported from is listed below and pinned in [UPSTREAM.md](UPSTREAM.md).

## 6.0.0 (unreleased)

Ported from chokidar **6.0.0** plus its two fixes after the release, #1496 and #1505 (`e4021d8`).

**The version jumps from 0.1.0 to 6.0.0** to adopt the scheme above. The jump does not signal a
rewrite: 0.1.0 was already a port of chokidar's v6 branch (`74adf65`). This release brings in what
changed upstream between that commit and the 6.0.0 release.

### Behaviour changes

- `getWatched()` returns null-prototype objects, so a watched directory named `__proto__` is
  listed ([chokidar#1493](https://github.com/paulmillr/chokidar/issues/1493)). Use
  `Object.hasOwn()` instead of `hasOwnProperty()` on the result.
- `ignored` no longer applies to the directories above a path passed to `watch()` or `add()`, so a
  missing path is still watched through its parent
  ([chokidar#1374](https://github.com/paulmillr/chokidar/issues/1374)). Other entries in those
  directories are still filtered.
- A watched path that is deleted is waited for from its nearest existing parent and reported again
  when it is recreated. Before, only a deleted file that was the sole watched path was waited for.
- When a native watch handle fails, the `error` event is still emitted, and the watcher then
  re-establishes the handle (up to three times) instead of dropping it, so later changes are still
  reported.

### Fixes

- A single `writeFile` of a new or existing file emits one `add` or `change`, not two.
- Watching a filesystem root no longer emits `unlink`/`unlinkDir` for every entry
  ([chokidar#1184](https://github.com/paulmillr/chokidar/issues/1184)).
- Sockets in a watched directory no longer cause errors on macOS
  ([chokidar#1391](https://github.com/paulmillr/chokidar/issues/1391)).
- On Linux, a watched directory that is deleted and recreated before its events are delivered is
  detected as a new directory, including when the new one reuses the old inode. This applies under
  Bare too.
- `awaitWriteFinish`: overlapping waits on the same file no longer interfere with each other,
  and a file deleted during the wait cancels it.
- Fixed missed events in several places: during event-queue overflow recovery, in the recursive
  watching fallback, and right after a macOS FSEvents subscription starts.
- Windows (Node only): files are compared by full 64-bit inode numbers, so distinct files are no
  longer mistaken for the same file. bare-fs has no BigInt stats, so this does not apply under Bare.
- The default scheduler takes its timers from the `timers` module, not the global `setTimeout`, so
  it works where the global is the DOM one
  ([chokidar#1496](https://github.com/paulmillr/chokidar/issues/1496)). Under Bare it uses Bare's own
  timers.
- A symlink to a directory that replaces a watched file is now watched
  ([chokidar#1505](https://github.com/paulmillr/chokidar/pull/1505)).
- The directory scanner follows readdirp 5.1.1: it keeps fewer directory listings in memory at once on
  wide trees, and explicitly `undefined` options fall back to their defaults.

### Verification

The ported upstream test suites match chokidar `e4021d8` under Node, and pass under Node and Bare
on macOS and Linux. See [docs/testing.md](docs/testing.md).

## 0.1.0 (2026-09-25)

First release, ported from chokidar's v6 branch at `74adf65`.
