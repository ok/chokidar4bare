// chokidar4bare original: directory listing that replaces readdirp for the engine (chokidar v6 uses
// readdirp 5.1.1, a Node Readable; bare-fs has no Node streams). Same entry shape, options,
// filters, depth counting, exploration order, warn-vs-error rule, end/close sequence and
// pause()/resume(), on a plain EventEmitter. Behaviour mirrors readdirp/index.ts @ 5.1.1 line for
// line where it matters; `highWaterMark` has no counterpart (entries are emitted, not buffered).
'use strict'

const EventEmitter = require('events')
const { lstat, readdir, realpath, stat } = require('fs/promises')
const sp = require('path')
const rt = require('./bare-runtime')

const EntryTypes = {
  FILE_TYPE: 'files',
  DIR_TYPE: 'directories',
  FILE_DIR_TYPE: 'files_directories',
  EVERYTHING_TYPE: 'all'
}

const defaultOptions = {
  root: '.',
  fileFilter: (_entryInfo) => true,
  directoryFilter: (_entryInfo) => true,
  type: EntryTypes.FILE_TYPE,
  lstat: false,
  depth: 2147483648,
  alwaysStat: false
}
Object.freeze(defaultOptions)

const RECURSIVE_ERROR_CODE = 'READDIRP_RECURSIVE_ERROR'
const NORMAL_FLOW_ERRORS = new Set(['ENOENT', 'EPERM', 'EACCES', 'ELOOP', RECURSIVE_ERROR_CODE])
const ALL_TYPES = [
  EntryTypes.DIR_TYPE,
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE,
  EntryTypes.FILE_TYPE
]
const DIR_TYPES = new Set([
  EntryTypes.DIR_TYPE,
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE
])
const FILE_TYPES = new Set([
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE,
  EntryTypes.FILE_TYPE
])

const isNormalFlowError = (error) => NORMAL_FLOW_ERRORS.has(error.code)

// readdirp asks Node for bigint stats on Windows (inode numbers exceed 2^53). bare-fs has no
// bigint option, so under Bare on Windows inodes are the truncated Number form.
const wantBigintFsStats = rt.platform === 'win32' && !rt.isBare

const emptyFn = (_entryInfo) => true

const normalizeFilter = (filter) => {
  if (filter === undefined) return emptyFn
  if (typeof filter === 'function') return filter
  if (typeof filter === 'string') {
    const fl = filter.trim()
    return (entry) => entry.basename === fl
  }
  if (Array.isArray(filter)) {
    const trItems = filter.map((item) => item.trim())
    return (entry) => trItems.some((f) => entry.basename === f)
  }
  return emptyFn
}

/**
 * Readdir stream, emitting `data` for each entry as it is listed, then `end` and `close`; on
 * `destroy()` only `close`; on a fatal error `error` then `close`. Listing starts on the next
 * microtask so listeners attached right after construction see every entry.
 */
class ReadDirStream extends EventEmitter {
  constructor(options = {}) {
    super()
    const opts = { ...defaultOptions, ...options }
    // Use ?? so an explicit `undefined` in user options doesn't shadow defaults.
    const root = opts.root ?? defaultOptions.root
    const type = opts.type ?? defaultOptions.type
    this.destroyed = false
    this._paused = false
    this._resumed = null
    this._fileFilter = normalizeFilter(opts.fileFilter)
    this._directoryFilter = normalizeFilter(opts.directoryFilter)
    const statMethod = opts.lstat ? lstat : stat
    this._stat = wantBigintFsStats ? (path) => statMethod(path, { bigint: true }) : statMethod
    this._maxDepth =
      opts.depth !== null && opts.depth !== undefined && Number.isSafeInteger(opts.depth)
        ? opts.depth
        : defaultOptions.depth
    this._wantsDir = DIR_TYPES.has(type)
    this._wantsFile = FILE_TYPES.has(type)
    this._wantsEverything = type === EntryTypes.EVERYTHING_TYPE
    this._root = sp.resolve(root)
    // Every fullPath is `_root + sep + relative path` (see _formatEntry), so
    // the relative path is a slice starting past the root and its trailing
    // separator (which resolved paths lack, except fs roots like '/', 'C:\').
    this._relStart = this._root.endsWith(sp.sep) ? this._root.length : this._root.length + 1
    this._isDirent = !opts.alwaysStat
    this._statsProp = this._isDirent ? 'dirent' : 'stats'
    this._rdOptions = { encoding: 'utf8', withFileTypes: this._isDirent }
    // Directories discovered but not yet emitted from ({ path, depth, pending? }). Listings are
    // read lazily (on pop, plus one prefetch) instead of eagerly on discovery: keeping whole
    // listings for every queued dir balloons RAM on wide trees. The root's readdir starts right
    // away; exploring the resolved root keeps parent paths absolute if the cwd changes.
    const rootDir = { path: this._root, depth: 1 }
    rootDir.pending = this._exploreDir(this._root, 1)
    this.parents = [rootDir]
    queueMicrotask(() => this._run())
  }

  /** Readable's pause(): stop emitting entries. Listing already in flight continues. */
  pause() {
    this._paused = true
    return this
  }

  /** Readable's resume(): continue emitting where pause() stopped. */
  resume() {
    this._paused = false
    const resumed = this._resumed
    this._resumed = null
    if (resumed) resumed.resolve()
    return this
  }

  isPaused() {
    return this._paused
  }

  _waitWhilePaused() {
    if (!this._paused) return
    if (!this._resumed) {
      let resolve
      const promise = new Promise((r) => {
        resolve = r
      })
      this._resumed = { promise, resolve }
    }
    return this._resumed.promise
  }

  destroy(error) {
    if (this.destroyed) return
    this.destroyed = true
    this.resume()
    queueMicrotask(() => {
      if (error) this.emit('error', error)
      this.emit('close')
    })
  }

  async _run() {
    try {
      while (!this.destroyed) {
        await this._waitWhilePaused()
        if (this.destroyed) return
        const parent = this.parents.pop()
        if (!parent) {
          this._end()
          return
        }
        const dir = parent.pending ?? this._exploreDir(parent.path, parent.depth)
        // Prefetch the next dir so its readdir overlaps with processing this one's entries. Only
        // the stack top is prefetched, keeping at most a handful of listings in RAM at once.
        const next = this.parents[this.parents.length - 1]
        if (next && !next.pending) next.pending = this._exploreDir(next.path, next.depth)
        const { files, depth, path } = await dir
        if (this.destroyed) return
        if (!files) continue
        for (const dirent of files) {
          // In dirent mode _formatEntry is synchronous: skip the per-entry microtask.
          let entry = this._formatEntry(dirent, path)
          if (entry instanceof Promise) entry = await entry
          if (!entry) continue
          if (this.destroyed) return
          // Only symlinks require async work; plain files / dirs resolve synchronously.
          let entryType = this._getEntryType(entry)
          if (typeof entryType !== 'string') entryType = await entryType
          if (this.destroyed) return
          await this._waitWhilePaused()
          if (this.destroyed) return
          if (entryType === 'directory' && this._directoryFilter(entry)) {
            if (depth <= this._maxDepth) {
              // Lazy: don't readdir until this dir is popped.
              this.parents.push({ path: entry.fullPath, depth: depth + 1 })
            }
            if (this._wantsDir) this.emit('data', entry)
          } else if (
            (entryType === 'file' || this._includeAsFile(entry)) &&
            this._fileFilter(entry)
          ) {
            if (this._wantsFile) this.emit('data', entry)
          }
        }
      }
    } catch (error) {
      this.destroy(error)
    }
  }

  _end() {
    if (this.destroyed) return
    this.emit('end')
    // autoDestroy: a finished stream closes itself
    this.destroyed = true
    queueMicrotask(() => this.emit('close'))
  }

  async _exploreDir(path, depth) {
    let files
    try {
      files = await readdir(path, this._rdOptions)
    } catch (error) {
      this._onError(error)
    }
    return { files, depth, path }
  }

  // Synchronous in dirent mode; returns a promise only when stats are needed.
  _formatEntry(dirent, path) {
    const basename = this._isDirent ? dirent.name : dirent
    // `path` is always an absolute, normalized parent dir (see the constructor's root seeding),
    // so a plain join is enough — resolve() would re-read cwd on every entry.
    const fullPath = sp.join(path, basename)
    // Slice instead of path.relative(): equivalent here (fullPath is always under _root).
    const entry = { path: fullPath.slice(this._relStart), fullPath, basename }
    if (this._isDirent) {
      entry.dirent = dirent
      return entry
    }
    return this._stat(fullPath).then(
      (stats) => {
        entry.stats = stats
        return entry
      },
      (err) => {
        this._onError(err)
        return undefined
      }
    )
  }

  _onError(err) {
    if (isNormalFlowError(err) && !this.destroyed) {
      this.emit('warn', err)
    } else {
      this.destroy(err)
    }
  }

  // Synchronous for regular files and directories; returns a promise only for
  // symlinks, which need realpath() to be classified.
  _getEntryType(entry) {
    // entry may be undefined, because a warning or an error were emitted
    // and the statsProp is undefined
    if (!entry || !(this._statsProp in entry)) return ''
    const stats = entry[this._statsProp]
    if (stats.isFile()) return 'file'
    if (stats.isDirectory()) return 'directory'
    if (stats.isSymbolicLink()) return this._getSymlinkEntryType(entry)
    return ''
  }

  async _getSymlinkEntryType(entry) {
    const full = entry.fullPath
    try {
      const entryRealPath = await realpath(full)
      const entryRealPathStats = await lstat(entryRealPath)
      if (entryRealPathStats.isFile()) return 'file'
      if (entryRealPathStats.isDirectory()) {
        const len = entryRealPath.length
        if (full.startsWith(entryRealPath) && full[len] === sp.sep) {
          const recursiveError = new Error(
            `Circular symlink detected: "${full}" points to "${entryRealPath}"`
          )
          recursiveError.code = RECURSIVE_ERROR_CODE
          this._onError(recursiveError)
          return ''
        }
        return 'directory'
      }
    } catch (error) {
      this._onError(error)
    }
    return ''
  }

  _includeAsFile(entry) {
    const stats = entry && entry[this._statsProp]
    return stats && this._wantsEverything && !stats.isDirectory()
  }
}

/**
 * Reads all files and directories in the given root recursively, emitting entries as they are
 * listed. Same signature and validation as readdirp(root, options).
 */
function readDir(root, options = {}) {
  let type = options.entryType || options.type
  if (type === 'both') type = EntryTypes.FILE_DIR_TYPE // backwards-compatibility
  if (!root) {
    throw new Error('readdirp: root argument is required. Usage: readdirp(root, options)')
  } else if (typeof root !== 'string') {
    throw new TypeError('readdirp: root argument must be a string. Usage: readdirp(root, options)')
  } else if (type && !ALL_TYPES.includes(type)) {
    throw new Error(`readdirp: Invalid type passed. Use one of ${ALL_TYPES.join(', ')}`)
  }
  // Copy options instead of mutating the caller's object.
  const opts = { ...options, root }
  if (type) opts.type = type
  return new ReadDirStream(opts)
}

module.exports = { readDir, ReadDirStream, EntryTypes }
