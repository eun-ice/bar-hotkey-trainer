#!/usr/bin/env node
/**
 * Cross-check data/shortcuts.json against BAR's own keybinding files.
 *
 *   npm run check:bindings          # what the game binds that the trainer does not list
 *   npm run check:bindings -- --all # also list what we cover, and what we list unbound
 *
 * shortcuts.json is hand-maintained, so it drifts as BAR adds bindings. This reads
 * luaui/configs/hotkeys/*.txt out of bar-data/ — the files the game actually loads — and
 * reports the gaps, rather than anyone transcribing a screenshot of the in-game chart.
 *
 * It compares key combos, not meanings: a match here says the trainer has *something* on
 * that combo, not that the description is right. Read the pairs it prints.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir  = dirname(fileURLToPath(import.meta.url))
const all  = process.argv.includes('--all')
const HOTKEYS = join(dir, 'bar-data', 'luaui', 'configs', 'hotkeys')

// Engine-level bindings that are not grid hotkeys and have no place in the trainer:
// chat line editing, camera nudging, the quit menu, widget-internal modifiers.
const IGNORED_ACTIONS = [
  /^edit_/, /^move(forward|back|left|right|up|down|fast|reset|rotate|tilt)$/,
  /^selectbox_/, /^selectloop/, /^quit/, /^pause$/, /^buildsplit/, /^commandinsert/,
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

/** "Ctrl+Shift+sc_a" → { mods: ['Ctrl','Shift'], keys: ['A'] }; commas are key sequences. */
function parseCombo(spec) {
  const steps = spec.split(',')
  const mods = []
  const keys = []
  for (const step of steps) {
    const parts = step.split('+')
    // A trailing empty part means the key itself was '+', e.g. "numpad+"
    const key = parts.pop() || '+'
    for (const part of parts) {
      const name = part.toLowerCase()
      if (name === 'any') continue          // "Any" = with or without modifiers
      if (name === 'meta') { mods.push('Space'); continue }   // BAR's Meta is the Space chord
      const proper = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt' }[name]
      if (proper && !mods.includes(proper)) mods.push(proper)
    }
    keys.push(canonKey(key))
  }
  return { mods, keys }
}

const ORDER = { Ctrl: 0, Shift: 1, Alt: 2, Space: 3 }
const comboId = ({ mods, keys }) =>
  [...mods].sort((a, b) => ORDER[a] - ORDER[b]).concat(keys.join(',')).join('+')

// ── What the game binds ───────────────────────────────────────────────────────
const bound = new Map()   // comboId → Set of actions
for (const file of readdirSync(HOTKEYS).filter(f => f.endsWith('.txt'))) {
  // The 60% preset is an alternative for the same actions, not extra bindings
  if (file.includes('60pct')) continue
  for (const line of readFileSync(join(HOTKEYS, file), 'utf8').split('\n')) {
    const match = line.match(/^bind\s+(\S+)\s+(.+?)\s*(?:\/\/.*)?$/)
    if (!match) continue
    const [, spec, rawAction] = match
    const action = rawAction.trim()
    if (IGNORED_KEYS.some(re => re.test(spec))) continue
    if (IGNORED_ACTIONS.some(re => re.test(action))) continue
    const combo = parseCombo(spec)
    // BAR spells toggles as tap counts on one key — "sc_b,sc_b,sc_b" is still just B
    if (combo.keys.length > 1 && new Set(combo.keys).size === 1) combo.keys = [combo.keys[0]]
    const id = comboId(combo)
    if (!bound.has(id)) bound.set(id, new Set())
    bound.get(id).add(action.replace(/\s+/g, ' ').slice(0, 46))
  }
}

// Holding Shift on a command only queues it — the same hotkey, not a second one to learn.
// Drop those once the bare combo is known to exist.
for (const id of [...bound.keys()]) {
  const bare = id.split('+').filter(part => part !== 'Shift').join('+')
  if (bare !== id && bound.has(bare)) bound.delete(id)
}

// ── What the trainer lists ────────────────────────────────────────────────────
const SC = JSON.parse(readFileSync(join(dir, 'data', 'shortcuts.json'), 'utf8'))
const listed = new Map()  // comboId → label
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
      if (!listed.has(id)) listed.set(id, `${sc.label} (${group.name})`)
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const missing = [...bound.entries()].filter(([id]) => !listed.has(id))
const covered = [...bound.entries()].filter(([id]) => listed.has(id))

console.log(`\nBAR binds ${bound.size} combos worth training · trainer lists ${listed.size}\n`)
console.log(`── Bound in game, absent from the trainer (${missing.length})`)
for (const [id, actions] of missing.sort())
  console.log(`   ${id.padEnd(16)} ${[...actions].join(', ')}`)

if (all) {
  console.log(`\n── Covered (${covered.length})`)
  for (const [id, actions] of covered.sort())
    console.log(`   ${id.padEnd(16)} ${listed.get(id).padEnd(38)} ← ${[...actions].join(', ')}`)

  const unbound = [...listed.entries()].filter(([id]) => !bound.has(id))
  console.log(`\n── Listed by the trainer, not found in the binding files (${unbound.length})`)
  console.log('   (mouse-only entries and engine defaults legitimately land here)')
  for (const [id, label] of unbound.sort()) console.log(`   ${id.padEnd(16)} ${label}`)
}
console.log()
