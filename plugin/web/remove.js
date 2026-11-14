/**
 * Removes the files named by its arguments: registry and inbox files the
 * deck made (Claude Code's file capability writes but never removes). A file
 * that is already gone, or cannot be removed, is left for the next clean.
 *
 *   node web/remove.js <path> [<path> ...]
 */
'use strict'
const fs = require('fs')
for (const p of process.argv.slice(2)) {
  try {
    fs.rmSync(p, { force: true })
  } catch {}
}
