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
npm run extract           # regenerate data/ from the BAR repo (downloads icons)
npm run extract:no-icons  # same, skipping icon conversion — much faster
```

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
  `app.js`. Bump it together with the `app.js?v=` in `index.html`, or a stale copy of the
  matching rules outlives the update.
