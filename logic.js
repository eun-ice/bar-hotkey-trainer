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

/**
 * The keys that build a unit from one builder's menu, as canonical key names: the
 * category key (constructors only), `B` once per page, then the slot's grid key. A unit
 * bottom-left on a constructor's first page needs no grid key — the category key alone
 * lands on that slot.
 */
export function menuRouteKeys(categoryKey, page, key) {
  if (categoryKey && page === 0 && key === 'Z') return [categoryKey]
  const keys = categoryKey ? [categoryKey] : []
  for (let p = 0; p < page; p++) keys.push('B')
  keys.push(key)
  return keys
}

// How well `text` answers the query: lower is better, null is no match. The name is
// scored on its own so "Shipyard" ranks the Shipyard above everything that merely
// mentions one in a description.
function searchScore(tokens, name, extra) {
  const lowerName = name.toLowerCase()
  const haystack  = (lowerName + ' ' + extra).toLowerCase()
  if (!tokens.every(token => haystack.includes(token))) return null
  const phrase = tokens.join(' ')
  if (lowerName === phrase) return 0
  if (lowerName.startsWith(phrase)) return 1
  if (lowerName.split(/[\s\-–—/()]+/).some(word => word.startsWith(phrase))) return 2
  if (tokens.every(token => lowerName.includes(token))) return 3
  return 4
}

const byScore = (a, b) => a.score - b.score || a.name.localeCompare(b.name)

/** Every key a range like "0–9" or "F1–F4" stands for; a plain key is just itself. */
export function expandKeyRange(key) {
  const [start, end] = key.split('–')
  if (end === undefined) return [key]
  const fKeys = start.startsWith('F')
  const from  = parseInt(fKeys ? start.slice(1) : start, 10)
  const to    = parseInt(fKeys ? end.slice(1) : end, 10)
  return Array.from({ length: to - from + 1 }, (_, i) => (fKeys ? 'F' : '') + (from + i))
}

/**
 * The bind actions a shortcut row stands for, written the way uikeys.txt writes them. A
 * prefix row (`group set ` on 0–9) stands for each member, so `group set 3` finds it. An
 * F-key member is numbered without its F: F2 is `set_camera_anchor 2`.
 */
export function shortcutActions(sc) {
  const own = sc.actionPrefix
    ? expandKeyRange(sc.key ?? '').map(member => sc.actionPrefix + member.replace(/^F/, ''))
    : [sc.action]
  return [...own, ...(sc.states ?? []).map(state => state.action)].filter(Boolean)
}

/**
 * `gridmenu_key <row> <col>`, `gridmenu_category <n>` and the paging actions are what the
 * grid layout binds every menu key to. Row 1 is the bottom row, as BAR counts it — Any+X
 * is `gridmenu_key 1 2`. `gridKeys` is the grid top row first (Q W E R / A S D F / Z X C V).
 */
export function gridActionKey(action, gridKeys, categoryKeys) {
  const text = action.trim().toLowerCase().replace(/\s+/g, ' ')
  const slot = text.match(/^gridmenu_key ([1-3]) ([1-4])$/)
  if (slot) {
    const [row, col] = [Number(slot[1]), Number(slot[2])]
    return { key: gridKeys[(3 - row) * 4 + col - 1], row, col }
  }
  const category = text.match(/^gridmenu_category ([1-4])$/)
  if (category) {
    const [categoryId, key] = Object.entries(categoryKeys)[Number(category[1]) - 1] ?? []
    return key ? { key, categoryId } : null
  }
  if (text === 'gridmenu_next_page') return { key: 'B', page: 'next' }
  return null
}

/**
 * One query across both references: units (with every builder that builds them),
 * builders and shortcuts.
 *
 * `builders` is the list the menu reference shows, in the order it shows it — routes
 * come back in that order. `categoryKeys` maps a category id to its key; a factory
 * (`isFactory(builder)`) has no category key to press. A shortcut hit on one of a
 * toggle's states targets that state, so "hold fire" lands on the tap that does it.
 */
export function searchReference(query, { builders, units, groups, categoryKeys, isFactory,
                                         gridKeys = [], waterEquivalents = {}, limit = 30 }) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const empty  = { units: [], builders: [], shortcuts: [], grid: null }
  if (!tokens.length) return empty
  const grid = gridActionKey(query, gridKeys, categoryKeys)

  // Every builder's every slot, collected per unit
  const routes = new Map()
  for (const builder of builders) {
    const factory = isFactory(builder)
    for (const [categoryId, cat] of Object.entries(builder.categories)) {
      for (const slot of cat.units) {
        const page = slot.page ?? 0
        if (!routes.has(slot.id)) routes.set(slot.id, [])
        routes.get(slot.id).push({
          builderId: builder.id, categoryId, page, key: slot.key,
          keys: menuRouteKeys(factory ? null : categoryKeys[categoryId], page, slot.key),
        })
      }
    }
  }

  const unitHits = []
  for (const [unitId, unitRoutes] of routes) {
    const info  = units[unitId]
    if (!info?.name) continue
    // Units carry no faction of their own; the builders that make them do
    const faction = builders.find(builder => builder.id === unitRoutes[0].builderId)?.faction
    // buildunit_<id> is how the legacy layout binds a unit straight to a key
    const score = searchScore(tokens, info.name,
      `${info.description ?? ''} ${unitId} buildunit_${unitId} ${faction}`)
    if (score === null) continue
    unitHits.push({ id: unitId, name: info.name, faction, score, routes: unitRoutes,
                    counterpart: waterEquivalents[unitId] ?? null })
  }

  const builderHits = []
  for (const builder of builders) {
    const score = searchScore(tokens, builder.name, `${builder.id} ${builder.faction}`)
    if (score !== null) builderHits.push({ id: builder.id, name: builder.name, score,
                                           faction: builder.faction })
  }

  const shortcutHits = []
  for (const group of groups) {
    for (const sc of group.shortcuts) {
      if (sc.learnHidden) continue
      const actions = shortcutActions(sc)
      const extra = [sc.description, sc.id, group.name, ...actions,
                     ...(sc.states ?? []).map(state => state.label)]
        .filter(Boolean).join(' ')
      const score = searchScore(tokens, sc.label, extra)
      if (score === null) continue
      // A state that answers the query on its own is the better target than the row
      const state = sc.states?.find(st =>
        searchScore(tokens, st.label, st.action ?? '') !== null)
      // Found by its bind action: say which one, since the label may read nothing like it
      const action = actions.find(text => tokens.every(token => text.toLowerCase().includes(token)))
      const phrase = tokens.join(' ')
      const actionScore = !action ? Infinity
        : action.toLowerCase().replace(/\s+/g, ' ').trim() === phrase ? 0
        : action.toLowerCase().includes(phrase) ? 2 : Infinity
      shortcutHits.push({
        id: state?.id ?? sc.id, rowId: sc.id, groupId: group.id, groupName: group.name,
        name: sc.label, stateLabel: state?.label ?? null, action: action ?? null,
        score: Math.min(state ? Math.min(score, 1) : score, actionScore),
      })
    }
  }

  return {
    units:     unitHits.sort(byScore).slice(0, limit),
    builders:  builderHits.sort(byScore).slice(0, limit),
    shortcuts: shortcutHits.sort(byScore).slice(0, limit),
    grid:      grid && { ...grid, action: query.trim().replace(/\s+/g, ' ') },
  }
}
