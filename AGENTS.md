# Notes for agents

## Debug hooks

Both are URL parameters and do nothing unless present, so normal play is untouched.

### `?queue=` — pin the training queue

```
http://localhost:3737/?queue=armcom:armsy,armcom:armlab,armcsa:armuwms
```

`builderId:unitId` pairs, separated by commas, or `sc:shortcutId` for a shortcut
question. The queue becomes exactly those entries, in that order, skipping the
difficulty/faction/tier filters, the shuffle, the spaced repetition sort and the usual
sprinkling of shortcuts between builds. Use it instead of waiting for a shuffled queue to
happen to serve up the case you want — that wastes minutes and often never hits.

```
http://localhost:3737/?queue=sc:attack-line,sc:fight-line
```

Handy pairs:

| Pair | Why it is interesting |
| --- | --- |
| `armcom:armsy` | Shipyard — its counterpart Bot Lab sits bottom-left, so the category key alone reaches it |
| `armcom:armlab` | Bot Lab — bottom-left itself |
| `armcsa:armuwms` | Naval Metal Storage — counterpart is on the *previous* page |
| `armcsa:armmex` | Metal Extractor — bottom-left of page 1, so `B` pages away from the pending build |
| `sc:attack-line` | Right-drag gesture — needs the context menu suppressed to finish at all |
| `sc:fight-line` | Left-drag line, the twin of the above; the pair is why the answer shows a mouse icon |
| `armcsa:armmstor` | Metal Storage — the land side of that pair |
| `armcom:armtl` | Harpoon — counterpart Sentry on another key, same page |

Look ids up in `data/buildmenus.json` (`builders` and `units`).

### `?mod=` — pin the constructor build modifier

```
http://localhost:3737/?queue=armcom:armsy&mod=shift-click
```

`click`, `shift-click` or `space-click`. Otherwise the modifier is drawn at random per
question, so a Shift+click bug takes a dozen reloads to hit. Constructors only —
factories carry their modifier on the grid key.

### `?nolayout` — pretend the Keyboard Map API is missing

Forces the fallback path Chrome never takes: the manual QWERTY/QWERTZ pick, and on a
touch device no prompt at all. Use it to check anything Safari or Firefox users see
without leaving Chrome.

### `?keylog` — raw keyboard events

Shows an overlay with the environment (platform, `IS_MAC`, layout detection) and every
keydown/keyup: `key`, `code`, modifier flags, `getModifierState`, and what our own
resolver made of it. Runs in the capture phase, so it sees events even where the app
calls `preventDefault()`.

Use it whenever a key "does not work". It settled the LibreWolf report in one go:
`privacy.resistFingerprinting` hides the Alt key from the page entirely — no keydown
when Alt is pressed alone, and `altKey` stripped from the combo.

## Commands

```bash
npm test                  # pure matching logic against the real data files
npm run bump              # cache-bust the assets whose files changed
npm run bump -- --all     # …or all of them regardless
npm run extract           # regenerate data/ from the BAR repo (downloads icons)
npm run extract:no-icons  # same, skipping icon conversion — much faster
```

Run `npm run bump` after editing `app.js`, `style.css` or `logic.js`. It bumps the `?v=`
on each in `index.html` and keeps the `logic.js?v=` inside `app.js`'s import in step,
which hand-editing kept getting wrong.

`npm test` covers `logic.js`: modifier matching, key ranges, the 60% keyboard preset and
every land/water pair of every builder. It runs in milliseconds and is the right place to
add a case. It does **not** cover the DOM — key resolution through `KeyLayout`, flashing,
pad state and the training flow all need the browser.

## Data files

`data/buildmenus.json` and `data/water-equivalents.json` are **generated**. Never edit
them by hand — change `extract-data.js` (or `fetch-bar-data.js`) and re-run, so the next
refresh does not silently undo the fix.

`data/shortcuts.json` is hand-maintained and may be edited directly.

Anything taken from the BAR repository has to arrive through the fetch/extract pipeline
rather than being copied into the code, so it can be refreshed when upstream changes.

## Things that bite

- **A toggle is one entry with `states`, not one entry per state.** The reference
  shows a single row listing each state next to the taps that reach it; `expandStates()`
  turns them into one trainable question each. Add a state, not a sibling shortcut.
  Repeated taps must land within `TAP_WINDOW_MS` (500 ms, measured in game) — a spelled
  out sequence like `Z` `Z` for Area MEX has no window and must keep none.
- **Which keys are tap-count and which are plain toggles** — all verified in game, do not
  re-derive from `grid_keys.txt` alone, it does not distinguish them:
  | Key | Behaviour |
  | --- | --- |
  | `L` | 1 = Fire at Will · 2 = Hold Fire · 3 = Return Fire |
  | `;` | 1 = Roam · 2 = Hold Position · 3 = Maneuver |
  | `T` | 1 = Repeat on · 2 = Repeat off |
  | `B` | 1 = On · 2 = Off — *not* a toggle |
  | `Ctrl+G` | 1 = Factory Guard on · 2 = off (Ctrl stays held) |
  | `Y` (Wait) | plain toggle, one press either way |
  | `K` (Cloak) | plain toggle |
  | `Alt+G` | plain toggle, queue mode ↔ quota mode |

- **Factory build modifiers changed in BAR.** `Ctrl` used to add twenty to the queue and
  `Ctrl+Shift` a hundred; both now *remove* — `Ctrl` takes one off, `Ctrl+Shift` five.
  Verified in game. There is no bulk-add beyond `Shift` (×5) any more.
- **Two widgets share the area commands; read both before rewriting a description.**
  `cmd_area_commands_filter.lua` ("Area Command Filter") acts *only* with Alt or Ctrl and
  filters by `unitDefID` / `featureDefID` — Alt means same type, Ctrl means same tech
  level. `unit_smart_area_reclaim.lua` ("Smart Area Reclaim") acts on *every* area reclaim
  with no modifier and picks metal or energy from the centre feature. Both ship enabled;
  the filter carries `layer = -1` so it runs first. Reading only the second one once led
  to "correcting" the Alt+drag reclaim text to metal/energy, which is the no-modifier
  behaviour — verified in game as unit id.
- **Ctrl on a set target means sticky, and the area filter can eat it.**
  `unit_target_on_the_move.lua` reads `cmdOptions.ctrl` as `ignoreStop` — "Target survives
  a Stop command" — for `SET_TARGET`, `SET_TARGET_NO_GROUND` and `SET_TARGET_RECTANGLE`
  alike, which is where `target-set-sticky` / `target-set-area-sticky` come from. But
  `cmd_area_commands_filter.lua` also claims `UNIT_SET_TARGET`, and it re-issues the
  filtered orders with only `shift` in `cmdOpts` — the Ctrl is dropped. It only fires on a
  4-param area command whose centre traces to a unit or feature, so `S` Ctrl+click and a
  Ctrl+drag centred on empty ground stay sticky, while a Ctrl+drag centred *on an enemy*
  loses the stickiness (and filters nothing either — `filterUnits` returns every unit in
  the area when Ctrl is held). Read from source, not yet confirmed in game.
- **Space is one binding with two behaviours, and Shift picks which.** `chat_and_ui_keys.txt`
  binds `Any+space` to `commandinsert prepend_between` — one line, so the trainer will
  never learn the split from the binding files. `cmd_commandinsert.lua` is where it lives:
  with Space alone it is `CMD.INSERT` at position 0, the order runs next
  (`queue-order-front`); with Space *and* Shift it walks the queue per unit and inserts at
  the slot with the smallest detour, `dist(prev→new) + dist(new→next) − dist(prev→next)`,
  appending instead when the end of the queue is the shorter walk (`queue-order-cheapest`).
  Read from source, not yet confirmed in game.
- **A `mouseAction` may stack modifier prefixes, but only the reference can train them.**
  `mouseActionMods()` is the one parser — `shift-space-click-right` wants both Shift and
  Space — and `formatMouseAction()` and `scGestureMatches()` go through it, so a stacked
  entry renders and ticks off on the reference pad. The training pad's `mouseup` still
  dispatches on exact action names (`'shift-click'`, `'ctrl-drag'`, …), so a *trainable*
  entry with two modifiers would reach no branch and silently do nothing. Keep such
  entries `displayOnly`, or generalise that chain first.
  `queue-order-cheapest` also cannot be ticked off on the reference pad, for an unrelated
  reason: `Shift+Space` is itself a complete shortcut (`show-build-queue`), so the key
  press flashes that one and pulls the view to Factory, and the right-click that follows
  is a bare gesture — `scFlash`'s `allowSwitch = false` deliberately refuses to yank the
  view back to Right-click, so nothing matches. Passing `gesture.mods.length > 0` as
  `allowSwitch` would fix it, at the cost of letting every modified keyless gesture change
  category. `select-box-idle` is now stuck the same way — Space completes `build-split`,
  which pulls the view to Builder before the drag lands — so that one line would free two
  entries. Note also that `select-box` itself has never been tickable: a plain unmodified
  left drag is deliberately left to the browser as text selection (`capturable()`), and
  the mouseup returns early for it.
- **A shortcut with no `level` is Commander-only, not level-less.** `buildShortcutQueue`
  skips the level check whole once the threshold is `Infinity`, which is exactly the
  Commander setting — so an entry without a `level`, or with one above 1, is drawn there
  and nowhere else. The reference badge therefore falls back to Commander on purpose; that
  fallback is the truth, not a guess. Blanking it once hid four genuinely trainable
  shortcuts (`select-all`, `select-waiting-units`, `select-idle-transports`, `gather-wait`),
  which now carry `level: 2` explicitly so the rule never has to be inferred again.
- **A Space tap on the reference screen ticks in place and never switches category.**
  BAR overloads Space harder than any other key — Build Split, Show Queue Presets, Show
  Build Queue, the preset numbers, Space+X — so a tap used to flash whichever of them
  sorted first and drag the view to that command's category, every time you reached for
  the modifier. The keydown handler still resolves the combo, but passes
  `allowSwitch = combo.key !== 'SPACE'` to `scFlash`: the row ticks off when it is already
  on screen, and nothing happens when it is not. `preventDefault` moved up into the Space
  branch so the page cannot scroll under the tap even when nothing matches. Space *held*
  is untouched — `Space+X`, `Space+<num>` and the preset rows resolve and may switch
  category like any other key, and the training screen has always treated Space this way.
- **Factory queue presets are `meta`, and `meta` is Space.** `num_keys.txt` binds
  `meta+<n>` to `factory_preset load <n>`, `meta+alt+<n>` to `factory_preset save <n>` and
  `any+sc_space` to `factory_preset_show`, so holding Space is what draws the ten preset
  boxes the numbers address. `cmd_factoryqmanager.lua` holds the rest: presets are kept
  per *factory type* and persist between matches, repeat state and quota mode travel with
  the queue, saving while the queue is empty deletes that preset, only a single selected
  factory counts, and `MousePress` loads a preset on left-click while right-click saving
  is explicitly disabled. Read from source, not yet confirmed in game.
- **60% boards have no factory presets at all, and the data model cannot say so.**
  `grid_keys_60pct.txt` opens with `unbindaction factory_preset` / `factory_preset_show`
  because Space+number is the F-row there. A `sixty` block can only *remap* a binding —
  `resolveBinding()` falls back to the normal key for anything it omits — so the preset
  entries are shown and drilled even with the 60% box ticked, which is wrong for those
  users. Needs a genuine "unbound on 60%" flag, honoured by both the question pool and the
  reference, before it can be fixed.
- **`Any+` means with *or without* modifiers, and it hides whole combos from the checker.**
  `bind any+sc_space factory_preset_show` binds Space, Shift+Space, Ctrl+Space and the
  rest, which is why `show-build-queue` on Shift+Space works in game — verified in game —
  even though no file spells that combo out. `check-bindings.js` used to drop the `any`
  and emit only the bare combo, so every trainer entry that adds a modifier to an `Any+`
  key was reported as "not found in the binding files"; it now tracks `anyModKeys` and
  treats those keys as bound on any combination. That false alarm once led to questioning
  a correct entry, so do not delete a shortcut on the strength of that list — check
  whether its key is bound with `Any+` first.
- **`grid_keys.txt` is the authority, not the in-game chart.** The keyboard images under
  `luaui/images/keybinds/` — the ones the visual reference shows — lag behind. Verified:
  they display `F9 Hide HP Bars`, which is in no binding file and does nothing in game,
  and their ALT page omits nine bindings that do exist (`Alt+Q`, the blueprint keys,
  `Alt+G`, …). Never add an entry on the strength of the picture; check
  `npm run check:bindings` and, where the binding file is silent, the game itself.
- **Keys are positions, not characters.** BAR binds the grid positionally, so matching
  goes through `event.code`; the printed label is only for display. `KeyLayout` uses
  `navigator.keyboard.getLayoutMap()` where available (Chromium, secure context) and
  falls back to the QWERTY/QWERTZ setting elsewhere.
- **The ` key moves.** It is `Backquote` on US and Windows German, but `IntlBackslash`
  on macOS ISO, where `Backquote` carries `<`. On AZERTY `Backquote` prints `²` and the
  circumflex is a separate dead key with no BAR binding.
- **Land/water counterparts share a build.** Either slot places the asked-for unit, the
  counterpart may sit on another page, and if it sits bottom-left the category key alone
  reaches it. `?queue=armcom:armsy` is the quickest way to see all three at once.
- **A grid key means a slot, not a unit.** It picks whatever is drawn there at that
  moment, so the visible page decides as much as the key does — `slotPicksUnit()` is the
  one rule for this. `B` pages the menu without touching the pending build, which is why
  on a Construction Seaplane `Y` `B` click still places the Metal Extractor while
  `Y` `B` `Y` moves the build to the Naval Metal Storage now occupying that same slot.
  Both verified in game.
- **Every mouse release is a click or a drag, never neither.** `DRAG_MIN_PX` is the only
  threshold. There used to be a second, lower one for clicks, and a gesture that landed
  between them was silently dropped — the question then simply ran out of time with no
  feedback at all. If a threshold is ever split again, make sure the gap is answered.
- **`logic.js` carries its own cache-busting query** in the import at the top of
  `app.js`, because a module import is cached separately from the file importing it.
  `npm run bump` keeps the two in step; do not edit either by hand.
- **Touch detection hides prompts, never wiring.** `isTouchOnly()` cannot tell whether a
  keyboard is attached — an iPad with a keyboard folio and no trackpad looks exactly like
  a bare phone. It skips the layout dialogue and hides the two "press a shortcut" hints,
  all of them pure text. Key checking stays live everywhere, so anyone who does have a
  keyboard and simply tries it still gets their checkmarks.
