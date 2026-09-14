#!/usr/bin/env node
/**
 * Cross-check data/shortcuts.json against BAR's own keybinding files.
 *
 *   npm run check:bindings          # what the game binds that the trainer does not list
 *   npm run check:bindings -- --all # also list what we cover, and what we list unbound
 *
 * shortcuts.json is hand-maintained, so it drifts as BAR adds bindings. This reads what
 * the game actually loads and reports the gaps, rather than anyone transcribing a
 * screenshot of the in-game chart.
 *
 * The source is `common/configs/keybind_defaults.json`: one file holding every shipped
 * profile as {keyset, action} pairs. It replaced the `luaui/configs/hotkeys/*.txt` presets
 * when the in-game keybind editor landed, and those are deleted upstream — so there is
 * nothing to fall back to and fetch-bar-data.js downloads this instead.
 *
 * It compares key combos, not meanings: a match here says the trainer has *something* on
 * that combo, not that the description is right. Read the pairs it prints.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readBarJson, barSourceLabel } from './bar-source.js'

const dir  = dirname(fileURLToPath(import.meta.url))
const all  = process.argv.includes('--all')

/** A missing data file is a "run this" message, not a stack trace. */
function fail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

// Which shipped profile the trainer is about. It teaches the grid layout and says so on
// its own front page, and the 60% variant is carried per entry by `sixty` blocks.
const PROFILE = 'Grid'

// Engine-level bindings that are not grid hotkeys and have no place in the trainer:
// chat line editing, camera nudging, the quit menu, widget-internal modifiers.
const IGNORED_ACTIONS = [
  /^edit_/, /^move(forward|back|left|right|up|down|fast|reset|rotate|tilt)$/,
  // selectbox_* are modifiers *held during a box drag*, so they have no key combo to
  // compare — the trainer carries them as mouse gestures in the Select group instead.
  /^selectbox_/, /^selectloop/, /^quit/, /^reloadforce/, /^pause$/, /^commandinsert/,
  /^pastetext$/, /^luaui /, /^teamstatus_close$/, /^customgameinfo_close$/,
  /^buildmenu_pregame_deselect$/, /^fullscreen$/, /^toggle_allied_upgrade$/,
  /^chat$/, /^chatswitch/,          // chat is covered as its own group already
]
const IGNORED_KEYS = [/numpad/i, /^(up|down|left|right|home|end|pageup|pagedown|delete)$/i]

/** BAR writes positions as `sc_x`; strip the prefix and upper-case plain letters. */
function canonKey(raw) {
  let key = raw.replace(/^sc_/, '')
  if (key === 'comma') key = ','
  if (/^[a-z]$/.test(key)) return key.toUpperCase()
  if (/^f\d+$/i.test(key)) return key.toUpperCase()
  const named = { esc: 'Escape', escape: 'Escape', tab: 'Tab', enter: 'Enter',
                  space: 'Space', backspace: 'Backspace' }
  return named[key.toLowerCase()] ?? key
}

/**
 * "Ctrl+Shift+sc_a" → { mods: ['Ctrl','Shift'], keys: ['A'] }; commas are key sequences.
 * `any` reports itself in `anyMods`: `Any+space` fires with *or without* modifiers, so
 * Shift+Space really is bound even though the file never spells that combo out.
 */
function parseCombo(spec) {
  const steps = spec.split(',')
  const mods = []
  const keys = []
  let anyMods = false
  for (const step of steps) {
    const parts = step.split('+')
    // A trailing empty part means the key itself was '+', e.g. "numpad+"
    const key = parts.pop() || '+'
    for (const part of parts) {
      const name = part.toLowerCase()
      if (name === 'any') { anyMods = true; continue }
      if (name === 'meta') { mods.push('Space'); continue }   // BAR's Meta is the Space chord
      const proper = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt' }[name]
      if (proper && !mods.includes(proper)) mods.push(proper)
    }
    keys.push(canonKey(key))
  }
  return { mods, keys, anyMods }
}

const ORDER = { Ctrl: 0, Shift: 1, Alt: 2, Space: 3 }
const comboId = ({ mods, keys }) =>
  [...mods].sort((a, b) => ORDER[a] - ORDER[b]).concat(keys.join(',')).join('+')

// ── What the game binds ──────────────────────────────────────────────────────
/** Every {keyset, action} pair of the grid profile. */
function readBinds() {
  const defaults = readBarJson('common/configs/keybind_defaults.json')
  if (!defaults)
    fail(`No common/configs/keybind_defaults.json in the ${barSourceLabel()}.\n`
      + 'Run `node fetch-bar-data.js`, or point BAR_REPO at a current game checkout.')
  const profile = defaults.profiles.find(p => p.name === PROFILE)
  if (!profile)
    fail(`keybind_defaults.json has no "${PROFILE}" profile — only: `
      + defaults.profiles.map(p => p.name).join(', '))
  return profile.binds
}

const bindPairs = readBinds()
const bound = new Map()   // comboId → Set of actions
const anyModKeys = new Set()  // keys bound with `Any+`, i.e. on any modifier combination
for (const { keyset, action } of bindPairs) {
  if (IGNORED_KEYS.some(re => re.test(keyset))) continue
  const combo = parseCombo(keyset)
  // BAR spells toggles as tap counts on one key — "sc_b,sc_b,sc_b" is still just B
  if (combo.keys.length > 1 && new Set(combo.keys).size === 1) combo.keys = [combo.keys[0]]
  // Before the action filter, not after: an `Any+` key is bound on every modifier
  // combination whatever the action is, and `chat` is both ignored and the reason
  // Alt+Enter works. Leaving this downstream reported those as unbound.
  if (combo.anyMods) for (const key of combo.keys) anyModKeys.add(key)
  if (IGNORED_ACTIONS.some(re => re.test(action))) continue
  const id = comboId(combo)
  if (!bound.has(id)) bound.set(id, new Set())
  bound.get(id).add(action.replace(/\s+/g, ' ').slice(0, 46))
}

// Holding Shift on a command only queues it — the same hotkey, not a second one to learn.
// Drop those once the bare combo is known to exist.
for (const id of [...bound.keys()]) {
  const bare = id.split('+').filter(part => part !== 'Shift').join('+')
  if (bare !== id && bound.has(bare)) bound.delete(id)
}

// ── What the trainer lists ────────────────────────────────────────────────────
const SC = JSON.parse(readFileSync(join(dir, 'data', 'shortcuts.json'), 'utf8'))
const listed = new Map()  // comboId → { label, key }
for (const group of SC.groups) {
  for (const sc of group.shortcuts) {
    if (!sc.key && !sc.keys) continue
    const keys = sc.keys ?? [sc.key]
    // A range like "0–9" or "F1–F4" stands for each key in it
    const expanded = keys.flatMap(key => {
      const range = key.match(/^(F?)(\d)–F?(\d)$/)
      if (!range) return [key]
      const [, prefix, from, to] = range
      const out = []
      for (let n = +from; n <= +to; n++) out.push(prefix + n)
      return out
    })
    const mods = (sc.modifiers ?? []).filter(m => m !== 'Shift' || (sc.modifiers ?? []).length === 1)
    for (const key of expanded) {
      const id = comboId({ mods, keys: [key] })
      if (!listed.has(id)) listed.set(id, { label: `${sc.label} (${group.name})`, key })
    }
  }
}

// The grid menu's own category keys (Z/X/C/V) are the trainer's whole build drill, so
// they live in buildmenus.json rather than shortcuts.json. Without this they would be
// reported as missing forever, and permanent noise hides the gaps that are real.
const MENUS = JSON.parse(readFileSync(join(dir, 'data', 'buildmenus.json'), 'utf8'))
for (const builder of Object.values(MENUS.builders)) {
  for (const cat of Object.values(builder.categories ?? {})) {
    if (!cat.key) continue
    const id = comboId({ mods: [], keys: [canonKey(cat.key)] })
    if (!listed.has(id)) listed.set(id, { label: `${cat.name ?? 'category'} (build menu)`, key: canonKey(cat.key) })
  }
}

// ── What the trainer claims each entry *is* ───────────────────────────────────
/**
 * Entries now name the BAR action they teach, so the two sides can be compared by meaning
 * instead of by key. That matters because the layout double-binds constantly — `A` is both
 * `attack` and `gridmenu_key 2 1`, `W` is `capture` for one unit and `resurrect` for
 * another — and a key-only comparison cannot tell those apart. Three things go wrong here:
 * an action BAR no longer knows, one it binds to a key the trainer does not teach, and one
 * the trainer teaches on a key BAR does not bind.
 */
const lower = action => action.trim().toLowerCase()
const actionKeys = new Map()   // action → Set of comboIds BAR binds it to
for (const { keyset, action } of bindPairs) {
  const combo = parseCombo(keyset)
  if (combo.keys.length > 1 && new Set(combo.keys).size === 1) combo.keys = [combo.keys[0]]
  const id = lower(action)
  if (!actionKeys.has(id)) actionKeys.set(id, new Set())
  actionKeys.get(id).add(comboId(combo))
}
// The catalog carries every bindable action, including the ones a given profile leaves
// unbound — `areamex` lives in Legacy alone — so the known set needs both it and the binds.
const catalog = readBarJson('common/configs/keybind_catalog.json')
if (!catalog)
  fail(`No common/configs/keybind_catalog.json in the ${barSourceLabel()}.\n`
    + 'Run `node fetch-bar-data.js`.')
const knownActions = new Set(actionKeys.keys())
const actionPrefixes = new Set()
{
  for (const entry of catalog) {
    if (entry.hidden) { for (const a of entry.hidden) knownActions.add(lower(a)); continue }
    for (const item of entry.items ?? []) {
      if (item.action) knownActions.add(lower(item.action))
      if (item.prefix) {
        actionPrefixes.add(lower(item.prefix))
        for (const m of item.members ?? []) knownActions.add(lower(item.prefix + m))
      }
    }
  }
}
const knows = action => knownActions.has(lower(action))
  || [...actionPrefixes].some(p => lower(action).startsWith(p))

const unknownActions = [], movedActions = []
for (const group of SC.groups) {
  for (const sc of group.shortcuts) {
    const named = [
      ...(sc.action ? [{ sc, action: sc.action }] : []),
      ...(sc.states ?? []).filter(s => s.action).map(s => ({ sc, action: s.action })),
    ]
    for (const { action } of named) {
      const where = `${sc.label} (${group.name})`
      if (!knows(action)) { unknownActions.push([where, action]); continue }
      const bound = actionKeys.get(lower(action))
      if (!bound || !bound.size) continue          // known but unbound in this profile
      // Every modifier counts here, unlike in the combo census: Ctrl+Shift+1 really is a
      // different action from Ctrl+1, so the queue-Shift rule must not collapse them.
      const key  = canonKey(sc.key ?? '')
      const mine = comboId({ mods: sc.modifiers ?? [], keys: [key] })
      // A trainer entry may sit on a gesture rather than a key, and several entries share
      // one action on purpose (Attack, Attack Circle, Attack Line). Only flag a real clash.
      if (!sc.key || bound.has(mine) || anyModKeys.has(key)) continue
      movedActions.push([where, action, mine, [...bound].join(' / ')])
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const missing = [...bound.entries()].filter(([id]) => !listed.has(id))
const covered = [...bound.entries()].filter(([id]) => listed.has(id))

console.log(`\nRead the ${PROFILE} profile from the ${barSourceLabel()}`)
console.log(`BAR binds ${bound.size} combos worth training · trainer lists ${listed.size}\n`)
console.log(`── Bound in game, absent from the trainer (${missing.length})`)
for (const [id, actions] of missing.sort())
  console.log(`   ${id.padEnd(16)} ${[...actions].join(', ')}`)

if (all) {
  console.log(`\n── Covered (${covered.length})`)
  for (const [id, actions] of covered.sort())
    console.log(`   ${id.padEnd(16)} ${listed.get(id).label.padEnd(38)} ← ${[...actions].join(', ')}`)

  // An `Any+` key counts as bound on every modifier combination, so Shift+Space does not
  // belong here just because the file only ever writes `Any+space`.
  const unbound = [...listed.entries()]
    .filter(([id, { key }]) => !bound.has(id) && !anyModKeys.has(key))
  console.log(`\n── Listed by the trainer, not found in the binding files (${unbound.length})`)
  console.log('   (mouse-only entries and engine defaults legitimately land here)')
  for (const [id, { label }] of unbound.sort()) console.log(`   ${id.padEnd(16)} ${label}`)
}

if (unknownActions.length) {
  console.log(`\n── Entries naming an action BAR does not know (${unknownActions.length})`)
  for (const [where, action] of unknownActions) console.log(`   ${action.padEnd(34)} ${where}`)
}
if (movedActions.length) {
  console.log(`\n── Entries whose action BAR binds elsewhere (${movedActions.length})`)
  for (const [where, action, mine, theirs] of movedActions)
    console.log(`   ${action.padEnd(28)} trainer ${mine.padEnd(12)} BAR ${theirs.padEnd(18)} ${where}`)
}
console.log()
