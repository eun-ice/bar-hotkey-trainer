#!/usr/bin/env node
/**
 * BAR Hotkey Trainer — Data Extraction Script
 *
 * Fetches unit data from the Beyond All Reason GitHub repository and generates:
 *   data/buildmenus.json   — all builders with categorised build menus + grid hotkeys
 *   data/icons/*.webp      — unit icons converted from DDS (requires ImageMagick)
 *
 * Requirements:
 *   Node.js 18+            (built-in fetch)
 *   ImageMagick            (brew install imagemagick)
 *
 * Usage:
 *   node extract-data.js                  # full run
 *   node extract-data.js --skip-icons     # skip icon conversion
 *   GITHUB_TOKEN=xxx node extract-data.js # avoids GitHub API rate limits (60/hr unauth)
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BAR_DATA = join(__dirname, 'bar-data')

const RAW = 'https://raw.githubusercontent.com/beyond-all-reason/Beyond-All-Reason/master'
const API = 'https://api.github.com/repos/beyond-all-reason/Beyond-All-Reason'
const HEADERS = {
  'User-Agent': 'bar-hotkey-trainer-extractor',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {}),
}

// ─── Build menu layout ────────────────────────────────────────────────────────
//
// The in-game build menu is a 3×4 grid.  Reading order top-left → bottom-right:
//
//   Row 1:  Q   W   E   R
//   Row 2:  A   S   D   F
//   Row 3:  Z   X   C   V     ← Z = Y key on QWERTZ keyboards
//
// The 4 category tabs sit at the bottom of the menu (same physical keys as row 3):
//   Z = Economy (category 1)
//   X = Combat  (category 2)
//   C = Utility (category 3)
//   V = Build   (category 4)
//
// ─────────────────────────────────────────────────────────────────────────────

const GRID_KEYS      = ['Q','W','E','R','A','S','D','F','Z','X','C','V']
const GRID_PAGE_SIZE = 12

// Override display names for specific units (used where the language file is wrong or missing)
const UNIT_NAME_OVERRIDES = {
  'armdecom': 'Decoy Commander',
  'cordecom': 'Decoy Commander',
  'legdecom': 'Decoy Commander',
}

// Unit IDs to exclude regardless of reachability (broken data, non-game modes, etc.)
const EXCLUDED_BUILDER_IDS = new Set([
  // Debug/unnamed commander variants (missing localisation data)
  'armcomcon','armcomnew','corcomcon',
  // Assist drones — nano-helpers spawned automatically, not player-directed constructors
  'armassistdrone','armassistdrone_land',
  'corassistdrone','corassistdrone_land',
  'legassistdrone','legassistdrone_land',
  // Decommissioning commanders — special game mode only
  'armdecom','cordecom','legdecom',
  // Nano-repair turrets that appear as builders in Lua but have no real build menu
  'armfark',                          // Armada T1 nano turret (Butler)
  'corprinter','corvac','corvacct',   // Cortex nano variants (all named Printer)
  // Special combat units with only a handful of build options
  'cormando',                         // Cortex Commando
])

// Product unit IDs to always exclude from build menus (exist in game files but not base game)
const EXCLUDED_PRODUCT_IDS = new Set([
  'armsfig2', 'corsfig2',  // "Cyclone" — mod-only heavy fighter, not in standard game
])

// Unit IDs that must never be added via the overflow pass (Pass 2).
// These units ARE legitimately buildable by some builders (where they appear in the
// gridmenu directly), but they also happen to be in other builders' buildoptions
// without a corresponding gridmenu entry — meaning the game menu never shows them
// there and the trainer should not add them for those builders.
const NEVER_OVERFLOW_IDS = new Set([
  // Defensive obstacles placed by construction ships; the naval engineers (Voyager /
  // Pathfinder / Artifex) list them in buildoptions but their gridmenu has no slot,
  // so they are inaccessible in-game from those builders.
  'armfdrag', 'corfdrag', 'legfdrag',  // Shark's Teeth
  'armdrag',  'cordrag',  'legdrag',   // Dragon's Teeth
])

// Builder IDs hidden by default — included in JSON but only shown with the "optional" filter
const OPTIONAL_BUILDER_IDS = new Set([
  'armmlv','cormlv','legmlv',    // Minelayers — have a build menu but rarely trained
])

const CATEGORIES = [
  { id: 'economy', label: 'Economy', key: 'Z' },
  { id: 'combat',  label: 'Combat',  key: 'X' },
  { id: 'utility', label: 'Utility', key: 'C' },
  { id: 'build',   label: 'Build',   key: 'V' },
]

// The in-game grid fills bottom-up: first lua row → bottom (Z X C V), last → top (Q W E R).
// Row 0 (first in Lua) = bottom row: Z X C V
// Row 1 (second)       = middle row: A S D F
// Row 2 (third)        = top row:    Q W E R
const ROW_KEYS = [['Z','X','C','V'], ['A','S','D','F'], ['Q','W','E','R']]
const ROWS_PER_PAGE = 3

// Factory (labGrids) flat arrays also fill bottom-to-top, left-to-right:
// positions 0-3 → Z X C V, 4-7 → A S D F, 8-11 → Q W E R (then page 2, same order)
const LAB_FILL_KEYS = ['Z','X','C','V','A','S','D','F','Q','W','E','R']

// ─── gridmenu_layouts.lua parser ─────────────────────────────────────────────
//
// The authoritative source of in-game build menu layouts.  Contains:
//   labGrids  — flat 12-slot arrays per factory (no category tabs)
//   unitGrids — [[rows…], …] per category per constructor/commander
//
// A "techsplit" conditional block (the standard competitive mode) overrides
// several entries.  We unconditionally apply all overrides so the trainer
// matches the default competitive layout.

/** Given src and an index pointing at '{', return src[start..matching '}'] */
function extractBraces(src, start) {
  let depth = 0
  let inStr = false
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (ch === '"' && !inStr)  { inStr = true;  continue }
    if (ch === '"' &&  inStr)  { inStr = false; continue }
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('Unmatched brace at ' + start)
}

/** Split src on top-level commas (respecting braces and quoted strings). */
function splitTopLevel(src) {
  const parts = []
  let depth = 0, inStr = false, start = 0
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{') { depth++; continue }
    if (ch === '}') { depth--; continue }
    if (ch === ',' && depth === 0) { parts.push(src.slice(start, i)); start = i + 1 }
  }
  parts.push(src.slice(start))
  return parts
}

/** Parse a Lua value: quoted string → string, '{…}' → array/object, else raw. */
function parseLuaVal(src) {
  src = src.trim()
  if (src[0] === '"') return src.slice(1, src.lastIndexOf('"'))
  if (src[0] === '{') return parseLuaTable(src)
  return src
}

/**
 * Parse a '{…}' Lua table.
 * Returns an object  { key: value, … } if any entry has the form  ident = value.
 * Returns an array   [ value, … ]       otherwise (positional / array table).
 */
function parseLuaTable(src) {
  const entries = splitTopLevel(src.slice(1, -1))
  const obj = {}, arr = []
  let isObj = false
  for (const raw of entries) {
    const entry = raw.trim()
    if (!entry) continue
    const eq = entry.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/)
    if (eq) { isObj = true; obj[eq[1]] = parseLuaVal(eq[2].trim()) }
    else    { arr.push(parseLuaVal(entry)) }
  }
  return isObj ? obj : arr
}

/**
 * Parse gridmenu_layouts.lua → { labGrids, unitGrids }.
 *
 * labGrids[id]  = flat string array  (factory; 12 slots per page)
 * unitGrids[id] = array of catArrays (constructor/commander)
 *   catArrays[catIdx] = array of row arrays
 *     row[colIdx] = unit ID string ('' = empty slot)
 * catIdx 0=economy 1=combat 2=utility 3=build
 */
function parseGridmenuLayouts(lua) {
  // Strip single-line comments so they don't confuse the brace/string scanner
  const src = lua.replace(/--[^\n]*/g, ' ')

  const labGrids  = {}
  const unitGrids = {}

  // Parse initial  local labGrids = { name = { … }, … }
  const labInit = /local\s+labGrids\s*=\s*\{/.exec(src)
  if (labInit) {
    const tbl = extractBraces(src, labInit.index + labInit[0].length - 1)
    Object.assign(labGrids, parseLuaTable(tbl))
  }

  // Parse initial  local unitGrids = { name = { … }, … }
  const unitInit = /local\s+unitGrids\s*=\s*\{/.exec(src)
  if (unitInit) {
    const tbl = extractBraces(src, unitInit.index + unitInit[0].length - 1)
    Object.assign(unitGrids, parseLuaTable(tbl))
  }

  // NOTE: we intentionally do NOT apply the  if Spring.GetModOptions().techsplit then … end
  // override blocks.  Techsplit is a non-default optional game mode; the base tables above
  // represent the standard (non-techsplit) layout that most players encounter.

  return { labGrids, unitGrids }
}

// ─── Category builders from gridmenu layouts ──────────────────────────────────

// Unit IDs in gridmenu_layouts.lua that are stale/typo names for current unit IDs.
const UNIT_ID_CORRECTIONS = {
  'armbantha': 'armbanth',     // typo in gridmenu_layouts.lua (amphibious T3 gantry — Titan)
  'armst':     'armgremlin',   // Gremlin stealth tank — old ID renamed; gridmenu not updated
  'armcarry':  'armantiship',  // ARM haven — carrier replaced by anti-ship craft (Haven)
  'corcarry':  'corantiship',  // COR haven — same rename; corasy slot 4 says corcarry
  'corseal':   'corsala',      // COR Salamander — gridmenu for coravp/coramsub says corseal (Croc sub)
                               //   but neither builder can build the Croc; correct unit is Salamander
}

// Per-builder gridmenu corrections: { builderId: { staleId: correctId } }
// Use instead of UNIT_ID_CORRECTIONS when the stale ID is valid for other builders.
const BUILDER_UNIT_ID_CORRECTIONS = {
  // coracv combat row 2 col 0 says 'leglrpc' (a Legion LRPC) — should be 'corint' (Basilisk)
  'coracv': { 'leglrpc': 'corint' },
}

// Per-builder gridmenu slot injections applied before Pass 1.
// Use to fill empty or missing slots that the Lua gridmenu omitted by mistake.
// { builderId: [ { catIdx, rowIdx, colIdx, unitId } ] }
// catIdx: 0=economy 1=combat 2=utility 3=build
// rowIdx / colIdx: 0-based within the catArrays row structure
const BUILDER_GRIDMENU_INJECT = {
  // ARM equivalent (armcsa/armbeaver) has armfrt at combat row 1 col 3 (key F, page 0).
  // The COR counterparts have only 3 units in that row — corfrt is missing from the Lua
  // but is confirmed buildable and accessible at key F in-game.
  'corch':      [{ catIdx: 1, rowIdx: 1, colIdx: 3, unitId: 'corfrt' }],
  'corcsa':     [{ catIdx: 1, rowIdx: 1, colIdx: 3, unitId: 'corfrt' }],
  'cormuskrat': [{ catIdx: 1, rowIdx: 1, colIdx: 3, unitId: 'corfrt' }],
}

// Units whose category cannot be inferred from the base gridmenu (not in any base unitGrids entry)
// but which ARE in builders' buildoptions and need to be placed on overflow pages.
const UNIT_CATEGORY_OVERRIDE = {
  'armuwgeo': 'economy', 'coruwgeo': 'economy', 'leguwgeo': 'economy',
}

// Units that are present in build menus but should never appear as training questions.
// These are extremely rare or situational structures that players never need to recall.
const TRAINING_EXCLUDED_IDS = new Set([
  'armuwgeo',  'coruwgeo',  'leguwgeo',      // T1 underwater geothermal power
  'armuwageo', 'coruwageo', 'leganavaladvgeo', // T2 underwater geothermal power
])

function unitEntry(rawId, page, key, unitDefs, unitNames, unitDescs, builderCorrections = {}) {
  const unitId = builderCorrections[rawId] ?? UNIT_ID_CORRECTIONS[rawId] ?? rawId
  if (EXCLUDED_PRODUCT_IDS.has(unitId)) return null
  const def    = unitDefs[unitId]
  if (!def) return null
  // When the game uses a different file for the icon (buildpic ≠ unitId), store
  // the buildpic ID so the icon fetcher knows which file to download.
  const iconBase = (def.buildpic && def.buildpic !== unitId) ? def.buildpic : unitId
  const entry = {
    id:          unitId,
    name:        UNIT_NAME_OVERRIDES[unitId] ?? unitNames[unitId] ?? def.name ?? unitId,
    description: unitDescs?.[unitId] ?? '',
    metalCost:   def.metalcost,
    energyCost:  def.energycost,
    buildTime:   def.buildtime,
    icon:        `icons/${iconBase}.webp`,
    key,
    page,
  }
  if (TRAINING_EXCLUDED_IDS.has(unitId)) entry.trainingExcluded = true
  return entry
}

/**
 * Build a lookup map { unitId → categoryId } from all unitGrids entries.
 * Used to auto-classify overflow units (in buildoptions but not in gridmenu).
 */
function buildUnitCategoryLookup(unitGrids) {
  const lookup = {}
  for (const catArrays of Object.values(unitGrids)) {
    for (let ci = 0; ci < catArrays.length && ci < CATEGORIES.length; ci++) {
      const catId = CATEGORIES[ci].id
      const rows  = catArrays[ci]
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        if (!Array.isArray(row)) continue
        for (const rawId of row) {
          if (!rawId) continue
          const id = UNIT_ID_CORRECTIONS[rawId] ?? rawId
          if (!lookup[id]) lookup[id] = catId
        }
      }
    }
  }
  return lookup
}

/**
 * Build categories object for a constructor/commander from its unitGrids entry.
 * catArrays[catIdx] is an array of rows; every 3 rows = one page.
 *
 * buildopts  — array of unit IDs from the builder's buildoptions (used to:
 *   a) filter out gridmenu phantom items not actually buildable, and
 *   b) add overflow items in buildoptions that have no gridmenu position.
 * unitCatLookup — { unitId → catId } used to classify overflow items.
 */
function categoriesFromConstructor(catArrays, unitDefs, unitNames, buildopts, unitCatLookup, unitDescs, builderId) {
  const builderCorrections = BUILDER_UNIT_ID_CORRECTIONS[builderId] ?? {}

  // Apply builder-specific gridmenu injections (fill slots the Lua left empty or wrong)
  const injects = BUILDER_GRIDMENU_INJECT[builderId] ?? []
  if (injects.length) {
    // Deep-clone the affected rows so we don't mutate the shared parsed Lua data
    catArrays = catArrays.map(cat => cat.map(row => [...row]))
    for (const { catIdx, rowIdx, colIdx, unitId } of injects) {
      if (!catArrays[catIdx]) continue
      while (catArrays[catIdx].length <= rowIdx) catArrays[catIdx].push([])
      const row = catArrays[catIdx][rowIdx]
      while (row.length <= colIdx) row.push('')
      row[colIdx] = unitId
    }
  }

  // Build a normalised set of buildable IDs for fast lookup (empty = no filter)
  const boSet = buildopts?.length
    ? new Set(buildopts.map(id => builderCorrections[id] ?? UNIT_ID_CORRECTIONS[id] ?? id))
    : null

  const result  = {}
  const placed  = new Set()  // tracks all unit IDs already assigned a slot

  // ── Pass 1: gridmenu-defined positions ─────────────────────────────────────
  for (let ci = 0; ci < catArrays.length && ci < CATEGORIES.length; ci++) {
    const { id: catId, label, key: catKey } = CATEGORIES[ci]
    const rows  = catArrays[ci]
    const units = []
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri]
      if (!Array.isArray(row)) continue
      const page    = Math.floor(ri / ROWS_PER_PAGE)
      const rowKeys = ROW_KEYS[ri % ROWS_PER_PAGE]
      for (let ci2 = 0; ci2 < row.length && ci2 < 4; ci2++) {
        const rawId = row[ci2]
        if (!rawId) continue
        const id = builderCorrections[rawId] ?? UNIT_ID_CORRECTIONS[rawId] ?? rawId
        // Skip items in gridmenu but absent from buildoptions (phantom/stale entries)
        if (boSet && !boSet.has(id)) continue
        const entry = unitEntry(rawId, page, rowKeys[ci2], unitDefs, unitNames, unitDescs, builderCorrections)
        if (entry) { units.push(entry); placed.add(entry.id) }
      }
    }
    if (units.length) result[catId] = { label, key: catKey, units }
  }

  // ── Pass 2: overflow — buildopts items with no gridmenu position ────────────
  if (boSet) {
    // Group unplaced items by target category
    const overflow = {}
    for (const rawBo of buildopts) {
      const id = UNIT_ID_CORRECTIONS[rawBo] ?? rawBo
      if (placed.has(id) || EXCLUDED_PRODUCT_IDS.has(id) || NEVER_OVERFLOW_IDS.has(id)) continue
      const catId = unitCatLookup?.[id] ?? UNIT_CATEGORY_OVERRIDE[id]
      if (!catId) continue  // can't classify → skip
      ;(overflow[catId] ??= []).push(rawBo)
    }

    // Append overflow items to each category at the next available row/page
    for (const [catId, rawIds] of Object.entries(overflow)) {
      const catMeta  = CATEGORIES.find(c => c.id === catId)
      if (!catMeta) continue
      const existing = result[catId]?.units ?? []
      // Number of rows already used for this category (from gridmenu)
      const ciIdx    = CATEGORIES.findIndex(c => c.id === catId)
      const usedRows = catArrays[ciIdx]?.length ?? 0
      let nextRi     = usedRows  // start at the first unused row index

      const newUnits = []
      let boIdx = 0
      while (boIdx < rawIds.length) {
        const page    = Math.floor(nextRi / ROWS_PER_PAGE)
        const rowKeys = ROW_KEYS[nextRi % ROWS_PER_PAGE]
        for (let col = 0; col < 4 && boIdx < rawIds.length; col++, boIdx++) {
          const entry = unitEntry(rawIds[boIdx], page, rowKeys[col], unitDefs, unitNames, unitDescs)
          if (entry) { newUnits.push(entry); placed.add(entry.id) }
        }
        nextRi++
      }

      if (newUnits.length) {
        if (!result[catId]) result[catId] = { label: catMeta.label, key: catMeta.key, units: [] }
        result[catId].units.push(...newUnits)
      }
    }
  }

  return result
}

/**
 * Build categories object for a factory from its labGrids flat array.
 * Factories have no category tabs in-game — all units go under 'build'.
 *
 * buildopts — array of unit IDs from the factory's buildoptions (used to
 *   filter phantom gridmenu items and add missing producible units).
 */
function categoriesFromFactory(flatArray, unitDefs, unitNames, buildopts, unitDescs) {
  const boSet = buildopts?.length
    ? new Set(buildopts.map(id => UNIT_ID_CORRECTIONS[id] ?? id))
    : null

  const units    = []
  const placed   = new Set()
  // All slot indices mentioned in gridmenu (including empties) are "claimed"
  // so that overflow units don't collide with gridmenu layout holes.
  const usedSlots = new Set(
    flatArray.map((_, i) => flatArray[i] ? i : -1).filter(i => i >= 0)
  )

  // ── Pass 1: gridmenu-defined positions ─────────────────────────────────────
  for (let i = 0; i < flatArray.length; i++) {
    const rawId = flatArray[i]
    if (!rawId) continue
    const id = UNIT_ID_CORRECTIONS[rawId] ?? rawId
    if (boSet && !boSet.has(id)) continue  // not buildable → skip
    const page  = Math.floor(i / LAB_FILL_KEYS.length)
    const slot  = i % LAB_FILL_KEYS.length
    const entry = unitEntry(rawId, page, LAB_FILL_KEYS[slot], unitDefs, unitNames, unitDescs)
    if (entry) { units.push(entry); placed.add(entry.id) }
  }

  // ── Pass 2: overflow — buildopts items absent from gridmenu ────────────────
  if (boSet) {
    let nextSlot = flatArray.length  // start after last gridmenu slot
    for (const rawBo of buildopts) {
      const id = UNIT_ID_CORRECTIONS[rawBo] ?? rawBo
      if (placed.has(id) || EXCLUDED_PRODUCT_IDS.has(id) || NEVER_OVERFLOW_IDS.has(id)) continue
      // Advance past any gridmenu-claimed slots
      while (usedSlots.has(nextSlot)) nextSlot++
      const page  = Math.floor(nextSlot / LAB_FILL_KEYS.length)
      const slot  = nextSlot % LAB_FILL_KEYS.length
      const entry = unitEntry(rawBo, page, LAB_FILL_KEYS[slot], unitDefs, unitNames, unitDescs)
      if (entry) { units.push(entry); placed.add(entry.id) }
      nextSlot++
    }
  }

  if (!units.length) return {}
  return { build: { label: 'Build', key: 'V', units } }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function localRead(url) {
  if (url.startsWith(RAW + '/')) {
    const localPath = join(BAR_DATA, url.slice(RAW.length + 1))
    if (existsSync(localPath)) return readFileSync(localPath, 'utf8')
  }
  return null
}

// Save text to bar-data/ so subsequent runs skip the download entirely.
function cacheWrite(url, text) {
  if (!url.startsWith(RAW + '/')) return
  const localPath = join(BAR_DATA, url.slice(RAW.length + 1))
  mkdirSync(dirname(localPath), { recursive: true })
  writeFileSync(localPath, text, 'utf8')
}

async function getText(url) {
  const cached = localRead(url)
  if (cached !== null) return cached
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  const text = await res.text()
  cacheWrite(url, text)
  return text
}

async function getJson(url) {
  const cached = localRead(url)
  if (cached !== null) return JSON.parse(cached)
  const res = await fetch(url, { headers: HEADERS })
  if (res.status === 403 || res.status === 429) {
    const body = await res.json().catch(() => ({}))
    const msg  = body.message ?? `HTTP ${res.status}`
    if (msg.includes('rate limit')) {
      throw new Error(
        `GitHub API rate limit exceeded.\n` +
        `  → Set GITHUB_TOKEN=<your_token> to raise the limit to 5000 req/hr.\n` +
        `  → Create a token at: https://github.com/settings/tokens\n` +
        `    (Classic token, no scopes needed for public repos)`
      )
    }
    throw new Error(`HTTP ${res.status}: ${msg}`)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  const json = await res.json()
  cacheWrite(url, JSON.stringify(json))
  return json
}

// Run promises in batches to avoid hammering GitHub
async function batch(items, size, fn) {
  const results = []
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size)
    results.push(...await Promise.all(chunk.map(fn)))
  }
  return results
}

// ─── Lua parsing ──────────────────────────────────────────────────────────────

function parseOrderTable(lua) {
  const map = {}
  for (const m of lua.matchAll(/\['(\w+)'\]\s*=\s*(\d+)/g))
    map[m[1].toLowerCase()] = parseInt(m[2])
  return map
}

function parseUnitDef(lua, unitId) {
  // Unit display name lives at the top level of the unit table (before weapondefs).
  // We extract only the portion before the first weapondefs/sfxtypes block to avoid
  // accidentally picking up weapon names like "Light close-quarters laser".
  const topLevel = lua.replace(/weapondefs\s*=\s*\{[\s\S]*/i, '')
                      .replace(/sfxtypes\s*=\s*\{[\s\S]*/i, '')
  const name     = topLevel.match(/\bname\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? unitId
  // buildpic tells the game which unitpics/ file to use — may differ from unitId
  const buildpic = topLevel.match(/\bbuildpic\s*=\s*['"]([^'"]+)['"]/i)?.[1]
                      ?.replace(/\.dds$/i, '')   // strip extension
                      .toLowerCase() ?? null

  // Resource costs — unit defs use either metalcost/energycost or buildcostmetal/buildcostenergy
  const metalcost  = parseInt(
    lua.match(/\bmetalcost\s*=\s*(\d+)/)?.[1] ??
    lua.match(/\bbuildcostmetal\s*=\s*(\d+)/)?.[1] ?? '0')
  const energycost = parseInt(
    lua.match(/\benergycost\s*=\s*(\d+)/)?.[1] ??
    lua.match(/\bbuildcostenergy\s*=\s*(\d+)/)?.[1] ?? '0')
  const buildtime  = parseInt(lua.match(/\bbuildtime\s*=\s*(\d+)/)?.[1]  ?? '0')

  // buildoptions supports both:
  //   { 'armck', 'armcv' }          (plain list)
  //   { [1]="armck", [2]="armcv" }  (indexed)
  const boBlock      = lua.match(/buildoptions\s*=\s*\{([^}]+)\}/s)?.[1] ?? ''
  const buildoptions = [...boBlock.matchAll(/["'](\w+)['"]/g)]
    .map(m => m[1].toLowerCase())
    .filter(id => !id.match(/^\d+$/))  // drop any accidental numeric matches

  // Category classification from customparams.unitgroup
  const unitgroup   = lua.match(/unitgroup\s*=\s*['"]([^'"]+)['"]/i)?.[1]?.toLowerCase()
  const isCommander = /iscommander\s*=\s*true/i.test(lua)

  // Tech level from customparams.techlevel (1/2/3) — falls back to name-based heuristic
  const techlevelRaw = lua.match(/\btechlevel\s*=\s*(\d)/i)?.[1]
  const tier = techlevelRaw ? parseInt(techlevelRaw)
             : unitgroup === 'buildert2' ? 2
             : unitgroup === 'buildert3' ? 3
             : isCommander               ? 0
             : 1  // default T1

  const faction = unitId.startsWith('arm') ? 'armada'
                : unitId.startsWith('cor') ? 'cortex'
                : unitId.startsWith('leg') ? 'legion'
                : 'unknown'

  return { unitId, name, buildpic, metalcost, energycost, buildtime, buildoptions, unitgroup, isCommander, tier, faction }
}

// ─── GitHub directory traversal ───────────────────────────────────────────────

// Returns [{name, path}] for all unit .lua files.
// On first run: walks the GitHub API and saves bar-data/units-index.json.
// On subsequent runs: reads the index from disk — zero API calls needed.
async function collectUnitFiles() {
  const indexPath = join(BAR_DATA, 'units-index.json')
  if (existsSync(indexPath)) {
    const index = JSON.parse(readFileSync(indexPath, 'utf8'))
    return Object.values(index).map(path => ({
      name: path.replace(/^.*\//, ''),
      path,
      type: 'file',
    }))
  }

  // Walk the GitHub API (up to 3 levels deep)
  async function walk(path, depth) {
    const files = []
    let entries
    try {
      entries = await getJson(`${API}/contents/${path}`)
    } catch (e) {
      if (e.message.includes('rate limit')) throw e
      return files
    }
    for (const entry of entries) {
      if (entry.type === 'file' && entry.name.endsWith('.lua')) {
        files.push(entry)
      } else if (entry.type === 'dir' && depth < 2) {
        files.push(...await walk(entry.path, depth + 1))
      }
    }
    return files
  }
  const files = await walk('units', 0)

  // Save index so the next run is fully offline for unit files
  mkdirSync(BAR_DATA, { recursive: true })
  const index = {}
  for (const f of files) {
    const unitId = f.name.replace(/\.lua$/i, '').toLowerCase()
    index[unitId] = f.path
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2))
  console.log(`  Saved bar-data/units-index.json (${files.length} entries)`)

  return files
}

// ─── Icon conversion ──────────────────────────────────────────────────────────

function findMagick() {
  for (const cmd of ['magick', 'convert']) {
    try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return cmd } catch {}
  }
  return null
}

async function convertIcons(unitIds, buildpicMap = {}) {
  const magick = findMagick()
  if (!magick) {
    console.warn('ImageMagick not found — skipping icon conversion.')
    console.warn('Install with: brew install imagemagick')
    return
  }

  const iconDir = join(__dirname, 'data', 'icons')
  let done = 0, skipped = 0
  // Each entry: { id, reason }
  const failed = []

  for (const unitId of unitIds) {
    const outPath = join(iconDir, `${unitId}.webp`)
    if (existsSync(outPath)) { skipped++; continue }

    const urlLower = `${RAW}/unitpics/${unitId}.dds`
    const urlUpper = `${RAW}/unitpics/${unitId.toUpperCase()}.dds`
    const tmpPath  = join(iconDir, `_tmp_${unitId}.dds`)
    let tmpWritten = false

    try {
      // Try lowercase first; fall back to ALL-CAPS; then to the buildpic name if set
      let res = await fetch(urlLower, { headers: HEADERS })
      if (!res.ok && res.status === 404) res = await fetch(urlUpper, { headers: HEADERS })
      if (!res.ok && res.status === 404 && buildpicMap[unitId]) {
        const bp = buildpicMap[unitId]
        res = await fetch(`${RAW}/unitpics/${bp}.dds`, { headers: HEADERS })
        if (!res.ok) res = await fetch(`${RAW}/unitpics/${bp.toUpperCase()}.dds`, { headers: HEADERS })
      }
      if (!res.ok) {
        failed.push({ id: unitId, reason: `HTTP ${res.status} — ${urlLower}` })
        continue
      }

      writeFileSync(tmpPath, Buffer.from(await res.arrayBuffer()))
      tmpWritten = true

      // Convert to WebP at native resolution (source DDS files are 256×256).
      // Quality 90 gives a good sharpness/filesize balance (~7–10 KB per icon).
      const resizeArgs = [tmpPath, '-quality', '90', outPath]
      if (magick === 'magick') {
        execFileSync('magick', resizeArgs, { stdio: 'pipe' })
      } else {
        execFileSync('convert', resizeArgs, { stdio: 'pipe' })
      }

      unlinkSync(tmpPath)
      done++
    } catch (err) {
      if (tmpWritten && existsSync(tmpPath)) { try { unlinkSync(tmpPath) } catch {} }
      failed.push({ id: unitId, reason: err.message ?? String(err) })
    }

    if ((done + failed.length) % 20 === 0)
      process.stdout.write(`\r  Icons: ${done} converted, ${failed.length} failed …`)
  }

  console.log(`\r  Icons: ${done} converted, ${skipped} cached, ${failed.length} failed  `)
  if (failed.length > 0) {
    console.log(`  Failed icons (${failed.length}):`)
    failed.forEach(({ id, reason }) => console.log(`    ${id}: ${reason}`))
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const skipIcons   = process.argv.includes('--skip-icons')
  const freshIcons  = process.argv.includes('--fresh-icons')
  const iconsOnly   = process.argv.includes('--icons-only')
  mkdirSync(join(__dirname, 'data', 'icons'), { recursive: true })

  // --icons-only: skip data pipeline, just retry missing icons from existing JSON
  if (iconsOnly) {
    const jsonPath = join(__dirname, 'data', 'buildmenus.json')
    if (!existsSync(jsonPath)) {
      console.error('data/buildmenus.json not found — run without --icons-only first.')
      process.exit(1)
    }
    const { readFileSync } = await import('node:fs')
    const data = JSON.parse(readFileSync(jsonPath, 'utf8'))
    const neededIds = new Set()
    const buildpicMap = {}
    for (const builder of Object.values(data.builders)) {
      neededIds.add(builder.id)
      const expectedBuilderIcon = `icons/${builder.id}.webp`
      if (builder.icon && builder.icon !== expectedBuilderIcon)
        buildpicMap[builder.id] = builder.icon.replace(/^icons\//, '').replace(/\.webp$/, '')
      for (const cat of Object.values(builder.categories))
        for (const unit of cat.units) {
          neededIds.add(unit.id)
          const expectedUnitIcon = `icons/${unit.id}.webp`
          if (unit.icon && unit.icon !== expectedUnitIcon)
            buildpicMap[unit.id] = unit.icon.replace(/^icons\//, '').replace(/\.webp$/, '')
        }
    }
    console.log(`Retrying missing icons from existing buildmenus.json (${neededIds.size} total) …`)
    await convertIcons([...neededIds], buildpicMap)
    console.log('Done.')
    return
  }

  if (freshIcons) {
    const { readdirSync, unlinkSync } = await import('node:fs')
    const iconDir = join(__dirname, 'data', 'icons')
    for (const f of readdirSync(iconDir)) {
      if (f.endsWith('.webp')) unlinkSync(join(iconDir, f))
    }
    console.log('Cleared existing icons (--fresh-icons)')
  }

  // 1. Unit display names from the English localisation file
  process.stdout.write('Fetching language/en/units.json … ')
  let unitNames = {}
  let unitDescs = {}
  try {
    const lang = await getJson(`${RAW}/language/en/units.json`)
    unitNames = lang?.units?.names        ?? {}
    unitDescs = lang?.units?.descriptions ?? {}
    console.log(`${Object.keys(unitNames).length} names, ${Object.keys(unitDescs).length} descriptions`)
  } catch {
    console.log('not found — will use unit IDs as names')
  }

  // 2. Grid menu layouts (authoritative source for slot positions)
  process.stdout.write('Fetching gridmenu_layouts.lua … ')
  const layoutLua = await getText(`${RAW}/luaui/configs/gridmenu_layouts.lua`)
  const { labGrids, unitGrids } = parseGridmenuLayouts(layoutLua)
  console.log(`${Object.keys(labGrids).length} factories, ${Object.keys(unitGrids).length} constructors`)

  // 3. Discover unit files
  process.stdout.write('Listing units/ via GitHub API … ')
  const unitFiles = await collectUnitFiles()
  console.log(`${unitFiles.length} .lua files`)

  // 4. Parse unit defs for metadata (name, costs, faction, tier)
  console.log('Parsing unit defs …')
  const unitDefs = {}
  let parseCount = 0

  await batch(unitFiles, 10, async (file) => {
    const unitId = file.name.replace(/\.lua$/i, '').toLowerCase()
    try {
      const lua = await getText(`${RAW}/${file.path}`)
      unitDefs[unitId] = parseUnitDef(lua, unitId)
      parseCount++
    } catch {
      // silently skip unreadable files
    }
    if (parseCount % 50 === 0)
      process.stdout.write(`\r  ${parseCount}/${unitFiles.length} …`)
  })
  console.log(`\r  ${parseCount} unit defs parsed`)

  // 4. Build output from gridmenu layouts
  // All builder IDs come from gridmenu_layouts.lua — it is the authoritative source
  const allBuilderIds = new Set([...Object.keys(labGrids), ...Object.keys(unitGrids)])

  // Build a unit→category lookup from all base unitGrids entries.
  // Used to classify buildoptions overflow items that have no gridmenu position.
  const unitCatLookup = buildUnitCategoryLookup(unitGrids)
  let excluded = 0

  const output = {
    version:     new Date().toISOString().split('T')[0],
    generatedAt: new Date().toISOString(),
    builders:    {},
  }

  for (const builderId of allBuilderIds) {
    if (EXCLUDED_BUILDER_IDS.has(builderId)) { excluded++; continue }
    const def = unitDefs[builderId]
    if (!def) { excluded++; continue }
    // Skip units with no localised name (scenario/campaign variants not in multiplayer)
    if (!unitNames[builderId]) { excluded++; continue }

    const buildopts = def.buildoptions?.length ? def.buildoptions : null
    const categories = labGrids[builderId]
      ? categoriesFromFactory(labGrids[builderId],      unitDefs, unitNames, buildopts, unitDescs)
      : categoriesFromConstructor(unitGrids[builderId], unitDefs, unitNames, buildopts, unitCatLookup, unitDescs, builderId)

    if (!Object.keys(categories).length) { excluded++; continue }

    const displayName    = unitNames[builderId] ?? def.name ?? builderId
    const isExperimental = displayName.toLowerCase().includes('experimental') || def.tier >= 3

    output.builders[builderId] = {
      id:           builderId,
      name:         displayName,
      faction:      def.faction,
      tier:         def.tier,
      isCommander:  def.isCommander,
      optional:     OPTIONAL_BUILDER_IDS.has(builderId),
      experimental: isExperimental,
      metalCost:    def.metalcost,
      energyCost:   def.energycost,
      icon:         `icons/${builderId}.webp`,
      categories,
    }
  }

  console.log(`${Object.keys(output.builders).length} builders from gridmenu (${excluded} excluded)`)

  // 5. Reachability filter + per-faction BFS
  //    Run a separate BFS from each faction's commander so we know exactly which
  //    factions can reach each builder.  This handles Legion sharing Cortex factories:
  //    cor* builders get factions:['cortex','legion'], leg* get factions:['legion'], etc.
  const FACTION_SEEDS = { armada: 'armcom', cortex: 'corcom', legion: 'legcom' }
  const byFaction = {}
  for (const [faction, seedId] of Object.entries(FACTION_SEEDS)) {
    const reachable = new Set()
    const q = [seedId]
    while (q.length) {
      const id = q.shift()
      if (reachable.has(id)) continue
      reachable.add(id)
      const b = output.builders[id]
      if (!b) continue
      for (const cat of Object.values(b.categories))
        for (const unit of cat.units)
          if (output.builders[unit.id]) q.push(unit.id)
    }
    byFaction[faction] = reachable
  }

  // Combined reachable set (union of all three factions)
  const reachable = new Set([...Object.values(byFaction)].flatMap(s => [...s]))

  const beforeCount = Object.keys(output.builders).length
  output.builders = Object.fromEntries(
    Object.entries(output.builders).filter(([id]) => reachable.has(id))
  )
  const afterCount = Object.keys(output.builders).length
  console.log(`Reachability filter: ${afterCount} builders kept, ${beforeCount - afterCount} unreachable removed`)

  // Annotate each builder with the list of factions that can reach it
  for (const [id, builder] of Object.entries(output.builders)) {
    builder.factions = Object.entries(byFaction)
      .filter(([, r]) => r.has(id))
      .map(([f]) => f)
  }

  // 6. Write JSON
  const jsonPath = join(__dirname, 'data', 'buildmenus.json')
  writeFileSync(jsonPath, JSON.stringify(output, null, 2))
  console.log(`Wrote data/buildmenus.json  (${afterCount} builders)`)

  // 7. Convert icons (only for units that survived the reachability filter)
  if (!skipIcons) {
    const neededIds = new Set()
    for (const b of Object.values(output.builders)) {
      neededIds.add(b.id)
      for (const cat of Object.values(b.categories))
        for (const unit of cat.units)
          neededIds.add(unit.id)
    }
    // Build a map of unitId → buildpic so icons with non-matching filenames still resolve
    const buildpicMap = {}
    for (const [id, def] of Object.entries(unitDefs)) {
      if (def.buildpic && def.buildpic !== id) buildpicMap[id] = def.buildpic
    }
    console.log(`Converting ${neededIds.size} icons …`)
    await convertIcons([...neededIds], buildpicMap)
  }

  console.log('Done.')
}

main().catch(e => { console.error(e.message); process.exit(1) })
