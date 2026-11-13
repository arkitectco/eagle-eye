/**
 * `/eagle-eye` and the words after it: `close`, `band`, `avatars`, `clear`,
 * `probe`, `web`, the sessions, the sample, and a tab of this session's deck
 * (the Dashboard alone). register.tsx registers the command and hands each
 * run here (`runEagleEye`); what a run does to the pane, the view and the
 * sample it asks of that module, imported from there.
 */
import type { CommandRunInput, CommandRunResult } from 'claude-code'
import type { EngineCalls } from './register'

import * as AV from '../web/avatars.mjs'
import * as F from './format'
import * as M from './model'
import {
  chatFollow,
  currentView,
  leaveDemo,
  orgDown,
  PANE,
  paneClosed,
} from './register'
import * as SR from './registry'
import { openWeb, stopWeb } from './webServer'

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
function avatarsCommand(host: EngineCalls, words: string): CommandRunResult {
  const list = AV.STYLES.map(one => `${one.id === currentView().avatarStyle ? '▸' : ' '} ${one.id.padEnd(8)} ${one.name}`).join('\n')
  if (words === '') return { text: `Avatar styles (now ${AV.styleName(currentView().avatarStyle)}):\n${list}\n/eagle-eye avatars <style> draws another, here and on the web page, in every session. The pane's Settings (6) picks one too.` }
  const style = avatarStyleNamed(words)
  if (style === undefined) return { text: `No avatar style called "${F.trunc(F.oneLine(words), 40)}". One of: ${AV.STYLE_IDS.join(', ')}.` }
  host.setAvatarStyle(style)
  return { text: `Avatars: ${AV.styleName(style)}, in every session: the pane, the web page and /eagle-eye demo draw them (the terminal as one character each); /eagle-eye avatars lists the others.` }
}

/**
 * A run of `/eagle-eye`: what its words ask for done, and what the command
 * answers. The deck opens on the tab named (the Dashboard with no words),
 * leaving the sample; a pane with no room yet says so.
 */
export async function runEagleEye(host: EngineCalls, e: Pick<CommandRunInput, 'args'>): Promise<CommandRunResult> {
  const arg = e.args.trim().toLowerCase()
  if (arg === 'close' || arg === 'off' || arg === 'hide') {
    await host.closePane({ id: PANE })
    paneClosed()
    chatFollow.isShown = false
    return { text: 'Eagle Eye closed.' }
  }
  if (arg === 'band') {
    currentView().isBandHidden = !currentView().isBandHidden
    host.savePrefs()
    host.changed()
    return { text: currentView().isBandHidden ? 'The agents band above the prompt is hidden. /eagle-eye band shows it again.' : 'The agents band shows above the prompt while subagents run.' }
  }
  if (arg === 'avatars' || arg.startsWith('avatars ')) return avatarsCommand(host, arg.slice('avatars'.length).trim())
  // the deck's own tidying: finished agents hidden from the Dashboard, Chat and Org (nothing in Claude Code), or shown again
  if (arg === 'clear') return { text: await host.clearFinished() }
  if (arg === 'clear show' || arg === 'clear undo') return { text: await host.showCleared() }
  if (arg === 'probe') return host.toggleProbe()
  // the live dashboard: started if need be, opened in your own browser; or, asked for, in Claude's Browser pane
  const words = arg.split(/\s+/)
  if (words[0] === 'web') {
    if (words[1] === 'stop' || words[1] === 'off' || words[1] === 'close') return { text: stopWeb(host) ? 'Eagle Eye web stopped.' : 'Eagle Eye web was not running.' }
    return openWeb(host, words[1] === 'pane' ? 'pane' : 'own')
  }
  // an Org chart Client that failed is tried again whenever /eagle-eye opens
  orgDown.clear()
  // every session on this machine, dropped over the tabs
  if (arg === 'sessions' || arg === 'all') {
    if (!SR.isListOpen()) host.toggleSessions()
    const isShown = await host.openPane()
    host.changed()
    return isShown ? {} : { text: 'Eagle Eye is open and waiting for room: widen the window, or press ctrl+x then tab.' }
  }
  // the sample: the deck drawn from the v2 sample
  if (arg === 'demo' || arg === 'sample') {
    const why = await host.loadDemo(true)
    const isShown = await host.openPane()
    host.changed()
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
  const isPlaced = await host.openPane()
  host.changed()
  return isPlaced ? {} : { text: 'Eagle Eye is open and waiting for room: widen the window, or press ctrl+x then tab.' }
}
