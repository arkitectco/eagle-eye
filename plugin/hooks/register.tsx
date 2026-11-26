/**
 * Eagle Eye: a pane (`/eagle-eye`) that shows the session's git state and every
 * agent's work, and a band above the prompt while subagents run.
 *
 * The hooks here record what the engine reports (tool calls, spawns, turns,
 * messages between agents) into one live model, run git in the background,
 * and draw the views from `./views`. `/eagle-eye web` serves the same model as a
 * live dashboard in your own browser, or in the Desktop's Browser pane (`./web`).
 * Every `$` call lives in this file, written as `$.noun.method(...)`, and
 * `$` goes only to functions declared at the top of it: the plugin
 * directory reads a mod's calls from this source and accepts no other form.
 * So the web deck's server, the git runner, `/eagle-eye` and Inspect's reads
 * are sections at the end of this file; the other files hold pure code.
 */
import type {
  AgentInfo,
  CommandRunInput,
  CommandRunResult,
  Elements,
  EngineInterface,
  PromptFillResult,
  Events,
  Register,
  RenderElement,
  RenderInput,
  RenderSurface,
  SessionCompactInput,
  SessionCompactResult,
  SessionMessage,
  Timer,
  ToolCallArgs,
  ToolCallResult,
  SettingsSource,
} from 'claude-code'

import type { DeckAck, DeckActivity, DeckAgent, DeckData, DeckHook, DeckMessage, DeckStatus, DeckView, DeckWebSaved } from '../types/index.d.ts'
import * as AV from '../web/avatars.mjs'
import * as B from './background'
import { addedFileHunks, countOf, filePatchesOf, hunksOf, patchOf, replaceHunks, type Hunk } from './diff'
import * as FB from './files'
import * as F from './format'
import * as G from './git'
import * as H from './hold'
import * as I from './inspect'
import * as M from './model'
import * as R from './repos'
import * as SR from './registry'
import * as SE from './sessions'
import type { DashModel, DeckModel, Kit, UsageInfo, WebPane } from './ui/types'
import { chatEndOf, followStep, isAtEndAfter, listStep, type ChatFollow } from './ui/v2/chat'
import { openRowsFor, paneRowsFor } from './ui/v2/fit'
import { newRenderMemo } from './renderMemo'
import * as T from './timeline'
import { bandOf, deckView, type DeckActions } from './views'
import * as W from './web'

export const PANE = 'eagle-eye'
/** This plugin's name, as its manifest gives it and `next.origin.plugin` names its own calls. */
const OWN = 'eagle-eye'
const SNAPSHOT = { plugin: 'eagle-eye', key: 'snapshot' } as const
const REPO_PIN = { plugin: 'eagle-eye', key: 'repo' } as const
const WEB_STATE = { plugin: 'eagle-eye', key: 'web' } as const

let data: DeckData = M.emptyData(0)
let view: DeckView = M.defaultView()
let cwd = ''
let sessionId = ''
let usage: UsageInfo | null = null
let usageAt = 0
/** The `source` of Claude Code's SessionStart for this process's session, which arrives just before `session.start`; '' until it arrives, and after a reload, when the snapshot's `data.isFork` stands in for it. */
let startedAs = ''
let isPaneOpen = false
const timers: { save?: Timer; tick?: Timer; dump?: Timer } = {}
/** The screen key the last drawing showed (or the last timed redraw asked for); see `screenKey`. */
let shownKey = ''
let gitKeyMemo: { of: G.GitState; key: string } | null = null

/** The session's data as the deck holds it now (`data`), for the modules this one hands its parts to. */
export function currentData(): DeckData {
  return data
}

/** The pane's view now (`view`). */
export function currentView(): DeckView {
  return view
}

/** The session's spend and context as last read (`usage`); null before. */
export function currentUsage(): UsageInfo | null {
  return usage
}

/** The session's id (`sessionId`); '' before it is read. */
export function currentSessionId(): string {
  return sessionId
}

/** The session's own folder (`cwd`). */
export function currentCwd(): string {
  return cwd
}

/** The questions whose race with Claude Code's dialog runs in this module (`askers`), by their call's id. */
export function currentAskers(): ReadonlyMap<string, unknown> {
  return askers
}

/** The pane was closed (`/eagle-eye close`): the deck no longer takes it for open. */
export function paneClosed(): void {
  isPaneOpen = false
}

/**
 * The sample `/eagle-eye demo` shows: `v2` the v2 sample (web/fixtures/state.v2.json,
 * `W.v2StateFromText`, its times moved to the moment it was read), null
 * while it is read or when it could not be; `v2Files` its lazy files
 * (web/fixtures/v2/), as read. `note` says why it could not be read;
 * `version` counts its changes (an answer given in it), for the screen key.
 */
const demo: { v2: W.WebStateV2 | null; v2Files: W.V2Files; note: string; version: number } = {
  v2: null,
  v2Files: W.v2FilesFrom({ agents: {}, patches: {}, messages: {} }),
  note: '',
  version: 0,
}

/** Counts the saves (`save`): each change of the data the deck keeps moves it on. */
let dataGen = 0

/**
 * The v2 view model (`W.deckStateOf`) as the screen
 * stands, shared by the pane (`dashOf`), the band, state.json (`writeWeb`)
 * and the debug dump, with what it shows as one key (`W.v2KeyOf`). Each
 * screen key builds it afresh (`screenKey`); `v2Of` builds it again only
 * when the data was saved since (`dataGen`), git was read or the usage
 * loaded again, a minute turned (the ages and times it words), or the
 * questions the deck may answer changed.
 */
const v2Memo: { key: string; data: DeckData | null; git: G.GitState | null; usage: UsageInfo | null; diffs: W.GitDiffs | null; state: W.WebStateV2 | null; shows: string } = {
  key: '',
  data: null,
  git: null,
  usage: null,
  diffs: null,
  state: null,
  shows: '',
}

export function v2Of(now: number, isFresh = false): W.WebStateV2 {
  const asking = [...askers.keys()]
  const key = [dataGen, M.minuteOf(now), asking.join(','), sessionId, cwd, view.avatarStyle, clearedKey(), SR.listKey()].join('\u0001')
  const git = currentGit()
  const gitDiffs = currentGitDiffs()
  if (!isFresh && v2Memo.state && v2Memo.key === key && v2Memo.data === data && v2Memo.git === git && v2Memo.usage === usage && v2Memo.diffs === gitDiffs) return v2Memo.state
  // a question the page may answer is one whose race runs in this module: none after a reload
  const built = W.deckStateOf(data, git, usage, now, sessionId, cwd, new Set(asking), gitDiffs, view.avatarStyle, clearedOf())
  // every session on this machine, this one first (./registry): once the registry was read
  const sessions = SR.sessionsFor(built, now)
  const state = sessions ? { ...built, sessions } : built
  Object.assign(v2Memo, { key, data, git, usage, diffs: gitDiffs, state, shows: W.v2KeyOf(state) })
  return state
}

/** What "Clear finished" hid, as the view keeps it (`DeckView2.cleared`, `clearedAt`). */
function clearedOf(): W.Cleared {
  return { ids: view.v2.cleared, at: view.v2.clearedAt }
}

/** What "Clear finished" hid, as one string: a change marks the state anew. */
function clearedKey(): string {
  return `${view.v2.cleared.length}:${view.v2.clearedAt}`
}

/** The sample with what "Clear finished" hid marked, kept while neither changes. */
const demoMemo: { of: W.WebStateV2 | null; key: string; state: W.WebStateV2 | null } = { of: null, key: '', state: null }

/** The sample as the pane shows it: what "Clear finished" hid marked (`W.clearedStateOf`); null while it is read. */
function demoShown(): W.WebStateV2 | null {
  const sample = demo.v2
  if (sample === null) return null
  const key = clearedKey()
  if (demoMemo.of !== sample || demoMemo.key !== key || demoMemo.state === null) Object.assign(demoMemo, { of: sample, key, state: W.clearedStateOf(sample, clearedOf()) })
  return demoMemo.state
}

/**
 * "Clear finished": every agent shown that is finished (done, failed,
 * stopped or idle) hidden from the Dashboard, Chat's members and Everyone,
 * and Org, in this session's deck or the sample shown. The deck's own
 * tidying: nothing in Claude Code changes. Kept in the view, so a reload
 * keeps it. Answers what it did, in words, and acks `ackId`.
 */
async function clearFinishedAgents($: EngineInterface, ackId = ''): Promise<string> {
  const now = await $.clock.now()
  const state = shownV2Of(now)
  const ids = state ? W.finishedIdsOf(state) : []
  if (ids.length === 0) {
    await ackPage($, ackId, 'failed', 'Nothing finished to clear')
    return 'Nothing finished to clear.'
  }
  view.v2 = M.clearedWith(view.v2, ids, now)
  deckChanged($)
  const said = `Cleared ${ids.length} finished ${ids.length === 1 ? 'agent' : 'agents'} from the deck`
  await ackPage($, ackId, 'delivered', said)
  return `${said} (Claude Code keeps them). /eagle-eye clear show brings them back.`
}

/** "Show N cleared": the agents "Clear finished" hid shown again everywhere; acks `ackId`. */
async function showClearedAgents($: EngineInterface, ackId = ''): Promise<string> {
  const now = await $.clock.now()
  const count = shownV2Of(now)?.cleared?.count ?? 0
  if (view.v2.cleared.length === 0) {
    await ackPage($, ackId, 'failed', 'Nothing cleared to show')
    return 'Nothing cleared to show.'
  }
  view.v2 = M.view2With(view.v2, { cleared: [], clearedAt: 0 })
  deckChanged($)
  const said = count > 0 ? `Showing ${count} cleared ${count === 1 ? 'agent' : 'agents'} again` : 'Showing the cleared agents again'
  await ackPage($, ackId, 'delivered', said)
  return `${said}.`
}


/** The key of the Button the pane's focus ring is on, as `ui.focus` last landed it ('' for none, or one of the engine's own stops): where `j`, `k` and `n` move it from. */
let paneFocus = ''

/** The moves of the pane the deck asked for (`$.ui.scroll`), for the debug dump: how many in all, and the newest ten, where each took it ("end", "start", a key and where it lands). */
const paneMoves = { count: 0, latest: [] as string[] }

/** A move of the pane the deck asks for, noted for the debug dump. */
function noteMove(to: string) {
  paneMoves.count += 1
  paneMoves.latest = [...paneMoves.latest, to].slice(-10)
}

/**
 * How long a Client may go without its beat (it posts `{ type: 'alive' }`
 * each second while it is mounted) before its surface counts as failed. Read
 * at this pace, and the first reading is let pass, so a Client that failed
 * shows within twice this.
 */
export const SILENT_MS = 3000

/** The Clients listened to for their beat, by the surface they draw on: the beats heard, and the timer that reads them. */
type Beats = Map<RenderSurface, { heard: number; timer: Timer }>

/** Whether what a Client posted is its beat. */
function isBeat(posted: unknown): boolean {
  return typeof posted === 'object' && posted !== null && (posted as { type?: unknown }).type === 'alive'
}

/** Listens for the beat of the Client a surface draws, unless it does already: `onSilent` once a whole SILENT_MS passed without one. */
function listenForBeat($: EngineInterface, beats: Beats, surface: RenderSurface, onSilent: () => void) {
  if (beats.has(surface)) return
  // -1: the first reading passes whatever was heard, the time a module takes to load
  let read = -1
  const timer = $.clock.every(SILENT_MS, () => {
    const beat = beats.get(surface)
    if (!beat) return
    if (beat.heard !== read) {
      read = beat.heard
      return
    }
    stopListening(beats, surface)
    onSilent()
  })
  beats.set(surface, { heard: 0, timer })
}

/** Stops listening for a surface's Client, or for them all: it is drawn no longer. */
function stopListening(beats: Beats, surface?: RenderSurface) {
  for (const [heardOn, beat] of beats) {
    if (surface !== undefined && heardOn !== surface) continue
    beat.timer.cancel()
    beats.delete(heardOn)
  }
}

/** A beat heard from a surface's Client. */
function noteBeat(beats: Beats, surface: RenderSurface) {
  const beat = beats.get(surface)
  if (beat) beat.heard += 1
}

/** Org's chart Clients, listened to while a drawing holds one. */
const chartBeats: Beats = new Map()

/**
 * The surfaces whose Org chart Client fell silent (no beat for SILENT_MS:
 * it failed to load, to draw, or while running): their Org lists
 * the agents as a tree while it stays open. A drawing of anything else
 * (another tab, an agent's page, Inspect) clears its surface, so the chart
 * is tried again the next time Org shows; /eagle-eye clears them all.
 */
export const orgDown = new Set<RenderSurface>()

/** Whether this surface's Org lists the agents instead of its chart: the chart fell silent there and Org has not been left since. */
function isOrgDownOn(surface: RenderSurface): boolean {
  if (view.v2.tab !== 'org' || view.page !== '') orgDown.delete(surface)
  return orgDown.has(surface)
}

/** The agent whose page was opened last: Org's chart marks it. */
let lastAgent: string | null = null

/** Draws every site of this plugin again; the engine folds calls to ten a second. Events that change the data call it. */
function redrawDeck($: EngineInterface) {
  drawn.clear()
  $.ui.invalidate('ui.render')
}

/**
 * The trees the pane and the band drew last, returned again while their
 * inputs are unchanged (hooks/renderMemo.ts). When the engine redraws on its
 * own (as when a click gives the pane the keyboard), every Button keeps its
 * press handle, so that click still lands. `redraw` clears it.
 */
const drawn = newRenderMemo()

/** What the git half of the screen shows: not when git was read, only whether it has been and what it found. */
function gitKeyOf(state: G.GitState): string {
  if (gitKeyMemo?.of === state) return gitKeyMemo.key
  const files = F.hash(state.files.map(file => `${file.code}${file.path}\t${file.added}\t${file.removed}`).join('\n'))
  const key = [
    state.isRepo,
    state.checkedAt > 0,
    state.root,
    state.branch,
    state.head,
    state.upstream,
    state.ahead,
    state.behind,
    state.files.length,
    state.added,
    state.removed,
    files,
    state.error ?? '',
    state.pinned,
    state.repos.map(repo => repo.root).join(','),
    state.isCwdRepo,
    state.nearby.map(repo => repo.root).join(','),
    state.commits.length,
    state.today.commits,
    state.today.added,
    state.today.removed,
    state.sessionCommits,
  ].join('|')
  gitKeyMemo = { of: state, key }
  return key
}

/**
 * Everything on screen, as one key: all that the v2 state shows, built
 * afresh (`W.v2KeyOf`: the header, needs, tree, plan, chat, changes, Inspect
 * and acks, every age and elapsed time as worded); git as the Changes tab
 * reads it (whether read, HEAD, branch, files and counts); how the web deck
 * stands; and the sample's own state while it shows. Equal keys draw the
 * same screen.
 */
function screenKey(now: number): string {
  v2Of(now, true)
  const shown = webPaneOf()
  const webKey = `${shown.status}\t${shown.url}\t${shown.opened}\t${shown.note}`
  const sample = view.isDemo ? [demo.version, demo.v2 !== null, demo.note, clearedKey()].join('|') : ''
  return [v2Memo.shows, gitKeyOf(currentGit()), webKey, sample, SR.registryKey()].join('\n\u0001')
}

/** Keeps the model in `$.state`, so a reload of this module picks it up again; while the debug folder is there, dumps it too, and while the web deck is on, writes its state. */
function saveDeckState($: EngineInterface) {
  dataGen += 1
  scheduleDump($)
  scheduleWeb($)
  if (timers.save) return
  timers.save = $.clock.after(1500, () => {
    timers.save = undefined
    void $.state.set(SNAPSHOT, M.copyOf({ v: M.SNAPSHOT_VERSION, data, view })).catch(() => undefined)
  })
}

/**
 * Redraws only when the screen would change: how events, the timer and the
 * background reads draw, so nothing moves while nothing changes. (A press
 * that changes the view draws unasked, through `changed`.) A change is the
 * web deck's signal too: its state is written again.
 */
function redrawIfChanged($: EngineInterface, now: number) {
  const key = screenKey(now)
  if (key === shownKey) return
  shownKey = key
  scheduleWeb($)
  SR.noteChanged(now)
  redrawDeck($)
}

/** What Claude Code showed of a step's thinking as it streamed, read from its chunks: their text, and the block the last came in. */
type Thinking = { text: string; block: number }

/** Appends a thinking chunk's text to the step's text so far, with a blank line before a new block. Once the text passes `M.LIMITS.wordChars` (the most a kept word holds), later chunks are ignored. */
function keepThinking(kept: Thinking, chunk: { index: number; text: string }): void {
  if (kept.text.length > M.LIMITS.wordChars) return
  if (kept.block !== -1 && chunk.index !== kept.block && kept.text !== '') kept.text += '\n\n'
  kept.block = chunk.index
  kept.text += chunk.text
}

/** An event changed the data: keep it, and draw if the screen would change. Whatever it brought that the deck could stop is put to Claude Code's permission check at once (`probeStops`), so its Stop shows with it. */
function touched($: EngineInterface, now: number) {
  saveDeckState($)
  redrawIfChanged($, now)
  probeStops($, now)
}

/** Inspect's read of the context put off (./inspectHooks reads it at most every 10 s). */
let inspectTimer: Timer | undefined

/** Inspect: the context's breakdown read again, now when the last read was 10 s ago or more, else once that has passed. */
async function readContextSoon($: EngineInterface): Promise<void> {
  try {
    const wait = contextWaitOf(await $.clock.now())
    if (wait > 0) {
      if (!inspectTimer) {
        inspectTimer = $.clock.after(wait, () => {
          inspectTimer = undefined
          void readContextSoon($)
        })
      }
      return
    }
    if (await readInspectContext($, data)) touched($, await $.clock.now())
  } catch {
    // Inspect's context is read again at the next measure
  }
}

/** Inspect: what is loaded (the model, the output style, the settings' hooks), then the context, read now. */
async function readInspected($: EngineInterface): Promise<void> {
  try {
    if (await readInspectLoaded($, data)) touched($, await $.clock.now())
    if (await readInspectContext($, data)) touched($, await $.clock.now())
  } catch {
    // Inspect shows what it had
  }
}


/**
 * Each directory edited in as the file system spells it, by `R.keyOf`:
 * `$.fs.stat(dir, { resolve: true }).realPath`, so an 8.3 short name
 * (`C:\Users\DEVELO~1`) reads as git prints it (`C:/Users/developer`).
 */
const realDirs = new Map<string, string>()

/** `abs` with its directory spelled as the file system resolves it; asked once per directory, the spelling given when it cannot be. */
async function realPathOf($: EngineInterface, abs: string): Promise<string> {
  const path = R.cleanPath(abs)
  if (!R.isAbsolute(path)) return path
  const dir = R.dirOf(path)
  const key = R.keyOf(dir)
  let real = realDirs.get(key)
  if (real === undefined) {
    try {
      const stat = await $.fs.stat(dir, { resolve: true })
      real = stat.realPath ? R.cleanPath(stat.realPath) : dir
      realDirs.set(key, real)
    } catch {
      return path
    }
  }
  return R.childOf(real, F.baseName(path))
}

/** The same from what is resolved already, with no file system call: for the instant a call starts. */
function knownRealOf(abs: string): string {
  const path = R.cleanPath(abs)
  const real = R.isAbsolute(path) ? realDirs.get(R.keyOf(R.dirOf(path))) : undefined
  return real === undefined ? path : R.childOf(real, F.baseName(path))
}

/** Whether `knownRealOf` can spell `abs` as the file system does already: a relative path, or one whose directory was resolved. */
function isSpelledOf(abs: string): boolean {
  const path = R.cleanPath(abs)
  return !R.isAbsolute(path) || realDirs.has(R.keyOf(R.dirOf(path)))
}

/**
 * A call that started in a directory not resolved yet (an 8.3 short name,
 * `C:\Users\DEVELO~1\…`, which git never prints) gets its target written
 * again once the file system spells the path: relative to the repository
 * like every later call there, never an absolute path cut from the left.
 */
async function respell($: EngineInterface, activity: DeckActivity, tool: string, input: Record<string, unknown>, file: string): Promise<void> {
  try {
    const real = await realPathOf($, file)
    const target = M.targetOf(tool, { ...input, file_path: real }, currentGit().root || null, data.board)
    if (target === activity.target) return
    activity.target = target
    touched($, await $.clock.now())
  } catch {
    // the target keeps the spelling the call gave
  }
}

/** A slash command's expansion (classic UserPromptExpansion), held for the prompt it becomes: its headline. */
let expansion: { headline: string; at: number } | null = null

/** A slash command submitted alone, before its expansion (if any) arrives: an expansion makes it a request. */
let pendingCommand: { text: string; origin: { kind: string; asUser?: unknown }; turnId?: string; at: number } | null = null

/**
 * A submitted prompt whose turn may still start: its text, whether the words
 * are the user's own, whether it was submitted during a running turn, whether
 * its submit has resolved, and the slash command it runs as typed ("/review
 * the diff"), when the engine said it runs one.
 */
type Submitted = { text: string; isTheirs: boolean; isQueued: boolean; isSettled: boolean; command?: string }

/**
 * The submitted prompts whose turn may still start, newest last (at most 20).
 * The engine starts a prompt's turn inside `prompt.submit`'s `next(e)`, so
 * `turn.start` fires before the submit hook resumes. Each prompt is noted
 * before `next(e)`, and the turn it starts finds it by its text. (Noted after
 * `next(e)`, a turn matched the prompt before its own: after a notification's
 * turn, your next prompt was treated as having no words of yours.)
 */
const submitted: Submitted[] = []

/** Notes a submitted prompt before its turn can start. A prompt submitted while the session is idle starts its turn at once, so any earlier idle-submitted entry still left (a local command's, which starts no turn) is dropped. */
function noteSubmitted(text: string, isTheirs: boolean, isQueued: boolean, command: string): Submitted {
  if (!isQueued) for (let i = submitted.length - 1; i >= 0; i--) if (submitted[i]?.isQueued === false) submitted.splice(i, 1)
  const entry: Submitted = { text: text.trim(), isTheirs, isQueued, isSettled: false, ...(command ? { command } : {}) }
  submitted.push(entry)
  if (submitted.length > 20) submitted.splice(0, submitted.length - 20)
  return entry
}

/** Lets a prompt go whose turn will never start: a hook dropped it. */
function dropSubmitted(entry: Submitted) {
  const at = submitted.indexOf(entry)
  if (at >= 0) submitted.splice(at, 1)
}

/**
 * Finds and removes the prompt a main-loop turn starts with: the newest one
 * submitted with the same text; failing that (a hook may have rewritten the
 * text), the newest one submitted while idle whose submit is still under
 * way. Undefined for a turn with no prompt.submit before it (one started by
 * a background task's notification).
 */
function takeSubmitted(text: string): Submitted | undefined {
  const said = text.trim()
  let at = -1
  for (let i = submitted.length - 1; i >= 0 && at < 0; i--) if (submitted[i]?.text === said) at = i
  for (let i = submitted.length - 1; i >= 0 && at < 0; i--) if (submitted[i]?.isQueued === false && submitted[i]?.isSettled === false) at = i
  return at < 0 ? undefined : submitted.splice(at, 1)[0]
}

/**
 * Your prompts typed during a running main-loop turn, logged when they were
 * submitted (`prompt.submit` with that turn's `turnId`). If the engine later
 * runs one as a turn of its own, that turn does not log it again. The
 * newest 20.
 */
const typedMidTurn: string[] = []

/** A prompt of yours logged as you typed it over a running turn: kept for the turn it may start. */
function noteTypedMidTurn(text: string) {
  const said = text.trim()
  if (said === '') return
  typedMidTurn.push(said)
  if (typedMidTurn.length > 20) typedMidTurn.splice(0, typedMidTurn.length - 20)
}

/**
 * Whether a main-loop turn starts with prompts you typed during the turn
 * before, which were logged then (its text is one of them, or several queued
 * together). Matches are removed, so each is logged only once.
 */
function takeTypedMidTurn(text: string): boolean {
  const said = text.trim()
  if (said === '' || typedMidTurn.length === 0) return false
  const at = typedMidTurn.indexOf(said)
  if (at >= 0) {
    typedMidTurn.splice(at, 1)
    return true
  }
  // several queued prompts can start one turn together
  const within = typedMidTurn.filter(one => said.includes(one))
  if (within.length < 2 || within.reduce((rest, one) => rest.replace(one, ''), said).trim() !== '') return false
  for (const one of within) typedMidTurn.splice(typedMidTurn.indexOf(one), 1)
  return true
}

/**
 * SendMessage calls under way, each with its own `summary` (the label Claude
 * gives its own transcript row): the row their `session.send` logs takes it
 * as its title. Let go when the call ends.
 */
const sendTitles: { id: string; from: string; text: string; summary: string }[] = []

/**
 * The sends under way (`session.send` before its `next(e)` resolves), each
 * with its recipient and text. A send that wakes a finished agent raises
 * that agent's resume inside it, and only the send logs the message.
 */
const sendsInFlight: { from: string; to: string; text: string }[] = []

/** The message rows a resume logged for want of a send under way, by id, the newest 20: a send of the same words after it is that one row. */
const resumeRows: string[] = []

/**
 * A resumed agent's waking words, one message: the send under way to it (or
 * just logged) logs them; with none, the resume does, from the sender its
 * envelope names (`<agent-message from="…">`, an agent's SendMessage), else
 * from `from`. The envelope comes off first, as the send never carried it.
 */
function logResumeWords(agent: DeckAgent, from: string, prompt: string, at: number) {
  const unwrapped = M.unwrapMessage(prompt)
  const words = unwrapped.text
  if (words.trim() === '') return
  const isSent = sendsInFlight.some(one => one.text.trim() === words.trim() && (one.to === agent.id || M.resolveRecipient(data, one.to)?.id === agent.id))
  if (isSent || M.loggedSendOf(data, { to: agent.id, text: words, at })) return
  const sender = unwrapped.from ? (M.resolveRecipient(data, unwrapped.from)?.id ?? F.trunc(F.oneLine(unwrapped.from), 120)) : from
  const row = M.addMessage(data, { from: sender, to: agent.id, kind: 'message', text: words, at })
  resumeRows.push(row.id)
  if (resumeRows.length > 20) resumeRows.splice(0, resumeRows.length - 20)
}

/** The summary of the SendMessage under way that sends `text` from loop `from`; '' for none. */
function sendTitleOf(from: string, text: string): string {
  const sent = F.oneLine(text)
  const found = sendTitles.find(one => one.from === from && (one.text === text || (F.oneLine(one.text) !== '' && sent.includes(F.oneLine(one.text).slice(0, 80)))))
  return found?.summary ?? ''
}

/**
 * The debug dump: while `<home>/debug/` exists (the person makes it), what
 * the live deck believes goes to `debug/<sessionId>.json` in Eagle Eye's home
 * about 2 s after the data changes, for a person to read without a
 * screenshot, each session to its own file, made 0600 in a folder made 0700
 * before the first write. The folder is looked for at session.start and on
 * each tick, and again right before each write: with it absent nothing is
 * written (`$.fs.write` would make it).
 */
const DUMP_MS = 2000
const debug = { isOn: false, loadedAt: 0, writes: 0, isPrivate: false }

/** The debug folder, `<home>/debug`; '' with no home. */
async function debugDirOf($: EngineInterface): Promise<string> {
  const at = await homeOf($)
  return at === '' ? '' : `${at}/${W.DEBUG_DIR}`
}

/** Whether the debug folder is there; a look that fails counts as absent. */
async function hasDebugDir($: EngineInterface): Promise<boolean> {
  try {
    const dir = await debugDirOf($)
    return dir !== '' && (await $.fs.exists(dir)) === true
  } catch {
    return false
  }
}

/** Looks for the debug folder again: one that appeared since the last look dumps soon, one gone stops the dump. */
async function checkDebug($: EngineInterface, isStart = false): Promise<void> {
  const was = debug.isOn
  debug.isOn = await hasDebugDir($)
  if (!debug.isOn) {
    timers.dump?.cancel()
    timers.dump = undefined
  } else if (!was && !isStart) {
    scheduleDump($)
  }
}

/** The data changed: a dump within about 2 s while the debug folder is there; changes meanwhile ride along. */
function scheduleDump($: EngineInterface) {
  if (!debug.isOn || timers.dump) return
  timers.dump = $.clock.after(DUMP_MS, () => {
    timers.dump = undefined
    void writeDump($)
  })
}

async function writeDump($: EngineInterface): Promise<void> {
  try {
    if (!(await hasDebugDir($))) {
      debug.isOn = false
      return
    }
    const now = await $.clock.now()
    const name = W.fileNameOf(sessionId || 'state')
    // the dump's file made 0600 (its folder 0700) before its first write: the engine's write keeps that mode
    if (!debug.isPrivate) debug.isPrivate = await runHome($, { op: 'prepare', home: homeDir(), id: name, files: [`${W.DEBUG_DIR}/${name}.json`], isOwnHome: isOwnHome() })
    if (!debug.isPrivate) return
    debug.writes += 1
    const state = { meta: { at: now, loadedAt: debug.loadedAt, writes: debug.writes }, ...debugStateOf(now) }
    await $.fs.write(`${await debugDirOf($)}/${name}.json`, `${JSON.stringify(state, null, 2)}\n`)
  } catch {
    // a dump that could not be written waits for the next change
  }
}

/**
 * What the deck believes now, as plain data, nothing in it made up: the raw
 * counts; git; the view (v2's own, and the pane's focus); the pane's window
 * (the list of sessions, Chat's end, the moves asked for); from the v2 state
 * every surface draws (`v2Of`), its header, needs, plan sources, latest chat
 * rows and tree; per loop what Claude Code gave it (its name, description,
 * type, origin, status, parent, background flag, calls, list and result);
 * the latest edits; and how the web deck stands (never its secret or a link).
 */
function debugStateOf(now: number) {
  const state = v2Of(now)
  const callOf = (call: DeckActivity) => `${call.tool} ${F.oneLine(call.command || call.target)}`.trim()
  return {
    counts: {
      agents: data.agents.length,
      shownAgents: data.agents.filter(M.isShownAgent).length,
      messages: data.messages.length,
      edits: data.edits.length,
      files: Object.keys(data.files).length,
      goals: data.goals.length,
      board: Object.keys(data.board).length,
      workflows: data.workflows.length,
      turns: data.turns,
    },
    git: { root: currentGit().root, isRepo: currentGit().isRepo, checkedAt: currentGit().checkedAt, files: currentGit().files.map(file => file.path) },
    view: { page: view.page, v2: view.v2, focus: paneFocus, isDemo: view.isDemo },
    // how the pane's window stands for the deck: whether the list of sessions shows, Chat's end kept to, and the moves the deck asked for
    pane: { isListOpen: SR.isListOpen(), follow: { ...chatFollow }, moves: paneMoves.count, latest: paneMoves.latest },
    // what every surface draws, as v2 has it: the header (your latest request, the word, the turn), what needs you, the plan's sources, the chat's latest rows
    header: state.header,
    needs: state.needs.map(need => ({ id: need.id, kind: need.kind, agent: need.agent, age: need.age, text: F.trunc(F.oneLine(need.text), 200), isAnswerable: need.isAnswerable })),
    plan: state.plan
      ? { board: state.plan.board.map(task => `${task.id} ${task.status}: ${task.subject}`), todos: state.plan.todos?.items.map(item => `${item.status}: ${item.text}`) ?? null, approved: state.plan.approved !== null, workflows: state.plan.workflows.map(run => `${run.name}: ${run.phases.join(' · ')}`) }
      : null,
    // each loop as Claude Code gave it: its words, its status, its parent, its calls
    agents: data.agents.map(agent => ({
      id: agent.id,
      kind: agent.kind,
      name: agent.name,
      description: agent.description,
      type: agent.type,
      origin: M.originOf(agent),
      status: agent.status,
      parent: M.parentIdOf(data, agent) ?? null,
      background: agent.background ?? null,
      current: agent.current ? callOf(agent.current) : null,
      recent: agent.recent.slice(-3).map(callOf),
      todos: (agent.todos ?? []).map(item => `${item.status}: ${item.text}`),
      answer: agent.answer === undefined ? null : agent.answer.slice(0, 200),
      resultVia: agent.resultVia ?? null,
      tools: agent.tools,
      files: agent.files,
    })),
    edits: data.edits.slice(-20).map(edit => ({ agent: edit.agent, tool: edit.tool, path: edit.path, added: edit.added, removed: edit.removed })),
    chat: state.chat.slice(-20).map(row => ({ from: row.from, to: row.to, who: row.who, kind: row.kind, ...(row.title ? { title: row.title } : {}), text: F.oneLine(row.text).slice(0, 80) })),
    tree: state.agents.map(row =>
      row.row === 'fold'
        ? { row: row.row, id: row.id, depth: row.depth, text: row.text, ids: row.ids }
        : { row: row.row, id: row.id, depth: row.depth, title: row.title, kind: row.kind, status: row.status, fold: row.fold, live: row.live ? `${row.live.tool} ${row.live.text}` : null, needs: row.needs },
    ),
    web: webDebugOf(),
    // what waits on you, and whether the page may answer it; what came of the page's latest commands
    pending: data.pending.map(item => ({ ...item, isAnswerable: askers.has(item.id) })),
    acks: data.acks.slice(-10),
  }
}


/**
 * A page command, checked against the model (`W.routeOf`) and acted on, its
 * ack under its `id`: the page's own, and one another session's deck sent
 * (`steerFromSession`), alike. Refused, its ack says why.
 */
function runCommand($: EngineInterface, cmd: Record<string, unknown>) {
  const ackId = W.cmdIdOf(cmd)
  const route = W.routeOf(cmd, data)
  if (route === null) void ackPage($, ackId, 'failed', W.refusalOf(cmd, data))
  else if (route.kind === 'chat') void sendChatMessage($, route.agentId, route.text, ackId)
  else if (route.kind === 'review') void sendReview($, route.text, ackId)
  else if (route.kind === 'answer') answerCall($, route.callId, route.answers, ackId)
  // Stop, Stop turn and Cancel: only through Claude Code's own channels (TaskStop, CronDelete, $.turn.abort)
  else if (route.kind === 'stopAgent') void stopAgentRun($, route.agentId, ackId)
  else if (route.kind === 'abortTurn') void abortMainTurn($, route.turnId, ackId)
  else if (route.kind === 'stopBackground') void stopBackgroundTask($, route.bgId, ackId)
  else if (route.kind === 'avatarStyle') {
    applyAvatarStyle($, route.style)
    void ackPage($, ackId, 'delivered', `Avatars: ${AV.styleName(route.style)}`)
  } else if (route.kind === 'clearFinished') void clearFinishedAgents($, ackId)
  else if (route.kind === 'showCleared') void showClearedAgents($, ackId)
  else if (route.kind === 'selectRepo') void repoFromPage($, route.root, ackId)
}

/**
 * The page's pick in Changes (`selectRepo`): a repository the deck offers
 * (one of the picks in the session's directory, or one it found agents
 * editing in) pinned, or '' to follow the work again; any other is refused.
 */
async function repoFromPage($: EngineInterface, root: string, ackId: string): Promise<void> {
  const offered = [...currentGit().nearby, ...currentGit().repos].find(one => R.sameRoot(one.root, root))
  if (root !== '' && !offered) {
    void ackPage($, ackId, 'failed', 'Not a repository Changes offers here')
    return
  }
  const why = await chooseRepo($, offered?.root ?? '')
  void ackPage($, ackId, why === '' ? 'delivered' : 'failed', why || (offered ? `Changes shows ${offered.name}` : 'Changes follows the work again'))
}

/** Keeps the person's own settings in the store (`prefs`), for every session: the band hidden or not, and the avatar style. */
function savePrefs($: EngineInterface) {
  void $.store.set('prefs', { isBandHidden: view.isBandHidden, avatarStyle: view.avatarStyle }).catch(() => undefined)
}

/**
 * Draws the agents' avatars in `style` (web/avatars.mjs `STYLE_IDS`; one it
 * does not know is let go): kept in the person's prefs, so it holds in every
 * session; the pane draws again, and the web page follows with the state it
 * is written next (its `avatarStyle`).
 */
function applyAvatarStyle($: EngineInterface, style: string) {
  if (!AV.isStyle(style) || style === view.avatarStyle) return
  view.avatarStyle = style
  savePrefs($)
  deckChanged($)
}


/** Says what came of the page's command `id` in the state it reads (`acks`); a command with no id is told nothing. */
async function ackPage($: EngineInterface, id: string, status: DeckAck['status'], text: string): Promise<void> {
  if (id === '') return
  try {
    const now = await $.clock.now()
    M.noteAck(data, { id, ok: status !== 'failed', status, text, at: now })
    touched($, now)
  } catch {
    // the page goes on without the word
  }
}

// Stop: the deck stops only through Claude Code's own channels, and never grants itself a permission.

/** The stopping calls whose verdict is being asked for now, by their key: one question each at a time. */
const probing = new Set<string>()

/** When the permission check itself last failed for a stopping call, by its key: asked again only CHECK_RETRY_MS later. */
const checkFailedAt = new Map<string, number>()

/** How long after a permission check that failed (it rejects inside a turn being stopped) the deck asks again. */
const CHECK_RETRY_MS = 5_000

/**
 * Asks Claude Code's permission check about every stopping call the deck
 * could make whose verdict is missing or old (`B.staleCallsOf`): TaskStop of
 * a background agent, a teammate or a background task, CronDelete of a
 * schedule. `$.tool.check` runs nothing, opens no dialog and asks no
 * classifier. Each verdict is kept (`B.noteVerdict`); Stop and Cancel show
 * only where it is `allow`.
 */
function probeStops($: EngineInterface, now: number): void {
  for (const call of B.staleCallsOf(data, now)) {
    if (probing.has(call.key) || now - (checkFailedAt.get(call.key) ?? -Infinity) < CHECK_RETRY_MS) continue
    probing.add(call.key)
    void verdictOf($, call).finally(() => probing.delete(call.key))
  }
}

/**
 * Claude Code's permission check on stopping call `call`, asked now and
 * kept. A check that fails (it rejects inside a turn being stopped) is no
 * verdict of Claude Code's: nothing is kept, the Stop stays as it was, it is
 * asked again soon, and what it said is answered as `failed`.
 */
async function verdictOf($: EngineInterface, call: B.StopCall): Promise<{ decision: 'allow' | 'ask' | 'deny'; reason?: string } | { failed: string }> {
  let verdict: { decision: 'allow' | 'ask' | 'deny'; reason?: string }
  try {
    const said = await $.tool.check({ tool: call.tool, input: call.input })
    verdict = { decision: said.decision, ...(said.reason ? { reason: said.reason } : {}) }
    checkFailedAt.delete(call.key)
  } catch (error) {
    try {
      checkFailedAt.set(call.key, await $.clock.now())
    } catch {
      // asked again at the next change
    }
    return { failed: firstSentenceOf(error instanceof Error ? error.message : String(error)) }
  }
  try {
    const now = await $.clock.now()
    if (B.noteVerdict(data, call.key, verdict, now)) touched($, now)
  } catch {
    // the verdict holds for this press whatever the deck keeps of it
  }
  return verdict
}

/**
 * Runs stopping call `call` through Claude Code's own tool (`$.tool.call`:
 * its hooks, its permission check, then the tool), once its permission
 * check, asked again now, allows it; never with a consent of the deck's
 * own. Answers '' when it ran, else why not, in a sentence.
 */
async function runStop($: EngineInterface, call: B.StopCall): Promise<string> {
  const verdict = await verdictOf($, call)
  if ('failed' in verdict) return `Could not ask Claude Code whether ${call.tool} is allowed${verdict.failed ? `: ${verdict.failed.replace(/[.!?]+$/, '')}` : ''}. Try again in a moment`
  if (verdict.decision !== 'allow') return B.stopOf(data, call.tool, call.id).why
  try {
    const request = { tool: call.tool, ...call.input } as unknown as ToolCallArgs
    const own = { tool: call.tool, input: call.input }
    ownCalls.push(own)
    let ran: ToolCallResult
    try {
      ran = await $.tool.call(request)
    } finally {
      ownCalls.splice(ownCalls.indexOf(own), 1)
    }
    if (ran.deny !== undefined) return `Claude Code refused ${call.tool}: ${firstSentenceOf(ran.deny) || 'no reason given'}`
    if (ran.isError === true) return `${call.tool} failed: ${firstSentenceOf(typeof ran.text === 'string' ? ran.text : '') || 'no reason given'}`
    return ''
  } catch (error) {
    return `${call.tool} failed: ${firstSentenceOf(error instanceof Error ? error.message : String(error)) || 'no reason given'}`
  }
}

/** A stop the deck could not make: the page's command and a toast say why. */
async function stopFailed($: EngineInterface, ackId: string, why: string): Promise<void> {
  $.ui.toast(why)
  await ackPage($, ackId, 'failed', why)
}

/**
 * Stop on a background agent or a teammate at work: Claude Code's own
 * TaskStop of it (`runStop`). Then its row ends as stopped, Chat says "You
 * stopped builder", and the page's command is told.
 */
async function stopAgentRun($: EngineInterface, agentId: string, ackId = ''): Promise<void> {
  const agent = M.agentOf(data, agentId)
  if (!agent || !B.isStoppableAgent(agent)) return stopFailed($, ackId, W.refusalOf({ cmd: 'stopAgent', agentId }, data))
  const name = W.rowTitleOf(agent)
  const why = await runStop($, B.stopCallOf('TaskStop', agent.id))
  if (why !== '') return stopFailed($, ackId, why)
  const now = await $.clock.now()
  if (M.isLive(agent.status)) {
    agent.status = 'killed'
    agent.endedAt = now
    delete agent.current
    delete agent.todo
  }
  M.addMessage(data, { from: M.YOU, to: agent.id, kind: 'stop', text: `You stopped ${name}`, at: now, ...(ackId ? { ackId } : {}) })
  $.ui.toast(`Stopped ${name}`)
  await ackPage($, ackId, 'delivered', `Stopped ${name}`)
  touched($, now)
}

/**
 * Stop turn: Claude Code's own `$.turn.abort` of the main loop's running
 * turn, as Esc does (an op: no permission is asked or granted); the
 * foreground agents end with it. Then Chat says "You stopped the turn".
 */
async function abortMainTurn($: EngineInterface, turnId: string, ackId = ''): Promise<void> {
  if (turnId === '' || data.mainTurnId !== turnId) return stopFailed($, ackId, data.mainTurnId === undefined ? 'No turn is running' : 'That turn has ended')
  try {
    await $.turn.abort({ turnId })
  } catch (error) {
    return stopFailed($, ackId, `Could not stop the turn: ${firstSentenceOf(error instanceof Error ? error.message : String(error)) || 'Claude Code refused'}`)
  }
  const now = await $.clock.now()
  M.addMessage(data, { from: M.YOU, to: M.MAIN, kind: 'stop', text: 'You stopped the turn', at: now, ...(ackId ? { ackId } : {}) })
  $.ui.toast('Stopped the turn')
  await ackPage($, ackId, 'delivered', 'Stopped the turn')
  touched($, now)
}

/**
 * Stop on a background shell, monitor or workflow (Claude Code's own
 * TaskStop), or Cancel on a cron or wakeup (its CronDelete), by the row's
 * `bgId` (`runStop`). Then its row goes, Chat says "You stopped npm run
 * dev" or "You cancelled …", and the page's command is told.
 */
async function stopBackgroundTask($: EngineInterface, bgId: string, ackId = ''): Promise<void> {
  const row = B.rowByBgId(data, bgId)
  if (!row) return stopFailed($, ackId, W.refusalOf({ cmd: 'stopBackground', bgId }, data))
  const call = B.stopCallOfRow(row)
  const name = B.rowNameOf(row)
  const by = row.by
  const why = await runStop($, call)
  if (why !== '') return stopFailed($, ackId, why)
  const now = await $.clock.now()
  B.noteEnd(data, { toolUseId: '', tool: call.tool, input: call.input, by: '', at: now, ok: true, result: null })
  const said = `You ${call.tool === 'CronDelete' ? 'cancelled' : 'stopped'} ${name}`
  M.addMessage(data, { from: M.YOU, to: '', kind: 'stop', text: said, at: now, ...(by ? { agent: by } : {}), ...(ackId ? { ackId } : {}) })
  $.ui.toast(said.replace(/^You s/, 'S').replace(/^You c/, 'C'))
  await ackPage($, ackId, 'delivered', said.replace(/^You s/, 'S').replace(/^You c/, 'C'))
  touched($, now)
}

/** Claude Code's snapshot of the background work that a Stop or SubagentStop carried (`background_tasks`, `session_crons`), taken at `at`, kept (`B.noteSnapshot`); whether the record changed. */
function noteBackground(ev: { background_tasks?: unknown; session_crons?: unknown }, at: number): boolean {
  return B.noteSnapshot(data, { tasks: ev.background_tasks, crons: ev.session_crons, at, agents: new Set(data.agents.map(agent => agent.id)) })
}


/**
 * Puts Review's request in the prompt box after what you had typed there,
 * read first so it stays (`W.reviewFillOf`: a blank line between; into an
 * empty box, as it is). The draft is read for this alone and kept nowhere.
 */
async function fillAfterDraft($: EngineInterface, text: string): Promise<PromptFillResult> {
  let draft = ''
  try {
    draft = (await $.prompt.read()).text
  } catch {
    // no box to read: it takes the request as it is
  }
  return $.prompt.fill(W.reviewFillOf(draft, text))
}

/** Puts a review request in the prompt box, for the person to send (the pane's Review), what they had typed kept. */
function fillReview($: EngineInterface, text: string) {
  void fillAfterDraft($, text)
    .then(filled => $.ui.toast(filled.isFilled ? 'The review request is in your prompt; press Enter to send it.' : 'Could not fill the prompt.'))
    .catch(() => $.ui.toast('Could not fill the prompt.'))
}

/**
 * The page's Review, which it asked you to confirm: the request goes in the
 * prompt box where there is one (the terminal), after what you had typed
 * there, for you to send. Where the
 * surface draws its own composer (the Desktop app: `no_composer`) it goes to
 * the Orchestrator as your next prompt, which runs once Claude is free.
 */
async function sendReview($: EngineInterface, text: string, ackId: string): Promise<void> {
  let filled: PromptFillResult | undefined
  try {
    filled = await fillAfterDraft($, text)
  } catch {
    filled = undefined
  }
  const said = W.reviewStepOf(filled)
  if (said.kind === 'filled') {
    $.ui.toast('The review request is in your prompt; press Enter to send it.')
    await ackPage($, ackId, 'delivered', 'In your prompt box: press Enter to send it')
  } else if (said.kind === 'queue') {
    const isBusy = M.agentOf(data, M.MAIN)?.status === 'running'
    await queueForMain($, text, ackId, { status: 'queued', text: isBusy ? 'Claude reviews it when it finishes its current turn' : 'Claude reviews it now' })
    $.ui.toast(isBusy ? 'Review queued: Claude reviews the changes when it finishes its current turn.' : 'Review sent: Claude reviews the changes now.')
  } else {
    $.ui.toast('Could not fill the prompt.')
    await ackPage($, ackId, 'failed', said.why)
  }
}

/**
 * Prompts the deck submitted to the Orchestrator in your words. Each was
 * logged as your message when sent, so the turn it starts does not log it
 * again. Each is marked once its `prompt.submit` passes with the deck's own
 * origin.
 */
const deckPrompts: { text: string; isSubmitted: boolean }[] = []

/**
 * Your words to the Orchestrator from the deck: logged at once as your
 * message (its ack `told`: queued while Claude works, saying when it reads
 * them; delivered while it is idle), then submitted as your next prompt
 * (`asUser`: the model reads them bare), which runs once the session is
 * idle. A prompt a hook drops, or one that cannot be queued, fails its ack.
 */
async function queueForMain($: EngineInterface, text: string, ackId: string, told: { status: 'queued' | 'delivered'; text: string }): Promise<void> {
  const said = text.trim()
  const now = await $.clock.now()
  M.addMessage(data, { from: M.YOU, to: M.MAIN, kind: 'chat', text: said, at: now, ...(ackId ? { ackId } : {}) })
  const entry = { text: said, isSubmitted: false }
  deckPrompts.push(entry)
  if (deckPrompts.length > 20) deckPrompts.splice(0, deckPrompts.length - 20)
  await ackPage($, ackId, told.status, told.text)
  touched($, now)
  const forget = () => {
    const at = deckPrompts.indexOf(entry)
    if (at >= 0) deckPrompts.splice(at, 1)
  }
  void $.prompt.submit({ text: said, asUser: true }).then(
    result => {
      if (result.drop === undefined) return
      forget()
      void ackPage($, ackId, 'failed', `Not sent: ${F.trunc(F.oneLine(result.drop), 200)}`)
    },
    error => {
      forget()
      const why = error instanceof Error ? error.message : String(error)
      $.ui.toast(`Could not queue the prompt: ${why}`)
      void ackPage($, ackId, 'failed', `Could not queue it: ${F.trunc(F.oneLine(why), 200)}`)
    },
  )
}

/** The deck's prompt that `prompt.submit` passed with the deck's own origin and these words: marked, for its turn to know it. */
function markDeckPrompt(text: string) {
  const entry = deckPrompts.find(one => !one.isSubmitted && one.text === text.trim())
  if (entry) entry.isSubmitted = true
}

/** Whether a turn starts with one of the deck's own prompts (a marked one first, else any with the same text); if so it is removed, since it was logged already. */
function takeDeckPrompt(text: string): boolean {
  const said = text.trim()
  if (said === '') return false
  const marked = deckPrompts.findIndex(one => one.isSubmitted && one.text === said)
  const at = marked >= 0 ? marked : deckPrompts.findIndex(one => one.text === said)
  if (at < 0) return false
  deckPrompts.splice(at, 1)
  return true
}

async function restore($: EngineInterface, now: number): Promise<boolean> {
  try {
    const { value } = await $.state.get(SNAPSHOT)
    if (value && value.v === M.SNAPSHOT_VERSION) {
      data = M.healData(M.copyOf(value.data), now)
      B.heal(data)
      // healView builds a fresh view from the snapshot's fields: one missing or unknown takes its default
      view = M.healView(value.view, data)
      return true
    }
  } catch {
    // a missing or unreadable snapshot starts the deck over
  }
  return false
}


/**
 * The agents you messaged from the deck and are awaiting a reply from, by
 * id: when the message was sent (`since`), and whether one of their steps
 * has started since (`isRead`: they had the chance to read it). The first
 * step started after the message that says anything is the reply; if a run
 * read it and ended without a word for you, the entry is dropped. A reload
 * forgets them.
 */
const replies = new Map<string, { since: number; isRead: boolean }>()

/**
 * Your message to an agent, from the pane's Talk or the page's: to the
 * Orchestrator, logged and queued as your next prompt (`queueForMain`); to a
 * subagent or teammate, delivered to its inbox (`$.session.send`): it reads
 * it at its next step, and a finished one is woken by it. Its ack says which;
 * the agent's reply, its next words, is logged when it comes (`turn.step`).
 */
async function sendChatMessage($: EngineInterface, agentId: string, text: string, ackId = ''): Promise<void> {
  const agent = M.agentOf(data, agentId)
  const now = await $.clock.now()
  if (!agent) {
    await ackPage($, ackId, 'failed', 'No such agent in this session')
    return
  }

  if (agent.kind === 'main') {
    const isBusy = agent.status === 'running'
    // busy, it reads them once its turn ends; idle, at once
    await queueForMain($, text, ackId, isBusy ? { status: 'queued', text: 'Claude reads it when it finishes its current turn' } : { status: 'delivered', text: 'Claude reads it now' })
    $.ui.toast(isBusy ? 'Queued for the Orchestrator: it reads it when its current turn ends.' : 'Sent to the Orchestrator.')
    redrawDeck($)
    return
  }

  const sent = await $.session.send({ to: { agentId }, text }).catch(error => ({ isDelivered: false as const, reason: String(error) }))
  const message = M.addMessage(data, { from: M.YOU, to: agentId, kind: 'chat', text, at: now, isDelivered: sent.isDelivered, ...(ackId ? { ackId } : {}) })
  if (sent.isDelivered) {
    $.ui.toast(`Sent to ${W.rowTitleOf(agent)}`)
    if (M.isEnded(agent.status)) M.reopen(agent, now)
    replies.set(agentId, { since: now, isRead: false })
    await ackPage($, ackId, 'delivered', 'It reads it at its next step')
  } else if (isAutoModeRefusal(sent.reason)) {
    // auto mode takes no send from the deck: the Orchestrator passes your words on, and they stay in this agent's Talk
    await relayViaMain($, agent, text, ackId, message)
  } else {
    const why = undeliveredOf(sent.reason)
    $.ui.toast(why)
    await ackPage($, ackId, 'failed', why)
  }
  saveDeckState($)
  redrawDeck($)
}

/** What a refused send to a subagent says in auto mode, where Claude Code's classifier judges the deck's sends. */
const AUTO_MODE_REFUSAL = "Not delivered: in auto mode, Claude Code doesn't accept messages to subagents from the deck. Send it from the chat, or turn auto mode off for this chat."

/** Whether a send was refused by auto mode's classifier ("no verdict", "denied by the … classifier"): one the Orchestrator can pass on. */
function isAutoModeRefusal(reason: string | undefined): boolean {
  return /\bno verdict\b|\bclassifier\b|\bauto[- ]mode\b/i.test(F.oneLine(reason ?? ''))
}

/** A text's first sentence on one line, at most `most` characters, an error's own name left off; '' for none. */
function firstSentenceOf(text: string | undefined, most = 120): string {
  const said = F.oneLine(text ?? '').replace(/^\w*Error:\s*/, '')
  const first = /^.*?[.!?](?=\s|$)/.exec(said)?.[0] ?? said
  return F.trunc(first.trim(), most)
}

/**
 * A refused send in the deck's own words, never the engine's raw refusal
 * (an auto-mode classifier's holds words meant for the model): a refusal of
 * the auto-mode classifier says so plainly; any other its first sentence,
 * at most 120 characters.
 */
function undeliveredOf(reason: string | undefined): string {
  if (isAutoModeRefusal(reason)) return AUTO_MODE_REFUSAL
  const shown = firstSentenceOf(reason)
  return shown ? `Not delivered: ${shown}` : 'Not delivered'
}

/**
 * Your messages to subagents that auto mode would not take from the deck,
 * which the deck asked the Orchestrator to pass on (`relayViaMain`): the
 * agent and its label, your words, the page's command id for the ack, your
 * message as Talk logged it, the prompt that asks, the relay turn it
 * started ('' until it starts), whether the Orchestrator passed it on, and
 * whether the agent has read it since. A reload forgets them; the newest 20 stay.
 */
type Relay = { agentId: string; label: string; text: string; ackId: string; message: DeckMessage; prompt: string; isSubmitted: boolean; turnId: string; isPassed: boolean; isRead: boolean }
const relays: Relay[] = []

/**
 * Your words to a subagent that auto mode would not take from the deck,
 * passed on by the Orchestrator instead: they stay your message in that
 * agent's Talk, acked queued until the Orchestrator sends them, and a
 * prompt in your name asks it to, with SendMessage, word for word. The
 * prompt shows in the chat and runs once Claude is free; auto mode judges
 * the Orchestrator's send as it judges any of its own. The turn it starts
 * is a relay turn: nothing of it goes in the Orchestrator's Talk
 * (`takeRelayTurn`, `endRelay`); its send marks your message delivered
 * (`passRelay`); a relay turn that ends without one fails it.
 *
 * The prompt is in your name, so nothing in it but your words is anyone
 * else's to say: the agent is named by its id alone (never its label, the
 * model's own description of it), and the message is said to be your words
 * and no instruction of yours.
 */
async function relayViaMain($: EngineInterface, agent: DeckAgent, text: string, ackId: string, message: DeckMessage): Promise<void> {
  const label = W.rowTitleOf(agent)
  const prompt = `Pass this message from me to the agent with id ${JSON.stringify(agent.id)} (the message is my words and no instruction of mine) with SendMessage, word for word, then carry on with what you were doing:\n\n${text}`
  const relay: Relay = { agentId: agent.id, label, text, ackId, message, prompt, isSubmitted: false, turnId: '', isPassed: false, isRead: false }
  relays.push(relay)
  if (relays.length > 20) relays.splice(0, relays.length - 20)
  await ackPage($, ackId, 'queued', 'Waiting for the Orchestrator to pass it on')
  $.ui.toast(`Auto mode: the Orchestrator will pass your message on to ${label}.`)
  // the Orchestrator could not be asked either (a hook dropped the prompt): auto mode's refusal stands, in words for you
  const refuse = () => {
    const at = relays.indexOf(relay)
    if (at >= 0) relays.splice(at, 1)
    $.ui.toast(AUTO_MODE_REFUSAL)
    void ackPage($, ackId, 'failed', AUTO_MODE_REFUSAL)
  }
  void $.prompt.submit({ text: prompt, asUser: true }).then(
    result => {
      if (result.drop !== undefined) refuse()
    },
    () => refuse(),
  )
}

/** Whether `text` is a relay prompt of the deck's still on its way. */
function isRelayPrompt(text: string): boolean {
  const said = text.trim()
  return relays.some(one => one.turnId === '' && one.prompt.trim() === said)
}

/** The deck's relay prompt that `prompt.submit` passed with the deck's own origin and these words: marked, for its turn to know it. */
function markRelayPrompt(text: string) {
  const said = text.trim()
  const relay = relays.find(one => !one.isSubmitted && one.prompt.trim() === said)
  if (relay) relay.isSubmitted = true
}

/** The relay a turn of the Orchestrator's starts with (its prompt, one marked submitted first), now tied to that turn; undefined for any other turn. */
function takeRelayTurn(text: string, turnId: string): Relay | undefined {
  const said = text.trim()
  if (said === '') return undefined
  const waiting = relays.filter(one => one.turnId === '' && one.prompt.trim() === said)
  const relay = waiting.find(one => one.isSubmitted) ?? waiting[0]
  if (relay) relay.turnId = turnId || 'turn'
  return relay
}

/** The relay a send of the Orchestrator's to `agentId` passes on: the oldest not yet passed whose words the send holds. */
function passRelay(agentId: string, text: string): Relay | undefined {
  const sent = F.oneLine(text)
  return relays.find(one => !one.isPassed && one.agentId === agentId && F.oneLine(one.text) !== '' && sent.includes(F.oneLine(one.text)))
}

/** The Orchestrator sent your words on: your message is delivered and its agent awaited (its next words are its reply), said in the ack and a toast. */
async function relayPassed($: EngineInterface, relay: Relay, now: number): Promise<void> {
  relay.isPassed = true
  relay.message.isDelivered = true
  const agent = M.agentOf(data, relay.agentId)
  if (agent && M.isEnded(agent.status)) M.reopen(agent, now)
  replies.set(relay.agentId, { since: now, isRead: false })
  $.ui.toast(`Passed on to ${relay.label} by the Orchestrator.`)
  await ackPage($, relay.ackId, 'delivered', 'Passed on by the Orchestrator')
}

/** Whether what agent `to` received is your message the Orchestrator passed on (logged already, as yours): marked read, so it matches once. */
function isRelayEcho(to: string, text: string): boolean {
  const body = F.oneLine(M.unwrapMessage(text).text)
  const relay = relays.find(one => one.isPassed && !one.isRead && one.agentId === to && body.includes(F.oneLine(one.text)))
  if (relay) relay.isRead = true
  return relay !== undefined
}

/**
 * The Orchestrator's turn `turnId` ended: whether it was a relay turn. A
 * relay it started that was not passed on fails, saying so, with the first
 * sentence of the turn's answer when it has one.
 */
function endRelay($: EngineInterface, turnId: string, answer: string): boolean {
  const ended = relays.filter(one => one.turnId !== '' && one.turnId === (turnId || 'turn'))
  for (const relay of ended) {
    if (relay.isPassed) continue
    relays.splice(relays.indexOf(relay), 1)
    const first = firstSentenceOf(answer)
    $.ui.toast(`The Orchestrator didn't pass your message on to ${relay.label}.`)
    void ackPage($, relay.ackId, 'failed', first ? `The Orchestrator didn't pass it on. ${first}` : "The Orchestrator didn't pass it on")
  }
  return ended.length > 0
}

function usageOf(raw: Awaited<ReturnType<EngineInterface['session']['usage']>>): UsageInfo {
  return {
    startedAt: raw.startedAt,
    ...(raw.context.percent !== undefined ? { contextPercent: raw.context.percent } : {}),
    ...(raw.cost ? { costUsd: raw.cost.usd } : {}),
    limits: raw.rateLimits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed })),
  }
}

/**
 * How the session began, as Claude Code's SessionStart says it: a fork's
 * /cost total starts at the session it was forked from (which the engine
 * does not name), so its spend counts that one's; a fresh start, a resume
 * or a /clear is no fork. A compaction says nothing of it.
 */
function noteStart(source: string) {
  if (source === 'fork') data.isFork = true
  else if (source !== 'compact') delete data.isFork
}

async function loadUsage($: EngineInterface): Promise<void> {
  try {
    usage = usageOf(await $.session.usage())
    usageAt = await $.clock.now()
    redrawIfChanged($, usageAt)
  } catch {
    // the status line's figures are optional here
  }
}

/** Folds in what the engine lists: agents spawned before this module loaded, and each one's status. */
async function syncAgents($: EngineInterface): Promise<void> {
  let list: AgentInfo[]
  try {
    list = await $.agent.list()
  } catch {
    return
  }
  const now = await $.clock.now()
  let isChanged = false

  for (const info of list) {
    const isKnown = M.agentOf(data, info.id) !== undefined
    // the engine lists subagents and teammates alone: a row taken for housekeeping is a real agent
    const agent = M.ensureAgent(data, info.id, now, info.teammateId ? 'teammate' : 'agent')
    if (!isKnown) isChanged = true
    if (info.teammateId) agent.kind = 'teammate'
    if (agent.origin === 'engine' || agent.origin === undefined) agent.origin = agent.kind === 'teammate' ? 'teammate' : 'agent'
    if (info.description && !agent.description) agent.description = info.description
    if (info.type && (agent.type === 'subagent' || agent.type === '')) agent.type = info.type
    if (info.name && M.isNameless(agent)) agent.name = info.name
    if (info.parentId && (agent.parentId === undefined || agent.parentId === M.MAIN) && M.agentOf(data, info.parentId)) agent.parentId = info.parentId
    M.fixLabel(data, agent)
    const status = info.status as DeckStatus
    // a row the deck ended (its turn, SubagentStop, TeammateIdle) is not woken by a list that lags: its own next call does that
    const isEndedHere = agent.endedAt !== undefined && !M.isLive(agent.status) && M.isLive(status)
    if (agent.status !== status && !isEndedHere) {
      agent.status = status
      if (M.isEnded(status)) {
        agent.endedAt ??= now
        delete agent.current
        delete agent.todo
      }
      isChanged = true
    }
  }

  if (isChanged) touched($, now)
}

/** The most agents' transcripts one recovery pass reads. */
const RECOVER_MOST = 12

/**
 * Recovery's own state: a pass under way, the agents whose transcripts were
 * read (each once while this module runs), and whether the pane's first tick
 * has looked yet (it looks again each time the pane opens).
 */
const recovery = { isBusy: false, isPaneSeen: false, tried: new Set<string>() }

/**
 * Reads back what a reload can cost the deck. With no goal in hand, the
 * person's newest prompt in their own words becomes one (`M.recoverGoal`).
 * Each ended agent with no result (at most 12 a pass, the latest to end
 * first) takes the hand-back or last words its own transcript holds, unless
 * the read is denied. Run unawaited from session.start and the pane's first
 * tick, one pass at a time; what it fails at leaves the deck as it was.
 */
async function recoverLost($: EngineInterface): Promise<void> {
  if (recovery.isBusy) return
  recovery.isBusy = true
  try {
    const now = await $.clock.now()
    let isChanged = false
    if (!M.goalOf(data)) {
      try {
        const found = M.recoverGoal(await $.session.messages())
        // a prompt may have started a goal while the transcript was read
        if (found && !M.goalOf(data)) isChanged = M.noteRecoveredGoal(data, found, now) !== undefined
      } catch {
        // no goal recovered: the person's next prompt starts one
      }
    }
    const ids = M.unansweredOf(data)
      .map(agent => agent.id)
      .filter(id => !recovery.tried.has(id))
      .slice(0, RECOVER_MOST)
    for (const id of ids) {
      recovery.tried.add(id)
      try {
        const found = await $.session.messages({ agentId: id })
        const result = Array.isArray(found) ? M.recoverResult(found) : undefined
        // the row as it stands now: a result that came meanwhile stays
        const agent = M.agentOf(data, id)
        if (result && agent && M.isEnded(agent.status) && !agent.answer) isChanged = M.noteResult(data, agent, result.text, agent.endedAt ?? now, result.via) || isChanged
      } catch {
        // that agent stays without a result
      }
    }
    if (isChanged) deckChanged($)
  } catch {
    // recovery is a nicety: the deck goes on as it was
  } finally {
    recovery.isBusy = false
  }
}

/**
 * Every 2.5 seconds: folds in the agents' statuses and, while the pane is
 * open or the web deck is on, re-reads git and usage in the background (the
 * pane's history too). It draws only when the screen would change
 * (`redrawIfChanged`, the web deck's signal as well); events draw for themselves.
 */
async function deckTick($: EngineInterface): Promise<void> {
  await checkDebug($)
  const now = await $.clock.now()
  // workflow agents and housekeeping loops fold away: they keep nothing on screen live
  const isAnyLive = M.hasLiveAgents(data)
  // every session on this machine: this one's inbox, the others' files while they show, the one viewed (./registry)
  await SR.registryTick(now, isWebOn())
  // a loop of Claude Code's own at work may be an agent the deck has not placed (a reload lost its spawn): the list says
  if (isAnyLive || isPaneOpen || isSharing() || M.hasLiveEngineLoops(data)) await syncAgents($)
  if (isPaneOpen || isSharing()) {
    if (now - lastGitRead() > 6000) void refreshGit($)
    if (now - usageAt > 10_000) void loadUsage($)
  }
  // what the deck may stop: Claude Code's permission check asked again where its verdict is missing or old
  if (isPaneOpen || isWebOn()) probeStops($, now)
  // the page's words held for your Send: those past their ten minutes, or answers to a question that no longer waits, go unsent
  await pruneHeld($)
  // the pane's first tick looks again for what a reload lost (once a pass under way is done)
  if (!isPaneOpen) {
    recovery.isPaneSeen = false
  } else if (!recovery.isPaneSeen && !recovery.isBusy) {
    recovery.isPaneSeen = true
    void recoverLost($)
  }
  // with the pane shut, no agent at work and no web deck nothing of the deck's is on screen: the next event draws
  if (isPaneOpen || isAnyLive || isSharing()) redrawIfChanged($, now)
}

/** The terminal's height as its last drawing of the deck (the pane or the band) measured it; 0 until one has. */
let screenRows = 0

/** Keeps the terminal's height a drawing on the terminal measured. */
function noteScreen(surface: RenderSurface, viewport: { rows: number } | undefined) {
  if (surface === 'terminal' && viewport && viewport.rows > 0) screenRows = viewport.rows
}

/** The cells the docked pane asks for. */
const DOCK_COLUMNS = 120

async function openPane($: EngineInterface): Promise<boolean> {
  // on a terminal of known height, an inline pane no taller than it leaves room for (`openRowsFor`): past the terminal's height, every redraw leaves stray lines
  const rows = openRowsFor(screenRows)
  // docked beside a fullscreen transcript: 120 cells, where the Dashboard sets its sections side by side (the engine keeps a dock to 45% of the terminal)
  const opened = await $.ui.open({ id: PANE, title: 'Eagle Eye', focus: true, columns: DOCK_COLUMNS, ...(rows !== undefined ? { rows } : {}) })
  isPaneOpen = true
  void refreshGit($, true)
  void loadUsage($)
  void syncAgents($)
  if (view.commit) void loadCommit($, view.commit)
  return opened.isPlaced
}

function deckChanged($: EngineInterface) {
  saveDeckState($)
  redrawDeck($)
}

/** How long a scroll waits for the drawing a press asked for: the engine folds redraws to ten a second. */
const SCROLL_MS = 150

/**
 * Brings the element keyed `key` into the pane's view, its top at the
 * window's top (`block` start; `nearest` moves the least that shows it),
 * once the drawing that holds it is up: a press that changed the view draws
 * it again first. Tried once more a beat later when the engine says no (not
 * drawn yet); an engine without `$.ui.scroll` leaves the pane where it is.
 */
function scrollTo($: EngineInterface, key: string, block: 'start' | 'nearest' = 'start', tries = 2) {
  $.clock.after(SCROLL_MS, () => {
    noteMove(`${key} ${block}`)
    try {
      void $.ui.scroll({ to: { key }, in: PANE, block })
        .then(result => {
          if (result.deny !== undefined && tries > 1) scrollTo($, key, block, tries - 1)
        })
        .catch(() => undefined)
    } catch {
      // no scroll on this engine: the pane stays where it is
    }
  })
}

/**
 * Chat keeps to its newest message while you are at the pane's end, as a
 * chat does (./ui/v2/chat's `followStep`): whether Chat showed at the last
 * drawing, what it ended with then, and whether you are at the end. You
 * are there once Chat comes into view (its tab, `/eagle-eye chat`, `m`, Back to
 * it, a new filter) or you send from it, and while your own scrolling
 * (`ui.scroll`) leaves you there; not once you scroll up, by a row or more.
 */
export const chatFollow: ChatFollow = { isShown: false, end: '', isAtEnd: false }

/**
 * Takes the pane to its end, where the engine keeps it while the drawing
 * grows and nothing else moves it, once the drawing is up: unless, by then,
 * you scrolled away from the end, Chat left view or the list of sessions
 * dropped over it. It scrolls and never redraws, so a click in flight still
 * lands.
 */
function scrollToEnd($: EngineInterface) {
  $.clock.after(SCROLL_MS, () => {
    if (!chatFollow.isShown || !chatFollow.isAtEnd || SR.isListOpen()) return
    noteMove('end')
    try {
      void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
    } catch {
      // no scroll on this engine: the pane stays where it is
    }
  })
}

/**
 * Scrolls the pane to its top at once, before the screen being drawn now is
 * up. This releases the pane from Chat's end: once a window is scrolled to
 * its end, the engine and the Desktop keep it there through every later
 * draw, whatever it shows, until a scroll moves it. So the screen replacing
 * Chat neither opens at its bottom nor follows it as it grows. A
 * scroll-into-view that a press asked for lands after this.
 */
function scrollToStart($: EngineInterface) {
  noteMove('start')
  try {
    void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
  } catch {
    // no scroll on this engine: the pane stays where it is
  }
}

/**
 * At each drawing of the pane: Chat coming into view takes the pane to its
 * end, and something new at Chat's end does too while you were there; Chat
 * leaving view while the pane kept to its end takes it to the top of what
 * shows instead. While the list of sessions is dropped over the tabs, no
 * drawing moves the pane. Anything else leaves the pane to you.
 */
function keepChat($: EngineInterface, now: number) {
  const isListOpen = SR.isListOpen()
  const state = !isListOpen && view.v2.tab === 'chat' && view.page === '' ? shownV2Of(now) : null
  const step = followStep(chatFollow, state ? chatEndOf(state, view.v2.chatFilter) : null, isListOpen)
  if (step === 'end') scrollToEnd($)
  else if (step === 'start') scrollToStart($)
}

/**
 * `s`, the header's title or its count of sessions, `/eagle-eye sessions`:
 * opens the list of sessions over the tabs (./registry), or closes it. When
 * it opens, Chat stops keeping to its end (./ui/v2/chat's `listStep`): you
 * are up at the list, and no drawing moves the pane while it shows. A pane
 * that was kept at Chat's end scrolls to its top at once, where the list
 * opens, which releases it from the end the engine and the Desktop held it at.
 */
function toggleSessions($: EngineInterface) {
  SR.toggleList()
  if (SR.isListOpen() && listStep(chatFollow) === 'start') scrollToStart($)
}

/**
 * A file read only as a plain file (the registry's, a session folder's: one
 * another program of the person's could write into): a FIFO, a device, a
 * folder or a link there is refused, never waited on or read through.
 * The engine's read opens whatever is at the path, so a look comes first;
 * these folders are the person's own (0700), and only their own programs
 * could swap a file in between.
 */
async function readPlain($: EngineInterface, path: string): Promise<string> {
  const stat = await $.fs.stat(path)
  if (stat.isLink || stat.kind !== 'file') throw new Error('not a plain file')
  return $.fs.read(path)
}

/**
 * The whole text of message `id` the state cut (`isCut`), for an agent
 * page's Show more, as the web page's `/message/<id>` serves it: the deck's
 * own copy while it holds one (whole under 700 characters; a longer one's
 * kept until the web deck writes it), else the file the web deck wrote
 * (`<home>/web/<session>/messages/<id>.md`); in the sample, its own as read
 * (`demo.v2Files`), else its file (web/fixtures/v2/messages). `onRead` gets
 * it, or null; then the pane draws.
 */
async function readMessage($: EngineInterface, id: string, onRead: (text: string | null) => void): Promise<void> {
  let text: string | null = null
  if (/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    const own = view.isDemo ? undefined : data.messages.find(message => W.webIdOf(message.id) === id)
    const sampled = view.isDemo ? demo.v2Files.message(id) : null
    if (sampled !== null) text = sampled
    else if (own?.full !== undefined) text = own.full
    else if (own && own.isSaved !== true && Array.from(own.text).length < M.LIMITS.messageChars) text = own.text
    else {
      const root = `${$.plugin.root}`.replace(/[\\/]+$/, '')
      const dir = view.isDemo ? `${root}/web/fixtures/v2` : webDir() || W.webDirOf(homeDir(), sessionId)
      try {
        if (dir === '') throw new Error('no folder')
        text = await readPlain($, `${dir}/messages/${id}.md`)
      } catch {
        // not on disk: the deck's own cut is the most there is
        text = own ? own.text : null
      }
    }
  }
  try {
    onRead(text === null ? null : text.replace(/\r\n/g, '\n').trimEnd())
  } catch {
    // the pane goes on without it
  }
  redrawDeck($)
}

/**
 * Moves the pane's focus ring onto the Button keyed `key` (`$.ui.focus`; a
 * row the next drawing brings is waited for), then brings it into view. A
 * refusal (the pane does not hold the keys, no such row is drawn) leaves the
 * ring where it was.
 */
async function focusOn($: EngineInterface, key: string): Promise<void> {
  try {
    const moved = await $.ui.focus({ requestId: PANE, key })
    if (moved.deny !== undefined) return
    paneFocus = key
    scrollTo($, key, 'nearest')
  } catch {
    // no focus on this engine: the ring stays where it is
  }
}

/** The v2 state the pane shows: the sample's while it shows (null while it is read), else this session's. */
function shownV2Of(now: number): W.WebStateV2 | null {
  return view.isDemo ? demoShown() : v2Of(now)
}

/** The ring a row down (1) or up (-1) among `keys`, else among the rows the v2 screen draws (`W.focusKeysOf`); held at either end. Chat and an agent's page move it onto their composer this way; no key is bound to it. */
async function moveFocusNext($: EngineInterface, dir: 1 | -1, keys?: readonly string[]): Promise<void> {
  const state = keys ? null : shownV2Of(await $.clock.now())
  const rows = keys ?? (state ? W.focusKeysOf(state, view.v2, view.page) : [])
  const key = W.focusStepOf(rows, paneFocus, dir)
  if (key !== '' && key !== paneFocus) await focusOn($, key)
}

/** Now (off an agent's page and Inspect): the ring on the next thing that needs you, after the one it is on, round to the first. No key is bound to it. */
async function moveFocusToNeed($: EngineInterface): Promise<void> {
  const state = shownV2Of(await $.clock.now())
  const key = state ? W.nextNeedKeyOf(state, paneFocus) : ''
  if (key === '') {
    $.ui.toast('Nothing needs you')
    return
  }
  if (view.v2.tab !== 'now' || view.page !== '') {
    view.page = ''
    view.v2 = M.view2With(view.v2, { tab: 'now' })
    deckChanged($)
  }
  await focusOn($, key)
}

/** The closures the views' buttons and fields run. */
function actionsFor($: EngineInterface): DeckActions {
  return {
    openAgent: id => {
      view.page = id
      lastAgent = id
      deckChanged($)
    },
    back: () => {
      view.page = ''
      deckChanged($)
    },
    // Now's sections fold to their heads, and the choice stays (the view's `collapsed`)
    toggleSection: id => {
      view.collapsed = M.collapsedWith(view.collapsed, id)
      deckChanged($)
    },
    answer: (callId, answers) => (view.isDemo ? void answerInSample($, callId, answers) : answerFromPane($, callId, answers)),
    redraw: () => redrawDeck($),
    loadMessage: (id, onRead) => void readMessage($, id, onRead),
    reveal: (key, block) => scrollTo($, key, block),
    exitDemo: () => {
      SR.showHere()
      leaveDemo()
      view.page = ''
      deckChanged($)
    },
    // the v2 screens' own state: each field checked as a reload checks it; Changes reads the file it shows again
    setV2View: patch => {
      // a tab pressed over the list of sessions leaves it for that tab
      if (patch.tab !== undefined) SR.closeList()
      // Chat opened by a press (its tab, m) or filtered anew: the next drawing takes the pane to its newest message
      if (patch.tab === 'chat' || (patch.chatFilter !== undefined && patch.chatFilter !== view.v2.chatFilter)) chatFollow.isShown = false
      view.v2 = M.view2With(view.v2, patch)
      if (view.v2.tab === 'changes' && view.file && currentGit().isRepo) void loadFileDiff($, view.file)
      deckChanged($)
    },
    // j and k: the focus a row down or up; n: the next thing that needs you
    focusNext: (dir, keys) => void moveFocusNext($, dir, keys),
    focusNeed: () => void moveFocusToNeed($),
    // Changes' picks and Follow the work: the repository it shows pinned, or let follow the work again; the sample's are a recording
    selectRepo: root => (view.isDemo ? $.ui.toast('Sample data: Changes shows the sample’s repository. Back to this chat to pick one of yours.') : void chooseRepo($, root).then(why => why && $.ui.toast(why))),
    selectFile: path => {
      view.file = view.file === path ? '' : path
      closeFileDiff()
      if (view.file && currentGit().isRepo) void loadFileDiff($, path)
      deckChanged($)
    },
    selectCommit: hash => {
      view.commit = view.commit === hash ? '' : hash
      closeCommit()
      if (view.commit) void loadCommit($, hash)
      deckChanged($)
    },
    toggleBand: () => {
      view.isBandHidden = !view.isBandHidden
      savePrefs($)
      deckChanged($)
    },
    setAvatarStyle: style => applyAvatarStyle($, style),
    // the deck's own tidying, nothing in Claude Code: finished agents hidden, or shown again
    clearFinished: () => void clearFinishedAgents($),
    showCleared: () => void showClearedAgents($),
    // Stop, Stop turn and Cancel: Claude Code's own TaskStop, $.turn.abort and CronDelete; the sample stops nothing
    stopAgent: id => (view.isDemo ? $.ui.toast('Sample data: nothing is stopped. Back to this chat to stop your agents.') : void stopAgentRun($, id)),
    abortTurn: () => (view.isDemo ? $.ui.toast('Sample data: nothing is stopped. Back to this chat to stop your turn.') : void abortMainTurn($, data.mainTurnId ?? '')),
    stopBackground: id => (view.isDemo ? $.ui.toast('Sample data: nothing is stopped. Back to this chat to stop your background work.') : void stopBackgroundTask($, id)),

    // the sample's chat sends nothing: its agents are a recording, and its Orchestrator is not this session's
    // a send from the pane's composer carries an id: its ack says what came of it, under the message; Chat keeps to its end, where it shows
    sendChat: (agentId, text, ackId) => {
      if (view.isDemo) {
        $.ui.toast('Sample data: nothing is sent. Back to this chat to talk to your agents.')
        return
      }
      chatFollow.isAtEnd = true
      void sendChatMessage($, agentId, text, W.cmdIdOf({ id: ackId }))
    },
    review: text => fillReview($, text),
    // every session on this machine (./registry): the list dropped over the tabs (`s`), and any session's deck shown in this one's place (here's again: this deck's own)
    openSessions: () => toggleSessions($),
    closeSessions: () => SR.closeList(),
    openSession: id => void SR.openSession(id, view.isDemo),
    // the band's Open: this session's deck on that tab, off a page
    open: tab => {
      SR.showHere()
      leaveDemo()
      view.v2 = M.view2With(view.v2, { tab })
      view.page = ''
      deckChanged($)
      void openPane($)
    },
    openBrowser: () => void openOwnBrowser($),
    openBrowserPane: () => void openWeb($, 'pane'),
    // the band's rows of what the Browser pane's page sent in your voice (./hold): your Send runs it, Discard drops it, More shows it whole
    sendHeld: key => sendHeldMessage($, key),
    discardHeld: key => discardHeldMessage($, key),
    toggleHeld: key => toggleHeldMessage($, key),
  }
}

function kitOf(ui: ReturnType<EngineInterface['ui']['resolve']>, surface: Kit['surface'], columns: number, rows?: number): Kit {
  return {
    surface,
    ...(rows !== undefined ? { rows } : {}),
    Box: ui.Box,
    Text: ui.Text,
    Button: ui.Button,
    Code: ui.Code,
    Markdown: ui.Markdown,
    columns,
    avatarStyle: view.avatarStyle,
    ...('Input' in ui ? { Input: ui.Input } : {}),
    ...('Select' in ui ? { Select: ui.Select } : {}),
    // the terminal's table answers to Svg but draws nothing for it: there the screens draw text
    ...('Svg' in ui && surface !== 'terminal' ? { Svg: ui.Svg } : {}),
    hasSurfaceModules: surface === 'desktop' && 'Client' in ui,
  }
}

/** What the pane draws from: this session's v2 state and its lazy files, or the sample's while it shows (with the sample's sessions); whether Org's chart fell silent on `surface`, the agent it marks, and what to call when the drawing holds its Client; another session's deck while one is viewed. */
function dashOf(now: number, surface: RenderSurface, $: EngineInterface, onOrgClient?: () => void): DashModel {
  const isDemo = view.isDemo
  const sample = isDemo ? demoShown() : null
  const sampleSessions = sample ? SR.sessionsFor(null, now) : null
  return {
    v2: isDemo ? (sample && sampleSessions ? { ...sample, sessions: sampleSessions } : sample) : v2Of(now),
    viewing: SR.viewingFor(modelOf(now), actionsFor($)),
    v2Files: isDemo ? demo.v2Files : W.v2FilesOf(data, currentGitDiffs()),
    isDemo,
    demoNote: demo.note,
    isOrgDown: isOrgDownOn(surface),
    ...(onOrgClient ? { onOrgClient } : {}),
    selected: lastAgent,
  }
}

/** Listens for the beat of Org's chart Client on a surface: silent, that surface's Org lists the agents as a tree until Org is left (or /eagle-eye opens). */
function listenForChart($: EngineInterface, surface: RenderSurface) {
  listenForBeat($, chartBeats, surface, () => {
    orgDown.add(surface)
    redrawDeck($)
  })
}

/**
 * What Org's chart Client posted: `{ type: 'open', id }` for a card clicked
 * opens that agent's page, when the pane shows that agent (this session's,
 * or the sample's). Anything else is let go: it came from code.
 */
async function openFromChart($: EngineInterface, posted: unknown): Promise<void> {
  if (typeof posted !== 'object' || posted === null) return
  const { type, id } = posted as { type?: unknown; id?: unknown }
  if (type !== 'open' || typeof id !== 'string') return
  const state = shownV2Of(await $.clock.now())
  if (!state?.agents.some(row => row.row === 'agent' && row.id === id)) return
  view.page = id
  lastAgent = id
  deckChanged($)
}

/** Leaves the sample: the pane shows this session again. */
export function leaveDemo() {
  SR.leaveSample()
  if (!view.isDemo && demo.v2 === null) return
  view.isDemo = false
  demo.v2 = null
  demo.v2Files = W.v2FilesFrom({ agents: {}, patches: {}, messages: {} })
  demo.note = ''
  demo.version += 1
}

/**
 * The v2 sample's lazy files under `dir` (web/fixtures/v2): each agent's
 * file its rows name (its times moved by `by`, as the state's were), each
 * edit's patch, each cut message's whole text. One that cannot be read is
 * left out: its screen says so.
 */
async function readV2Sample($: EngineInterface, dir: string, state: W.WebStateV2, by: number): Promise<W.V2Files> {
  const isSafe = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id)
  const agents: Record<string, W.V2AgentFile> = {}
  const patches: Record<string, string> = {}
  const messages: Record<string, string> = {}
  const gitDiffsRead: Record<string, string> = {}
  let timeline: T.V2Timeline | null = null
  const read = async (path: string, keep: (text: string) => void) => {
    try {
      keep(await $.fs.read(path))
    } catch {
      // not in the sample: left out
    }
  }
  await Promise.all([
    ...state.agents.flatMap(row =>
      row.row === 'agent' && isSafe(row.fileId)
        ? [
            read(`${dir}/agents/${row.fileId}.json`, text => {
              agents[row.fileId] = W.v2TimesMoved(JSON.parse(text) as W.V2AgentFile, by)
            }),
          ]
        : [],
    ),
    ...state.changes.edits.filter(edit => isSafe(edit.id)).map(edit => read(`${dir}/patches/${edit.id}.diff`, text => (patches[edit.id] = text.replace(/\r\n/g, '\n')))),
    ...state.chat.filter(row => row.isCut && isSafe(row.id)).map(row => read(`${dir}/messages/${row.id}.md`, text => (messages[row.id] = text.replace(/\r\n/g, '\n').trimEnd()))),
    ...state.changes.files.flatMap(file => (file.diffId !== null && isSafe(file.diffId) ? [file.diffId] : [])).map(id => read(`${dir}/gitdiffs/${id}.diff`, text => (gitDiffsRead[id] = text.replace(/\r\n/g, '\n')))),
    read(`${dir}/timeline.json`, text => (timeline = T.timelineFromText(text, by))),
  ])
  return W.v2FilesFrom({ agents, patches, messages, gitDiffs: gitDiffsRead, timeline })
}

/**
 * `/eagle-eye demo`, or a reload while the sample showed: reads the v2 sample
 * under the mod's folder (web/fixtures/state.v2.json, then the lazy files
 * its state names under web/fixtures/v2) and shows it, its times moved to
 * now. `isFresh` opens it on Now; a reload keeps the tab and page it was on.
 * Answers why it could not be read; '' once it shows.
 */
async function loadDemo($: EngineInterface, isFresh: boolean): Promise<string> {
  const root = `${$.plugin.root}`.replace(/[\\/]+$/, '')
  view.isDemo = true
  if (isFresh) {
    view.page = ''
    view.v2 = M.view2With(view.v2, { tab: 'now' })
  }
  demo.v2 = null
  demo.v2Files = W.v2FilesFrom({ agents: {}, patches: {}, messages: {} })
  demo.note = ''
  demo.version += 1
  redrawDeck($)
  const readAt = await $.clock.now()
  let shown: W.WebStateV2 | null = null
  let files: W.V2Files | null = null
  // the sample's other sessions, for its All sessions (`s`)
  void SR.readSample(root, readAt)
  try {
    const text = await $.fs.read(`${root}/web/fixtures/state.v2.json`)
    shown = W.v2StateFromText(text, readAt)
    if (shown) files = await readV2Sample($, `${root}/web/fixtures/v2`, shown, readAt - (JSON.parse(text) as { now: number }).now)
  } catch {
    shown = null
  }
  // left (or loaded afresh) while it was read
  if (!view.isDemo || demo.v2 !== null) return ''
  if (!shown) {
    demo.note = 'The sample could not be read: web/fixtures/state.v2.json is missing, or not a deck state.'
    demo.version += 1
    redrawDeck($)
    return demo.note
  }
  const isPage = (id: string) => shown?.agents.some(row => row.row === 'agent' && row.id === id) === true
  demo.v2 = shown
  if (files) demo.v2Files = files
  if (view.page !== '' && !isPage(view.page)) view.page = ''
  demo.version += 1
  deckChanged($)
  return ''
}

/** The state a drawing reads: the live model, as it is now; the views build their rows from it. */
function modelOf(now: number): DeckModel {
  return {
    data,
    view,
    git: currentGit(),
    fileDiff: currentFileDiff(),
    commit: currentCommit(),
    usage,
    now,
    cwd,
    web: webPaneOf(),
    // what the band says: this session's, never the sample's
    band: W.bandOf(v2Of(now)),
    held: H.heldRowsOf(heldQueue().items, heldQueue().open),
    isSessionsOpen: SR.isListOpen(),
  }
}

/**
 * What the registry of sessions (./registry) reads of this deck: its id, its
 * state, its folder, its process, the plugin's store (where the person's
 * key for the registry's seals is kept); a command another session's deck
 * sent runs here as the page's own would (`steerFromSession`).
 */
function registryHost($: EngineInterface): SR.RegistryHost {
  const read = async (get: () => Promise<string | undefined>) => {
    try {
      return await get()
    } catch {
      // nothing answers (the tests): unset
      return undefined
    }
  }
  return {
    env: async () => ({
      override: await read(() => $.env.get('EAGLE_EYE_SESSIONS')),
      eagleEyeHome: await read(() => $.env.get('EAGLE_EYE_HOME')),
      configDir: await read(() => $.env.get('CLAUDE_CONFIG_DIR')),
      home: (await read(() => $.env.get('USERPROFILE'))) ?? (await read(() => $.env.get('HOME'))),
      wtSession: await read(() => $.env.get('WT_SESSION')),
      termProgram: await read(() => $.env.get('TERM_PROGRAM')),
    }),
    now: () => $.clock.now(),
    read: path => readPlain($, path),
    write: (path, text) => $.fs.write(path, text),
    list: path => $.fs.list(path),
    stat: path => $.fs.stat(path),
    storeGet: key => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    alive: pids => $.process.run(['node', `${`${$.plugin.root}`.replace(/[\\/]+$/, '')}/web/alive.js`, ...pids], { timeoutMs: 10_000, ...(nodeCwd() ? { cwd: nodeCwd() } : {}) }),
    remove: paths => $.process.run(['node', `${`${$.plugin.root}`.replace(/[\\/]+$/, '')}/web/remove.js`, ...paths], { timeoutMs: 10_000, ...(nodeCwd() ? { cwd: nodeCwd() } : {}) }),
    every: (ms, fn) => $.clock.every(ms, fn),
    after: (ms, fn) => $.clock.after(ms, fn),
    surfaces: () => $.session.surfaces(),
    repoRoot: async () => (await $.session.repo())?.root ?? null,
    sessionId: () => sessionId,
    stateOf: now => v2Of(now),
    dirOf: () => webDir() || (sessionId !== '' ? W.webDirOf(homeDir(), sessionId) : ''),
    pidOf: () => sessionPidOf($),
    steer: cmd => steerFromSession($, cmd),
    hasAck: id => data.acks.some(one => one.id === id),
    ack: (id, status, text) => void ackPage($, id, status, text),
    changed: () => deckChanged($),
    refresh: now => redrawIfChanged($, now),
    // a deck views this session: its folder written from now, as for /eagle-eye web
    share: () => shareWeb($),
    toast: text => $.ui.toast(text),
  }
}

/**
 * A command another session's deck sent (its inbox, ./registry): one of
 * `SE.STEERING`, each field checked (`SE.steeringCmdOf`), runs exactly as
 * the page's own (`runCommand`: an answer, a message, Stop, Stop turn,
 * Cancel, Clear finished, a pick of Changes, Review), through Claude Code's
 * channels and with the same checks, its ack in this session's state; any
 * other is refused, its ack saying why.
 */
function steerFromSession($: EngineInterface, cmd: Record<string, unknown>) {
  const said = SE.steeringCmdOf(cmd)
  if (said) runCommand($, said)
  else void ackPage($, W.cmdIdOf(cmd), 'failed', SE.steeringRefusalOf(cmd))
}

function editedPathOf(input: Record<string, unknown>): string {
  return typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
}

/** A tool's `structuredPatch` (or a bashEditDiff file's hunks) as the deck's hunks, each line cleaned. */
function hunksFrom(value: unknown): Hunk[] {
  const patch = Array.isArray(value) ? (value as unknown[]) : []
  return patch
    .filter((hunk): hunk is Record<string, unknown> => typeof hunk === 'object' && hunk !== null)
    .map(hunk => ({
      oldStart: Number(hunk.oldStart) || 0,
      oldLines: Number(hunk.oldLines) || 0,
      newStart: Number(hunk.newStart) || 0,
      newLines: Number(hunk.newLines) || 0,
      lines: Array.isArray(hunk.lines) ? hunk.lines.map(line => F.clean(String(line))) : [],
    }))
}

/**
 * Records exactly what an Edit, Write or NotebookEdit changed, from the
 * tool's own patch, under `abs`, the file's path as the file system spells
 * it (`realPathOf`), so it compares with git's; and whether the person
 * changed the proposed edit before accepting it (`userModified`).
 */
function recordEdit(agent: DeckAgent, tool: string, id: string, input: Record<string, unknown>, ran: ToolCallResult, now: number, abs: string) {
  if (!abs) return
  const record = (ran.result ?? null) as Record<string, unknown> | null
  if (record && record.staged === true) return

  let hunks: Hunk[] = hunksFrom(record?.structuredPatch)
  const isNew = tool === 'Write' && record?.type === 'create'

  if (hunks.length === 0) {
    if (tool === 'Write' && isNew) hunks = addedFileHunks(String(input.content ?? ''))
    else if (tool === 'Edit') hunks = replaceHunks(String(input.old_string ?? ''), String(input.new_string ?? ''))
    else if (tool === 'NotebookEdit') hunks = addedFileHunks(String(input.new_source ?? ''))
  }

  const { added, removed } = countOf(hunks)
  M.addEdit(data, agent, {
    id,
    agent: agent.id,
    tool,
    path: M.relOf(abs, currentGit().root || null),
    abs: M.normPath(abs),
    at: now,
    added,
    removed,
    patch: patchOf(hunks, M.LIMITS.patchChars),
    isNew,
    ...(record?.userModified === true ? { userModified: true } : {}),
  })
  // the next git refresh probes a directory not seen before, and follows the repository edited last
  R.noteEdit(repoBook(), abs, now)
}

/**
 * Records the files a Bash command changed, from its result's
 * `bashEditDiff` (feature-detected: an internal field, absent on builds
 * without it, and skipped when it says the diff is unavailable): one edit
 * per file, with that file's exact hunks. Answers how many it recorded.
 */
async function recordShellEdits($: EngineInterface, agent: DeckAgent, tool: string, id: string, ran: ToolCallResult, now: number): Promise<number> {
  const record = (ran.result ?? null) as Record<string, unknown> | null
  const diff = record && typeof record.bashEditDiff === 'object' && record.bashEditDiff !== null ? (record.bashEditDiff as Record<string, unknown>) : null
  if (!diff || diff.unavailable === true || diff.skipped === true || !Array.isArray(diff.files)) return 0
  let count = 0
  for (const file of diff.files as unknown[]) {
    if (typeof file !== 'object' || file === null) continue
    const one = file as Record<string, unknown>
    if (typeof one.filePath !== 'string' || one.filePath === '') continue
    const abs = await realPathOf($, one.filePath)
    const hunks = hunksFrom(one.hunks)
    const { added, removed } = countOf(hunks)
    M.addEdit(data, agent, {
      id: `${id}:${count}`,
      agent: agent.id,
      tool,
      path: M.relOf(abs, currentGit().root || null),
      abs: M.normPath(abs),
      at: now,
      added,
      removed,
      patch: patchOf(hunks, M.LIMITS.patchChars),
      isNew: one.created === true,
    })
    R.noteEdit(repoBook(), abs, now)
    count += 1
  }
  return count
}

// Held on you: the questions the deck may answer, and the permission prompts it shows.

/** The `tool.call` hook's own argument and chain, as `raceDeck` takes them. */
type ToolCallEvent = Parameters<Events['tool.call']>[1]
type ToolCallNext = Parameters<Events['tool.call']>[2]

/** The deck's answer to a question: the answers by question, as the dialog gives them, and the id of the page's command for its ack. */
type DeckAnswer = { answers: Record<string, string>; ackId: string }

/**
 * The questions the deck may answer, by the AskUserQuestion call's
 * tool_use_id: what settles that call's race with the deck's answer
 * (`raceDeck`). Like `web.waiters`, it lives in this module alone: a reload
 * drops every one, so a question restored from the snapshot is shown, never
 * answered from the page (`isAnswerable`).
 */
const askers = new Map<string, (answer: DeckAnswer) => void>()

/** How a question's race ended: the deck answered, Claude Code did (its dialog, or its idle timer), or the call went unanswered (dismissed, failed, abandoned). */
type QuestionEnd = 'deck' | 'engine' | 'idle' | 'gone'

/** How the latest questions ended, by call id: what an answer from the page that comes too late is told. */
const questionEnds = new Map<string, QuestionEnd>()

/** The tool calls in flight whose start this module saw. Their ends are still to come, so a note that one of them is waiting on you is never stale. */
const openCalls = new Set<string>()

/**
 * The real calls that reached Claude Code's permission check (`tool.check`),
 * by tool_use_id, until they end. One becomes a permission prompt waiting on
 * you when its dialog is asked for (`classic.PermissionRequest`). A check
 * alone proves nothing: most are allowed, and the auto-mode classifier and a
 * headless host settle asks too.
 */
const asks = new Map<string, { tool: string; input: unknown; agentId: string }>()

/** The tools whose dialog is the person's own say (a question, a plan to approve): never a permission prompt. */
const PERSON_TOOLS: readonly string[] = ['AskUserQuestion', 'ExitPlanMode']

/** The most asks and question ends kept: beyond, the oldest go. */
const MOST_KEPT = 100

function keepAtMost<K, V>(map: Map<K, V>, most: number) {
  for (const key of map.keys()) {
    if (map.size <= most) return
    map.delete(key)
  }
}

/** Plain data in one spelling whatever its keys' order: how a permission dialog's input is matched to its call's. */
function sameValue(a: unknown, b: unknown): boolean {
  const spell = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(spell)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter(([, one]) => one !== undefined)
              .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
              .map(([key, one]) => [key, spell(one)]),
          )
        : value
  return JSON.stringify(spell(a)) === JSON.stringify(spell(b))
}

/** The deck's own tool calls in flight (`$.tool.call`), by tool and input: their permission checks are no call of Claude's, so Inspect and the prompts leave them out. */
const ownCalls: { tool: string; input: unknown }[] = []

/** Whether a permission check for `tool` with `input` is for one of the deck's own calls in flight. */
function isOwnCall(tool: string, input: unknown): boolean {
  return ownCalls.some(one => one.tool === tool && sameValue(one.input, input))
}

/** The verdicts being asked for (`watchCheck`), by call id, until each is recorded: a dialog for the call waits for its own (`watchDialog`). */
const checking = new Map<string, Promise<void>>()

/**
 * A real call reached Claude Code's permission check (`tool.check`). The
 * call is kept at once as one a dialog may show for (`asks`): the deck's
 * own calls, a query (no call id) and the tools whose dialog is the
 * person's own answer (a question, a plan) are left out. Its verdict is
 * then asked for apart from the hook, which passes the real one on unread.
 */
function watchCheck($: EngineInterface, check: { tool: string; input: unknown; tool_use_id?: string; agentId?: string; approver?: string }): Promise<void> {
  const id = check.tool_use_id ?? ''
  if (id === '' || isOwnCall(check.tool, check.input)) return Promise.resolve()
  if (!PERSON_TOOLS.includes(check.tool)) {
    asks.set(id, { tool: check.tool, input: check.input, agentId: check.agentId ?? M.MAIN })
    keepAtMost(asks, MOST_KEPT)
  }
  const asked = recordCheck($, check)
  checking.set(id, asked)
  keepAtMost(checking, MOST_KEPT)
  return asked
}

/**
 * Inspect's permissions log for a real call: Claude Code's verdict on it,
 * from a query of the deck's own (`$.tool.check`: the same rules, mode and
 * mods' hooks, no tool run, no dialog). A query runs no settings hook and
 * sits outside the agent's loop, so a verdict a PreToolUse hook made, or a
 * subagent's own mode, reads here as the session's rules alone give it.
 */
async function recordCheck($: EngineInterface, check: { tool: string; input: unknown; tool_use_id?: string; agentId?: string; approver?: string }): Promise<void> {
  try {
    const said = await $.tool.check({ tool: check.tool, input: check.input })
    const verdict = { decision: said.decision, reason: said.reason, rule: said.rule, hook: said.hook, setting: said.setting, plugin: said.plugin }
    const isNoted = await inspectCheck($, data, check, verdict, false, currentGit().root || null)
    if (isNoted) touched($, await $.clock.now())
  } catch {
    // no verdict to show: the call's own stands whatever the deck makes of it
  } finally {
    if (check.tool_use_id) checking.delete(check.tool_use_id)
  }
}

/**
 * A permission dialog is asked for (`classic.PermissionRequest`): Inspect
 * marks the call's decision as put to you, and the call is held on you
 * until it ends or is denied. The hook passes the request on unread, so a
 * settings hook that answers in the dialog's place is not told apart: the
 * call it settles ends, or is denied, and stops waiting then.
 */
async function watchDialog($: EngineInterface, asking: { tool_name: string; tool_input: unknown; agent_id?: string; permission_mode?: unknown; effort?: unknown }): Promise<void> {
  try {
    const agentId = asking.agent_id ?? M.MAIN
    const id = askFor(asking.tool_name, asking.tool_input, agentId)
    if (id !== undefined) await checking.get(id)
    if (inspectDialog(data, id, {}, asking)) touched($, await $.clock.now())
    const asked = id !== undefined ? asks.get(id) : undefined
    if (id !== undefined && asked && openCalls.has(id)) {
      const now = await $.clock.now()
      M.notePending(data, M.permissionOf({ id, tool: asked.tool, input: asked.input, agentId, at: now }, currentGit().root || null))
      touched($, now)
    }
  } catch {
    // the dialog shows whatever the deck makes of it
  }
}

/**
 * The call a permission dialog is for: the ask whose tool, input and loop
 * match the dialog's (`tool_name`, `tool_input`, `agent_id`), the oldest
 * first; with none exact, the one ask of that tool in that loop. Undefined
 * when none can be told, or the call is noted held already.
 */
function askFor(tool: string, input: unknown, agentId: string): string | undefined {
  const free = [...asks.entries()].filter(([id, one]) => one.tool === tool && one.agentId === agentId && !data.pending.some(item => item.id === id))
  const exact = free.find(([, one]) => sameValue(one.input, input))
  if (exact) return exact[0]
  return free.length === 1 ? free[0]?.[0] : undefined
}

/**
 * An AskUserQuestion call, raced. Its question is held on you (`pending`,
 * its questions as the call gave them) and said in the asking agent's Talk;
 * the dialog gets a line saying the deck answers too (where it takes one).
 * Then the dialog runs beneath (`next`, called once: each call would open it
 * again) while the page may answer: the deck's answer returns `{ result }`
 * with the call's own `questions` passed through unchanged (the tool's
 * output schema checks it), which cancels the dialog beneath; Claude Code's
 * answer, or its idle timer's, returns what the dialog gave. An abandoned
 * call (`next.signal`: an interrupt, a hook above settling first) ends the
 * race with nothing answered. However it ends, the question is taken down,
 * Talk says how it was answered, and the page's command, if one came, is
 * told what came of it.
 */
async function raceDeck($: EngineInterface, ev: ToolCallEvent, proceed: ToolCallNext, agentId: string, at: number): Promise<ToolCallResult> {
  const id = ev.tool_use_id
  const input = ev as unknown as Record<string, unknown>
  const questions = M.questionsOf(input.questions)
  // nothing the deck could show: the dialog alone
  if (!id || questions.length === 0) return proceed(ev)

  try {
    M.notePending(data, { id, agentId, kind: 'question', tool: 'AskUserQuestion', at, questions })
    M.addMessage(data, { from: agentId, to: M.YOU, kind: 'question', text: M.questionsTextOf(questions), at, callId: id })
    touched($, at)
  } catch {
    // the dialog asks whatever the deck makes of it
  }
  if (isWebOn()) {
    try {
      $.ui.notice(id, 'Also answerable in Eagle Eye')
    } catch {
      // a dialog that takes no line: the page answers all the same
    }
  }

  type Won = { by: 'deck'; answer: DeckAnswer } | { by: 'engine'; ran: ToolCallResult } | { by: 'failed'; error: unknown } | { by: 'abort' }
  // an answer from the page that lands while Claude Code's is settling loses, and is told so
  const late: { answer?: DeckAnswer } = {}
  let settle: ((won: Won) => void) | undefined
  const onAbort = () => settle?.({ by: 'abort' })
  const below = proceed(ev)
  // when the deck answers first the dialog's own end is abandoned, its rejection too
  below.catch(() => undefined)
  const won = await new Promise<Won>(resolve => {
    settle = resolve
    askers.set(id, answer => {
      late.answer = answer
      resolve({ by: 'deck', answer })
    })
    below.then(
      ran => resolve({ by: 'engine', ran }),
      error => resolve({ by: 'failed', error }),
    )
    if (proceed.signal.aborted) resolve({ by: 'abort' })
    else proceed.signal.addEventListener('abort', onAbort, { once: true })
  })
  askers.delete(id)
  proceed.signal.removeEventListener('abort', onAbort)

  const answered = won.by === 'deck' ? won.answer : undefined
  const ran: ToolCallResult = answered
    ? ({ result: { questions: input.questions, answers: answered.answers } } as ToolCallResult)
    : won.by === 'engine'
      ? won.ran
      : { deny: 'The question was left unanswered' }
  const said = won.by === 'engine' && won.ran.deny === undefined && won.ran.isError !== true ? M.questionResultOf(won.ran.result) : undefined
  const end: QuestionEnd = answered ? 'deck' : said ? (said.isIdle ? 'idle' : 'engine') : 'gone'
  questionEnds.set(id, end)
  keepAtMost(questionEnds, MOST_KEPT)
  try {
    const now = await $.clock.now()
    M.dropPending(data, id)
    if (answered) {
      M.addMessage(data, { from: M.YOU, to: agentId, kind: 'choice', text: `You answered: ${M.answeredOf(questions, answered.answers)}`, at: now, callId: id, ...(answered.ackId ? { ackId: answered.ackId } : {}) })
      await ackPage($, answered.ackId, 'answered', 'Claude carries on')
    } else if (said) {
      const words = M.answeredOf(questions, said.answers) || F.oneLine(said.response)
      const how = said.isIdle ? 'Auto-answered after idle' : 'Answered in Claude Code'
      M.addMessage(data, { from: M.YOU, to: agentId, kind: 'choice', text: words ? `${how}: ${words}` : how, at: now, callId: id })
    }
    if (!answered && late.answer) await ackPage($, late.answer.ackId, 'failed', end === 'idle' ? 'Auto-answered after idle' : end === 'engine' ? 'Already answered in Claude Code' : 'No longer pending')
    touched($, now)
  } catch {
    // the answer stands whatever the deck makes of it
  }
  if (won.by === 'failed') throw won.error
  return ran
}

/**
 * An answer to the question held on call `callId`, from the web page (its
 * `answer` command, `ackId` its id) or the pane's needs-you card (no ack):
 * the one resolver both take. Checked as the page's command is
 * (`W.routeOf`: one to four answers, none too long), then it settles that
 * call's race (`answerQuestion`). Answers why it was refused; '' when it
 * went to the race, which says what came of it.
 */
function answerCall($: EngineInterface, callId: string, answers: Record<string, string>, ackId: string): string {
  const route = W.routeOf({ cmd: 'answer', callId, answers }, data)
  if (route === null || route.kind !== 'answer') {
    const why = 'Not an answer the deck can read'
    void ackPage($, ackId, 'failed', why)
    return why
  }
  return answerQuestion($, route.callId, route.answers, ackId)
}

/** Why the question held on call `callId` takes no answer from the deck (answered in Claude Code, by its idle timer, gone, or restored by a reload, which the deck may not answer); '' while its race runs here. */
export function answerGoneOf(callId: string): string {
  if (askers.has(callId)) return ''
  const end = questionEnds.get(callId)
  const item = M.pendingOf(data).find(one => one.id === callId)
  if (end === 'engine') return 'Already answered in Claude Code'
  if (end === 'idle') return 'Auto-answered after idle'
  return item && end === undefined ? 'The deck cannot answer this one since it reloaded: answer it in Claude Code' : 'No longer pending'
}

/**
 * The answer to the question held on call `callId`: it settles that call's
 * race (`raceDeck`), which says what came of it. Refused, with why (the
 * page's ack, and the answer), when nothing races there any more (answered
 * in Claude Code, by its idle timer, or gone; or restored by a reload, which
 * the deck may not answer), or when an answer is to no question that call
 * asked; '' when it went to the race.
 */
function answerQuestion($: EngineInterface, callId: string, answers: Record<string, string>, ackId: string): string {
  const item = M.pendingOf(data).find(one => one.id === callId)
  const asker = askers.get(callId)
  if (!asker) {
    const why = answerGoneOf(callId)
    void ackPage($, ackId, 'failed', why)
    return why
  }
  const problem = W.answerProblemOf(item, answers)
  if (problem || !item) {
    void ackPage($, ackId, 'failed', problem || 'No longer pending')
    return problem || 'No longer pending'
  }
  askers.delete(callId)
  asker({ answers: W.answersFor(item, answers), ackId })
  return ''
}

/** The pane's answer (a needs-you card's option, Other or Submit): the page's resolver (`answerCall`), what came of it in a toast. */
function answerFromPane($: EngineInterface, callId: string, answers: Record<string, string>) {
  const why = answerCall($, callId, answers, '')
  $.ui.toast(why ? `Not answered: ${why}` : 'Answered: Claude carries on')
  redrawDeck($)
}

/** An answer given in the sample: its question taken down there alone (`W.answeredInSample`), nothing sent to Claude. */
async function answerInSample($: EngineInterface, callId: string, answers: Record<string, string>): Promise<void> {
  const answered = demo.v2 ? W.answeredInSample(demo.v2, callId, answers, await $.clock.now()) : null
  if (!answered) return
  demo.v2 = answered.state
  const words = answered.words
  demo.version += 1
  $.ui.toast(`Sample data: you answered ${F.trunc(words, 120)}. Nothing was sent to Claude.`)
  redrawDeck($)
}

/** Marks the commits a shell command made as that agent's. */
async function attributeCommits($: EngineInterface, agentId: string, before: string): Promise<void> {
  const ran = await runGit($, before ? G.argv.newSince(before) : G.argv.recentHashes)
  if (!ran.ok) return
  const hashes = ran.out.split('\n').map(line => line.trim()).filter(Boolean)
  const fresh = before ? hashes : hashes.slice(0, 1).filter(hash => hash !== currentGit().head)
  for (const hash of fresh) data.commitsBy[hash] = agentId
  const keys = Object.keys(data.commitsBy)
  if (keys.length > 300) for (const old of keys.slice(0, keys.length - 300)) delete data.commitsBy[old]
  if (fresh.length > 0) scheduleGit($, 200, true)
  saveDeckState($)
}

/**
 * `/eagle-eye probe`: a pane of its own that settles in one look what a surface
 * does with a `Client` (./ui/probe.client.tsx) beside native Text and an
 * Svg. A diagnostic; the deck's screens read none of it.
 */
const PROBE = 'eagle-eye-probe'

const probe: {
  /** Bumped every 1500 ms while the pane is open; each bump redraws it, handing the Client new props. */
  tick: number
  timer?: Timer
  /** The last `ui.message` the Client posted besides its beat, as one line of JSON; '' before the first. */
  message: string
  /** The Client's beats heard since the probe opened, on every surface. */
  heard: number
  /** The Clients listened to for their beat, while a drawing holds one. */
  beats: Beats
  /** Where the Client fell silent: those drawings leave it out until the probe opens again. */
  failedOn: Set<RenderSurface>
} = { tick: 0, message: '', heard: 0, beats: new Map(), failedOn: new Set() }

/** Starts the probe's tick, or restarts it. */
function startProbe($: EngineInterface) {
  probe.timer?.cancel()
  probe.timer = $.clock.every(1500, () => {
    probe.tick += 1
    redrawDeck($)
  })
}

function stopProbe() {
  probe.timer?.cancel()
  probe.timer = undefined
  stopListening(probe.beats)
}

/** Listens for the beat of the probe's Client on a surface: silent, that surface's drawing leaves it out and says so. */
function listenForProbe($: EngineInterface, surface: RenderSurface) {
  listenForBeat($, probe.beats, surface, () => {
    probe.failedOn.add(surface)
    redrawDeck($)
  })
}

/**
 * `/eagle-eye probe`: opens the probe afresh with the keyboard (Esc closes it),
 * or closes it while it is open; the `ui.close` hook stops the tick.
 */
async function toggleProbe($: EngineInterface): Promise<CommandRunResult> {
  const panes = await $.ui.panes().catch(() => [])
  if (panes.some(pane => pane.id === PROBE)) {
    await $.ui.close({ id: PROBE })
    return { text: 'Eagle Eye probe closed.' }
  }
  probe.tick = 0
  probe.message = ''
  probe.heard = 0
  stopListening(probe.beats)
  probe.failedOn.clear()
  const opened = await $.ui.open({ id: PROBE, title: 'Eagle Eye probe', focus: true, closeOnEscape: true, rows: 24 })
  startProbe($)
  return opened.isPlaced ? {} : { text: 'Eagle Eye probe is open and waiting for room: widen the window, or press ctrl+x then tab.' }
}

/** Plain data as one line of JSON, cut to fit a line. */
function jsonLine(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return F.trunc(F.oneLine(text), 240)
}

/** The probe's own colours and label font: graphite ground, bone text, one copper accent (the screens' theme's, held here so the hooks module names no renderer file). */
const PROBE_LOOK = { ground: '#161615', text: '#e9e4d8', copper: '#c9824f', font: "Bahnschrift,'Segoe UI',system-ui,sans-serif" } as const

/**
 * The probe's Svg: markup far wider than any slot (2400×160 over a 900×60
 * viewBox), graphite ground, one 13px bone label carrying the tick `count`.
 * (No `tick` here: the validator resolves the functions handed `$` by name.)
 */
function probeSvg(count: number): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="160" viewBox="0 0 900 60">',
    `<rect x="0" y="0" width="900" height="60" fill="${PROBE_LOOK.ground}"/>`,
    `<text x="16" y="35" font-family="${PROBE_LOOK.font}" font-size="13" fill="${PROBE_LOOK.text}">tick ${count} &#183; this text is 13px</text>`,
    '</svg>',
  ].join('')
}

/**
 * The probe pane, top to bottom: the site's numbers and a hex colour in
 * native Text, the Client, an Svg without `isInteractive`, and the last
 * `ui.message` the Client posted and how many of its beats were heard. Draws it on the terminal and
 * desktop, where Claude Code supports surface modules.
 */
function probeView(
  ui: ReturnType<EngineInterface['ui']['resolve']>,
  ev: RenderInput<'Pane'>,
  Svg: Elements['desktop']['Svg'] | undefined,
): RenderElement {
  const { Box, Text } = ui
  const viewport = ev.viewport ? `${ev.viewport.columns}×${ev.viewport.rows}` : 'none'
  const isSilent = probe.failedOn.has(ev.surface)
  let client: RenderElement | string | null | undefined
  if ((ev.surface !== 'terminal' && ev.surface !== 'desktop') || !('Client' in ui)) client = <Text dimColor>{`No Client on ${ev.surface}: its element table has none.`}</Text>
  else if (isSilent) client = <Text dimColor>{`The Client is left out here after it fell silent; /eagle-eye probe twice draws it again.`}</Text>
  else client = h('Client', { key: 'probe', module: './ui/probe.client.tsx', width: '100%', props: { tick: probe.tick, cols: ev.props.bodyColumns } })
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" columnGap={2}>
        <Text>{`bodyColumns=${ev.props.bodyColumns}  viewport=${viewport}  placement=${ev.props.placement}  bodyRows=${ev.props.scroll.bodyRows}  surface=${ev.surface}`}</Text>
        <Text color={PROBE_LOOK.copper}>copper hex</Text>
      </Box>
      {client}
      {Svg ? (
        <Svg source={probeSvg(probe.tick)} alt={`tick ${probe.tick}: 13px bone text on graphite, markup 2400×160 over a 900×60 viewBox`} />
      ) : (
        <Text dimColor>{`No Svg on ${ev.surface}.`}</Text>
      )}
      <Box flexDirection="column">
        <Text dimColor>{`ui.message: ${probe.message || 'none yet'}`}</Text>
        <Text dimColor>{`beats: ${probe.heard} heard${isSilent ? `, then none for ${SILENT_MS / 1000} s on ${ev.surface}: it failed to load, to draw, or while running` : ''}`}</Text>
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // /eagle-eye before anything else is awaited: a reload drops the old registration, and the menu (the terminal's
    // typeahead, a desktop session's list) goes without /eagle-eye until this runs
    try {
      await $.command.register({
        name: 'eagle-eye',
        description: 'Open Eagle Eye: what Claude is doing, who is working on what, and what needs you (/eagle-eye dashboard, chat, org, changes, inspect or settings; /eagle-eye demo: sample data; /eagle-eye web: in your browser)',
        // now (the Dashboard's id), help (Settings) and probe (a dev check) still open, unlisted
        argumentHint: '[dashboard|chat|org|changes|inspect|settings|demo|web|web stop|clear|clear show|band|avatars [style]|close]',
        immediate: true,
      })
    } catch (error) {
      $.ui.log(`could not add /eagle-eye: ${error instanceof Error ? error.message : String(error)}`)
    }

    const now = await $.clock.now()
    cwd = e.cwd
    debug.loadedAt = now
    await checkDebug($, true)
    const isRestored = await restore($, now)
    if (!isRestored) {
      data = M.emptyData(now)
      view = M.defaultView()
    }
    // Claude Code's SessionStart, heard just before: whether the session is a fork (a reload hears none, its snapshot keeping it)
    if (startedAs !== '') noteStart(startedAs)

    try {
      const prefs = await $.store.get('prefs')
      if (prefs && typeof prefs === 'object' && 'isBandHidden' in prefs) view.isBandHidden = Boolean((prefs as { isBandHidden: unknown }).isBandHidden)
      // the avatar style is the person's own: it holds in every session (blocks until they pick another)
      if (prefs && typeof prefs === 'object' && 'avatarStyle' in prefs) view.avatarStyle = AV.styleOf((prefs as { avatarStyle: unknown }).avatarStyle)
    } catch {
      // defaults stand
    }

    try {
      const panes = await $.ui.panes()
      isPaneOpen = panes.some(pane => pane.id === PANE)
      // a reload drops the probe's tick with the old environment: start it again while its pane stays up
      if (panes.some(pane => pane.id === PROBE)) startProbe($)
    } catch {
      isPaneOpen = false
    }

    try {
      sessionId = await $.session.id()
    } catch {
      sessionId = ''
    }
    setPluginRoot(`${$.plugin.root}`.replace(/[\\/]+$/, ''))
    // Eagle Eye's home: the gone sessions' folders swept, this one's made private before any deck writes there (never awaited)
    await homeOf($)
    void startHome($)
    // every session on this machine: this deck's file in the registry, and the others' read (never awaited)
    void SR.startRegistry(registryHost($))

    // the web deck's supervisor, this session.start's: on again at once when a reload found it on
    startSupervisor($)

    try {
      const raw = await $.session.usage()
      usage = usageOf(raw)
      usageAt = now
      if (!isRestored) data.startedAt = raw.startedAt
    } catch {
      // the session's start stays the module's first look
    }

    try {
      const main = M.agentOf(data, M.MAIN)
      if (main && !main.model) main.model = await $.session.model()
    } catch {
      // the model shows once a request reports it
    }

    // Inspect: what is loaded and the context, read in the background
    void readInspected($)

    // a reload while the sample showed reads it again, on the tab and page it was on
    if (view.isDemo) void loadDemo($, false)

    void startRepos($)
    void syncAgents($)
    // what a reload lost (the goal, an ended agent's result), read back from the transcripts: never awaited, it redraws when done
    void recoverLost($)
    timers.tick = $.clock.every(2500, () => void deckTick($))

    return next(e)
  })

  // a /clear or a resume: the process goes on, and the deck with it under the id it started with (no session.start comes); what the folder held of the conversation before goes
  on('session.end', { reason: ['clear', 'resume'] }, async ($, e, next) => {
    const result = await next(e)
    const now = await $.clock.now()
    data = M.emptyData(now)
    closeCommit()
    closeFileDiff()
    await clearWeb($)
    deckChanged($)
    return result
  })

  // the session ends (not a /clear or a resume, where the process goes on): its file in the registry goes, then its state folder
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    await SR.endRegistry(e.reason)
    if (e.reason !== 'clear' && e.reason !== 'resume') {
      await endWeb($)
      // the snapshot the host held of this session (its conversation) is cleared: nothing of it is kept once the session is over
      timers.save?.cancel()
      timers.save = undefined
      const now = await $.clock.now()
      await $.state.set(SNAPSHOT, M.copyOf({ v: M.SNAPSHOT_VERSION, data: M.emptyData(now), view: M.defaultView() })).catch(() => undefined)
    }
    return result
  })

  on('command.run', { command: 'eagle-eye' }, async ($, e) => runEagleEye($, e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    isPaneOpen = false
    stopListening(chartBeats)
    paneFocus = ''
    chatFollow.isShown = false
    return result
  })

  // the probe closes by /eagle-eye probe, Esc or its close mark: its tick stops
  on('ui.close', { id: PROBE }, async ($, e, next) => {
    const result = await next(e)
    stopProbe()
    return result
  })

  on('tool.call', async ($, e, next) => {
    // the deck's own calls are no agent's work
    if (next.origin.plugin === OWN) return next(e)
    const start = await $.clock.now()
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const agentId = e.agentId ?? M.MAIN
    const command = typeof input.command === 'string' ? input.command : ''
    const isShell = M.SHELL_TOOLS.includes(tool)
    const isEdit = M.EDIT_TOOLS.includes(tool)
    const isSpawn = tool === 'Agent' || (tool === 'Task' && typeof input.prompt === 'string')
    let agent: DeckAgent | undefined

    try {
      // a loop no spawn named is a workflow's agent while a run is live, else the engine's own
      agent = M.seeLoop(data, agentId, start)
      // a call is work: an ended agent (a message woke it) or an idle teammate runs again
      if (M.isEnded(agent.status) || agent.status === 'idle') M.reopen(agent, start)
      delete agent.endedAt
      // a new call means the agent no longer waits on you: clear its needs-you notes, and drop its calls a reload left marked as waiting on you (they have ended)
      M.clearNeeds(data, { kind: 'start', agent: agentId })
      M.dropStale(data, agentId, openCalls)
      if (e.tool_use_id) openCalls.add(e.tool_use_id)
      const file = typeof input.file_path === 'string' ? input.file_path : ''
      const said = file ? { ...input, file_path: knownRealOf(file) } : input
      const activity = M.activityOf(e.tool_use_id, tool, said, currentGit().root || null, start, data.board)
      M.beginTool(data, agent, activity)
      inspectCalled(data, tool, input, start)
      // the call is recorded at once; if its directory is not resolved yet, its target is rewritten once the file system resolves it
      if (file && !isSpelledOf(file)) void respell($, activity, tool, input, file)
    } catch {
      agent = undefined
    }
    try {
      // an Agent call shows its agent at once, keyed by the call until the spawn binds it
      if (isSpawn) {
        M.addPlaceholder(data, {
          toolUseId: e.tool_use_id,
          parentId: agentId,
          ...(typeof input.name === 'string' ? { name: input.name } : {}),
          description: typeof input.description === 'string' ? input.description : '',
          prompt: typeof input.prompt === 'string' ? input.prompt : '',
          ...(typeof input.subagent_type === 'string' ? { type: input.subagent_type } : {}),
          at: start,
        })
      }
      if (tool === 'Workflow') {
        const meta = typeof input.script === 'string' ? M.workflowMetaOf(input.script) : undefined
        const named = typeof input.name === 'string' ? input.name : ''
        M.noteWorkflow(data, { id: e.tool_use_id, caller: agentId, name: meta?.name || named, phases: meta?.phases ?? [], at: start })
      }
      // background work it starts (a shell in the background, Monitor, Workflow, CronCreate, ScheduleWakeup): its row at once
      B.noteStart(data, { toolUseId: e.tool_use_id, tool, input, by: agentId, at: start })
      touched($, start)
    } catch {
      // the call goes ahead whatever the deck makes of it
    }

    // a SendMessage's own summary titles the row its send logs
    const summary = tool === 'SendMessage' && typeof input.summary === 'string' ? F.trunc(F.oneLine(input.summary), 200) : ''
    if (summary !== '' && typeof input.message === 'string') {
      sendTitles.push({ id: e.tool_use_id, from: agentId, text: input.message, summary })
      if (sendTitles.length > 20) sendTitles.splice(0, sendTitles.length - 20)
    }
    const before = isShell && currentGit().isRepo && G.mayCommit(command) ? await runGit($, G.argv.head).then(ran => (ran.ok ? ran.out.trim() : '')) : ''
    let ran: ToolCallResult
    try {
      // a question the deck may answer too: raced with its dialog beneath
      ran = tool === 'AskUserQuestion' ? await raceDeck($, e, next, agentId, start) : await next(e)
    } finally {
      // the call ended (answered, run, refused or failed): nothing of it is held on you any more
      openCalls.delete(e.tool_use_id)
      if (summary !== '') {
        const at = sendTitles.findIndex(one => one.id === e.tool_use_id)
        if (at >= 0) sendTitles.splice(at, 1)
      }
      asks.delete(e.tool_use_id)
      M.dropPending(data, e.tool_use_id)
    }

    let end = start
    let ok = false
    try {
      end = await $.clock.now()
      ok = ran.deny === undefined && ran.isError !== true
      // Inspect: the call ran (its permission was given), or it was refused (Claude Code hands a refusal back as an error that no PostToolUse heard)
      inspectEnded(data, e.tool_use_id, ran)
      if (agent) {
        M.endTool(agent, e.tool_use_id, ok, end)
        // a permission prompt holds its call: the call's end is the person's answer
        M.clearNeeds(data, { kind: 'end', agent: agentId, call: e.tool_use_id })
      }
    } catch {
      // tracking never changes what the tool returned
    }
    const record = ran.result !== null && typeof ran.result === 'object' ? (ran.result as Record<string, unknown>) : null

    // the files it changed, spelled as the file system does (an 8.3 short name made long), so git's paths match
    let shellEdits = 0
    if (ok && agent) {
      try {
        const named = isEdit ? editedPathOf(input) : ''
        if (named) recordEdit(agent, tool, e.tool_use_id, input, ran, end, await realPathOf($, named))
        if (tool === 'Bash') shellEdits = await recordShellEdits($, agent, tool, e.tool_use_id, ran, end)
      } catch {
        // an edit the deck could not read is left out
      }
    }

    // its lists: the whole todo list, and the task board
    if (ok && agent) {
      try {
        if (M.LIST_TOOLS.includes(tool)) M.noteTodo(data, agent, tool, input, ran.result, end)
        if (M.TASK_TOOLS.includes(tool)) M.noteBoard(data, agent, tool, input, ran.result, end)
      } catch {
        // a list the deck could not read is left out
      }
    }

    // an Agent call's row: bound to the agent its result names, or ended when none started; a foreground agent's report
    if (isSpawn) {
      try {
        const status = typeof record?.status === 'string' ? record.status : ''
        const handback = record?.handbackReport
        const report =
          handback && typeof handback === 'object' && typeof (handback as { text?: unknown }).text === 'string'
            ? String((handback as { text: string }).text)
            : Array.isArray(record?.content)
              ? (record.content as unknown[]).map(block => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '')).join('\n')
              : ''
        M.settleAgentCall(data, {
          toolUseId: e.tool_use_id,
          ...(typeof record?.agentId === 'string' && record.agentId !== '' ? { agentId: record.agentId } : {}),
          isStarted: ok,
          why: ran.deny ?? (typeof ran.text === 'string' ? ran.text : ''),
          ...(ok && status === 'completed' && report.trim() !== '' ? { report } : {}),
          isDone: ok && status === 'completed',
          isRemote: status === 'remote_launched',
          at: end,
        })
      } catch {
        // the call's agent stands as its spawn left it
      }
    }

    // an agent's report: SubagentHandback's message, its result whatever its turn's answer says
    if (ok && agent && tool === 'SubagentHandback') {
      try {
        if (typeof input.message === 'string') M.noteResult(data, agent, input.message, end, 'handback')
      } catch {
        // the report stands in the agent's own transcript
      }
    }

    // the plan the person approved
    if (ok && tool === 'ExitPlanMode' && record?.awaitingLeaderApproval !== true) {
      try {
        let plan = typeof record?.plan === 'string' ? record.plan : typeof input.plan === 'string' ? input.plan : ''
        if (plan.trim() === '' && typeof record?.filePath === 'string' && record.filePath !== '') plan = await $.fs.read(record.filePath)
        if (plan.trim() !== '') {
          // as Claude wrote it, for the plan it is; and split into steps
          M.noteApproved(data, plan, agentId, end)
          M.notePlan(data, plan, end)
        }
      } catch {
        // no plan the deck could read
      }
    }

    // a Workflow run's ids, or its end when it never launched; a TaskStop of one ends it
    try {
      if (tool === 'Workflow') {
        const text = (field: string) => (typeof record?.[field] === 'string' ? (record[field] as string) : undefined)
        M.launchWorkflow(data, e.tool_use_id, { ok, at: end, ...(text('runId') ? { runId: text('runId') } : {}), ...(text('taskId') ? { taskId: text('taskId') } : {}), ...(text('workflowName') ? { name: text('workflowName') } : {}) })
      }
      if (ok && tool === 'TaskStop') M.endWorkflows(data, String(input.task_id ?? input.shell_id ?? ''), end)
    } catch {
      // the run stands as it was
    }

    try {
      // background work: its row takes Claude Code's id, or goes (it never started, or TaskStop or CronDelete ended it)
      B.noteEnd(data, { toolUseId: e.tool_use_id, tool, input, by: agentId, at: start, ok, result: ran.result })
    } catch {
      // the row stands as it was
    }

    try {
      if (isEdit || shellEdits > 0 || (isShell && G.mayChangeTree(command))) scheduleGit($, 700)
      // a commit the shell reports by its sha is this agent's; else git is asked what is new
      const operation = record?.gitOperation
      const commit = operation && typeof operation === 'object' ? (operation as { commit?: { sha?: unknown } }).commit : undefined
      if (ok && commit && typeof commit.sha === 'string' && commit.sha !== '') {
        data.commitsBy[commit.sha] = agentId
        scheduleGit($, 200, true)
      } else if (isShell && ok && G.mayCommit(command)) {
        void attributeCommits($, agentId, before)
      }
      touched($, end)
    } catch {
      // tracking never changes what the tool returned
    }

    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      const now = await $.clock.now()
      const parentId = e.parentAgentId ?? M.MAIN
      // a message woke a finished agent (SendMessage to it), or Claude Code brought one back: the same agent resumed, no new spawn
      const resumed = e.resume && result.agentId ? M.noteResume(data, result.agentId, now) : undefined
      if (resumed) {
        logResumeWords(resumed, resumed.parentId ?? parentId, e.prompt, now)
      } else if (result.agentId) {
        if (parentId !== M.MAIN) M.seeLoop(data, parentId, now)
        // the row its Agent call made takes the agent's id: the same row, never a second one
        const { agent } = M.noteSpawn(data, {
          toolUseId: e.tool_use_id,
          agentId: result.agentId,
          parentId,
          ...(e.name ? { name: e.name } : {}),
          description: e.description,
          prompt: e.prompt,
          type: e.subagentType,
          isTeammate: e.isTeammate === true,
          ...(e.workflow ? { workflow: e.workflow.runId } : {}),
          model: result.model,
          background: e.background === true,
          at: now,
        })
        if (e.resume) {
          // resumed, though the deck never saw it start (a reload lost it): its words a message, once
          agent.resumedAt = now
          logResumeWords(agent, agent.parentId ?? parentId, e.prompt, now)
        } else if (!e.workflow) {
          // a workflow's agents fold into one row: their hand-offs stay in the run
          M.addMessage(data, { from: agent.parentId ?? parentId, to: agent.id, kind: 'spawn', text: e.prompt, at: now })
        }
      } else if (result.deny !== undefined && !e.workflow && !e.resume) {
        M.settleAgentCall(data, { toolUseId: e.tool_use_id, isStarted: false, why: result.deny, at: now })
      }
      touched($, now)
    } catch {
      // the spawn stands whatever the deck makes of it
    }
    return result
  })

  // the person's own words: a new goal, or a follow-up of the one in hand; anything else is an event
  on('prompt.submit', async ($, e, next) => {
    let kind: M.PromptKind = 'event'
    try {
      kind = M.promptKindOf(data, e)
    } catch {
      kind = 'event'
    }
    const isDecks = e.origin.kind === 'plugin' && e.origin.name === OWN
    // the deck's prompt asking the Orchestrator to pass your words to a subagent is no goal of yours, nor a follow-up
    if (isDecks && isRelayPrompt(e.text)) kind = 'event'
    // the turn it starts begins inside next(e): noted first, so that turn knows whose words it starts with
    const command = e.command ? M.commandOf(e.command) : ''
    const entry = noteSubmitted(e.text, M.isUsersWords(e.origin), e.turnId !== undefined, command)
    const result = await next(e)
    if (result.drop !== undefined) dropSubmitted(entry)
    else entry.isSettled = true
    try {
      const now = await $.clock.now()
      let isChanged = false
      if (result.drop === undefined) {
        // the deck's own prompt, logged as your message when it was sent (a relay, in its agent's Talk): the turn it starts logs it no second time
        if (isDecks) {
          markDeckPrompt(e.text)
          markRelayPrompt(e.text)
        }
        const said = expansion !== null && now - expansion.at < 10_000 ? expansion.headline : ''
        expansion = null
        // a slash command typed alone asks Claude for nothing, unless it expands to a prompt (a skill or a command's file: "/open-sourcing"): then it is a request like typed words
        const isBareCommand = kind === 'event' && !isDecks && M.isUsersWords(e.origin) && M.commandLineOf(e.text) !== ''
        if (isBareCommand && said) kind = M.promptKindOf(data, { origin: e.origin, ...(e.turnId !== undefined ? { turnId: e.turnId } : {}) })
        // its expansion may come after the submit resolves: kept, so the expansion makes it the request then
        pendingCommand = isBareCommand && !said ? { text: e.text, origin: e.origin, ...(e.turnId !== undefined ? { turnId: e.turnId } : {}), at: now } : null
        if (kind !== 'event') isChanged = M.noteGoal(data, kind, { text: e.text, origin: e.origin.kind, at: now, ...(kind === 'goal' && said ? { headline: said } : {}) }) !== undefined
        // typed during a running turn: log it now, as submitted, and note it so the turn it may start does not log it again (a slash command run alone is logged as the command you ran)
        if (e.turnId !== undefined && !isDecks && M.isUsersWords(e.origin)) {
          const words = 'text' in result && typeof result.text === 'string' ? result.text : e.text
          const logged = M.addPrompt(data, { text: words, at: now, ...(command ? { command } : {}) })
          if (data.messages.includes(logged)) {
            noteTypedMidTurn(words)
            isChanged = true
          }
        }
        // a background task's notification: Claude Code's row to the main loop, and it may end a Workflow run
        if (e.origin.kind === 'task-notification') {
          isChanged = M.noteTaskNotices(data, e.text, now) || isChanged
          isChanged = M.endWorkflows(data, e.text, now) || isChanged
          // a background task's notification that it ended takes its row down (the timeline keeps it to now)
          isChanged = B.noteTaskEnds(data, e.text, now) || isChanged
        }
        // a cron or a wakeup fired: a one-shot one is done, a recurring one's next run unknown
        if (e.origin.kind === 'scheduled-trigger') isChanged = B.noteFired(data, e.text) || isChanged
      }
      if (isChanged) touched($, now)
    } catch {
      // the prompt goes in whatever the deck makes of it
    }
    return result
  })

  // a slash command's own words make a better headline than the prompt it expands to
  on('classic.UserPromptExpansion', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      const args = F.oneLine(e.command_args)
      const headline = `/${e.command_name}${args ? ` ${args}` : ''}`
      const goal = M.goalOf(data)
      const expanded = F.oneLine(e.prompt).slice(0, 60)
      const isThisGoal = goal !== undefined && now - goal.at < 5_000 && (goal.text.trim().startsWith(`/${e.command_name}`) || (expanded !== '' && F.oneLine(goal.text).includes(expanded)))
      const pending = pendingCommand
      pendingCommand = null
      if (isThisGoal) {
        if (M.retitleGoal(data, headline, goal.at)) touched($, now)
      } else if (pending && now - pending.at < 5_000 && pending.text.trim().startsWith(`/${e.command_name}`)) {
        // the command was submitted alone and read as asking nothing: its expansion says it asks Claude for something
        const kind = M.promptKindOf(data, { origin: pending.origin, ...(pending.turnId !== undefined ? { turnId: pending.turnId } : {}) })
        if (kind !== 'event' && M.noteGoal(data, kind, { text: pending.text, origin: pending.origin.kind, at: pending.at, ...(kind === 'goal' ? { headline } : {}) }) !== undefined) touched($, now)
      } else {
        expansion = { headline, at: now }
      }
    } catch {
      // the prompt keeps its own first line
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // a subagent's or teammate's run starts a turn of its own (engine 2.1.304): none of it is the main loop's
    if (e.agentId !== undefined) return next(e)
    // the prompt it starts with, noted by prompt.submit before its next(e): taken before anything is awaited
    const prompt = takeSubmitted(e.text)
    try {
      const now = await $.clock.now()
      const main = M.agentOf(data, M.MAIN)
      // the main loop's running turn: the one Stop turn ends ($.turn.abort takes its id)
      M.noteMainTurn(data, e.turnId, now)
      // you answered, or the Orchestrator went on by itself: it waits on nobody
      M.clearNeeds(data, { kind: 'turn' })
      if (main) {
        main.status = 'running'
        main.lastAt = now
      }
      // the prompt is not yours if it came from elsewhere (an agent's hand-back, already recorded as its result) or if it
      // opens with a notice: a background agent's <task-notification> can start a turn with no prompt.submit before it
      const isTheirs = (prompt?.isTheirs ?? true) && !M.isNoticeText(e.text)
      // your words from the deck were logged when you sent them; a relay of them to a subagent goes in no Talk of the Orchestrator's
      const isDecks = takeRelayTurn(e.text, e.turnId) !== undefined || takeDeckPrompt(e.text)
      // a prompt you typed over the turn before was logged as you typed it
      const isTyped = isTheirs && !isDecks && takeTypedMidTurn(e.text)
      // a slash command run alone ("/login") is the command you ran, not words of yours
      if (e.text.trim() && isTheirs && !isDecks && !isTyped) M.addPrompt(data, { text: e.text, at: now, ...(prompt?.command ? { command: prompt.command } : {}) })
      // a turn the engine starts with a background task's notification, no prompt.submit before it: Claude Code's row, once
      if (M.isNoticeText(e.text)) M.noteTaskNotices(data, e.text, now)
      // and a background task it says ended takes its row down (the timeline keeps it to now)
      if (M.isNoticeText(e.text)) B.noteTaskEnds(data, e.text, now)
      // a new turn: no call of the Orchestrator's last one is held on you any more
      M.dropStale(data, M.MAIN, openCalls)
      touched($, now)
    } catch {
      // a turn starts whatever the deck makes of it
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? M.MAIN
    // a new step means every call of the loop's last step has ended, so drop its calls a reload left marked as waiting on you
    const isStale = data.pending.length > 0 && M.dropStale(data, id, openCalls)
    // you messaged it from the deck: a step it starts now may read your words, and answer them
    const awaited = e.agentId !== undefined ? replies.get(e.agentId) : undefined
    const startedAt = awaited || isStale ? await $.clock.now() : 0
    if (isStale) touched($, startedAt)
    // the response as it streams: each chunk goes on at once, as it came; what Claude Code shows of the thinking is read on the way
    const stream = next(e)
    const thinking: Thinking = { text: '', block: -1 }
    for await (const chunk of stream) {
      if (chunk.kind === 'thinking') keepThinking(thinking, chunk)
      yield chunk
    }
    const result = await stream.result
    let isReply = false
    try {
      if (awaited && e.agentId !== undefined && replies.get(e.agentId) === awaited && startedAt > awaited.since) {
        // its first words since your message: said to nobody in particular, so never taken to be to you
        if (result.answer.trim() !== '') {
          replies.delete(e.agentId)
          isReply = true
          const now = await $.clock.now()
          M.addMessage(data, { from: e.agentId, to: '', kind: 'chat', text: result.answer, at: now })
          touched($, now)
        } else {
          awaited.isRead = true
        }
      }
    } catch {
      // the reply stands in the agent's own transcript
    }
    try {
      // what the step gave besides its calls: its thinking as Claude Code showed it, then its visible text; kept on its loop's row, never in Chat
      const agent = M.agentOf(data, id)
      if (agent && (thinking.text.trim() !== '' || result.answer.trim() !== '')) {
        const now = await $.clock.now()
        const step = { at: now, turnId: e.turnId, step: e.index }
        M.noteWord(agent, { ...step, kind: 'thought', text: thinking.text })
        // a step that asks for no call ends its turn: its text is the turn's answer, which Chat has (the Orchestrator's answer to you, an agent's result)
        M.noteWord(agent, { ...step, kind: 'said', text: result.answer, isChat: isReply || result.toolUses.length === 0 })
        touched($, now)
      }
    } catch {
      // the words stand in the agent's own transcript
    }
    try {
      const usageOfStep = result.usage
      const agent = M.agentOf(data, id)
      if (usageOfStep && agent) {
        const now = await $.clock.now()
        agent.tokensIn += usageOfStep.input_tokens + usageOfStep.cache_creation_input_tokens
        agent.cacheRead += usageOfStep.cache_read_input_tokens
        agent.tokensOut += usageOfStep.output_tokens
        agent.requests += 1
        agent.lastAt = now
        if (!agent.model) agent.model = usageOfStep.model
        // a step of an ended agent's loop (a message woke it), or of an idle teammate's, is a new run
        if (agent.kind !== 'main' && (M.isEnded(agent.status) || agent.status === 'idle')) M.reopen(agent, now)
        M.bump(data, now, 'tokens', usageOfStep.input_tokens + usageOfStep.output_tokens + usageOfStep.cache_creation_input_tokens + usageOfStep.cache_read_input_tokens)
        touched($, now)
      }
    } catch {
      // counting tokens never changes the response
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      const now = await $.clock.now()
      // its run ended: no call of it is held on you any more
      M.dropStale(data, e.agentId ?? M.MAIN, openCalls)
      if (e.agentId) {
        // a loop no spawn and no list named that the list still leaves out was Claude Code's own (a prompt suggestion, a compaction): forgotten
        if (M.isEngineLoopId(data, e.agentId)) await syncAgents($)
        const agent = M.forgetLoop(data, e.agentId) ? undefined : M.agentOf(data, e.agentId)
        if (agent) {
          agent.status = e.reason === 'aborted' ? 'killed' : e.reason === 'answer' ? (agent.kind === 'teammate' ? 'idle' : 'completed') : 'failed'
          agent.endedAt = now
          delete agent.current
          delete agent.todo
          // its answer is its result unless it handed a report back (whose turn answers "")
          if (e.answer.trim()) M.noteResult(data, agent, e.answer, now, 'answer')
        }
        // a run that read your message and ended without a word for you: no reply is coming
        if (replies.get(e.agentId)?.isRead) replies.delete(e.agentId)
      } else {
        const main = M.agentOf(data, M.MAIN)
        // no turn of the main loop's runs now: nothing for Stop turn to end
        M.endMainTurn(data, e.turnId, now)
        // a relay turn passed your words on to a subagent (or failed to, which its ack says): nothing of it is an answer to you
        const isRelay = endRelay($, e.turnId, e.answer)
        if (main) {
          main.status = 'idle'
          delete main.current
          main.lastAt = now
          delete main.todo
          // its answer to you is its latest report (the web deck's Orchestrator shows it), and its reply in your Talk
          if (!isRelay) {
            M.noteMainAnswer(main, e.answer)
            if (e.answer.trim()) M.addMessage(data, { from: M.MAIN, to: M.YOU, kind: 'answer', text: e.answer, at: now })
          }
        }
        data.turns += 1
        data.turnMs += e.durationMs
      }
      scheduleGit($, 300)
      touched($, now)
    } catch {
      // the turn's end stands whatever the deck makes of it
    }
    return result
  })

  // a subagent the deck saw end runs again; one it never saw spawn waits for its first call. Claude Code raises this only for agents'
  // runs, so a loop the deck took for the engine's own is that agent, and the agent list is read for the rest of its details
  on('classic.SubagentStart', async ($, e, next) => {
    try {
      const isEngine = M.isEngineLoopId(data, e.agent_id)
      const now = await $.clock.now()
      if (M.noteSubagentStart(data, e.agent_id, e.agent_type, now)) touched($, now)
      if (isEngine && !M.isEngineLoopId(data, e.agent_id)) void syncAgents($)
    } catch {
      // the start stands whatever the deck makes of it
    }
    return next(e)
  })

  // a subagent stopped: its row ends at once, and with no report handed back its last message is its result. A loop that no spawn, agent
  // list or SubagentStart named, and that the list still leaves out, was Claude Code's own (a prompt suggestion, whose last words guess your next prompt): forget it
  on('classic.SubagentStop', async ($, e, next) => {
    const seen = await $.clock.now()
    const result = await next(e)
    try {
      // a stop a hook blocked goes on working
      if (result.block === undefined) {
        if (M.isEngineLoopId(data, e.agent_id)) await syncAgents($)
        const now = await $.clock.now()
        if (M.forgetLoop(data, e.agent_id) || M.noteStop(data, e.agent_id, e.last_assistant_message ?? '', now)) touched($, now)
      }
      // Claude Code's snapshot of the background work, as it stood when the stop was raised
      if (noteBackground(e, seen)) touched($, seen)
    } catch {
      // the stop stands whatever the deck makes of it
    }
    return result
  })

  // Claude stopped: Claude Code's snapshot of the background work (its tasks and schedules) brings Background up to date, and its input names the main loop's permission mode and effort (Inspect). Observe only.
  on('classic.Stop', async ($, e, next) => {
    const seen = await $.clock.now()
    const result = await next(e)
    try {
      const isBackground = noteBackground(e, seen)
      if (inspectMode(data, e) || isBackground) touched($, seen)
    } catch {
      // the stop stands whatever the deck makes of it
    }
    return result
  })

  // a teammate between turns: its row ends at once
  on('classic.TeammateIdle', async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.block === undefined) {
        const now = await $.clock.now()
        if (M.noteIdle(data, { ...(e.agent_id ? { id: e.agent_id } : {}), name: e.teammate_name }, now)) touched($, now)
      }
    } catch {
      // the teammate idles whatever the deck makes of it
    }
    return result
  })

  // the task board, as the team's own events tell it
  on('classic.TaskCreated', async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.block === undefined) {
        const now = await $.clock.now()
        const by = e.teammate_name ? M.resolveRecipient(data, e.teammate_name)?.id : e.agent_id
        const task = { id: e.task_id, subject: e.task_subject, ...(e.task_description ? { description: e.task_description } : {}), ...(by ? { by } : {}) }
        if (M.noteTaskEvent(data, 'created', task, now)) touched($, now)
      }
    } catch {
      // the task stands whatever the deck makes of it
    }
    return result
  })

  on('classic.TaskCompleted', async ($, e, next) => {
    const result = await next(e)
    try {
      if (result.block === undefined) {
        const now = await $.clock.now()
        const by = e.teammate_name ? M.resolveRecipient(data, e.teammate_name)?.id : e.agent_id
        const task = { id: e.task_id, subject: e.task_subject, ...(e.task_description ? { description: e.task_description } : {}), ...(by ? { by } : {}) }
        if (M.noteTaskEvent(data, 'completed', task, now)) touched($, now)
      }
    } catch {
      // the task stands whatever the deck makes of it
    }
    return result
  })

  on('session.send', async ($, e, next) => {
    // if this send wakes a finished agent, the resume is raised inside next(e): this entry tells the resume that the send logs the message
    const flight = { from: e.agentId ?? M.MAIN, to: typeof e.to === 'string' ? e.to : '', text: e.text }
    sendsInFlight.push(flight)
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
    } finally {
      sendsInFlight.splice(sendsInFlight.indexOf(flight), 1)
    }
    try {
      const isMine = e.origin.kind === 'plugin' && e.origin.name === OWN
      if (!isMine) {
        const now = await $.clock.now()
        const from = e.agentId ?? M.MAIN
        if (from !== M.MAIN) M.seeLoop(data, from, now)
        // a name two agents carried goes to the newest live one; a name none carries stays the name SendMessage was given
        const target = M.resolveRecipient(data, e.to)
        const to = target?.id ?? F.trunc(F.oneLine(e.to), 120)
        // the Orchestrator passing your words on (a relay): your message, now delivered, and no second one
        const relay = from === M.MAIN && e.origin.kind === 'model' && result.isDelivered && target ? passRelay(target.id, e.text) : undefined
        const title = e.origin.kind === 'model' ? sendTitleOf(from, e.text) : ''
        // the resume it caused logged its words already (raised before this send): that row is this send's
        const woke = M.loggedSendOf(data, { to, text: e.text, at: now })
        const resumeRow = woke && resumeRows.includes(woke.id) ? woke : undefined
        if (relay) await relayPassed($, relay, now)
        else if (resumeRow) {
          resumeRow.from = from
          resumeRow.isDelivered = result.isDelivered
          if (title !== '') resumeRow.title = title
        } else M.addMessage(data, { from, to, kind: 'message', text: e.text, at: now, isDelivered: result.isDelivered, ...(title !== '' ? { title } : {}) })
        touched($, now)
      }
    } catch {
      // the message goes whatever the deck makes of it
    }
    return result
  })

  on('session.receive', async ($, e, next) => {
    const result = await next(e)
    try {
      const origin = e.origin
      const now = await $.clock.now()
      if (origin.kind === 'task-notification' && M.endWorkflows(data, e.text, now)) touched($, now)
      if (origin.kind === 'peer' || origin.kind === 'coordinator' || origin.kind === 'peer-send-message') {
        const to = e.agentId ?? M.MAIN
        // the receiver reads a send inside an envelope (<agent-message from="…">): matched without it, logged once
        const echo = M.echoOf(data, to, e.text, now)
        if (echo) {
          echo.isDelivered = true
          if (echo.to !== to && M.agentOf(data, to)) echo.to = to
        } else if (isRelayEcho(to, e.text)) {
          // your words the Orchestrator passed on: logged already, as yours
        } else if (!('plugin' in origin && origin.plugin === OWN)) {
          const unwrapped = M.unwrapMessage(e.text)
          const named = 'teammate' in origin ? origin.teammate : unwrapped.from
          // a sender that is no agent of the session keeps the name it gave; with no name, the sender is the delivery's kind (a coordinator's is the main loop)
          const from = named ? (M.resolveRecipient(data, named)?.id ?? F.trunc(F.oneLine(named), 120)) : origin.kind === 'coordinator' ? M.MAIN : origin.kind
          if (unwrapped.text.trim() !== '') M.addMessage(data, { from, to, kind: 'message', text: unwrapped.text, at: now })
        }
        touched($, now)
      }
    } catch {
      // the delivery stands whatever the deck makes of it
    }
    return result
  })

  // Claude Code decides whether a call may run. The decision is passed on as it is, never read here: the plugin
  // directory accepts a permission hook only when it returns `next(e)` as written. What the deck shows of the
  // decision it asks for itself (`watchCheck`: a `$.tool.check` query, which runs nothing and opens no dialog).
  on('tool.check', async ($, e, next) => {
    void watchCheck($, e)
    return next(e)
  })

  // A permission dialog is asked for: the call is held on you until it ends or is denied. Passed on as it is, never read here.
  on('classic.PermissionRequest', async ($, e, next) => {
    void watchDialog($, e)
    return next(e)
  })

  // The permission was refused (the auto-mode classifier): nothing waits on you for it.
  on('classic.PermissionDenied', async ($, e, next) => {
    const result = await next(e)
    if (inspectDenied(data, e)) touched($, await $.clock.now())
    try {
      asks.delete(e.tool_use_id)
      if (M.dropPending(data, e.tool_use_id)) touched($, await $.clock.now())
    } catch {
      // the refusal stands whatever the deck makes of it
    }
    return result
  })

  // Claude Code's notification: a row in the chat, as it sent it, and waiting on you when it asks (a permission prompt, an MCP server's question, Claude idle for your input). Observe only.
  on('classic.Notification', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      const note = { type: e.notification_type, message: e.message, at: now, ...(e.title ? { title: e.title } : {}), ...(e.agent_id ? { agent: e.agent_id } : {}) }
      if (M.noteNotification(data, note)) touched($, now)
    } catch {
      // the notification goes out whatever the deck makes of it
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    isPaneOpen = true
    const now = await $.clock.now()
    shownKey = screenKey(now)
    keepChat($, now)
    noteScreen(e.surface, e.viewport)
    // the terminal: the drawing no taller than the pane's room and the terminal allow (`paneRowsFor`), Chat's newest messages and the Dashboard's sections cut to fit
    const rows = e.surface === 'terminal' ? paneRowsFor(e.props.scroll.bodyRows, e.viewport?.rows) : undefined
    // the terminal: whether the pane holds the keyboard, since its keys type into the prompt while it does not (the desktop's drawing keeps out of it: ./renderMemo)
    const isKeyless = e.surface === 'terminal' && e.props.isFocused === false
    // a drawing made anew says whether it holds Org's chart Client; one returned from the memo holds what the last did
    let holdsClient: boolean | undefined
    const tree = drawn.of(`pane:${e.surface}`, [e.props.bodyColumns, rows ?? 0, shownKey, view, isKeyless], () => {
      holdsClient = false
      const kit = { ...kitOf($.ui.resolve(e), e.surface, Math.max(24, e.props.bodyColumns - 1), rows), ...(isKeyless ? { isKeyless } : {}) }
      return deckView(kit, modelOf(now), actionsFor($), dashOf(now, e.surface, $, () => (holdsClient = true)))
    })
    if (holdsClient === true) listenForChart($, e.surface)
    else if (holdsClient === false) stopListening(chartBeats, e.surface)
    return tree
  })

  // what Org's chart Client posts: its beat each second, and a card clicked, which opens that agent's page
  on('ui.message', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (isBeat(e.data)) noteBeat(chartBeats, e.surface)
    else await openFromChart($, e.data)
    return next(e)
  })

  // the pane's focus ring, wherever it moved (your Tab, arrows or click; the deck's j, k and n): where they move it from next
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) paneFocus = e.element ?? ''
    return result
  })

  // your own scrolling of the pane: whether it leaves you at the end, where Chat keeps to its newest message; read from the move as you made it, before the engine answers, so nothing the deck does meanwhile takes you back down
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') chatFollow.isAtEnd = isAtEndAfter(e)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    noteScreen(e.surface, e.viewport)
    if (e.props.hasSurvey) return next(e)
    const now = await $.clock.now()
    // one line, this session's: only while an agent is at work or something needs you (`W.bandOf`), and the person has not hidden it; Claude Code's own loops raise none
    const band = view.isBandHidden ? null : W.bandOf(v2Of(now))
    // what the Browser pane's page sent in your voice shows whatever else does: hidden band, no agent at work
    if (!band && heldQueue().items.length === 0) return next(e)
    const theirs: RenderElement = await next(e)
    // the band speaks for the screen only while the pane, which shows more, is shut
    const key = screenKey(now)
    if (!isPaneOpen) shownKey = key
    return drawn.of(`band:${e.surface}`, [e.props.bodyColumns, key, view, theirs, heldQueue().version], () => {
      const kit = kitOf($.ui.resolve(e), e.surface, Math.max(24, e.props.bodyColumns))
      return bandOf(kit, { ...modelOf(now), band }, actionsFor($), theirs) ?? theirs
    })
  })

  // Inspect's own events (./inspectHooks), each observing only: a compaction, the context measured, the instruction files, the mode, the settings

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (await inspectCompaction($, data, e, result)) {
      touched($, await $.clock.now())
      void readContextSoon($)
    }
    return result
  })

  // the engine measured the session (after each main-thread turn): the breakdown read again, at most every 10 s; the spend and the context read again when they moved, the deck shut or not, so the header, state.json and this deck's registry file follow
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    void readContextSoon($)
    if (e.changed.includes('cost') || e.changed.includes('context')) void loadUsage($)
    return result
  })

  // how the main loop's session began (Claude Code's SessionStart): a fork's spend counts the session it was forked from
  on('classic.SessionStart', async ($, e, next) => {
    void sessionBegan($, e)
    return next(e)
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    if (await inspectInstructions($, data, result.instructionFiles ?? e.instructionFiles)) touched($, await $.clock.now())
    return result
  })

  on('classic.InstructionsLoaded', async ($, e, next) => {
    const result = await next(e)
    if (await inspectInstructionLoaded($, data, e)) touched($, await $.clock.now())
    return result
  })

  // the main loop's permission mode and effort, as each of these names them
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    if (inspectMode(data, e)) touched($, await $.clock.now())
    return result
  })

  // each also says Claude Code ran the call (it was not refused before it ran): Inspect's decisions and Recent activity's "⊘ denied" read it
  on('classic.PostToolUse', async ($, e, next) => {
    inspectRan(e.tool_use_id)
    const result = await next(e)
    if (inspectMode(data, e)) touched($, await $.clock.now())
    return result
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    inspectRan(e.tool_use_id)
    const result = await next(e)
    if (inspectMode(data, e)) touched($, await $.clock.now())
    return result
  })

  // a settings file changed: its hooks and the output style read again
  on('classic.ConfigChange', async ($, e, next) => {
    const result = await next(e)
    void readInspected($)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PROBE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    // the surfaces that draw the Client: silent there, it is left out
    if ((e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in ui && !probe.failedOn.has(e.surface)) listenForProbe($, e.surface)
    return probeView(ui, e, Svg)
  })

  // what the probe's Client posts (its beat each second, a click's cell); only this plugin's hooks hear it
  on('ui.message', { component: 'Pane', requestId: PROBE }, async ($, e, next) => {
    if (isBeat(e.data)) {
      probe.heard += 1
      noteBeat(probe.beats, e.surface)
    } else {
      probe.message = jsonLine(e.data)
      redrawDeck($)
    }
    return next(e)
  })
}

// ----------------------------------------------------------------------
// Formerly ./gitRunner.ts
/**
 * Git, run for the deck: every command ./git builds, run with its guards
 * (`runGit`: where git's settings come from read first, the repository's own
 * filters off, and its output dropped if they moved while it ran), the
 * repositories agents work in found and followed (./repos), and what
 * Changes reads: the branch and the uncommitted files (`refreshGit`), git's
 * own diff of each while the web deck is on (`readGitDiffs`), a file's diff
 * (`loadFileDiff`) and a commit (`loadCommit`). Untracked and attribute files
 * are read through web/files.js (`readSafely`), never following a link.
 *
 * Its state is its own (`git`, the file and the commit open, git's diffs),
 * read by the hooks module (register.tsx) and the web deck through the
 * accessors below; what it reads of the hooks module's (the session's data,
 * view and folder) and asks of it (a redraw, a save) it imports from there.
 */

let git: G.GitState = G.emptyGit()
let fileDiff: G.FileDiff | null = null
let commit: G.CommitDetail | null = null
let isGitBusy = false
let isGitQueued = false
let isHeavyQueued = false
let lastGitAt = 0
let lastHeavyAt = 0
/** Git's timer: its next read of the repository (`scheduleGit`). */
const gitTimers: { git?: Timer } = {}

/**
 * Git's own diff of each uncommitted file, by path, as the web deck serves
 * it (gitdiffs/<id>.diff, `W.GitDiffs`): read after each read of git while
 * the web deck is on (`readGitDiffs`), and replaced whole when one changes.
 */
let gitDiffs: W.GitDiffs = new Map()

/** Git's state as the deck last read it (`refreshGit`). */
export function currentGit(): G.GitState {
  return git
}

/** The file whose diff Changes has open, as read (`loadFileDiff`); null for none. */
export function currentFileDiff(): G.FileDiff | null {
  return fileDiff
}

/** The commit Changes has open, as read (`loadCommit`); null for none. */
export function currentCommit(): G.CommitDetail | null {
  return commit
}

/** Git's own diff of each uncommitted file (`gitDiffs`). */
export function currentGitDiffs(): W.GitDiffs {
  return gitDiffs
}

/** When git was read last; 0 before. */
export function lastGitRead(): number {
  return lastGitAt
}

/** Which repository each directory agents edit in belongs to (`book`): an edit notes its own there. */
export function repoBook(): R.RepoBook {
  return book
}

/** Lets the file's diff Changes had open go: the next one is read afresh. */
export function closeFileDiff(): void {
  fileDiff = null
}

/** Lets the commit Changes had open go. */
export function closeCommit(): void {
  commit = null
}


/** Which repository each directory agents edit in belongs to, and the one the deck follows. */
let book: R.RepoBook = R.emptyBook()
/** The pin as `$.state` holds it. */
let savedPin = ''
/** The root the edits' display paths are made against; null until the first look. */
let shownRoot: string | null = null

/** What the deck told the person once about a repository's own git settings (a filter switched off, a repository it runs no git in, a git too old), by what it said. */
const gitTold = new Set<string>()

/** Says `text` once a session (a toast), however often git meets it again. */
function tellGitOnce($: EngineInterface, text: string) {
  if (gitTold.has(text)) return
  gitTold.add(text)
  $.ui.toast(text)
}

/** A git run's outcome: whether it exited 0, and what it printed. */
type GitRun = { ok: boolean; out: string; err: string }

/** The repositories the deck runs no git in again this session (their filter settings moved while it read them), by `R.keyOf` of where, and why. */
const gitRefused = new Map<string, string>()

/** The person's own home folder (`USERPROFILE`, else `HOME`), read once: where a repository's `~/` attribute file lies; '' when unknown. */
let userHome: string | null = null

/**
 * Reads attribute files through web/files.js (`readSafely`): `places` under
 * `root`, each a regular file there with no link anywhere on its way, at most
 * `G.MOST_ATTR_BYTES`. Their texts, the places not there, or the first one
 * that is a link, no plain file, too big or unreadable (`refused`).
 */
async function readAttrFiles($: EngineInterface, root: string, places: readonly string[]): Promise<{ texts: string[]; missing: string[] } | { refused: string }> {
  const stats = await Promise.all(
    places.map(async place => {
      try {
        return { place, stat: await $.fs.stat(joinPath(root, place)) }
      } catch {
        return { place, stat: null }
      }
    }),
  )
  const missing = stats.filter(one => one.stat === null).map(one => one.place)
  const wanted: Wanted[] = []
  for (const { place, stat } of stats) {
    if (stat === null) continue
    if (stat.isLink || stat.kind !== 'file' || stat.size > G.MOST_ATTR_BYTES) return { refused: place }
    wanted.push({ place, abs: joinPath(root, place), size: stat.size, mtimeMs: stat.mtimeMs })
  }
  const read = await readSafely($, root, wanted, G.MOST_ATTR_BYTES, G.MOST_ATTR_BYTES)
  const texts: string[] = []
  for (const one of wanted) {
    const got = read.get(one.place)
    if (got?.kind === 'none') missing.push(one.place)
    else if (got?.kind === 'file' && got.text !== undefined) texts.push(got.text)
    else if (got === undefined && isNodeMissing) {
      // no node to read it safely: the engine's read, after the look above. Only the filter names in it are taken, never shown, so a link swapped in here hands over no text
      try {
        texts.push(await $.fs.read(one.abs))
      } catch {
        return { refused: one.place }
      }
    } else return { refused: one.place }
  }
  return { texts, missing }
}

/** Splits an absolute path into its folder and its name, for `readAttrFiles` (a drive's or the disk's root stays a root). */
function folderAndName(path: string): [string, string] {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const folder = cut <= 0 ? '/' : path.slice(0, cut)
  return [/^[A-Za-z]:$/.test(folder) ? `${folder}/` : folder, path.slice(cut + 1)]
}

/**
 * The filter driver names a repository's attribute files name (`filter=NAME`,
 * a macro's own line included), read there and then beside its config, so
 * each can be switched off even if the repository defines it in its config
 * after the deck read that (`G.attrFilterNamesOf`): every `.gitattributes`
 * git lists in it (tracked, untracked or ignored, nested ones too:
 * `G.argv.attrFiles`, `G.argv.ignoredAttrFiles`; a tracked one gone from the
 * working tree as the index holds it, which git reads then), its
 * `info/attributes` where git keeps it, and the `core.attributesFile` its own
 * config names (`G.attributesFileOf`, placed as git places it). Each is read
 * through web/files.js; one that is a link, no plain file, too big or
 * unreadable is a refusal, as is a list git could not give. None of their
 * text is ever shown.
 */
async function attrNamesIn($: EngineInterface, where: string, listing: string, lists: { attrs: GitRun; ignored: GitRun; info: GitRun }, run: (argv: readonly string[], ms: number) => Promise<GitRun>): Promise<string[] | { refusal: string }> {
  const { attrs, ignored, info } = lists
  if (!attrs.ok || !ignored.ok || !info.ok) return { refusal: 'git could not list its attribute files' }
  const places = G.attrPlacesOf(attrs.out, ignored.out)
  if (places.length > G.MOST_ATTR_FILES) return { refusal: G.attrRefusalOf(`${places.length} .gitattributes files`) }
  if (userHome === null) userHome = ((await $.env.get('USERPROFILE').catch(() => undefined)) ?? (await $.env.get('HOME').catch(() => undefined)) ?? '').trim()
  const named = G.attributesFileOf(listing, where, userHome)
  if (typeof named !== 'string') return named
  const infoPath = info.out.replace(/\r?\n$/, '')
  const outside = [infoPath === '' ? '' : /^(?:[\\/]|[A-Za-z]:[\\/])/.test(infoPath) ? infoPath : joinPath(where, infoPath), named].filter(one => one !== '')
  const texts: string[] = []
  const inTree = await readAttrFiles($, where, places)
  if ('refused' in inTree) return { refusal: G.attrRefusalOf(inTree.refused) }
  texts.push(...inTree.texts)
  for (const path of outside) {
    const [folder, name] = folderAndName(path)
    const one = await readAttrFiles($, folder, [name])
    if ('refused' in one) return { refusal: G.attrRefusalOf(path) }
    texts.push(...one.texts)
  }
  // a tracked one gone from the working tree: git reads the index's
  for (const place of inTree.missing.slice(0, 16)) {
    const blob = await run(G.argvIn(G.argv.indexBlob(place), where), 5_000)
    if (!blob.ok) continue
    if (blob.out.length > G.MOST_ATTR_BYTES) return { refusal: G.attrRefusalOf(place) }
    texts.push(blob.out)
  }
  if (inTree.missing.length > 16) return { refusal: G.attrRefusalOf(inTree.missing[16] ?? '') }
  return G.attrFilterNamesOf(texts)
}

/**
 * Runs git in `where`, the repository shown unless told otherwise; with
 * none, runs nothing. Each run first reads where git's settings there come
 * from (`G.argv.config`), there and then, so nothing the repository's own
 * config defines runs (`G.repoConfigOf`: its filter drivers off, the rest
 * held off by every command's own options); where git cannot say, nothing
 * runs. A command that reads the working tree (`G.readsWorktree`, the only
 * kind a filter runs in) has every filter the repository's attribute files
 * name blanked too (`attrNamesIn`), so one its config defines only after
 * that read has nothing to attach to; and once it ran, the filter settings
 * are read again: moved (`G.filterSettingsOf`), its output is dropped and
 * the repository refused for the session (`gitRefused`), with a notice.
 * Git starts in the session's own folder and changes to `where` itself
 * (`G.argvIn`).
 */
export async function runGit($: EngineInterface, args: readonly string[], timeoutMs = 15_000, where = git.root): Promise<GitRun> {
  if (!where) return { ok: false, out: '', err: 'not in a git repository' }
  const refused = gitRefused.get(R.keyOf(where))
  if (refused !== undefined) return { ok: false, out: '', err: refused }
  const run = async (argv: readonly string[], ms: number): Promise<GitRun> => {
    try {
      const ran = await $.process.run(argv, { env: G.GIT_ENV, timeoutMs: ms })
      return { ok: ran.exitCode === 0, out: ran.stdout, err: ran.stderr }
    } catch (error) {
      return { ok: false, out: '', err: error instanceof Error ? error.message : String(error) }
    }
  }
  const isTree = G.readsWorktree(args)
  const ms = Math.min(timeoutMs, 5_000)
  const none: GitRun = { ok: true, out: '', err: '' }
  const [listed, attrs, ignored, info] = await Promise.all([
    run(G.argvIn(G.argv.config, where), ms),
    isTree ? run(G.argvIn(G.argv.attrFiles, where), ms) : none,
    isTree ? run(G.argvIn(G.argv.ignoredAttrFiles, where), ms) : none,
    isTree ? run(G.argvIn(G.argv.infoAttributes, where), ms) : none,
  ])
  if (!listed.ok) {
    const why = G.configRefusalOf(listed.err)
    if (why === G.OLD_GIT) tellGitOnce($, why)
    return { ok: false, out: '', err: why }
  }
  const name = F.baseName(R.cleanPath(where))
  // the filters the repository's attribute files name, blanked too, so a definition it writes into its config after this read cannot attach to one (a race)
  const names = isTree ? await attrNamesIn($, where, listed.out, { attrs, ignored, info }, run) : []
  const plan = Array.isArray(names) ? G.repoConfigOf(listed.out, names) : names
  if ('refusal' in plan) {
    tellGitOnce($, `${name}: ${plan.refusal}`)
    return { ok: false, out: '', err: plan.refusal }
  }
  if (plan.drivers.length > 0) tellGitOnce($, `Changes reads ${name} with its own git ${plan.drivers.length === 1 ? 'filter' : 'filters'} (${plan.drivers.join(', ')}) off: files ${plan.drivers.length === 1 ? 'it handles' : 'they handle'} may show as changed.`)
  const ran = await run(G.argvIn(args, where, plan.overrides), timeoutMs)
  if (!isTree) return ran
  // a filter defined while git ran (the race): what it printed is dropped, and the repository refused from now on
  const after = await run(G.argvIn(G.argv.config, where), ms)
  if (!after.ok || G.filterSettingsOf(after.out) !== G.filterSettingsOf(listed.out)) {
    gitRefused.set(R.keyOf(where), G.SETTINGS_MOVED)
    tellGitOnce($, `${name}: ${G.SETTINGS_MOVED}`)
    return { ok: false, out: '', err: G.SETTINGS_MOVED }
  }
  return ran
}

/** The root of the repository holding `dir` as git spells it; null outside one, or where git cannot run. */
async function probeRoot($: EngineInterface, dir: string): Promise<string | null> {
  const ran = await runGit($, G.argv.toplevel, 10_000, dir || '.')
  return (ran.ok && R.rootOf(ran.out)) || null
}

/** Probes what the book has not seen yet (the session's directory, a kept pin, each new edited directory), four at a time; then looks once into a session's directory in no repository. */
async function discoverRepos($: EngineInterface): Promise<void> {
  const probes = R.probesOf(book)
  for (let i = 0; i < probes.length; i += 4) {
    await Promise.all(probes.slice(i, i + 4).map(async probe => R.settle(book, probe, await probeRoot($, probe.dir))))
  }
  if (R.needsNearby(book)) await lookNearby($)
}

/**
 * Looks once into the session's directory while it is in no repository, for
 * Changes' picks: each child directory holding a `.git` (a folder, or a
 * worktree's file), and when that last changed. No git runs: one listing and
 * a stat a child, sixteen at a time; what it found is kept for that directory.
 */
async function lookNearby($: EngineInterface): Promise<void> {
  const dir = book.cwd
  let names: string[] = []
  try {
    names = R.childDirsOf(await $.fs.list(dir))
  } catch {
    // a directory that cannot be listed offers no picks
  }
  const found: { name: string; changedAt: number }[] = []
  for (let i = 0; i < names.length; i += 16) {
    await Promise.all(
      names.slice(i, i + 16).map(async name => {
        try {
          const stat = await $.fs.stat(R.childOf(R.childOf(dir, name), '.git'))
          if (stat.kind !== 'other') found.push({ name, changedAt: stat.mtimeMs })
        } catch {
          // no .git there: not a repository's top
        }
      }),
    )
  }
  if (R.sameRoot(dir, book.cwd)) R.settleNearby(book, dir, found)
}

/** What the book tells git's state: every repository found, the pin, whether the session's directory is in one, and the picks inside it while it is not. */
function bookFields(): Pick<G.GitState, 'repos' | 'pinned' | 'isCwdRepo' | 'nearby'> {
  return { repos: R.repoList(book), pinned: book.pinned, isCwdRepo: book.cwdRoot === null ? null : book.cwdRoot !== '', nearby: R.nearbyOf(book) }
}

/** Keeps the pin in `$.state`, so a reload of the deck keeps it too. */
function savePin($: EngineInterface) {
  if (book.pinned === savedPin) return
  savedPin = book.pinned
  void $.state.set(REPO_PIN, book.pinned).catch(() => undefined)
}

/** Starts following the work: the session's repository, the ones restored edits lie in, and a pin kept from before a reload. */
export async function startRepos($: EngineInterface): Promise<void> {
  R.setCwd(book, currentCwd())
  for (const edit of currentData().edits) R.noteEdit(book, edit.abs, edit.at)
  try {
    const { value } = await $.state.get(REPO_PIN)
    if (typeof value === 'string') {
      book.pinned = value
      savedPin = value
    }
  } catch {
    // no pin kept: the deck follows the work
  }
  await refreshGit($, true)
}

/**
 * Pins the deck to the repository holding `root` (a root from `git.repos` or
 * `git.nearby`, or any directory inside a repository); '' lets it follow the
 * work again: the repository an agent edited last, else the session's own.
 * Answers why it could not ('' when it did).
 */
export async function chooseRepo($: EngineInterface, root: string): Promise<string> {
  const wanted = root.trim()
  let pin = ''
  if (wanted) {
    const known = R.lookup(book, wanted)
    pin = (known === undefined ? await probeRoot($, wanted) : known) ?? ''
    if (!pin) return `Not in a git repository: ${wanted}`
    if (known === undefined) R.settleDir(book, wanted, pin)
  }
  book.pinned = pin
  savePin($)
  git = { ...git, ...bookFields() }
  redrawDeck($)
  await refreshGit($, true)
  return ''
}

/**
 * Moves the deck to the repository at `root` ('' for none): the file and
 * commit open in the last one close, and edits read from the new root.
 */
function switchRepo($: EngineInterface, root: string) {
  const from = shownRoot ?? R.rootOfEdits(currentData().edits)
  if (shownRoot !== null || (from !== '' && !R.sameRoot(from, root))) {
    fileDiff = null
    commit = null
    currentView().file = ''
    currentView().commit = ''
  }
  for (const edit of currentData().edits) edit.path = M.relOf(edit.abs, root || null)
  for (const file of Object.values(currentData().files)) file.path = M.relOf(file.abs, root || null)
  for (const agent of currentData().agents) agent.files = [...new Set(agent.files.map(path => R.rerootPath(path, from, root)))]
  shownRoot = root
  lastHeavyAt = 0
  git = { ...G.emptyGit(), root, ...bookFields() }
  saveDeckState($)
}

function joinPath(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${rel}`
}

/** The repository's own place as the file system resolves it (every link folded), for judging whether an untracked file's own place is inside it; `root` itself when it cannot be resolved. */
async function rootRealOf($: EngineInterface, root: string): Promise<string> {
  try {
    const stat = await $.fs.stat(root, { resolve: true })
    return R.cleanPath(stat.realPath ?? root)
  } catch {
    return R.cleanPath(root)
  }
}

/** Whether `real` (an absolute, resolved path) is `rootReal` or inside it. */
function isInsideRoot(real: string, rootReal: string): boolean {
  const a = R.keyOf(real)
  const b = R.keyOf(rootReal)
  return a === b || a.startsWith(`${b}/`)
}

/**
 * What an untracked path at `abs` is, as `$.fs.stat` sees it, never from
 * outside the repository (`rootReal`, resolved once): a symbolic link is
 * shown as git shows one, its target's path and never the target's content
 * (`target`, '' when it leads nowhere); a path whose real place is outside
 * the repository is left out (`outside`); a regular file inside it carries
 * its `size` and time, for the caller to read through web/files.js
 * (`readSafely`), which opens it without following a link anywhere, so a
 * file swapped for a link after this look is refused there, never read
 * through. git, asked of a path that is a link or leads outside, shows no
 * diff of its content either.
 */
type Untracked = { kind: 'link'; target: string } | { kind: 'file'; size: number; mtimeMs: number } | { kind: 'outside' } | { kind: 'gone' }
async function untrackedAt($: EngineInterface, abs: string, rootReal: string): Promise<Untracked> {
  try {
    const stat = await $.fs.stat(abs, { resolve: true })
    if (stat.isLink) return { kind: 'link', target: stat.realPath ?? '' }
    if (stat.realPath === undefined || !isInsideRoot(stat.realPath, rootReal)) return { kind: 'outside' }
    if (stat.kind !== 'file') return { kind: 'gone' }
    return { kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return { kind: 'gone' }
  }
}

/** What web/files.js read of each file the deck reads safely (an untracked file, an attribute file), as it stood then: read again only once its size or time moves (`FB.keptOf`). */
const fileBook: FB.FileBook = new Map()

/** A file to read under a folder: its place there, its whole path, and its size and time as `$.fs.stat` saw them just before. */
type Wanted = { place: string; abs: string; size: number; mtimeMs: number }

/** web/files.js could not start at its last run (no node on PATH): a new file then shows no text, and says why. */
let isNodeMissing = false

/**
 * Reads `wanted` under `root` through web/files.js (node, no shell), never
 * with `$.fs.read`: each file is opened without following a link anywhere on
 * its path, and read only if it is a regular file. A file `fileBook` holds
 * with the same size and time is answered from there; the rest are read in
 * runs of at most 64, so a refresh where nothing changed starts no node. A
 * file the helper could not answer for is left out.
 */
async function readSafely($: EngineInterface, root: string, wanted: readonly Wanted[], most: number, textMost: number): Promise<Map<string, FB.FileRead>> {
  const out = new Map<string, FB.FileRead>()
  const fresh: Wanted[] = []
  for (const one of wanted) {
    const kept = FB.keptOf(fileBook, one.abs, one.size, one.mtimeMs, textMost)
    if (kept) out.set(one.place, kept)
    else fresh.push(one)
  }
  const script = `${`${$.plugin.root}`.replace(/[\\/]+$/, '')}/web/files.js`
  for (let i = 0; i < fresh.length; i += FB.MOST_PATHS) {
    const batch = fresh.slice(i, i + FB.MOST_PATHS)
    const paths = batch.map(one => one.place)
    let answer: Map<string, FB.FileRead> | null = null
    try {
      const ran = await $.process.run(FB.filesArgvOf(script), { stdin: FB.requestTextOf({ root, paths, most, textMost }), timeoutMs: 15_000, ...(nodeCwd() ? { cwd: nodeCwd() } : {}) })
      answer = ran.exitCode === 0 ? FB.answerOf(ran.stdout, paths) : null
      isNodeMissing = false
    } catch (error) {
      isNodeMissing = /ENOENT|not found|failed to start/i.test(error instanceof Error ? error.message : String(error))
      answer = null
    }
    if (!answer) continue
    for (const one of batch) {
      const read = answer.get(one.place)
      if (!read) continue
      FB.keep(fileBook, one.abs, one.size, one.mtimeMs, read)
      out.set(one.place, read)
    }
  }
  return out
}

/** An untracked file as the deck shows it: a link, one outside the repository, one gone, or what web/files.js read of it. */
type UntrackedRead = Exclude<Untracked, { kind: 'file' }> | FB.FileRead

/**
 * The untracked files at `places` under `root`, as the deck shows them: a
 * link as its target's path, one outside the repository or gone as such, one
 * past `most` bytes as `big`, and each plain file read safely (`readSafely`),
 * with its text when it is at most `textMost`.
 */
async function untrackedOf($: EngineInterface, root: string, places: readonly string[], most: number, textMost: number): Promise<Map<string, UntrackedRead>> {
  const rootReal = await rootRealOf($, root)
  const found = await Promise.all(places.map(async place => [place, await untrackedAt($, joinPath(root, place), rootReal)] as const))
  const out = new Map<string, UntrackedRead>()
  const wanted: Wanted[] = []
  for (const [place, one] of found) {
    if (one.kind !== 'file') out.set(place, one)
    else if (one.size > most) out.set(place, { kind: 'big', size: one.size })
    else wanted.push({ place, abs: joinPath(root, place), size: one.size, mtimeMs: one.mtimeMs })
  }
  const read = await readSafely($, root, wanted, most, textMost)
  for (const one of wanted) out.set(one.place, read.get(one.place) ?? { kind: 'gone' })
  return out
}

/** The diff a link shows: one added line, its target's path, as git shows a symbolic link (never the target's content). */
function linkHunks(target: string): Hunk[] {
  return addedFileHunks(`${target}\n`)
}

/** An untracked file's line count for its row: a link counts as its one line of target text; a file outside the repository, too big (past 1 MB), binary or unreadable is left uncounted. */
function lineCountOf(read: UntrackedRead): number | null {
  if (read.kind === 'link') return read.target === '' ? 0 : 1
  return read.kind === 'file' ? read.lines : null
}

export function scheduleGit($: EngineInterface, ms: number, isHeavy = false) {
  isHeavyQueued ||= isHeavy
  gitTimers.git?.cancel()
  gitTimers.git = $.clock.after(ms, () => {
    gitTimers.git = undefined
    const heavy = isHeavyQueued
    isHeavyQueued = false
    void refreshGit($, heavy)
  })
}

/**
 * Reads the repository the deck follows (after probing any directory agents
 * newly edited in): branch, uncommitted files with counts, and (when HEAD
 * moved) the log and day totals.
 */
export async function refreshGit($: EngineInterface, isHeavy = false): Promise<void> {
  if (isGitBusy) {
    isGitQueued = true
    isHeavyQueued ||= isHeavy
    return
  }
  isGitBusy = true

  try {
    await discoverRepos($)
    const now = await $.clock.now()
    const root = R.activeRoot(book)
    if (shownRoot === null || !R.sameRoot(root, shownRoot)) switchRepo($, root)

    if (!root) {
      git = { ...G.emptyGit(), isRepo: false, checkedAt: now, ...bookFields() }
      return
    }

    const run = (args: readonly string[]) => runGit($, args, 15_000, root)
    const [branch, head, status] = await Promise.all([run(G.argv.branch), run(G.argv.head), run(G.argv.status)])

    if (!status.ok) {
      if (!R.sameRoot((await probeRoot($, root)) ?? '', root)) {
        // gone: follow the work to another repository, if any
        R.dropRepo(book, root)
        isGitQueued = true
      }
      git = { ...G.emptyGit(), root, isRepo: false, checkedAt: now, error: F.trunc(status.err.trim(), 200), ...bookFields() }
      return
    }

    const headHash = head.ok ? head.out.trim() : ''
    const numstat = await run(G.argv.numstat(headHash ? 'HEAD' : G.EMPTY_TREE))
    const rows = G.parseStatus(status.out)
    const untracked = new Map<string, number>()
    // read once for both: the line counts, and while the web deck is on the text its diffs show (`readGitDiffs` then finds it kept)
    const reads = await untrackedOf(
      $,
      root,
      rows.filter(row => row.x === '?').slice(0, 30).map(row => row.path),
      1_000_000,
      isSharing() ? W.GIT_DIFF_MOST : 0,
    )
    for (const [place, read] of reads) {
      const lines = lineCountOf(read)
      if (lines !== null) untracked.set(place, lines)
    }

    const files = G.filesOf(rows, G.parseNumstat(numstat.out), untracked)
    const nextUp: G.GitState = {
      ...git,
      isRepo: true,
      branch: branch.ok ? branch.out.trim() : '',
      head: headHash,
      files,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
      checkedAt: now,
      ...bookFields(),
    }

    const isMoved = headHash !== git.head
    if (isMoved || isHeavy || now - lastHeavyAt > 60_000) {
      lastHeavyAt = now
      const [log, upstream, aheadBehind, todayCount, todayStat, sessionCount] = await Promise.all([
        run(G.argv.log(30)),
        run(G.argv.upstream),
        run(G.argv.aheadBehind),
        run(G.argv.countSince('midnight')),
        run(G.argv.statSince('midnight')),
        run(G.argv.countSince(G.sinceOf(currentData().startedAt - 60_000))),
      ])
      const [behind = 0, ahead = 0] = aheadBehind.ok ? aheadBehind.out.trim().split(/\s+/).map(Number) : [0, 0]
      nextUp.commits = log.ok ? G.parseLog(log.out) : []
      nextUp.upstream = upstream.ok ? upstream.out.trim() : ''
      nextUp.ahead = Number.isFinite(ahead) ? ahead : 0
      nextUp.behind = Number.isFinite(behind) ? behind : 0
      nextUp.today = { commits: todayCount.ok ? Number(todayCount.out.trim()) || 0 : 0, ...(todayStat.ok ? G.sumShortstats(todayStat.out) : { added: 0, removed: 0 }) }
      nextUp.sessionCommits = sessionCount.ok ? Number(sessionCount.out.trim()) || 0 : 0
    }

    git = nextUp
    if (currentView().file && currentView().v2.tab === 'changes') void loadFileDiff($, currentView().file)
  } finally {
    isGitBusy = false
    savePin($)
    lastGitAt = await $.clock.now()
    redrawIfChanged($, lastGitAt)
    if (isGitQueued) {
      isGitQueued = false
      scheduleGit($, 300)
    }
  }
  void readGitDiffs($)
}

/** The most untracked files whose whole text one read of git's diffs takes. */
const GIT_DIFF_UNTRACKED = 30

/** One read of git's diffs at a time; another asked for meanwhile runs after it. */
const gitDiffRead = { isBusy: false, isQueued: false }

/**
 * Git's own diff of each uncommitted file, while the web deck is on (none
 * otherwise): one `git diff` against HEAD for the tracked files, split per
 * file, and the whole text of the first 30 untracked ones. A binary file, or
 * one past `W.GIT_DIFF_MOST`, has none. Kept (and the state redrawn) only
 * when one changed, and only for the repository the deck still shows.
 */
export async function readGitDiffs($: EngineInterface): Promise<void> {
  if (!isSharing() || git.isRepo !== true || git.root === '') {
    if (gitDiffs.size > 0) gitDiffs = new Map()
    return
  }
  if (gitDiffRead.isBusy) {
    gitDiffRead.isQueued = true
    return
  }
  gitDiffRead.isBusy = true
  try {
    const { root, head, files } = git
    const nextUp = new Map<string, { id: string; text: string }>()
    const keep = (path: string, hunks: readonly Hunk[]) => {
      const text = W.gitDiffTextOf(hunks)
      if (text !== '' && text.length <= W.GIT_DIFF_MOST) nextUp.set(path, { id: W.gitDiffIdOf(path, text), text })
    }
    const tracked = files.filter(file => !file.isUntracked)
    if (tracked.length > 0) {
      const ran = await runGit($, G.argv.fileDiff(head ? 'HEAD' : G.EMPTY_TREE, []), 20_000, root)
      if (ran.ok) {
        for (const one of filePatchesOf(ran.out)) {
          const row = tracked.find(file => file.path === one.path)
          if (row && !one.isBinary) keep(row.path, hunksOf(one.text))
        }
      }
    }
    const places = files.filter(one => one.isUntracked).slice(0, GIT_DIFF_UNTRACKED).map(one => one.path)
    for (const [place, read] of await untrackedOf($, root, places, W.GIT_DIFF_MOST, W.GIT_DIFF_MOST)) {
      // a link shows as its target's path (git's own diff of one); its content, and a file outside the repository, are never read; one that cannot be read has no diff
      if (read.kind === 'link') keep(place, linkHunks(read.target))
      else if (read.kind === 'file' && read.text !== undefined) keep(place, addedFileHunks(read.text))
    }
    // read in a repository the deck has since left: not this one's
    if (!R.sameRoot(root, git.root)) return
    const isSame = nextUp.size === gitDiffs.size && [...nextUp].every(([path, one]) => gitDiffs.get(path)?.id === one.id)
    if (isSame) return
    gitDiffs = nextUp
    redrawIfChanged($, await $.clock.now())
  } catch {
    // the diffs stand as they were
  } finally {
    gitDiffRead.isBusy = false
    if (gitDiffRead.isQueued) {
      gitDiffRead.isQueued = false
      void readGitDiffs($)
    }
  }
}

export async function loadFileDiff($: EngineInterface, path: string): Promise<void> {
  const { root, head } = git
  const row = git.files.find(file => file.path === path)
  const now = await $.clock.now()
  let found: G.FileDiff

  if (!row) {
    found = { path, hunks: [], isBinary: false, note: 'This file has no uncommitted changes any more.', at: now }
  } else if (row.isUntracked) {
    let read: UntrackedRead = { kind: 'gone' }
    try {
      read = (await untrackedOf($, root, [path], 2_000_000, 2_000_000)).get(path) ?? read
    } catch {
      // a file that cannot be read says so
    }
    if (read.kind === 'link') {
      // a link shows as its target's path, the way git shows one (its one line of diff); its content is never read
      found = { path, hunks: linkHunks(read.target), isBinary: false, at: now }
    } else if (read.kind === 'outside') {
      found = { path, hunks: [], isBinary: false, note: 'This file lies outside the repository.', at: now }
    } else if (read.kind === 'big' || (read.kind === 'file' && read.text === undefined)) {
      found = { path, hunks: [], isBinary: false, note: `New file, ${Math.round(read.size / 1024)} KB: too big to show.`, at: now }
    } else if (read.kind === 'binary') {
      found = { path, hunks: [], isBinary: true, at: now }
    } else if (read.kind === 'file') {
      found = { path, hunks: addedFileHunks(read.text ?? ''), isBinary: false, at: now }
    } else {
      found = { path, hunks: [], isBinary: false, note: isNodeMissing ? 'Could not read this new file: Eagle Eye reads new files with Node.js, which is not on PATH.' : 'Could not read this new file.', at: now }
    }
  } else {
    const paths = row.oldPath ? [row.oldPath, path] : [path]
    const ran = await runGit($, G.argv.fileDiff(head ? 'HEAD' : G.EMPTY_TREE, paths), 15_000, root)
    found = {
      path,
      hunks: hunksOf(ran.out),
      isBinary: /^Binary files /m.test(ran.out),
      at: now,
      ...(ran.ok ? {} : { note: F.trunc(ran.err.trim() || 'git diff failed', 200) }),
    }
  }

  // a diff read in the repository the deck has since left stays unshown
  if (!R.sameRoot(root, git.root)) return
  const isSame = fileDiff !== null && sameFileDiff(fileDiff, found)
  fileDiff = found
  if (!isSame) redrawDeck($)
}

/** Whether two reads of a file's diff show the same; when each was read does not count. */
function sameFileDiff(a: G.FileDiff, b: G.FileDiff): boolean {
  return a.path === b.path && a.isBinary === b.isBinary && a.note === b.note && JSON.stringify(a.hunks) === JSON.stringify(b.hunks)
}

export async function loadCommit($: EngineInterface, hash: string): Promise<void> {
  const root = git.root
  // git is handed a commit's name as git printed it, never anything it could read as an option
  if (!G.isHash(hash)) return
  const [meta, numstat, patch] = await Promise.all([
    runGit($, G.argv.showMeta(hash), 15_000, root),
    runGit($, G.argv.showNumstat(hash), 15_000, root),
    runGit($, G.argv.showPatch(hash), 30_000, root),
  ])

  if (currentView().commit !== hash || !R.sameRoot(root, git.root)) return
  if (!meta.ok) {
    commit = null
    $.ui.toast(`Could not read commit ${hash.slice(0, 7)}`)
    return
  }

  const cap = 160_000
  commit = {
    ...G.parseMeta(meta.out),
    hash,
    files: G.parseNumstat(numstat.out),
    patch: patch.out.slice(0, cap),
    isPatchCut: patch.out.length > cap,
  }
  redrawDeck($)
}

// ----------------------------------------------------------------------
// Formerly ./inspectHooks.ts
/**
 * Inspect's engine side: what the hooks module's events hand it, and the
 * reads it makes of the engine, each recorded into the deck's data through
 * hooks/inspect.ts. Every function says whether the data changed; the hooks
 * module (register.tsx) registers the events, keeps the data, and saves and
 * draws (`touched`) when one did. Every hook that calls these observes only:
 * it returns what is beneath it, unchanged.
 *
 * - `session.compact`: a compaction that stands (its summary, its tokens
 *   before and after) or one refused; `precompute` is no compaction.
 * - `session.measure`, and each compaction: the context read again as
 *   /context breaks it down (`host.contextUsage()`,
 *   which sends no request), at most once every 10 s (`contextWaitOf`).
 * - `prompt.context`: the instruction files the conversation carries;
 *   `classic.InstructionsLoaded`: each one loaded, and why.
 * - A classic hook's input (`classic.UserPromptSubmit`, `PostToolUse`,
 *   `Stop`, `PermissionRequest`, `PermissionDenied`): the main loop's
 *   permission mode and effort.
 * - `classic.ConfigChange`, and the session's start: the model, the output
 *   style and the settings' hooks read again.
 * - `tool.check`, the permission dialog, auto mode's refusal and each call's
 *   start and end: the permission decisions, the skills run, the MCP tools
 *   called.
 */

/** The least time between two reads of the context's breakdown. */
export const CONTEXT_EVERY_MS = 10_000

/** The settings sources whose hooks Loaded lists, lowest precedence first. */
const SOURCES = ['user', 'project', 'local', 'policy'] as const

/** When the breakdown was read last, and whether a read runs now. */
const read = { at: 0, isBusy: false }

/** How long until the breakdown may be read again (0: now; a read running counts as just made). */
export function contextWaitOf(now: number): number {
  if (read.isBusy) return CONTEXT_EVERY_MS
  return Math.max(0, read.at + CONTEXT_EVERY_MS - now)
}

/** The context's breakdown read now, and what it lists of what is loaded. Whether it was recorded. */
export async function readInspectContext($: EngineInterface, data: DeckData): Promise<boolean> {
  if (read.isBusy) return false
  read.isBusy = true
  try {
    const raw = await $.session.usage({ breakdown: 'summary' })
    const now = await $.clock.now()
    read.at = now
    const breakdown = raw.context.breakdown
    if (!breakdown) return false
    I.noteBreakdown(data, breakdown, raw.context.window, now)
    return true
  } catch {
    // the breakdown is Inspect's alone: the deck goes on without it
    return false
  } finally {
    read.isBusy = false
  }
}

/** The model, the output style and the hooks of every settings source, as the engine reads them now. Whether they were recorded. */
export async function readInspectLoaded($: EngineInterface, data: DeckData): Promise<boolean> {
  try {
    const at = await $.clock.now()
    let model = ''
    try {
      model = await $.session.model()
    } catch {
      // the model shows once a request reports it
    }
    const hooks: DeckHook[] = []
    for (const source of SOURCES) {
      try {
        hooks.push(...I.hooksOf(await $.settings.read({ source }), source))
      } catch {
        // a source the engine bars from the read lists none
      }
    }
    let outputStyle = ''
    try {
      const style = await $.settings.read({ key: 'outputStyle' })
      if (typeof style === 'string') outputStyle = style
    } catch {
      // none set in the settings: /config's row says it below
    }
    if (outputStyle === '') {
      try {
        const row = (await $.config.list()).find(one => /^output.?style$/i.test(one.key) || /^output style$/i.test(one.label))
        if (row && typeof row.value === 'string') outputStyle = row.value
      } catch {
        // no row for it: the output style is left unsaid
      }
    }
    I.noteLoaded(data, { ...(model ? { model } : {}), ...(outputStyle ? { outputStyle } : {}), hooks }, at)
    return true
  } catch {
    // Loaded stays as it was
    return false
  }
}

/** A `session.compact` and what came of it: one that stands, or one refused; nothing for a `precompute`. Whether it was recorded. */
export async function inspectCompaction($: EngineInterface, data: DeckData, ev: SessionCompactInput, result: SessionCompactResult): Promise<boolean> {
  if (ev.trigger === 'precompute') return false
  try {
    const at = await $.clock.now()
    const agent = ev.agentId ?? M.MAIN
    if (result.skip !== undefined) {
      I.noteCompaction(data, { agent, trigger: ev.trigger, summary: '', skipped: result.skip, at })
    } else {
      const summary = result.messages[0]?.text ?? ''
      I.noteCompaction(data, { agent, trigger: ev.trigger, summary, at, ...(result.tokensBefore !== undefined ? { before: result.tokensBefore } : {}), ...(result.tokensAfter !== undefined ? { after: result.tokensAfter } : {}) })
    }
    return true
  } catch {
    // the compaction stands whatever the deck makes of it
    return false
  }
}

/** The instruction files `prompt.context` says the conversation carries (its answer's, else its input's). Whether any was recorded. */
export async function inspectInstructions($: EngineInterface, data: DeckData, files: readonly { path: string; kind: string; content: string; parent?: string }[] | undefined): Promise<boolean> {
  if (!files || files.length === 0) return false
  try {
    I.noteInstructions(
      data,
      files.map(file => ({ path: file.path, kind: file.kind, content: file.content, ...(file.parent ? { parent: file.parent } : {}) })),
      await $.clock.now(),
    )
    return true
  } catch {
    // the context goes out whatever the deck makes of it
    return false
  }
}

/** One file classic.InstructionsLoaded says loaded. Whether it was recorded. */
export async function inspectInstructionLoaded($: EngineInterface, data: DeckData, ev: { file_path: string; memory_type: string; load_reason: string; trigger_file_path?: string; parent_file_path?: string }): Promise<boolean> {
  try {
    I.noteInstructionLoaded(data, { path: ev.file_path, memoryType: ev.memory_type, reason: ev.load_reason, ...(ev.trigger_file_path ? { trigger: ev.trigger_file_path } : {}), ...(ev.parent_file_path ? { parent: ev.parent_file_path } : {}) }, await $.clock.now())
    return true
  } catch {
    // the file is loaded whatever the deck makes of it
    return false
  }
}

/** A classic hook's input: the main loop's mode and effort, kept when they moved. Whether they did. */
export function inspectMode(data: DeckData, input: { permission_mode?: unknown; effort?: unknown; agent_id?: unknown }): boolean {
  try {
    return I.noteMode(data, input)
  } catch {
    // the mode stays as it was heard last
    return false
  }
}

/** A call's `tool.check` verdict: recorded unless it is a query, the deck's own, or a question's. Whether it was. */
export async function inspectCheck($: EngineInterface, data: DeckData, ev: { tool: string; input: unknown; tool_use_id?: string; agentId?: string; approver?: string }, verdict: I.CheckIn['verdict'], isOwn: boolean, root: string | null): Promise<boolean> {
  if (isOwn || !ev.tool_use_id) return false
  try {
    return I.noteCheck(data, { id: ev.tool_use_id, tool: ev.tool, input: ev.input, agentId: ev.agentId ?? M.MAIN, verdict, ...(ev.approver ? { approver: ev.approver } : {}), at: await $.clock.now(), root }) !== undefined
  } catch {
    // the verdict stands whatever the deck makes of it
    return false
  }
}

/** A permission dialog for call `id` showed, or a PermissionRequest hook answered in its place; and the mode its input names. Whether anything changed. */
export function inspectDialog(data: DeckData, id: string | undefined, result: { decision?: { behavior?: unknown; message?: unknown }; block?: unknown }, input: { permission_mode?: unknown; effort?: unknown; agent_id?: unknown }): boolean {
  const isMode = inspectMode(data, input)
  try {
    return I.noteDialog(data, id, result.decision ?? null, result.block) || isMode
  } catch {
    // the dialog shows whatever the deck makes of it
    return isMode
  }
}

/** Auto mode refused a call (classic.PermissionDenied); and the mode its input names. Whether anything changed. */
export function inspectDenied(data: DeckData, ev: { tool_use_id: string; reason: string; permission_mode?: unknown; effort?: unknown; agent_id?: unknown }): boolean {
  const isMode = inspectMode(data, ev)
  try {
    return I.noteDenied(data, ev.tool_use_id, ev.reason) || isMode
  } catch {
    // the refusal stands whatever the deck makes of it
    return isMode
  }
}

/** A call began: a skill run, an MCP tool called. Its own touch follows. */
export function inspectCalled(data: DeckData, tool: string, input: unknown, at: number): void {
  try {
    I.noteCall(data, tool, input, at)
  } catch {
    // the call goes ahead whatever the deck makes of it
  }
}

/**
 * The calls Claude Code ran, by tool_use_id: its classic PostToolUse or
 * PostToolUseFailure named them (`inspectRan`; both fire inside the call,
 * before its `tool.call` resolves), until the call's end takes them
 * (`inspectEnded`). The newest 200: a call whose end never comes (the deck's
 * own, which its `tool.call` hook leaves alone) goes past them.
 */
const ranCalls = new Set<string>()
const MOST_RAN = 200

/** Claude Code ran call `id`: its classic PostToolUse or PostToolUseFailure fired. */
export function inspectRan(id: unknown): void {
  if (typeof id !== 'string' || id === '') return
  ranCalls.add(id)
  for (const old of ranCalls) {
    if (ranCalls.size <= MOST_RAN) break
    ranCalls.delete(old)
  }
}

/**
 * A call ended as `end` says: it ran, or it was refused (`I.refusalOfEnd`:
 * a hook's `deny`, or an error with no PostToolUse or PostToolUseFailure of
 * it, which is how Claude Code hands back a refusal). Its own touch follows.
 */
export function inspectEnded(data: DeckData, id: string, end: I.CallEnd): void {
  try {
    const hasRun = ranCalls.delete(id)
    const refusal = I.refusalOfEnd(end, hasRun)
    I.noteEnd(data, id, refusal === undefined, refusal ?? '')
  } catch {
    // tracking never changes what the tool returned
  }
}

// ----------------------------------------------------------------------
// Formerly ./webServer.ts
/**
 * The web deck's live half: Eagle Eye's home on disk (kept private by
 * web/home.js), the `web/server.js` child it starts and watches for the
 * session (`superviseWeb`), the state folder it writes (`writeWeb`), the
 * tickets its links carry, the openers (your own browser through
 * web/open.js, Claude's Browser pane), and what the Browser pane's page
 * sends in your voice, held for your Send above the prompt (./hold).
 *
 * Its state is its own (`web`, `held`, the home), read by the hooks module
 * (register.tsx) through the accessors below; what it reads of that module's
 * (the session's data, view and usage, the v2 view model) and asks of it (a
 * redraw, an ack, a page command run) it imports from there, and git's state
 * from ./gitRunner. What is pure is ./web's.
 */

/** The mod's folder (`$.plugin.root`, no trailing separator). */
let pluginRoot = ''
/** Eagle Eye's home (`SE.homeDirOf`: `EAGLE_EYE_HOME`, else `eagle-eye` under Claude Code's configuration folder), where each session's state folder lies (`<home>/web/<sessionId>`) and the debug dump goes; '' until read, or when no home is known. */
let home = ''

/** Where the deck starts a `node` child: the mod's own folder, else the home, never a workspace, so Windows (which looks for a bare `node` in the working folder first) never runs one a repository holds; undefined when neither is known (the session's own folder then, as in the tests). */
export function nodeCwd(): string | undefined {
  return pluginRoot || home || undefined
}

/** The web deck's timer: its next write of the state folder (`scheduleWeb`). */
const webTimers: { web?: Timer } = {}

/**
 * The web deck. `/eagle-eye web`, or "Open in browser" (the deck's header,
 * `o`, Settings), starts `web/server.js` for the session and opens the page
 * in your own browser with the system's opener; `/eagle-eye web pane` opens
 * it in the Desktop's Browser pane instead. Each link carries a one-time
 * ticket the page trades for a handle (web/server.js), of one of two grades
 * (`W.WebGrade`): your own browser's is `full`; the Browser pane's is
 * `pane`, since Claude's tools drive that pane, and what it sends in your
 * voice waits for your Send in the band (./hold). The terminal deck shows a `full` one as text
 * to copy. A link is never in what the model reads. While it is on, what the
 * deck holds goes to `<home>/web/<sessionId>/state.json` at most every 300 ms
 * after a change (`W.webStateOf`, with the v2 view model under `v2`), each
 * edit's patch once beside it, each agent's file when it changed, and the
 * page's commands come back as lines on the server's stdout.
 *
 * The folder is private (0700, each file 0600 before its first write, by
 * web/home.js) and lives only as long as the session: removed at its end,
 * emptied at a /clear, and a crashed session's swept at the next start.
 *
 * The child is the session's: `superviseWeb` runs from session.start, whose
 * `$` outlives every hook, and spawns it each time it is asked. Leaving its
 * loop (`/eagle-eye web stop`) or a reload of this module kills it, and its
 * `--parent` check ends it with the session's process (its stdin carries
 * the secret and then closes, so stdin cannot tell it). Every start makes a
 * new secret, never kept: a reload starts it again on the port `$.state`
 * kept, and a page open on it hears its old handle refused and says to open
 * it again from the deck.
 */
/** How long a start waits for the server's ready line. */
const WEB_START_MS = 10_000

/** Whether the home is Eagle Eye's own (no `EAGLE_EYE_HOME`): then it is made 0700 too; a folder the person named stays as they keep it. */
let isHomeOwn = false
/** The registry folder as the environment names it (`SE.registryDirOf`), for the start's sweep: read with the home. */
let homeRegistry = ''

/** Eagle Eye's home (`home`), read from the environment once: '' when no home is known, and then nothing is kept on disk. */
export async function homeOf($: EngineInterface): Promise<string> {
  if (home !== '') return home
  const read = async (get: () => Promise<string | undefined>) => {
    try {
      return await get()
    } catch {
      return undefined
    }
  }
  const env = {
    override: await read(() => $.env.get('EAGLE_EYE_SESSIONS')),
    eagleEyeHome: await read(() => $.env.get('EAGLE_EYE_HOME')),
    configDir: await read(() => $.env.get('CLAUDE_CONFIG_DIR')),
    home: (await read(() => $.env.get('USERPROFILE'))) ?? (await read(() => $.env.get('HOME'))),
  }
  home = SE.homeDirOf(env)
  homeRegistry = SE.registryDirOf(env)
  isHomeOwn = !(env.eagleEyeHome && env.eagleEyeHome.trim() !== '')
  return home
}

/** Asks web/home.js (node, no shell) to keep the home private, or to remove what the session no longer needs; whether it did. */
export async function runHome($: EngineInterface, request: W.HomeRequest): Promise<boolean> {
  if (request.home === '') return false
  try {
    const ran = await $.process.run(W.homeArgvOf(`${`${$.plugin.root}`.replace(/[\\/]+$/, '')}/web/home.js`, request), { timeoutMs: 10_000, ...(nodeCwd() ? { cwd: nodeCwd() } : {}) })
    return ran.exitCode === 0 && W.isHomeDone(ran.stdout)
  } catch {
    return false
  }
}

/**
 * At session.start: the folders of sessions that are gone swept (a crash
 * leaves its own), then this session's own made private, with its inbox,
 * before any deck writes there.
 */
export async function startHome($: EngineInterface): Promise<void> {
  if (home === '' || currentSessionId() === '') return
  await runHome($, { op: 'sweep', home, registry: homeRegistry, keep: currentSessionId() })
  // the registry folder named too, so it and this session's file in it are made private (0700/0600) however the race with the registry writer goes
  if (await runHome($, { op: 'prepare', home, id: currentSessionId(), files: [], isOwnHome: isHomeOwn, ...(homeRegistry !== '' ? { registry: homeRegistry } : {}) })) web.isPrivate = true
}

const web: {
  /** On for this session, from the first /eagle-eye web until /eagle-eye web stop, as `$.state` keeps it. */
  isOn: boolean
  /** The secret the running server seals its tickets with (`W.ticketOf`): new for every start, never kept; '' while none runs. */
  secret: string
  /** The `full` ticket the terminal deck shows as its link, made when the server is ready and again once the page it opened traded it; '' before. */
  shown: string
  /** The port the server listens on, taken again after a reload; 0 before it is known. */
  port: number
  /** The port a restart asked for again, until its ready line says which it got. */
  keptPort: number
  /** The folder it serves (`<home>/web/<sessionId>`), fixed for the server's life. */
  dir: string
  /** The folder was made private (0700, by web/home.js) in this module's life: nothing is written in it before. */
  isPrivate: boolean
  /** The files in it made 0600 before their first write, by their place under the home. */
  made: Set<string>
  /** The session ended: its folder is gone, and nothing is written again. */
  isEnded: boolean
  /** Bumped when the folder is emptied or removed, so a write that began earlier stops writing what it had. */
  gen: number
  /** The write under way, which an emptying or a removal waits for. */
  writing: Promise<void>
  status: WebPane['status']
  /** Why it is not running, as the pane and `/eagle-eye web` say it; '' while it runs. */
  note: string
  /** How the last try to open it in the Browser pane went. */
  opened: WebPane['opened']
  /** The session's own process (claude.exe), the server's `--parent`; '' when it could not be read. */
  pid: string
  /** The session.start the supervisor in charge belongs to. */
  epoch: number
  /** A start asked of the supervisor, and the wake of its wait. */
  isAsked: boolean
  wake?: () => void
  /** Ends the child's loop, and with it the child. */
  stop?: () => void
  /** The starts waiting for the ready line. */
  waiters: ((isUp: boolean) => void)[]
  /** The patches written, by their web id. */
  written: Set<string>
  /** Git's diffs written (gitdiffs/<id>.diff), by their id. */
  gitDiffsWritten: Set<string>
  /** The state last written, its time left out. */
  lastKey: string
  /** Each agent's file (`agents/<id>.json`) as last written, by its web id: one is written again only when it changed. */
  agentFiles: Map<string, string>
  isWriting: boolean
  isWriteQueued: boolean
} = {
  isOn: false,
  secret: '',
  shown: '',
  port: 0,
  keptPort: 0,
  dir: '',
  isPrivate: false,
  made: new Set(),
  isEnded: false,
  gen: 0,
  writing: Promise.resolve(),
  status: 'off',
  note: '',
  opened: '',
  pid: '',
  epoch: 0,
  isAsked: false,
  waiters: [],
  written: new Set(),
  gitDiffsWritten: new Set(),
  lastKey: '',
  agentFiles: new Map(),
  isWriting: false,
  isWriteQueued: false,
}

/** Whether the web deck is on for this session (`web.isOn`). */
export function isWebOn(): boolean {
  return web.isOn
}

/** The folder the web deck serves (`web.dir`); '' until one is fixed. */
export function webDir(): string {
  return web.dir
}

/** Eagle Eye's home as read (`home`); '' before it is, or when no home is known. */
export function homeDir(): string {
  return home
}

/** Whether the home is Eagle Eye's own (`isHomeOwn`). */
export function isOwnHome(): boolean {
  return isHomeOwn
}

/** Sets the mod's folder (`pluginRoot`), as session.start reads it. */
export function setPluginRoot(root: string): void {
  pluginRoot = root
}

/** What the Browser pane's page sent in your voice, waiting for your Send above the prompt (`held`). */
export function heldQueue(): Readonly<typeof held> {
  return held
}

/** The web deck as the debug dump tells it: its switch, server and folder, and what waits for your Send. */
export function webDebugOf() {
  return { isOn: web.isOn, status: web.status, port: web.port, dir: web.dir, opened: web.opened, note: web.note, patches: web.written.size, hasParent: web.pid !== '', held: held.items.map(item => ({ kind: item.kind, to: item.to, session: item.session, at: item.at })) }
}

/** The session's process id (`enginePidOf`), read once and kept for the server's `--parent`; '' when it could not be read. */
export async function sessionPidOf($: EngineInterface): Promise<string> {
  if (web.pid === '') web.pid = await enginePidOf($)
  return web.pid
}

/** A deck began to view this session (./registry): its folder written from now, as for /eagle-eye web. */
export function shareWeb($: EngineInterface): void {
  if (web.dir === '' && currentSessionId() !== '') web.dir = W.webDirOf(home, currentSessionId())
  web.lastKey = ''
  web.agentFiles.clear()
  void readGitDiffs($)
  scheduleWeb($)
}

/** Starts the web deck's supervisor for a session.start (`superviseWeb`): the previous supervisor stops, and if a reload finds the deck was on, it comes on again at once. */
export function startSupervisor($: EngineInterface): void {
  web.epoch += 1
  const wake = web.wake
  web.wake = undefined
  wake?.()
  web.stop?.()
  void superviseWeb($, web.epoch)
}

/** The web deck as the pane draws it: its link the `full` one the terminal shows (`web.shown`). */
export function webPaneOf(): WebPane {
  const isUp = web.status === 'running' && web.port > 0 && web.shown !== ''
  return { status: web.status, url: isUp ? W.webUrlOf(web.port, web.shown) : '', opened: web.opened, note: web.note }
}

/** A new one-time ticket of `grade` for the running server ('' while none runs): each link the deck hands out carries its own; with `until` (seconds since the epoch) it works until then only. */
function ticketFor(grade: W.WebGrade, until = 0): string {
  return web.secret === '' ? '' : W.ticketOf(web.secret, grade, W.newNonce(), until)
}

/** Keeps the web deck's switch, port and folder in `$.state`, so a reload starts it again where it was; its secret never. */
function saveWeb($: EngineInterface) {
  void $.state.set(WEB_STATE, { isOn: web.isOn, port: web.port, dir: web.dir }).catch(() => undefined)
}

/** Settles every start waiting for the server: up, or not. */
function settleWeb(isUp: boolean) {
  const waiters = web.waiters
  web.waiters = []
  for (const waiter of waiters) waiter(isUp)
}

/** Asks the supervisor for a server. */
function askWeb() {
  web.isAsked = true
  const wake = web.wake
  web.wake = undefined
  wake?.()
}

/** Whether the state folder is written: while the web deck is on, or another session's deck views this one (./registry); never once the session ended. */
export function isSharing(): boolean {
  return !web.isEnded && (web.isOn || SR.isShared())
}

/** The data changed: the web deck's state is written within 300 ms while it is on (or this session is viewed); changes meanwhile ride along. */
export function scheduleWeb($: EngineInterface) {
  if (!isSharing() || web.dir === '' || webTimers.web) return
  webTimers.web = $.clock.after(W.WEB_WRITE_MS, () => {
    webTimers.web = undefined
    void writeWeb($)
  })
}

/**
 * Makes the folder private (0700) and each of `files` (by its name in the
 * folder) 0600 before its first write, in one call of web/home.js: the
 * engine's write keeps an existing file's mode. Those made already are not
 * asked again. False when it could not: then nothing is written.
 */
async function makePrivate($: EngineInterface, files: readonly string[]): Promise<boolean> {
  const id = W.idOfWebDir(home, web.dir)
  if (id === '') return false
  const fresh = files.map(file => W.homeFileOf(id, file)).filter(file => file !== '' && !web.made.has(file))
  if (web.isPrivate && fresh.length === 0) return true
  if (!(await runHome($, { op: 'prepare', home, id, files: fresh, isOwnHome: isHomeOwn }))) return false
  web.isPrivate = true
  for (const file of fresh) web.made.add(file)
  return true
}

/**
 * Writes what the page reads: each edit's patch not written yet
 * (`patches/<id>.diff`, once), each cut message's whole text not written yet
 * (`messages/<id>.md`, once: it is then marked saved and its whole text let
 * go), each agent's file that changed (`agents/<id>.json`, v2's), git's
 * diff of each uncommitted file not written yet (`gitdiffs/<id>.diff`,
 * once), then `state.json` (v1, and the v2 view model the pane draws under `v2`),
 * unless it says what the last write said (its time aside). Each file new
 * to the folder is made 0600 first (`makePrivate`); nothing is written while
 * that fails. One write at a time: a change during one writes again after it.
 */
async function writeWeb($: EngineInterface): Promise<void> {
  if (!isSharing() || web.dir === '') return
  if (web.isWriting) {
    web.isWriteQueued = true
    return
  }
  web.isWriting = true
  let done = () => {}
  web.writing = new Promise<void>(resolve => {
    done = resolve
  })
  const gen = web.gen
  // each file written only while the folder is still this write's: an emptying or a removal since stops it (the catch below)
  const put = async (path: string, text: string) => {
    if (gen !== web.gen || !isSharing()) throw new Error('the folder was emptied or removed')
    await $.fs.write(path, text)
  }
  try {
    const patches = W.newPatchesOf(currentData(), web.written)
    const messages = W.newMessageFilesOf(currentData())
    const agents = W.agentFilesOf(currentData()).filter(file => web.agentFiles.get(file.id) !== file.text)
    const diffs = W.newGitDiffsOf(currentGitDiffs(), web.gitDiffsWritten)
    const names = [
      'state.json',
      'timeline.json',
      ...patches.map(patch => `patches/${patch.id}.diff`),
      ...messages.map(file => `messages/${file.id}.md`),
      ...agents.map(file => `agents/${file.id}.json`),
      ...diffs.map(diff => `gitdiffs/${diff.id}.diff`),
    ]
    if (!(await makePrivate($, names))) return
    for (const patch of patches) {
      await put(`${web.dir}/patches/${patch.id}.diff`, patch.text)
      web.written.add(patch.id)
    }
    for (const file of messages) {
      await put(`${web.dir}/messages/${file.id}.md`, file.text)
      file.message.isSaved = true
      delete file.message.full
    }
    for (const file of agents) {
      await put(`${web.dir}/agents/${file.id}.json`, file.text)
      web.agentFiles.set(file.id, file.text)
    }
    for (const diff of diffs) {
      await put(`${web.dir}/gitdiffs/${diff.id}.diff`, diff.text)
      web.gitDiffsWritten.add(diff.id)
    }
    const now = await $.clock.now()
    // Org's Timeline (timeline.json), before the state: written again when it says something new, its time aside
    const timeline = T.timelineTextOf(T.timelineOf(currentData(), v2Of(now)))
    const timelineKey = timeline.replace(/^\{"v":2,"now":\d+,/, '')
    if (timelineKey !== timelineWritten.key) {
      await put(`${web.dir}/timeline.json`, timeline)
      timelineWritten.key = timelineKey
    }
    // a question the page may answer is one whose race runs in this module: none after a reload
    const text = JSON.stringify({ ...W.webStateOf(currentData(), currentView(), currentGit(), currentUsage(), now, currentSessionId(), currentCwd(), new Set(currentAskers().keys())), v2: v2Of(now) })
    // both builds' times left out: a state that says nothing new is not written again
    const key = text.replace(/^\{"v":1,"now":\d+,/, '').replace(/,"v2":\{"v":2,"now":\d+,/, ',"v2":{')
    if (key !== web.lastKey) {
      await put(`${web.dir}/state.json`, text)
      web.lastKey = key
    }
  } catch {
    // a write that failed waits for the next change
  } finally {
    web.isWriting = false
    done()
    if (web.isWriteQueued) {
      web.isWriteQueued = false
      scheduleWeb($)
    }
  }
}

/** Org's Timeline as timeline.json was last written, its time left out: it is written again only when it changed. */
const timelineWritten = { key: '' }

/**
 * Notes how the main loop's session began. The hook on classic.SessionStart
 * hands it the event and returns `next(e)` as written, so what the session
 * starts with is Claude Code's alone.
 */
async function sessionBegan($: EngineInterface, ev: { agent_id?: string; source: string }): Promise<void> {
  if (ev.agent_id !== undefined) return
  startedAs = ev.source
  const wasFork = data.isFork === true
  noteStart(ev.source)
  // before session.start the deck has nothing to show yet: session.start applies it
  if (sessionId !== '' && (data.isFork === true) !== wasFork) touched($, await $.clock.now())
}

/** The session's own process id, read as the parent of a node it starts (no shell between); '' when node cannot say. */
async function enginePidOf($: EngineInterface): Promise<string> {
  try {
    const ran = await $.process.run(['node', `${`${$.plugin.root}`.replace(/[\\/]+$/, '')}/web/pid.js`], { timeoutMs: 10_000, ...(nodeCwd() ? { cwd: nodeCwd() } : {}) })
    const pid = ran.stdout.trim()
    return ran.exitCode === 0 && /^\d+$/.test(pid) ? pid : ''
  } catch {
    return ''
  }
}

/**
 * The session's web deck, for as long as this session.start is the latest:
 * picks up what `$.state` kept (a reload while it was on asks for the server
 * again, on its port), then runs the server each time it is asked.
 * A folder kept that is no longer this session's (one a /clear's old id
 * named) is let go, and removed when it is in the home: the server serves
 * this session's own.
 */
async function superviseWeb($: EngineInterface, epoch: number): Promise<void> {
  try {
    const { value } = await $.state.get(WEB_STATE)
    if (value && value.isOn === true && epoch === web.epoch) {
      web.isOn = true
      web.port = typeof value.port === 'number' && value.port > 0 ? value.port : 0
      const own = W.webDirOf(await homeOf($), currentSessionId())
      if (typeof value.dir === 'string' && value.dir !== '' && value.dir !== own) {
        const old = W.idOfWebDir(home, value.dir)
        if (old !== '' && old !== currentSessionId()) void runHome($, { op: 'remove', home, ids: [old] })
      }
      if (own !== '') web.dir = own
      web.status = 'starting'
      web.isAsked = true
    }
  } catch {
    // nothing kept: the web deck waits for /eagle-eye web
  }
  while (epoch === web.epoch) {
    if (!web.isAsked) {
      await new Promise<void>(resolve => {
        web.wake = resolve
      })
      continue
    }
    web.isAsked = false
    await runWeb($, epoch)
  }
}

/** How one run of the server went: whether it said it was ready, whether node was missing, and the last thing it said of why it ended. */
type WebRun = { isReady: boolean; isMissing: boolean; why: string }

/**
 * Runs the server until it ends: the state is written first (the page's
 * first load finds it), the session's pid read for `--parent`, then `node
 * web/server.js` starts with a new secret on its stdin. A restart on a
 * kept port that never comes up is tried once more on a port the OS picks.
 */
async function runWeb($: EngineInterface, epoch: number): Promise<void> {
  const root = `${$.plugin.root}`.replace(/[\\/]+$/, '')
  const script = `${root}/web/server.js`
  web.status = 'starting'
  web.note = ''
  if (web.dir === '') web.dir = W.webDirOf(await homeOf($), currentSessionId())
  // no home to keep its state in, or none that could be made private: the deck stays native
  if (web.dir === '' || !(await makePrivate($, []))) {
    web.isOn = false
    web.status = 'failed'
    web.note = web.dir === '' ? 'No home folder is known (HOME), so the dashboard has nowhere to keep its state.' : 'Its state folder could not be made private, so the dashboard does not start.'
    saveWeb($)
    settleWeb(false)
    redrawDeck($)
    return
  }
  saveWeb($)
  redrawDeck($)
  web.lastKey = ''
  web.agentFiles.clear()
  timelineWritten.key = ''
  void readGitDiffs($)
  await writeWeb($)
  if (web.pid === '') web.pid = await enginePidOf($)
  // a newer session.start took over: the web deck is its supervisor's now
  if (epoch !== web.epoch) return
  // stopped while it was being readied: nothing to start
  if (!web.isOn) {
    web.status = 'off'
    settleWeb(false)
    redrawDeck($)
    return
  }
  web.keptPort = web.port
  let ran = await spawnWeb($, W.serverArgvOf(script, web.dir, web.pid, web.port, SR.registryDir()))
  if (!ran.isReady && !ran.isMissing && web.port > 0 && web.isOn && epoch === web.epoch) {
    web.port = 0
    ran = await spawnWeb($, W.serverArgvOf(script, web.dir, web.pid, 0, SR.registryDir()))
  }
  web.keptPort = 0
  if (epoch !== web.epoch) return
  // what the server handed out ended with it
  web.secret = ''
  web.shown = ''
  if (!web.isOn) {
    web.status = 'off'
  } else if (ran.isMissing) {
    // no node: the deck stays native
    web.isOn = false
    web.status = 'failed'
    web.note = 'Node.js was not found on PATH, so the dashboard cannot start.'
    saveWeb($)
    $.ui.toast('Eagle Eye web needs Node.js on PATH; the deck stays in its pane.')
  } else {
    web.status = 'failed'
    web.note = ran.isReady
      ? `The dashboard's server stopped${ran.why ? ` (${ran.why})` : ''}; Open in browser starts it again.`
      : `The dashboard's server did not start${ran.why ? ` (${ran.why})` : ''}.`
  }
  settleWeb(false)
  redrawDeck($)
}

/** The last line a stream said, on one row. */
function lastLineOf(text: string): string {
  const lines = text
    .split('\n')
    .map(line => F.oneLine(line))
    .filter(line => line !== '')
  return F.trunc(lines[lines.length - 1] ?? '', 200)
}

/**
 * One run of the server, with a secret of its own (every start's is new,
 * so no ticket or handle of an earlier one works on it): its stdout read
 * line by line as it comes (a chunk may cut a line or hold several;
 * `W.splitLines` holds the rest), its stderr kept for why it ended, until
 * the child ends or `web.stop` ends the loop. Rejects never: a start that
 * fails (no node) is a run that says so.
 */
async function spawnWeb($: EngineInterface, argv: readonly string[]): Promise<WebRun> {
  let rest = ''
  let isReady = false
  let errors = ''
  let stop: (() => void) | undefined
  web.secret = W.newSecret()
  web.shown = ''
  try {
    // the secret on stdin, never argv or the environment, which other processes can read; started outside any workspace (Windows looks for a bare `node` in the working folder first)
    const child = $.process.spawn({ argv, input: `${web.secret}\n`, ...(nodeCwd() ? { cwd: nodeCwd() } : {}) })
    stop = () => {
      void child.return({ code: null, signal: null }).catch(() => undefined)
    }
    web.stop = stop
    for await (const chunk of child) {
      if (chunk.stream === 'stderr') {
        errors = `${errors}${chunk.text}`.slice(-2000)
        continue
      }
      const cut = W.splitLines(rest, chunk.text)
      rest = cut.rest
      for (const line of cut.lines) {
        try {
          if (onWebLine($, line)) isReady = true
        } catch {
          // a line the deck could not act on is let go: the loop reads on
        }
      }
    }
    return { isReady, isMissing: false, why: lastLineOf(errors) }
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error)
    return { isReady, isMissing: !isReady && /ENOENT|not found|failed to start/i.test(said), why: F.trunc(F.oneLine(said), 200) }
  } finally {
    // a newer run's handle stays
    if (web.stop === stop) web.stop = undefined
  }
}

/**
 * A whole line from the server: its ready line (the port it listens on); a
 * ticket traded (the terminal's link, once used, is replaced); or a command
 * from the page, checked against the model (`W.routeOf`) and acted on:
 * `chat` through `sendChat`, `review` through `sendReview`, `answer` to the
 * question it names (`answerCall`, which the pane uses too). A command in
 * your voice from a `pane` page, and every command from such a page for
 * another session's deck except `view` (`H.isHeld`), is held for your Send
 * above the prompt instead (`holdFromPage`). A command with an `id` gets an
 * ack, the page's word on what came of it; a refused one gets the reason.
 * Anything else is ignored. Returns whether it was the ready line.
 */
function onWebLine($: EngineInterface, line: string): boolean {
  const said = W.parseLine(line)
  if (said === null) return false
  if (said.kind === 'used') {
    if (said.nonce === W.nonceOf(web.shown)) {
      web.shown = ticketFor('full')
      redrawDeck($)
    }
    return false
  }
  if (said.kind === 'ready') {
    const kept = web.keptPort
    web.keptPort = 0
    web.port = said.port
    web.status = 'running'
    web.note = ''
    web.shown = ticketFor('full')
    saveWeb($)
    settleWeb(true)
    // the page open before a reload knows the old port only
    if (kept > 0 && kept !== said.port) $.ui.toast('Eagle Eye web started again on another port: /eagle-eye web opens it again, and /eagle-eye shows its new link.')
    redrawDeck($)
    return true
  }
  // in your voice from the Browser pane's page, or any press of it for another session's deck: it waits for your Send above the prompt
  if (said.grade !== 'full' && H.isHeld(said.cmd, currentSessionId())) {
    void holdFromPage($, said.cmd)
    return false
  }
  runFromPage($, said.cmd)
  return false
}

/** A page's command run: one for another session's deck (the page views it) into its inbox, where its own deck takes it; this session's through `runCommand`. */
function runFromPage($: EngineInterface, cmd: Record<string, unknown>): void {
  const other = SE.sessionCmdOf(cmd, currentSessionId())
  if (other) void SR.fromPage(other.session, other.cmd)
  else runCommand($, cmd)
}

/**
 * What the Browser pane's page sent in your voice, waiting for your Send in
 * the band above the prompt (./hold), oldest first; the rows opened to their
 * whole text; a count that moves with every change, for the band's drawing;
 * and the next key.
 */
const held: { items: H.Held[]; open: Set<string>; version: number; seq: number } = { items: [], open: new Set(), version: 0, seq: 0 }

/** Whom a command for this session goes to, in words: its agent's name ("Orchestrator", "builder"), the Orchestrator for Review, an answer's asker. */
function heldToOf(cmd: Record<string, unknown>): string {
  if (cmd.cmd === 'review') return ''
  const route = W.routeOf(cmd, currentData())
  const id = route?.kind === 'chat' ? route.agentId : route?.kind === 'answer' ? (M.pendingOf(currentData()).find(one => one.id === route.callId)?.agentId ?? M.MAIN) : M.MAIN
  const agent = M.agentOf(currentData(), id)
  return agent ? M.labelOf(agent) : M.ORCHESTRATOR
}

/**
 * A command in your voice from the Browser pane's page, or any press of it
 * for another session's deck (a Stop there too): checked as it would be
 * once sent (one refused now is refused at once, never held), then held in
 * the band for your Send, its ack saying so; refused while `H.MOST_HELD`
 * wait already. One for another session's deck goes into its inbox once
 * you press Send.
 */
async function holdFromPage($: EngineInterface, cmd: Record<string, unknown>): Promise<void> {
  const ackId = W.cmdIdOf(cmd)
  const other = SE.sessionCmdOf(cmd, currentSessionId())
  // one that names another session it cannot go to is never run as this one's
  const isElsewhere = !other && typeof cmd.session === 'string' && cmd.session !== '' && cmd.session !== currentSessionId()
  const route = other || isElsewhere ? null : W.routeOf(cmd, currentData())
  // an answer to a question that no longer waits here is refused at once, as it would be once sent
  const gone = route?.kind === 'answer' ? answerGoneOf(route.callId) : ''
  const refusal = isElsewhere ? SE.steeringRefusalOf(cmd) : other ? (SE.steeringCmdOf(other.cmd) ? '' : SE.steeringRefusalOf(other.cmd)) : route === null ? W.refusalOf(cmd, currentData()) : gone
  if (refusal !== '' || held.items.length >= H.MOST_HELD) {
    void ackPage($, ackId, 'failed', refusal || H.FULL_TEXT)
    return
  }
  const now = await $.clock.now()
  const agentOfOther = other && (other.cmd.cmd === 'chat' || other.cmd.cmd === 'stopAgent') && other.cmd.agentId !== M.MAIN ? ` · ${F.trunc(F.oneLine(String(other.cmd.agentId)), 40)}` : ''
  const to = other ? `${SR.sessionNameOf(other.session)}${agentOfOther}` : heldToOf(cmd)
  held.seq += 1
  held.items.push(H.heldOf(other ? other.cmd : cmd, `h${held.seq}`, now, other?.session ?? '', to))
  held.version += 1
  await ackPage($, ackId, 'held', H.HELD_TEXT)
  $.ui.toast('From the web page: it waits above your prompt for your Send.')
  // it goes unsent once its ten minutes are up (the tick looks too)
  $.clock.after(H.HOLD_MS, () => void pruneHeld($))
  redrawDeck($)
}

/** Takes held command `key` out of the queue; undefined when it went already. */
function takeHeld(key: string): H.Held | undefined {
  const at = held.items.findIndex(item => item.key === key)
  if (at < 0) return undefined
  const [item] = held.items.splice(at, 1)
  held.open.delete(key)
  held.version += 1
  return item
}

/**
 * Your Send on a held row: the command runs exactly as a page in your own
 * browser would have run it at once (its checks again, its ack under the
 * page's id); one for another session's deck goes into its inbox, sealed,
 * as ever. A long or many-line one goes only while its row is open (More).
 */
export function sendHeldMessage($: EngineInterface, key: string): void {
  // a long or many-line one goes only once it is open, its whole text on screen (the band draws its Send only then)
  const shown = H.heldRowsOf(held.items.filter(one => one.key === key), held.open)[0]
  if (!shown || (shown.isLong && !shown.isOpen)) return
  const item = takeHeld(key)
  if (!item) return
  if (item.session === '') {
    runCommand($, item.cmd)
  } else {
    void SR.fromPage(item.session, item.cmd).then(why => {
      // its own deck acks it in its own state; here the word it went
      if (why === '') void ackPage($, item.ackId, 'queued', 'Sent to its deck')
    })
  }
  redrawDeck($)
}

/** Your Discard on a held row: nothing is sent, and the page's ack says so. */
export function discardHeldMessage($: EngineInterface, key: string): void {
  const item = takeHeld(key)
  if (!item) return
  void ackPage($, item.ackId, 'failed', H.unsentText('discarded'))
  redrawDeck($)
}

/** More and Less on a held row too long for one line: its whole text shown, or its start again. */
export function toggleHeldMessage($: EngineInterface, key: string): void {
  if (!held.items.some(item => item.key === key)) return
  if (!held.open.delete(key)) held.open.add(key)
  held.version += 1
  redrawDeck($)
}

/** The held commands whose ten minutes are up go unsent, and an answer held for a question that no longer waits goes with why; the page's acks say so. */
export async function pruneHeld($: EngineInterface): Promise<void> {
  if (held.items.length === 0) return
  const now = await $.clock.now()
  const expired = new Set(H.expiredOf(held.items, now))
  let isChanged = false
  for (const item of [...held.items]) {
    const route = item.session === '' && item.kind === 'answer' && !expired.has(item) ? W.routeOf(item.cmd, currentData()) : null
    const gone = route?.kind === 'answer' ? answerGoneOf(route.callId) : ''
    if (!expired.has(item) && gone === '') continue
    takeHeld(item.key)
    isChanged = true
    void ackPage($, item.ackId, 'failed', gone || H.unsentText('expired'))
  }
  if (isChanged) redrawDeck($)
}

/** Starts the web deck when it is not running, and waits (10 s at most) for its server to be up. */
async function ensureWeb($: EngineInterface): Promise<boolean> {
  if (web.status === 'running' && web.port > 0) return true
  const isStarting = web.isOn && web.status === 'starting'
  web.isOn = true
  if (!isStarting) {
    web.status = 'starting'
    web.note = ''
    web.opened = ''
    redrawDeck($)
    askWeb()
  }
  return new Promise<boolean>(resolve => {
    let isDone = false
    const finish = (isUp: boolean) => {
      if (isDone) return
      isDone = true
      timer.cancel()
      resolve(isUp)
    }
    const timer = $.clock.after(WEB_START_MS, () => finish(false))
    web.waiters.push(finish)
  })
}

/**
 * Opens `url` in the Desktop's Browser pane: its server's preview_start over
 * MCP (by either spelling of its name), else as a tool call; false when none
 * takes it. Neither records the call in the conversation: the model never
 * sees the URL (checked with a headless session: the call's arguments and
 * result reach the mod alone).
 */
async function openInBrowser($: EngineInterface, url: string): Promise<boolean> {
  try {
    const opened = await $.mcp.call('Claude_Browser', 'preview_start', { url })
    if (opened.isError !== true) return true
  } catch {
    // not by that name
  }
  try {
    const opened = await $.mcp.call('Claude Browser', 'preview_start', { url })
    if (opened.isError !== true) return true
  } catch {
    // no Browser pane over MCP (a terminal, a headless run)
  }
  try {
    // the request is built first: the plugin directory reads a `$` call only with nothing cast inside it
    const request = { tool: 'mcp__Claude_Browser__preview_start', url } as unknown as ToolCallArgs
    const own = { tool: 'mcp__Claude_Browser__preview_start', input: { url } }
    ownCalls.push(own)
    try {
      const called = await $.tool.call(request)
      return called.deny === undefined && called.isError !== true
    } finally {
      ownCalls.splice(ownCalls.indexOf(own), 1)
    }
  } catch {
    return false
  }
}

/** Tries the Browser pane with the page; the pane shows the link when that fails. */
async function showWeb($: EngineInterface, url: string): Promise<void> {
  const isOpened = await openInBrowser($, url)
  web.opened = isOpened ? 'opened' : 'failed'
  redrawDeck($)
}

/**
 * What `/eagle-eye web` and `/eagle-eye web pane` answer once the page is up:
 * no link, since a command's text reaches the model as its output; the
 * links are the deck's.
 */
const WEB_OPENED_TEXT = 'Eagle Eye web is running on this machine and opened in your own browser. Open in browser, at the top of the deck (/eagle-eye), opens it again.'
const WEB_PANE_TEXT = "Eagle Eye web is open in Claude's Browser pane. What you send from there waits above your prompt until you press Send."
const WEB_NO_PANE_TEXT = 'Eagle Eye web is running on this machine. A terminal has no Browser pane: press o in the deck (/eagle-eye), or Open in browser at its top, to open it in your own browser. The deck also shows a link to copy under its header.'

/** What the model is told beside each: that the link is the person's. */
const WEB_CONTEXT = ['/eagle-eye web opened the Eagle Eye dashboard for the user. Its address is for the user alone; if they ask to see it again, tell them to run /eagle-eye web, which opens it itself.']

/** What a start of the web deck that ended the session refused says. */
const WEB_ENDED_TEXT = 'This session has ended: Eagle Eye web starts again in a new one.'

/** Why the server is not up after `ensureWeb` gave up on it, in a sentence: it never answered, or what stopped it. */
function webDownWhy(): string {
  return web.status === 'starting' ? "The dashboard's server did not answer within 10 s." : web.note || "The dashboard's server did not start."
}

/** Whether the session draws only in a terminal, where there is no Browser pane; false while that is not known. */
async function isTerminalOnly($: EngineInterface): Promise<boolean> {
  try {
    const surfaces = await $.session.surfaces()
    return surfaces.length > 0 && surfaces.every(surface => surface === 'terminal')
  } catch {
    return false
  }
}

/**
 * `/eagle-eye web`: the page in your own browser, as Open in browser opens it
 * (`openOwnBrowser`: started first when it is not running, a `full` link
 * made for it on web/open.js's stdin). `/eagle-eye web pane` (`where`
 * `pane`), as Settings' "Open in Claude's browser" on the desktop: started if need be,
 * then the Browser pane (left to run) asked to open it with a new `pane`
 * ticket, whose words in your voice wait for your Send (./hold); in a
 * session that draws only in a terminal, which has no Browser pane, no pane
 * is asked and the deck shows its link to copy. A link acts as the person,
 * so it goes to the person alone (the system's opener, the Browser pane,
 * the terminal's link text, `webPaneOf`), never to the model: the answer's
 * text and context, which the model reads, say where it is, never a link
 * nor why an opener failed. Without node the deck stays native.
 */
export async function openWeb($: EngineInterface, where: 'own' | 'pane'): Promise<CommandRunResult> {
  if (web.isEnded) return { text: WEB_ENDED_TEXT }
  if (where === 'own') {
    const opened = await ownBrowserOpen($)
    if (opened.kind === 'down') return { text: `${opened.why} The deck stays in its pane: /eagle-eye.` }
    if (opened.kind === 'busy') return { text: 'Eagle Eye web is starting, and opens in your own browser once it is up.' }
    if (opened.kind === 'unopened') {
      const copy = (await isTerminalOnly($)) ? ' The deck also shows a link to copy under its header.' : ''
      return { text: `Eagle Eye web is running on this machine, but your browser did not open. Open in browser, at the top of the deck (/eagle-eye), tries again.${copy}`, context: WEB_CONTEXT }
    }
    return { text: WEB_OPENED_TEXT, context: WEB_CONTEXT }
  }
  const isUp = await ensureWeb($)
  if (!isUp) {
    const why = webDownWhy()
    $.ui.toast(`Eagle Eye web: ${why}`)
    return { text: `${why} The deck stays in its pane: /eagle-eye.` }
  }
  if (await isTerminalOnly($)) {
    web.opened = 'failed'
    redrawDeck($)
    return { text: WEB_NO_PANE_TEXT, context: WEB_CONTEXT }
  }
  void showWeb($, W.webUrlOf(web.port, ticketFor('pane')))
  return { text: WEB_PANE_TEXT, context: WEB_CONTEXT }
}

/** A press of Open in browser is waiting for the server it started: another press meanwhile starts and opens nothing. */
let isBrowserWaiting = false

/**
 * How a try to open the deck in your own browser went: opened; nothing
 * done, since a try before it waits for the server it started (`busy`); the
 * server would not come up (`down`), or the opener did not open it
 * (`unopened`), with what the toast says.
 */
type OwnOpen = { kind: 'opened' } | { kind: 'busy' } | { kind: 'down'; why: string } | { kind: 'unopened'; why: string }

/**
 * "Open in browser" (at the right of the deck's header, `o`, and in
 * Settings): starts the web deck when it is not running (`ensureWeb`, and
 * its toast when it could not; a second press while it starts does
 * nothing), but never opens the Browser pane; then a `full` link made for
 * this press, opened in your own browser (`ownBrowserOpen`); a toast when it
 * could not (the terminal shows a link to copy).
 */
export async function openOwnBrowser($: EngineInterface): Promise<void> {
  const opened = await ownBrowserOpen($)
  if (opened.kind === 'unopened') $.ui.toast(`Could not open your browser${opened.why ? ` (${F.trunc(F.oneLine(opened.why), 120)})` : ''}. In a terminal, the deck shows the link to copy under its header.`)
}

/**
 * The page in your own browser: the web deck started first when it is not
 * running (its toast when it could not), then a `full` link made for this
 * try, opened by the system's opener (web/open.js: osascript's `open
 * location` read on its stdin on macOS, so no process's arguments ever hold
 * it; `start`, `xdg-open` elsewhere, whose arguments do while they run), the
 * link on its stdin. Its ticket works for `W.OPENER_TICKET_MS` only, unless
 * the page traded it by then.
 */
async function ownBrowserOpen($: EngineInterface): Promise<OwnOpen> {
  if (web.status !== 'running' || web.port <= 0) {
    if (isBrowserWaiting) return { kind: 'busy' }
    if (web.isEnded) {
      $.ui.toast(WEB_ENDED_TEXT)
      return { kind: 'down', why: WEB_ENDED_TEXT }
    }
    isBrowserWaiting = true
    let isUp = false
    try {
      isUp = await ensureWeb($)
    } finally {
      isBrowserWaiting = false
    }
    if (!isUp) {
      const why = webDownWhy()
      $.ui.toast(`Eagle Eye web: ${why}`)
      return { kind: 'down', why }
    }
  }
  const until = Math.ceil(((await $.clock.now()) + W.OPENER_TICKET_MS) / 1000)
  const ticket = web.status === 'running' && web.port > 0 ? ticketFor('full', until) : ''
  if (ticket === '') {
    $.ui.toast('Eagle Eye web is not running: Open in browser starts it.')
    return { kind: 'down', why: 'Eagle Eye web is not running.' }
  }
  let why = ''
  try {
    const ran = await $.process.run(['node', `${`${$.plugin.root}`.replace(/[\\/]+$/, '')}/web/open.js`], { stdin: `${W.webUrlOf(web.port, ticket)}\n`, timeoutMs: 10_000, ...(nodeCwd() ? { cwd: nodeCwd() } : {}) })
    if (ran.exitCode === 0 && W.isHomeDone(ran.stdout)) return { kind: 'opened' }
    why = W.openWhyOf(ran.stdout)
  } catch (error) {
    why = error instanceof Error ? error.message : String(error)
  }
  return { kind: 'unopened', why }
}

/** `/eagle-eye web stop`: the server ends, the state is no longer written, and the next start makes a new link. Answers whether it was on. */
export function stopWeb($: EngineInterface): boolean {
  const wasOn = web.isOn || web.status === 'running' || web.status === 'starting'
  web.isOn = false
  web.isAsked = false
  web.secret = ''
  web.shown = ''
  web.port = 0
  web.keptPort = 0
  web.status = 'off'
  web.note = ''
  web.opened = ''
  webTimers.web?.cancel()
  webTimers.web = undefined
  saveWeb($)
  web.stop?.()
  settleWeb(false)
  redrawDeck($)
  return wasOn
}

/**
 * A /clear or a resume: what the folder held of the conversation before (its
 * state, patches, messages, agent files, git's diffs, Timeline) goes, its
 * inbox kept, and what the deck wrote is forgotten, so the next write makes
 * each file afresh (0600 again).
 */
export async function clearWeb($: EngineInterface): Promise<void> {
  const id = W.idOfWebDir(home, web.dir)
  web.gen += 1
  await web.writing
  web.written.clear()
  web.gitDiffsWritten.clear()
  web.agentFiles.clear()
  web.made.clear()
  web.lastKey = ''
  timelineWritten.key = ''
  if (id !== '') await runHome($, { op: 'clear', home, id })
}

/**
 * The session ended: the server stopped, nothing written again, and its
 * state folder removed whole (the one the server served, and the one its
 * id names, if a reload after a /clear moved it). A folder a crash left is
 * swept at the next start instead.
 */
export async function endWeb($: EngineInterface): Promise<void> {
  web.isEnded = true
  web.isAsked = false
  web.gen += 1
  webTimers.web?.cancel()
  webTimers.web = undefined
  web.stop?.()
  await web.writing
  const ids = [...new Set([W.idOfWebDir(home, web.dir), W.idOfWebDir(home, W.webDirOf(home, currentSessionId()))])].filter(id => id !== '')
  if (ids.length > 0) await runHome($, { op: 'remove', home, ids })
}

// ----------------------------------------------------------------------
// Formerly ./commands.ts
/**
 * `/eagle-eye` and the words after it: `close`, `band`, `avatars`, `clear`,
 * `probe`, `web`, the sessions, the sample, and a tab of this session's deck
 * (the Dashboard alone). register.tsx registers the command and hands each
 * run here (`runEagleEye`); what a run does to the pane, the view and the
 * sample it asks of that module, imported from there.
 */

/** The style `/eagle-eye avatars <words>` names: by its id or its name, any case, spaces or not, or the start of one alone ("crit"); undefined for none. */
function avatarStyleNamed(words: string): AV.AvatarStyle | undefined {
  const said = words.toLowerCase().replace(/[\s_-]+/g, '')
  if (said === '') return undefined
  const exact = AV.STYLES.find(one => one.id === said || one.name.toLowerCase().replace(/\s+/g, '') === said)
  if (exact) return exact.id
  const starts = AV.STYLES.filter(one => one.id.startsWith(said) || one.name.toLowerCase().replace(/\s+/g, '').startsWith(said))
  return starts.length === 1 ? starts[0]?.id : undefined
}

/** `/eagle-eye avatars`: the styles, the one drawn marked; `/eagle-eye avatars <style>` draws that one from now on, in every session. */
function avatarsCommand($: EngineInterface, words: string): CommandRunResult {
  const list = AV.STYLES.map(one => `${one.id === currentView().avatarStyle ? '▸' : ' '} ${one.id.padEnd(8)} ${one.name}`).join('\n')
  if (words === '') return { text: `Avatar styles (now ${AV.styleName(currentView().avatarStyle)}):\n${list}\n/eagle-eye avatars <style> draws another, here and on the web page, in every session. The pane's Settings (6) picks one too.` }
  const style = avatarStyleNamed(words)
  if (style === undefined) return { text: `No avatar style called "${F.trunc(F.oneLine(words), 40)}". One of: ${AV.STYLE_IDS.join(', ')}.` }
  applyAvatarStyle($, style)
  return { text: `Avatars: ${AV.styleName(style)}, in every session: the pane, the web page and /eagle-eye demo draw them (the terminal as one character each); /eagle-eye avatars lists the others.` }
}

/**
 * A run of `/eagle-eye`: what its words ask for done, and what the command
 * answers. The deck opens on the tab named (the Dashboard with no words),
 * leaving the sample; a pane with no room yet says so.
 */
export async function runEagleEye($: EngineInterface, ev: Pick<CommandRunInput, 'args'>): Promise<CommandRunResult> {
  const arg = ev.args.trim().toLowerCase()
  if (arg === 'close' || arg === 'off' || arg === 'hide') {
    await $.ui.close({ id: PANE })
    paneClosed()
    chatFollow.isShown = false
    return { text: 'Eagle Eye closed.' }
  }
  if (arg === 'band') {
    currentView().isBandHidden = !currentView().isBandHidden
    savePrefs($)
    deckChanged($)
    return { text: currentView().isBandHidden ? 'The agents band above the prompt is hidden. /eagle-eye band shows it again.' : 'The agents band shows above the prompt while subagents run.' }
  }
  if (arg === 'avatars' || arg.startsWith('avatars ')) return avatarsCommand($, arg.slice('avatars'.length).trim())
  // the deck's own tidying: finished agents hidden from the Dashboard, Chat and Org (nothing in Claude Code), or shown again
  if (arg === 'clear') return { text: await clearFinishedAgents($) }
  if (arg === 'clear show' || arg === 'clear undo') return { text: await showClearedAgents($) }
  if (arg === 'probe') return toggleProbe($)
  // the live dashboard: started if need be, opened in your own browser; or, asked for, in Claude's Browser pane
  const words = arg.split(/\s+/)
  if (words[0] === 'web') {
    if (words[1] === 'stop' || words[1] === 'off' || words[1] === 'close') return { text: stopWeb($) ? 'Eagle Eye web stopped.' : 'Eagle Eye web was not running.' }
    return openWeb($, words[1] === 'pane' ? 'pane' : 'own')
  }
  // an Org chart Client that failed is tried again whenever /eagle-eye opens
  orgDown.clear()
  // every session on this machine, dropped over the tabs
  if (arg === 'sessions' || arg === 'all') {
    if (!SR.isListOpen()) toggleSessions($)
    const isShown = await openPane($)
    deckChanged($)
    return isShown ? {} : { text: 'Eagle Eye is open and waiting for room: widen the window, or press ctrl+x then tab.' }
  }
  // the sample: the deck drawn from the v2 sample
  if (arg === 'demo' || arg === 'sample') {
    const why = await loadDemo($, true)
    const isShown = await openPane($)
    deckChanged($)
    if (why) return { text: why }
    return isShown ? {} : { text: 'Eagle Eye is open and waiting for room: widen the window, or press ctrl+x then tab.' }
  }
  // anything else is this session's deck: /eagle-eye alone the Dashboard; dashboard (or now), chat, org, changes or settings (inspect and help too)
  leaveDemo()
  currentView().page = ''
  // /eagle-eye chat takes the pane to Chat's newest message, though Chat showed already
  chatFollow.isShown = false
  const tab = arg === '' ? 'now' : M.v2TabFor(words[0] ?? '')
  if (tab) currentView().v2 = M.view2With(currentView().v2, { tab })
  const isPlaced = await openPane($)
  deckChanged($)
  return isPlaced ? {} : { text: 'Eagle Eye is open and waiting for room: widen the window, or press ctrl+x then tab.' }
}
