// chokidar4bare original: `timers` under Bare. Bare's global timers are its native ones (they have
// ref()/unref()/hasRef()) and Bare has no DOM, so the globals are what `node:timers` gives Node.
'use strict'

module.exports = { setTimeout, clearTimeout }
