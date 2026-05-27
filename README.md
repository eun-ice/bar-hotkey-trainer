# BAR Hotkey Trainer

Hotkey training app for [Beyond All Reason](https://www.beyondallreason.info/).

[Try BAR Hotkey Trainer](https://bar-hotkey-trainer.vercel.app/).


### Requirements

- Node.js 18+
- ImageMagick (`brew install imagemagick`)
- Optional: GitHub personal access token to avoid the 60 req/hr API rate limit


## BAR LUA File download


fetch-bar-data.js fetches unit data (.lua) from the BAR GitHub repository and stores them in bar-data.

You should set your personal github token to avoid the API limit.

Run

```bash
GITHUB_TOKEN=xxxx node fetch-bar-data.js
```

or

```bash
GITHUB_TOKEN=xxxx node fetch-bar-data.js --refresh
```


## Creation of buildmenus and unit icons

extract-data.js uses downloaded files in bar-data and writes

- `data/buildmenus.json` — all builders with categorised build menus and grid hotkeys
- `data/icons/*.webp` — unit icons (converted from DDS with imagemagick)
- `data/sounds/*.wav` — Sound effects


```bash
node extract-data.js
```

or

```bash
node extract-data.js --icons-only
```

## Command shortcuts

The command shortcuts are in data/shortcuts.json

Add or remove as you like.

## Data format

`data/buildmenus.json` structure:

```jsonc
{
  "version": "2025-05-25",
  "builders": {
    "armcom": {
      "id": "armcom",
      "name": "Armada Commander",
      "faction": "armada",
      "isCommander": true,
      "categories": {
        "economy": {
          "label": "Economy",
          "key": "Z",          // Z = Y on QWERTZ keyboards
          "units": [
            {
              "id": "armsolar",
              "name": "Solar Collector",
              "metalCost": 170,
              "energyCost": 1700,
              "key": "Q",      // grid position key
              "page": 0        // 0-indexed page (B to advance)
            }
          ]
        }
      }
    }
  }
}
```

Grid key layout per category (page 0):

```
Q  W  E  R
A  S  D  F
Z  X  C  V   ← same keys as category tabs
```
