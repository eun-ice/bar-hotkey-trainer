#!/usr/bin/env node
/**
 * Tests for the matching rules in logic.js, run against the real data files.
 *
 *   node test.js
 *
 * The point of these is coverage the UI cannot give cheaply: the training queue is
 * shuffled, so waiting for it to serve up "Naval Metal Storage on a Construction
 * Seaplane" is luck. Here every builder and every land/water pair is checked in
 * milliseconds.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  modsSatisfy, scRangeIncludes, scComboMatchesKey, resolveBinding, equivalentKeyOnPage,
  slotPicksUnit, menuRouteKeys, searchReference, gridActionKey,
} from './logic.js'

const dir  = dirname(fileURLToPath(import.meta.url))
const load = f => JSON.parse(readFileSync(join(dir, 'data', f), 'utf8'))
const MENUS = load('buildmenus.json')
const WATER = load('water-equivalents.json')
const SC    = load('shortcuts.json')

let passed = 0
const failures = []
const check = (name, cond, detail = '') => {
  if (cond) { passed++; return }
  failures.push(name + (detail ? '\n      ' + detail : ''))
}
const group = name => console.log('\n' + name)

// ─── Modifier tolerance ───────────────────────────────────────────────────────
group('modsSatisfy — optional modifiers')
check('exact match',              modsSatisfy(['shift','alt'], ['shift','alt']))
check('order does not matter',    modsSatisfy(['alt','shift'], ['shift','alt']))
check('no modifiers wanted/held', modsSatisfy([], []))
check('extra modifier rejected',  !modsSatisfy(['shift'], []))
check('missing modifier rejected',!modsSatisfy(['alt'], ['shift','alt']))
check('optional may be omitted',   modsSatisfy(['alt'], ['shift','alt'], ['shift']))
check('optional may be held',      modsSatisfy(['shift','alt'], ['shift','alt'], ['shift']))
check('required still enforced',  !modsSatisfy(['shift'], ['shift','alt'], ['shift']))
check('wrong modifier rejected',  !modsSatisfy(['ctrl','alt'], ['shift','alt'], ['shift']))
check('nothing held rejected',    !modsSatisfy([], ['shift','alt'], ['shift']))

group('Build Spacing accepts Alt+Z with and without Shift')
for (const id of ['build-spacing-increase', 'build-spacing-decrease']) {
  const sc = SC.groups.flatMap(g => g.shortcuts).find(s => s.id === id)
  check(`${id} exists with optionalModifiers`, sc && sc.optionalModifiers?.includes('Shift'))
  if (!sc) continue
  const b = resolveBinding(sc)
  check(`${id} documented combo`, scComboMatchesKey(
    { key: sc.key, mods: ['Shift','Alt'] }, b.key, b.modifiers, b.optionalModifiers))
  check(`${id} without Shift`, scComboMatchesKey(
    { key: sc.key, mods: ['Alt'] }, b.key, b.modifiers, b.optionalModifiers))
  check(`${id} rejects Shift alone`, !scComboMatchesKey(
    { key: sc.key, mods: ['Shift'] }, b.key, b.modifiers, b.optionalModifiers))
}

// ─── Ranges ───────────────────────────────────────────────────────────────────
group('scRangeIncludes')
check('digit inside',    scRangeIncludes('0–9', '5'))
check('digit at edges',  scRangeIncludes('0–9', '0') && scRangeIncludes('0–9', '9'))
check('letter rejected', !scRangeIncludes('0–9', 'A'))
check('two digits out',  !scRangeIncludes('0–9', '10'))
check('F-key inside',    scRangeIncludes('F1–F4', 'F3'))
check('F-key outside',   !scRangeIncludes('F1–F4', 'F5'))

// ─── 60% preset ───────────────────────────────────────────────────────────────
group('60% keyboard preset')
const withSixty = SC.groups.flatMap(g => g.shortcuts).filter(s => s.sixty)
check('entries carry a sixty block', withSixty.length === 11, `found ${withSixty.length}`)
for (const sc of withSixty) {
  const std = resolveBinding(sc, false)
  const cmp = resolveBinding(sc, true)
  const name = `${sc.id}: ${[...std.modifiers, std.key].join('+')} → ${[...cmp.modifiers, cmp.key].join('+')}`
  check(name + ' differs', std.key !== cmp.key || std.modifiers.join() !== cmp.modifiers.join())
  check(name + ' has no F-row key', !/^F\d/.test(cmp.key))
  check(name + ' has no backtick', cmp.key !== '`')
}
check('standard mode is a pass-through', SC.groups.flatMap(g => g.shortcuts).every(sc => {
  const b = resolveBinding(sc, false)
  return b.key === sc.key && (b.keys ?? undefined) === (sc.keys ?? undefined)
      && b.modifiers.join() === (sc.modifiers ?? []).join()
}))

// ─── Land / water equivalents ─────────────────────────────────────────────────
group('Land/water equivalents — every builder, every pair')
let pairsBoth = 0, crossPage = 0
for (const [builderId, builder] of Object.entries(MENUS.builders)) {
  const where = {}
  for (const [catId, cat] of Object.entries(builder.categories))
    for (const u of cat.units) where[u.id] = { catId, key: u.key, page: u.page ?? 0 }

  for (const [unitId, spot] of Object.entries(where)) {
    const equivId = WATER[unitId]
    if (!equivId || !where[equivId]) continue          // counterpart not buildable here
    const other = where[equivId]
    if (other.catId !== spot.catId) continue           // never happens in the data
    pairsBoth++
    if (other.page !== spot.page) crossPage++

    // Asked for `unitId`: pressing the counterpart's key must be accepted while its
    // page is on screen — including when that is a different page than the unit's own.
    const got = equivalentKeyOnPage(WATER, builder, spot.catId, unitId, other.page)
    check(`${builderId}/${spot.catId}: ${unitId} accepts ${equivId}'s key`,
      got === other.key, `expected ${other.key}, got ${got}`)

    // …and must NOT be accepted on a page where the counterpart is not shown
    const wrongPage = other.page === 0 ? 99 : 0
    check(`${builderId}/${spot.catId}: ${unitId} rejects key on page ${wrongPage}`,
      equivalentKeyOnPage(WATER, builder, spot.catId, unitId, wrongPage) === null)
  }
}
console.log(`  ${pairsBoth} pairs with both sides buildable, ${crossPage} of them across pages`)
check('cross-page pairs exist (the case that used to be rejected)', crossPage > 0)

group('The two cases verified in game')
const seaplane = MENUS.builders.armcsa
check('Construction Seaplane: Naval Metal Storage accepts Metal Storage key', (() => {
  if (!seaplane) return false
  const land = Object.values(seaplane.categories).flatMap(c => c.units).find(u => u.id === 'armmstor')
  return land && equivalentKeyOnPage(WATER, seaplane, 'economy', 'armuwms', land.page) === land.key
})(), 'armuwms ← armmstor')

const commander = MENUS.builders.armcom
check('Commander: Shipyard accepts Bot Lab key and vice versa', (() => {
  if (!commander) return false
  const build = commander.categories.build.units
  const lab = build.find(u => u.id === 'armlab'), yard = build.find(u => u.id === 'armsy')
  return lab && yard
    && equivalentKeyOnPage(WATER, commander, 'build', 'armsy', lab.page) === lab.key
    && equivalentKeyOnPage(WATER, commander, 'build', 'armlab', yard.page) === yard.key
})())

// Sentry is armllt; armdl is the Anemone, a separate coastal launcher with no counterpart
check('Commander: Harpoon accepts Sentry key and vice versa', (() => {
  if (!commander) return false
  const combat = commander.categories.combat.units
  const sentry = combat.find(u => u.id === 'armllt'), harpoon = combat.find(u => u.id === 'armtl')
  if (!sentry || !harpoon) return false
  return equivalentKeyOnPage(WATER, commander, 'combat', 'armtl', sentry.page) === sentry.key
      && equivalentKeyOnPage(WATER, commander, 'combat', 'armllt', harpoon.page) === harpoon.key
})())

// ─── A grid key picks what is on the visible page ─────────────────────────────
// Verified in game on a Construction Seaplane: Y picks the Metal Extractor bottom-left,
// B only pages the menu, so Y B click still places the Extractor — while Y B Y moves the
// pending build to the Naval Metal Storage now sitting on that same bottom-left slot.
group('Grid key resolves against the page on screen')
const picks = (page, key, unitId) => slotPicksUnit(WATER, seaplane, 'economy', page, key, unitId)
check('page 1, Z → Metal Extractor',            picks(0, 'Z', 'armmex'))
check('page 2, Z → NOT the Metal Extractor',   !picks(1, 'Z', 'armmex'))
check('page 2, Z → Naval Metal Storage',        picks(1, 'Z', 'armuwms'))
check('page 1, Z → NOT Naval Metal Storage',   !picks(0, 'Z', 'armuwms'))
check('page 1, W → Naval Metal Storage (water counterpart)', picks(0, 'W', 'armuwms'))
check('page 1, W → Metal Storage itself',       picks(0, 'W', 'armmstor'))
check('page 2, W → nothing, the slot is empty',!picks(1, 'W', 'armmstor'))
check('Commander: Z → Shipyard via the Bot Lab slot',
  slotPicksUnit(WATER, commander, 'build', 0, 'Z', 'armsy'))
check('Commander: X → not the Shipyard',
  !slotPicksUnit(WATER, commander, 'build', 0, 'X', 'armsy'))

// ─── Category key as a shortcut to the bottom-left slot ───────────────────────
// Verified in game: the Commander's V + click places a Bot Lab on land and a Shipyard
// on water, so the counterpart sitting bottom-left counts just like the unit itself.
group('Bottom-left slot reachable by the category key alone')
const bottomLeftKey = (builder, catId, unitId, gridKey, page) => {
  if (page > 0) return null
  if (gridKey === 'Z') return gridKey
  const k = equivalentKeyOnPage(WATER, builder, catId, unitId, 0)
  return k === 'Z' ? k : null
}
check('Commander: Shipyard reachable via the Build category key', (() => {
  const yard = commander?.categories.build.units.find(u => u.id === 'armsy')
  return yard && bottomLeftKey(commander, 'build', 'armsy', yard.key, yard.page) === 'Z'
})(), 'Bot Lab sits on Z and becomes a Shipyard over water')
check('Commander: Bot Lab itself is bottom-left', (() => {
  const lab = commander?.categories.build.units.find(u => u.id === 'armlab')
  return lab && bottomLeftKey(commander, 'build', 'armlab', lab.key, lab.page) === 'Z'
})())
check('a unit with no bottom-left route is not claimed', (() => {
  // Anemone sits on Q and has no water counterpart at all
  const a = commander?.categories.combat.units.find(u => u.id === 'armdl')
  return a && bottomLeftKey(commander, 'combat', 'armdl', a.key, a.page) === null
})())
let reachable = 0
for (const [builderId, builder] of Object.entries(MENUS.builders)) {
  for (const [catId, cat] of Object.entries(builder.categories))
    for (const u of cat.units)
      if (u.key !== 'Z' && bottomLeftKey(builder, catId, u.id, u.key, u.page ?? 0) === 'Z') reachable++
}
console.log(`  ${reachable} units reachable through their bottom-left counterpart`)
check('the shortcut applies somewhere', reachable > 0)

// ─── Tap-count sequences ──────────────────────────────────────────────────────
// BAR spells a toggle's states as repeats of the whole combo: Factory Guard off is
// Ctrl+G twice, not Ctrl+G and then a bare G. Every step therefore carries the same
// modifiers, which is what app.js builds seqMods from.
group('Repeated-combo sequences carry their modifiers on every step')
const sequences = SC.groups.flatMap(g => g.shortcuts).filter(s => s.keys)
check('sequences exist', sequences.length > 0)
for (const sc of sequences) {
  const bind = resolveBinding(sc)
  const mods = bind.modifiers
  bind.keys.forEach((key, idx) => {
    check(`${sc.id} step ${idx + 1} matches ${[...mods, key].join('+')}`,
      scComboMatchesKey({ key: key.toUpperCase(), mods }, key, mods))
    if (!mods.length) return
    // …and the bare key must not pass for a step that wants a modifier
    check(`${sc.id} step ${idx + 1} rejects a bare ${key}`,
      !scComboMatchesKey({ key: key.toUpperCase(), mods: [] }, key, mods))
  })
}
// Tap-count toggles live as one entry with a `states` list — one reference row, but one
// trainable question per state. Verified in game, so the tap counts are not guesses.
group('Tap-count toggles')
const toggles = SC.groups.flatMap(g => g.shortcuts).filter(s => s.states)
check('toggles carry states', toggles.length === 6, `found ${toggles.length}`)
for (const sc of toggles) {
  check(`${sc.id} has a base key`, !!sc.key)
  check(`${sc.id} has no keys of its own`, !sc.keys)
  const taps = sc.states.map(state => state.taps)
  check(`${sc.id} taps start at 1 and rise by one`,
    taps.every((n, idx) => n === idx + 1), taps.join(','))
  for (const state of sc.states) {
    check(`${sc.id}/${state.id} has an id and label`, !!state.id && !!state.label)
    // Every tap repeats the whole combo, modifiers included
    check(`${sc.id}/${state.id} matches ${[...(sc.modifiers ?? []), sc.key].join('+')}`,
      scComboMatchesKey({ key: sc.key.toUpperCase(), mods: sc.modifiers ?? [] },
                        sc.key, sc.modifiers ?? []))
  }
}
const guard = toggles.find(s => s.id === 'factory-guard')
check('Factory Guard is Ctrl+G, off on the second tap',
  guard?.key === 'G' && guard?.modifiers?.join() === 'Ctrl'
  && guard?.states.find(state => state.label === 'Off')?.taps === 2)
const stance = toggles.find(s => s.id === 'stance')
check('Fire stance is Fire at Will → Hold Fire → Return Fire',
  stance?.states.map(state => state.label).join(' → ')
    === 'Fire at Will → Hold Fire → Return Fire')

// ─── Shortcut table sanity ────────────────────────────────────────────────────
group('Every shortcut matches its own binding')
for (const g of SC.groups) {
  for (const sc of g.shortcuts) {
    if (sc.keys || !sc.key || sc.key.includes('–')) continue
    const b = resolveBinding(sc)
    check(`${sc.id} matches itself`, scComboMatchesKey(
      { key: sc.key.toUpperCase(), mods: b.modifiers }, b.key, b.modifiers, b.optionalModifiers))
  }
}

// ─── Reference search ────────────────────────────────────────────────────────
group('searchReference — units, builders, shortcuts')
{
  const isFactory = builder => {
    const cats = Object.keys(builder.categories)
    return cats.length === 1 && cats[0] === 'build'
  }
  const opts = {
    builders: Object.values(MENUS.builders), units: MENUS.units, groups: SC.groups, isFactory,
    categoryKeys: { economy: 'Z', combat: 'X', utility: 'C', build: 'V' },
    gridKeys: ['Q','W','E','R','A','S','D','F','Z','X','C','V'],
    waterEquivalents: WATER,
  }
  const find = query => searchReference(query, opts)

  check('bottom-left of page 1 is the category key alone', menuRouteKeys('Z', 0, 'Z').join() === 'Z')
  check('later page pages with B first', menuRouteKeys('Z', 1, 'Q').join() === 'Z,B,Q')
  check('factory has no category key', menuRouteKeys(null, 1, 'Z').join() === 'B,Z')
  check('empty query finds nothing', !find('  ').units.length && !find('').shortcuts.length)

  const shipyard = find('shipyard').units.find(unit => unit.id === 'armsy')
  check('Shipyard is found with its builders', shipyard?.routes.some(route => route.builderId === 'armcom'),
    JSON.stringify(shipyard?.routes.map(route => route.builderId)))
  check('the commander builds the Shipyard with V V', shipyard?.routes
    .find(route => route.builderId === 'armcom')?.keys.join(' ') === 'V V')
  check('Shipyard knows its land counterpart', shipyard?.counterpart === 'armlab')
  check('an exact name ranks first', find('shipyard').units[0]?.name === 'Shipyard')
  check('faction narrows a unit', find('cortex shipyard').units.every(unit => unit.faction === 'cortex'))

  check('Construction Seaplane is found as a builder',
    find('construction seaplane').builders.some(hit => hit.id === 'armcsa'))

  const holdFire = find('hold fire').shortcuts[0]
  check('a toggle state is targeted on its own', holdFire && holdFire.id !== holdFire.rowId
    && holdFire.stateLabel === 'Hold Fire', JSON.stringify(holdFire))
  check('BAR action ids find the shortcut', find('settarget').shortcuts
    .some(hit => hit.rowId.startsWith('target-set')))
  // uikeys.txt names — what a player reads in their own binding file
  const top = query => find(query).shortcuts[0]
  check('group set 3 finds the prefix row first', top('group set 3')?.rowId === 'group-set-range'
    && top('group set 3')?.action === 'group set 3', JSON.stringify(top('group set 3')))
  check('an F-key member is numbered without its F',
    top('set_camera_anchor 2')?.action === 'set_camera_anchor 2')
  check('factory_preset load 3 finds the load row',
    top('factory_preset load 3')?.rowId === 'factory-preset-load-range')
  check('buildunit_<id> finds the unit', find('buildunit_armsolar').units[0]?.id === 'armsolar')
  check('gridmenu_key 1 2 is X — row 1 is the bottom row',
    gridActionKey('gridmenu_key 1 2', opts.gridKeys, opts.categoryKeys)?.key === 'X')
  check('gridmenu_key 3 1 is Q', find('gridmenu_key 3 1').grid?.key === 'Q')
  check('gridmenu_category 2 is Combat on X',
    find('gridmenu_category 2').grid?.categoryId === 'combat' && find('gridmenu_category 2').grid?.key === 'X')
  check('gridmenu_next_page is B', find('gridmenu_next_page').grid?.key === 'B')
  check('a plain word is no grid action', find('shipyard').grid === null)

  check('learnHidden rows never come back', find('group').shortcuts.every(hit =>
    !SC.groups.flatMap(g => g.shortcuts).find(sc => sc.id === hit.rowId)?.learnHidden))
}

// ─── Report ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60))
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED\n`)
  for (const f of failures.slice(0, 25)) console.log('  ✗ ' + f)
  if (failures.length > 25) console.log(`  … and ${failures.length - 25} more`)
  process.exit(1)
}
console.log(`${passed} checks passed ✓`)
