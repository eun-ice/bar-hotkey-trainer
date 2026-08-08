/**
 * Pure matching logic — no DOM, no app state.
 *
 * These are the rules that decide whether a keypress counts as the right answer. They
 * live apart from app.js so they can be exercised directly against data/*.json by
 * test.js, which is a great deal more reliable than waiting for a shuffled training
 * queue to happen to serve up the case you want to check.
 */

/**
 * Do the modifiers actually held satisfy the ones a shortcut wants?
 *
 * `optional` names modifiers that belong to the documented combo but are not required
 * to trigger it — Build Spacing is written Shift+Alt+Z because Shift is what makes the
 * build grid visible, yet the spacing changes with Alt+Z alone.
 */
export function modsSatisfy(held, want, optional = []) {
  const norm = list => [...list].map(m => m.toLowerCase()).sort().join('+')
  if (norm(held) === norm(want)) return true
  if (!optional.length) return false
  const lowerOptional = optional.map(m => m.toLowerCase())
  const required = want.filter(m => !lowerOptional.includes(m.toLowerCase()))
  // Every held modifier must be wanted, and every non-optional one must be held
  return norm(held) === norm(required)
}

/** Does `key` fall inside a range written like "0–9" or "F1–F4"? (en dash) */
export function scRangeIncludes(rangeKey, key) {
  const parts = rangeKey.split('–')
  if (parts.length !== 2) return false
  const [start, end] = parts
  if (!isNaN(start) && !isNaN(end)) {
    const n = parseInt(key, 10)
    return !isNaN(n) && n >= parseInt(start, 10) && n <= parseInt(end, 10)
  }
  if (start.startsWith('F') && end.startsWith('F')) {
    const n = parseInt(key.slice(1), 10)
    return key.startsWith('F') && !isNaN(n) && n >= parseInt(start.slice(1), 10) && n <= parseInt(end.slice(1), 10)
  }
  return false
}

/** Does a pressed combo `{key, mods}` match a shortcut's key + modifiers? */
export function scComboMatchesKey(combo, scKey, scMods, optionalMods = []) {
  if (!modsSatisfy(combo.mods, scMods, optionalMods)) return false
  return scKey.includes('–')
    ? scRangeIncludes(scKey, combo.key)
    : scKey.toUpperCase() === combo.key
}

/**
 * Which binding a shortcut has for this user. BAR ships a second hotkey preset for
 * 60%/65% boards (luaui/configs/hotkeys/grid_keys_60pct.txt) that moves everything off
 * the F-row and off the ` key; entries that differ carry a `sixty` block.
 */
export function resolveBinding(shortcut, compact60 = false) {
  const alt = compact60 ? shortcut.sixty : null
  return {
    key:               alt?.key ?? shortcut.key,
    keys:              alt ? null : shortcut.keys,
    modifiers:         alt?.modifiers ?? shortcut.modifiers ?? [],
    optionalModifiers: shortcut.optionalModifiers ?? [],
  }
}

/**
 * The grid key that also places `unitId`, because BAR swaps the pending build between a
 * land unit and its water counterpart as the cursor crosses the shoreline.
 *
 * `page` is the page currently on screen, NOT the page the asked-for unit sits on: the
 * counterpart may live on another page of the same category (Metal Storage on page 1,
 * Naval Metal Storage on page 2), and reaching it that way needs no page flip at all.
 * Returns the key, or null when there is no such route.
 */
export function equivalentKeyOnPage(waterEquivalents, builder, categoryId, unitId, page) {
  const equivId = waterEquivalents[unitId]
  if (!equivId) return null
  const cat = builder?.categories?.[categoryId]
  if (!cat) return null
  const equivUnit = cat.units.find(u => u.id === equivId && u.page === page)
  return equivUnit ? equivUnit.key : null
}

/** The unit drawn in one slot of a category page, or null when that slot is empty. */
export function unitAtSlot(builder, categoryId, page, key) {
  const cat = builder?.categories?.[categoryId]
  if (!cat) return null
  return cat.units.find(unit => (unit.page ?? 0) === page && unit.key === key) ?? null
}

/**
 * Would pressing `key` while `page` is on screen leave the asked-for unit pending?
 *
 * A grid key picks whatever is drawn under it at that moment, so the page decides as much
 * as the key does — Z is the Metal Extractor on the first page of the Construction
 * Seaplane's economy tab and the Naval Metal Storage on the second. Water counterparts
 * still count, since either slot places the same building depending on the ground.
 */
export function slotPicksUnit(waterEquivalents, builder, categoryId, page, key, unitId) {
  const picked = unitAtSlot(builder, categoryId, page, key)
  if (!picked) return false
  return picked.id === unitId || waterEquivalents[unitId] === picked.id
}
