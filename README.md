# BAR Hotkey Trainer

Hotkey training app for [Beyond All Reason](https://www.beyondallreason.info/).

[Try BAR Hotkey Trainer](https://bar-hotkey-trainer.vercel.app/).

It teaches the **grid** keyboard layout. Three things live on the front page:

- **Practice** — a timed run of questions: "build this unit with this builder" (press the
  category key, page with `B`, press the grid key, click), plus game shortcuts in between.
  Three levels (Noob / Mid / Commander), filters for faction, builder kind and tier, a
  per-key time limit and reaction-time stats at the end.
- **Build Menu Reference** — every builder's build menu, category by category and page by
  page, with the keys of *your* layout printed on the slots.
- **Shortcut Reference** — every game shortcut grouped by context, with a visual reference
  (the in-game keyboard charts and command infographics). Each row can be ticked off by
  pressing it.

One search box on all three screens finds units, builders and shortcuts, and also answers
to the action names a player reads in their own `uikeys.txt` (`gridmenu_key 1 2`,
`buildunit_armmex`, `group set 3`, …).

Keys are matched by *position*, not by printed character. In Chromium browsers the layout
is read from the Keyboard Map API; elsewhere the app asks QWERTY or QWERTZ once. A 60% /
65% board option switches to BAR's 60% preset.

The app is plain HTML, CSS and JavaScript with no build step.


## Running it locally

Unit icons and the keyboard charts are not in the repository, so a fresh clone needs the
game data first. Needs Node.js 18+ and ImageMagick.

```bash
npm install
npm run fetch
npm run extract
npx serve -l 3737 .
```

Then open <http://localhost:3737/>. Any static file server works; the site is deployed to
Vercel from this directory as is. Details on the data steps are under [Game data](#game-data).

The URL parameters `?queue=`, `?mod=`, `?nolayout` and `?keylog` are debug hooks for
pinning the question queue, the build modifier, the layout fallback and raw keyboard
events. They are documented in [AGENTS.md](AGENTS.md), together with everything else a
contributor should know before touching the data or the key handling.


## Commands

```bash
npm test                  # matching logic in logic.js against the real data files
npm run bump              # cache-bust the assets whose files changed
npm run bump -- --all     # …or all of them regardless
npm run fetch             # download the BAR game files into bar-data/
npm run fetch:refresh     # …forcing a re-download
npm run extract           # regenerate data/ from bar-data/ (converts icons)
npm run extract:no-icons  # same, skipping icon conversion — much faster
npm run check:bindings    # compare data/shortcuts.json with BAR's own keybind files
```

Run `npm run bump` after editing `app.js`, `style.css` or `logic.js`. It bumps the `?v=`
query on each in `index.html` and keeps the `logic.js?v=` inside `app.js`'s import in step.

`npm test` runs in milliseconds and covers `logic.js`: modifier matching, key ranges, the
60% preset, the reference search, and every land/water pair of every builder. It does not
cover the DOM.


## Game data

Everything under `data/` that comes from the game arrives through a two-step pipeline, so
it can be refreshed when BAR changes. Nothing from the BAR repository is copied into the
code by hand.

### Requirements

- Node.js 18+
- ImageMagick (`brew install imagemagick`) — only for icon conversion
- Optional: a GitHub personal access token, to stay clear of the 60 requests/hour
  unauthenticated API limit

### 1. Download the BAR files

`fetch-bar-data.js` downloads the game files the extractor needs into `bar-data/`, which
mirrors the repo layout (`units/`, `language/en/`, `common/configs/`, `luaui/configs/`,
…). It also fetches the UI sound effects straight into `data/sounds/`.

```bash
GITHUB_TOKEN=xxxx npm run fetch          # only if bar-data/ is absent
GITHUB_TOKEN=xxxx npm run fetch:refresh  # force a re-download
```

If you already have a checkout of the game, skip the download and point at it. `BAR_REPO`
is honoured by every script, and a path that does not exist is an error rather than a
silent fall back to the cache:

```bash
BAR_REPO=~/Projects/bar/Beyond-All-Reason npm run extract
```

### 2. Extract

`extract-data.js` reads the files and writes:

- `data/buildmenus.json` — all builders with categorised build menus and grid keys, plus a
  unit table (name, description, costs, build time, icon)
- `data/water-equivalents.json` — land ↔ water counterpart pairs from the context-build
  widget; either slot places the asked-for unit
- `data/icons/*.webp` — unit icons, converted from DDS with ImageMagick
- `data/keybinds/*.webp` — the in-game keyboard charts shown in the visual reference
- `data/commands/*.webp` — one frame of each in-game command cursor

```bash
node extract-data.js                # full run
node extract-data.js --skip-icons   # everything but the unit icons
node extract-data.js --icons-only   # only retry missing icons, from the existing JSON
node extract-data.js --fresh-icons  # clear and reconvert every icon
```

After a refresh, compare the `Wrote data/water-equivalents.json (N pairs)` line with the
previous run. `npm test` fails loudly when the pairs are gone.

### Hand-maintained files

- `data/shortcuts.json` — the game shortcuts: groups, contexts, levels, toggle states,
  build modifiers. Edit it directly; `npm run check:bindings` reports every entry the game
  does not know or binds to a different key, and every binding the trainer does not list.
  Notes on the format and the verified in-game behaviours are in [AGENTS.md](AGENTS.md).
- `data/origins/*.webp` and `data/guides/*.webp` — photos of what an area drag starts on,
  and the official command infographics. Not regenerated by any script.

Never edit `data/buildmenus.json` or `data/water-equivalents.json` by hand; change the
extractor and re-run, or the next refresh undoes the fix.


## Data format

`data/buildmenus.json`, abridged:

```jsonc
{
  "version": "2026-10-02",
  "generatedAt": "2026-10-02T21:11:30.769Z",
  "builders": {
    "armcom": {
      "id": "armcom",
      "name": "Armada Commander",
      "faction": "armada",
      "factions": ["armada"],
      "tier": 0,
      "isCommander": true,
      "optional": false,         // minelayers: in the file, hidden unless asked for
      "experimental": false,     // T3 / experimental gantries
      "metalCost": 2700,
      "energyCost": 26000,
      "icon": "icons/armcom.webp",
      "categories": {
        "economy": {
          "label": "Economy",
          "key": "Z",            // category tab key — Y on QWERTZ, matched by position
          "units": [
            { "id": "armsolar", "key": "Q", "page": 0 }   // grid key; page 0-indexed, B advances
          ]
        }
      }
    }
  },
  "units": {
    "armsolar": {
      "name": "Solar Collector",
      "description": "Produces 20 Energy",
      "metalCost": 155,
      "energyCost": 0,
      "buildTime": 2600,
      "icon": "icons/armsolar.webp"
    }
  }
}
```

Grid key layout per category (page 0):

```
Q  W  E  R
A  S  D  F
Z  X  C  V   ← same keys as the category tabs
```

`data/water-equivalents.json` is a flat map, symmetric in both directions:

```json
{ "armmstor": "armuwms", "armuwms": "armmstor" }
```


## License

Trainer code is MIT. Unit icons are CC BY-NC-ND (IceXuick and Floris) and the build menu
layout data is GPL v2, both from the BAR repository. See [LICENSE.md](LICENSE.md).
