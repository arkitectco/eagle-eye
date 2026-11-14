/**
 * Prints, one to a line, the process ids among its arguments that the system
 * still runs. The deck uses it to tell which listed sessions are gone. It
 * signals nothing: signal 0 only asks whether the process exists.
 *
 *   node web/alive.js <pid> [<pid> ...]
 */
'use strict'
for (const p of process.argv.slice(2)) {
  try {
    process.kill(Number(p), 0)
    console.log(p)
  } catch (e) {
    if (e.code === 'EPERM') console.log(p)
  }
}
