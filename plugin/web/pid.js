/**
 * Prints the process id of the program that started it: the session's own,
 * since the deck runs it with node and no shell between.
 *
 *   node web/pid.js
 */
'use strict'
process.stdout.write(`${process.ppid}\n`)
