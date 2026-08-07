// ─── Constants ────────────────────────────────────────────────────────────────

const IS_FIREFOX = navigator.userAgent.includes('Firefox')
const IS_MAC     = navigator.platform.startsWith('Mac') || /Mac/.test(navigator.userAgent)

const CATEGORIES = [
  { id: 'economy', label: 'Economy', key: 'Z' },
  { id: 'combat',  label: 'Combat',  key: 'X' },
  { id: 'utility', label: 'Utility', key: 'C' },
  { id: 'build',   label: 'Build',   key: 'V' },
]

const GRID_KEYS = ['Q','W','E','R','A','S','D','F','Z','X','C','V']

// ─── Keyboard layout ──────────────────────────────────────────────────────────
//
// BAR binds the grid by POSITION, so a shortcut means "the key sitting here", not
// "the key printed with this letter". Internally a key keeps its US label ('Q', '1',
// '`') — on a US board label and position coincide, which makes it a convenient name
// for the position. Everything layout-specific lives in KeyLayout:
//
//   getKeyPressed(event) — physical key → canonical name   (matching)
//   getDisplayKey(name)  — canonical name → printed label  (what we show on a keycap)
//
// navigator.keyboard.getLayoutMap() reports the real labels of the user's layout, so
// AZERTY, UK, Danish, Dutch and the rest work with no tables of ours. It is Chromium-
// only and needs a secure context (https or localhost); elsewhere we fall back to the
// QWERTY/QWERTZ setting, which is what the app did everywhere before.

const CANON_TO_CODE = {
  ...Object.fromEntries([...'QWERTYUIOPASDFGHJKLZXCVBNM'].map(c => [c, 'Key' + c])),
  ...Object.fromEntries([...'0123456789'].map(d => [d, 'Digit' + d])),
  '`': 'Backquote',    '-': 'Minus',        '=': 'Equal',
  '[': 'BracketLeft',  ']': 'BracketRight', '\\': 'Backslash',
  ';': 'Semicolon',    "'": 'Quote',
  ',': 'Comma',        '.': 'Period',       '/': 'Slash',
}

const KeyLayout = {
  map:     null,                    // code → printed label, from getLayoutMap()
  toCode:  { ...CANON_TO_CODE },    // canonical → the code carrying it on THIS machine
  toCanon: null,                    // inverse of toCode

  async init() {
    try {
      if (!window.isSecureContext || !navigator.keyboard?.getLayoutMap) return
      this.map = await navigator.keyboard.getLayoutMap()
    } catch { this.map = null; return }
    // The key BAR calls ` is whichever key is printed ` or ^, and its position is NOT
    // stable: Backquote on US and Windows German, but IntlBackslash on macOS ISO, where
    // Backquote carries '<'. Locate it by label instead of guessing from the OS.
    for (const [code, label] of this.map) {
      if (label === '`' || label === '^') { this.toCode['`'] = code; break }
    }
    this.toCanon = Object.fromEntries(Object.entries(this.toCode).map(([c, k]) => [k, c]))
  },

  /** True once the browser has told us the real layout — no manual pick needed then. */
  get detected() { return this.map !== null },

  /** Best-effort QWERTY/QWERTZ guess, only to keep settings.keyboard meaningful. */
  guessLayout() {
    return this.map?.get('KeyZ') === 'y' ? 'qwertz' : 'qwerty'
  },

  /** The keys we care about as this user sees them, for confirming the detection.
   *  Leads with the number row because the ` key that unsets groups lives there and
   *  is the one that moves around most between layouts. */
  gridLabels() {
    const rows = [['`','1','2','3'], ['Q','W','E','R'], ['A','S','D','F'], ['Z','X','C','V']]
    return rows.map(r => r.map(k => this.getDisplayKey(k)).join(' ')).join('  /  ')
  },

  /** KeyboardEvent (or {key, code}) → canonical key name used throughout the app. */
  getKeyPressed(event, isQwertz) {
    const key  = event.key ?? ''
    const code = event.code
    if (key === ' ') return 'SPACE'
    // Named keys (Tab, Enter, F1 …) carry no printed label and are the same on every
    // layout. Upper-cased to match what the pre-KeyLayout normalise() returned.
    if (key.length > 1 && key !== 'Dead') return key.toUpperCase()
    if (this.toCanon && code && this.toCanon[code]) return this.toCanon[code]
    return normaliseByLabel(key, isQwertz, code)
  },

  /** Canonical key name → what is actually printed on that key for this user. */
  getDisplayKey(name, isQwertz) {
    if (this.map) {
      const label = this.map.get(this.toCode[name])
      if (label) return label.length === 1 ? label.toUpperCase() : label
      return name          // ranges like "0–9", F-keys, Tab … have no printed label
    }
    return displayByLayout(name, isQwertz)
  },
}

// Fallback for browsers without the Keyboard Map API: guess from the QWERTY/QWERTZ
// setting and the character the browser reported. This is the pre-getLayoutMap path.
function normaliseByLabel(key, isQwertz, code) {
  const k = key.toUpperCase()
  if (isQwertz && k === 'Y') return 'Z'
  if (isQwertz && k === 'Z') return 'Y'
  if (isQwertz && k === 'Ö') return ';'  // physical ;/Ö key position → ; shortcut
  if (isQwertz && k === '+') return ']'  // physical ] key position → ] shortcut
  if (isQwertz && k === 'Ü') return '['  // physical [ key position on QWERTZ is labeled ü
  // BAR's ` key is whichever key is printed ` or ^. Neither the character nor the
  // position is stable: browsers report 'Dead', '^', 'ˆ', '°' or '`', and the position
  // moves too — Backquote on US and Windows German, but IntlBackslash on macOS German,
  // where Backquote carries '<' instead. Match on the label and only fall back to the
  // position for dead keys, which report no label at all.
  if (k === '`' || k === '^' || k === 'ˆ' || k === '°') return '`'
  if (k === 'DEAD' && (code === 'Backquote' || code === 'IntlBackslash')) return '`'
  if (k === ' ') return 'SPACE'
  // A number-row key always means its digit, whatever Shift/Alt turned it into:
  // Shift+1 is '!' on US and Shift+3 is '§' on German, but both are still the group key.
  // The digit-row position is identical on QWERTY and QWERTZ, so code is safe here.
  if (code && code.startsWith('Digit')) return code.slice(5)  // 'Digit1' → '1'
  // On macOS, Alt/Option composes non-ASCII characters (e.g. Alt+B → '∫', Alt++ → '±').
  // When event.key lands outside ASCII, fall back to event.code (the physical scan-code)
  // which is always the unmodified key name regardless of held modifiers or OS.
  if (code && k.charCodeAt(0) > 127) {
    if (code.startsWith('Key')) {
      const letter = code.slice(3)  // 'KeyB' → 'B'
      if (isQwertz && letter === 'Y') return 'Z'
      if (isQwertz && letter === 'Z') return 'Y'
      return letter
    }
    if (code === 'BracketLeft')  return '['
    if (code === 'BracketRight') return ']'
    if (code === 'Semicolon')    return ';'
  }
  return k
}

function keysMatch(pressed, expected) {
  return pressed === expected
}

function isEquivGridKey(key) {
  if (!currentEntry || currentEntry.type === 'shortcut') return false
  const equivId = WATER_EQUIVALENTS[currentEntry.unit.id]
  if (!equivId) return false
  const cat = currentEntry.builder.categories[currentEntry.categoryId]
  if (!cat) return false
  const equivUnit = cat.units.find(u => u.id === equivId && u.page === currentEntry.page)
  return equivUnit ? keysMatch(key, equivUnit.key) : false
}

// Fallback labels when the Keyboard Map API is unavailable: the QWERTZ positions that
// differ from QWERTY. Every other layout falls back to the plain QWERTY label.
function displayByLayout(key, isQwertz) {
  if (!isQwertz) return key
  if (key === 'Z') return 'Y'
  if (key === 'Y') return 'Z'
  if (key === ';') return 'Ö'
  if (key === '[') return 'ü'
  if (key === ']') return '+'
  if (key === '`') return '^'
  return key
}

// The two entry points the rest of the app uses. Signatures are unchanged so every
// existing call site keeps working; the layout logic now lives in KeyLayout.
function normalise(key, isQwertz, code) {
  return KeyLayout.getKeyPressed({ key, code }, isQwertz)
}

function display(key, isQwertz) {
  return KeyLayout.getDisplayKey(key, isQwertz)
}

// ─── Audio ────────────────────────────────────────────────────────────────────

const audioCtx = (() => {
  try { return new (window.AudioContext || window.webkitAudioContext)() } catch { return null }
})()

// Loaded AudioBuffer cache
const loadedSounds = { builder: null, factory: null, applause: null }

async function loadSounds() {
  if (!audioCtx) return
  const files = [
    { key: 'builder', path: 'data/sounds/buildbar_click.wav' },
    { key: 'factory', path: 'data/sounds/buildbar_add.wav'   },
    { key: 'applause', path: 'data/sounds/applause.mp3'      },
  ]
  for (const { key, path } of files) {
    try {
      const resp = await fetch(path)
      if (!resp.ok) continue
      const arrayBuf = await resp.arrayBuffer()
      loadedSounds[key] = await audioCtx.decodeAudioData(arrayBuf)
    } catch {
      // File missing or decode failed — fall back to synthesised tone
    }
  }
}

// Two sounds mirroring BAR's build-click cues.
// 'builder' → constructor picks a unit to build (bright rising blip)
// 'factory' → unit queued in factory (softer descending blip)
function playBuildSound(type) {
  if (!audioCtx || !settings.soundEnabled) return
  // Resume suspended context on first user gesture
  if (audioCtx.state === 'suspended') audioCtx.resume()
  const ctx = audioCtx

  // Use the loaded WAV buffer if available
  const buf = loadedSounds[type] ?? null
  if (buf) {
    const source = ctx.createBufferSource()
    source.buffer = buf
    source.connect(ctx.destination)
    source.start()
    return
  }

  // Fallback: synthesised tones
  const now  = ctx.currentTime
  const osc  = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)
  if (type === 'factory') {
    // Short descending tone — queue acknowledged
    osc.type = 'sine'
    osc.frequency.setValueAtTime(740, now)
    osc.frequency.exponentialRampToValueAtTime(480, now + 0.09)
    gain.gain.setValueAtTime(0.18, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13)
    osc.start(now); osc.stop(now + 0.13)
  } else {
    // Short rising tone — unit selected for construction
    osc.type = 'sine'
    osc.frequency.setValueAtTime(820, now)
    osc.frequency.exponentialRampToValueAtTime(1180, now + 0.07)
    gain.gain.setValueAtTime(0.18, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11)
    osc.start(now); osc.stop(now + 0.11)
  }
}

// Single countdown beep — synced to each digit in showNewRunCountdown()
function playCountBeep(isLast) {
  if (!audioCtx || !settings.soundEnabled) return
  if (audioCtx.state === 'suspended') audioCtx.resume()
  const ctx = audioCtx
  const now = ctx.currentTime
  const freq     = isLast ? 1320 : 880
  const duration = isLast ? 0.45 : 0.12
  const osc  = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain); gain.connect(ctx.destination)
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, now)
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.12, now + 0.01)
  gain.gain.setValueAtTime(0.12, now + duration - 0.02)
  gain.gain.linearRampToValueAtTime(0, now + duration)
  osc.start(now); osc.stop(now + duration + 0.01)
}

// Applause — uses the downloaded CC0 recording, falls back to synthesised noise
function playApplauseSound() {
  if (!audioCtx || !settings.soundEnabled) return
  if (audioCtx.state === 'suspended') audioCtx.resume()
  const ctx = audioCtx
  const now = ctx.currentTime

  const buf = loadedSounds.applause
  if (buf) {
    const source = ctx.createBufferSource()
    source.buffer = buf
    const gain = ctx.createGain()
    // Fade in quickly, hold, then fade out — keep it at comfortable volume
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(0.28, now + 0.1)
    gain.gain.setValueAtTime(0.28, now + 3.5)
    gain.gain.linearRampToValueAtTime(0, now + 4.5)
    source.connect(gain); gain.connect(ctx.destination)
    source.start(now)
    source.stop(now + 4.6)
    return
  }

  // Fallback: synthesised crowd noise if file not loaded
  const duration = 3.0
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate)
  const data = noiseBuf.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  const noise  = ctx.createBufferSource()
  noise.buffer = noiseBuf
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'; filter.frequency.value = 1000; filter.Q.value = 0.8
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.10, now + 0.2)
  gain.gain.linearRampToValueAtTime(0.08, now + 1.5)
  gain.gain.linearRampToValueAtTime(0, now + duration)
  noise.connect(filter); filter.connect(gain); gain.connect(ctx.destination)
  noise.start(now); noise.stop(now + duration)
}

// Flawless-run fanfare — synthesised triumphant chord + crowd roar
function playFanfareSound() {
  if (!audioCtx || !settings.soundEnabled) return
  if (audioCtx.state === 'suspended') audioCtx.resume()
  const ctx = audioCtx
  const now = ctx.currentTime

  const buf = loadedSounds.applause
  if (buf) {
    const src = ctx.createBufferSource()
    src.buffer = buf
    const ag = ctx.createGain()
    ag.gain.setValueAtTime(0, now)
    ag.gain.linearRampToValueAtTime(0.45, now + 0.2)
    ag.gain.setValueAtTime(0.45, now + 4)
    ag.gain.linearRampToValueAtTime(0, now + 5.5)
    src.connect(ag); ag.connect(ctx.destination)
    src.start(now); src.stop(now + 5.5)
  }

  // Triumphant fanfare: G4 → C5 → E5 → G5+C6 chord hold
  const fanfare = [
    { freq: 392.0, t: 0.05, dur: 0.18 },   // G4
    { freq: 523.3, t: 0.20, dur: 0.18 },   // C5
    { freq: 659.3, t: 0.35, dur: 0.18 },   // E5
    { freq: 784.0, t: 0.50, dur: 1.60 },   // G5 (hold)
    { freq: 1046.5,t: 0.50, dur: 1.60 },   // C6 (harmony)
    { freq: 587.3, t: 0.50, dur: 1.60 },   // D5 (extra body)
  ]
  for (const n of fanfare) {
    // Two detuned oscillators per note for warmth
    for (const detune of [-5, 5]) {
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = n.freq
      osc.detune.value = detune
      const og = ctx.createGain()
      const t = now + n.t
      og.gain.setValueAtTime(0, t)
      og.gain.linearRampToValueAtTime(0.18, t + 0.03)
      og.gain.setValueAtTime(0.18, t + n.dur - 0.08)
      og.gain.linearRampToValueAtTime(0, t + n.dur)
      osc.connect(og); og.connect(ctx.destination)
      osc.start(t); osc.stop(t + n.dur + 0.01)
    }
  }
}

// ─── Settings (localStorage) ──────────────────────────────────────────────────

const SETTINGS_KEY = 'bar-trainer-settings'

function defaultSettings() {
  return {
    factions:     ['armada', 'cortex'],
    tiers:        [0, 1, 2, 3, 'optional'],
    builderTypes: ['factory', 'constructor'],
    keyboard:     '',
    hintTimeout:  0,
    timeLimit:    8,   // seconds per required key press
    runLength:    20,  // questions per run (0 = unlimited)
    shortcuts:    ['general', 'move', 'groups', 'battle', 'factory', 'builder', 'blueprint', 'rezbot', 'transport', 'camera', 'pip', 'game'],
    difficulty:      'noob',
    soundEnabled:    true,
    mouseEnabled:    true,
    swapCmdAlt:      IS_MAC,
    buildModifiers:  true,
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) }
  } catch {}
  return defaultSettings()
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
}

// When swapCmdAlt is on (Mac default), Cmd acts as Alt and vice versa
function effectiveAlt(event)  { return (settings.swapCmdAlt && IS_MAC) ? event.metaKey : event.altKey  }
function effectiveMeta(event) { return (settings.swapCmdAlt && IS_MAC) ? event.altKey  : event.metaKey }

// ─── Spaced repetition (SM-2 simplified) ─────────────────────────────────────

const SR_KEY = 'bar-trainer-sr'

function loadSR() {
  try { return JSON.parse(localStorage.getItem(SR_KEY) ?? '{}') } catch { return {} }
}
function saveSR(sr) { localStorage.setItem(SR_KEY, JSON.stringify(sr)) }

function srNext(card = {}, quality) {
  // quality: 5 = perfect, 3 = correct with hesitation, 0 = blackout
  let { ef = 2.5, interval = 1, reps = 0 } = card
  if (quality >= 3) {
    interval = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(interval * ef)
    reps++
  } else {
    reps = 0; interval = 1
  }
  ef = Math.max(1.3, ef + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
  const due = new Date()
  due.setDate(due.getDate() + interval)
  return { ef, interval, reps, due: due.toISOString().slice(0,10) }
}

function srPriority(card) {
  if (!card) return 0               // new item — high priority
  const today = new Date().toISOString().slice(0,10)
  if (card.due <= today) return 0   // due — high priority
  return 1                          // future — lower
}

// ─── Data + queue ─────────────────────────────────────────────────────────────

let DATA              = null  // parsed buildmenus.json
let SHORTCUTS         = []    // groups from shortcuts.json
let WATER_EQUIVALENTS = {}    // bidirectional land↔water unit ID map
let UNIT_LEVELS       = {}    // { unitId → level } inverted from shortcuts.json unitLevels
let FACTORY_LEVELS    = {}    // { builderId → level } inverted from shortcuts.json factoryLevels
let CONSTRUCTOR_MODS  = { 'click': 0, 'shift-click': 1, 'space-click': 1 }
let FACTORY_MODS      = { 'none': 0, 'shift': 1, 'ctrl': 1, 'alt': 1, 'ctrl-shift': 2 }

// What each build modifier does, for the reference screen's legend and result cards.
// `mods` are the modifier names held together with the grid key (factories) or the
// mouse click (constructors); order matters for display. `note` is an extra caveat
// shown only on the result card, where there is room for it.
const FACTORY_MOD_INFO = {
  'none':       { mods: [],                label: 'Build 1',      desc: 'Adds one to the end of the queue' },
  'shift':      { mods: ['shift'],         label: 'Queue ×5',     desc: 'Adds five to the end of the queue' },
  'ctrl':       { mods: ['ctrl'],          label: 'Queue ×20',    desc: 'Adds twenty to the end of the queue' },
  'ctrl-shift': { mods: ['ctrl','shift'],  label: 'Queue ×100',   desc: 'Adds a hundred to the end of the queue' },
  'alt':        { mods: ['alt'],           label: 'Insert next',  desc: 'Jumps the queue — builds this one next',
                  note: '<strong>Hint:</strong> if the factory is on <strong>Repeat</strong>, any unit being built is finished and this one is built next. If the factory is not on Repeat, a unit under construction is <strong>cancelled</strong> and this one starts instead.' },
}
// `short` is the compact wording used on the result card, where all three are listed at once
const CONSTRUCTOR_MOD_INFO = {
  'click':       { mods: [],        short: 'Build',   label: 'Build',           desc: 'Place it — runs after the current orders' },
  'shift-click': { mods: ['shift'], short: 'Queue',   label: 'Queue build',     desc: 'Appends to the build queue' },
  'space-click': { mods: ['space'], short: 'Instant', label: 'Build instantly', desc: 'Skips the queue and starts right away' },
}

const SHORTCUT_CONTEXT_UNITS = {
  battle:    { armada: 'armcom',   cortex: 'corcom',   legion: 'legcom'    },
  rezbot:    { armada: 'armrectr', cortex: 'cornecro', legion: 'legrezbot' },
  transport: { armada: 'armatlas', cortex: 'corvalk',  legion: 'legatrans' },
}

function uInfo(id) { return DATA.units[id] ?? {} }

function difficultyThreshold() {
  return settings.difficulty === 'noob' ? 0 : settings.difficulty === 'mid' ? 1 : Infinity
}

async function loadData() {
  const res = await fetch('data/buildmenus.json', { cache: 'reload' })
  if (!res.ok) throw new Error(`Could not load data/buildmenus.json (${res.status})`)
  DATA = await res.json()
  const weRes = await fetch('data/water-equivalents.json')
  if (weRes.ok) WATER_EQUIVALENTS = await weRes.json()
}

/** Return builders matching current settings */
function filteredBuilders(settings) {
  const types = settings.builderTypes ?? ['factory', 'constructor']
  const threshold = difficultyThreshold()
  return Object.values(DATA.builders).filter(b => {
    if (threshold < Infinity) {
      const fLvl = FACTORY_LEVELS[b.id]
      if (fLvl === undefined || fLvl > threshold) return false
    }
    // A builder is included if at least one of its reachable factions is selected.
    // (Legion shares all Cortex factories, so cor* builders have factions ['cortex','legion'])
    const factions = b.factions ?? [b.faction]
    if (!factions.some(f => settings.factions.includes(f))) return false
    if (b.optional && !settings.tiers.includes('optional')) return false
    if (b.experimental && !settings.tiers.includes(3)) return false
    if (!settings.tiers.includes(b.tier)) return false
    // Filter by unit type: factories vs constructors
    if (isFactory(b) && !types.includes('factory'))     return false
    if (!isFactory(b) && !types.includes('constructor')) return false
    return true
  })
}

/**
 * Build a shuffled queue of { builderId, unitId, categoryId, gridKey, page }.
 * Due/new SR items come first; rest are random.
 */
function buildQueue(builders, sr) {
  const items = []
  for (const builder of builders) {
    for (const [catId, cat] of Object.entries(builder.categories)) {
      const threshold = difficultyThreshold()
      for (const unit of cat.units) {
        if (unit.trainingExcluded) continue
        if (threshold < Infinity) {
          const lvl = UNIT_LEVELS[unit.id]
          if (lvl === undefined || lvl > threshold) continue
        }
        items.push({
          builderId:  builder.id,
          unitId:     unit.id,
          categoryId: catId,
          gridKey:    unit.key,
          page:       unit.page,
        })
      }
    }
  }

  // Shuffle, then stable-sort by SR priority so due items float up
  shuffle(items)
  items.sort((a, b) => {
    const ka = `${a.builderId}:${a.unitId}`
    const kb = `${b.builderId}:${b.unitId}`
    return srPriority(sr[ka]) - srPriority(sr[kb])
  })
  return items
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

function buildShortcutQueue() {
  const items = []
  for (const group of SHORTCUTS) {
    if (!settings.shortcuts?.includes(group.id)) continue
    const threshold = difficultyThreshold()
    for (const shortcut of group.shortcuts) {
      if (shortcut.displayOnly) continue
      if (threshold < Infinity) {
        if (shortcut.level === undefined || shortcut.level > threshold) continue
      }
      // Unreachable in this browser/OS combination — drop it rather than show a study card
      if (isOsReserved(shortcut.key, shortcut.modifiers ?? [])) continue
      // Normalise keys and per-key modifier arrays
      const seqKeys = shortcut.keys ?? (shortcut.key ? [shortcut.key] : null)
      if (!seqKeys) continue
      let seqMods
      if (shortcut.keys) {
        // Sequence of keys — each key has no modifiers
        seqMods = shortcut.keys.map(() => [])
      } else {
        // Single key with optional modifiers
        seqMods = [(shortcut.modifiers ?? []).map(m => m.toLowerCase())]
      }
      items.push({
        type:            'shortcut',
        id:              shortcut.id,
        label:           shortcut.label,
        description:     shortcut.description ?? '',
        context:         shortcut.contextOverride ?? group.context,
        seqKeys,
        seqMods,
        mouseAction:     shortcut.mouseAction ?? 'none',
        browserReserved: isBrowserReserved(shortcut.key, shortcut.modifiers ?? []),
      })
    }
  }
  shuffle(items)
  return items
}

// ─── Application state ────────────────────────────────────────────────────────

const State = {
  WAITING_CATEGORY: 'cat',
  WAITING_SHIFT:    'shift',
  WAITING_PAGE:     'page',
  WAITING_GRID:     'grid',
  WAITING_SHORTCUT: 'shortcut',
  WAITING_MOUSE:    'mouse',
  SHOW_ANSWER:      'show_answer',
  FEEDBACK:         'feedback',
}

let settings      = loadSettings()
let sr            = loadSR()
let queue         = []
let queueIndex    = 0
let currentEntry  = null   // item from queue + resolved builder/unit objects
let trainingState = State.WAITING_CATEGORY
let activeCatId   = null   // currently displayed category in menu
let currentPage   = 0
let hintTimerId   = null
let hintInterval  = null
let shortcutKeyVisible  = false  // false = hide key for first 3s of shortcut question
let shortcutKeyTimerId  = null
let session       = { correct: 0, late: 0, wrong: 0, streak: 0 }

let answerTimerId    = null
let answerTimerEnd   = 0
let currentTimeLimitMs = 0
let paused           = false
let pauseRemainingMs = 0
let runComplete      = false
const TIMER_CIRCUMFERENCE = 113.097
let countingDown        = false
let spaceHeld           = false   // Space used as a modifier key (Space+X = explosion radius)
let currentMouseAction  = null    // active mouse interaction type during WAITING_MOUSE

// ─── Wrong-answer correction flow ────────────────────────────────────────────
// When the user presses a wrong key we no longer immediately show the answer.
// Instead we keep the timer running and let them self-correct.  The answer is
// only revealed when the timer expires.  After reveal, a 10-second countdown
// auto-advances if the user doesn't click "OK Next".
let questionHadWrong        = false   // any wrong key was pressed this question
let showAnswerCountdownId   = null    // setInterval handle for 10-s auto-advance
let showAnswerCountdownSec  = 0       // remaining seconds
let showAnswerPrefix        = ''      // prefix shown in instruction (e.g. '⏱ Time up — ')
let showAnswerKeysHtml      = ''      // pre-built <kbd>...</kbd> HTML

// ─── Reaction-time tracking ───────────────────────────────────────────────────

const RUNS_KEY       = 'bar-trainer-runs'
const MAX_RUNS       = 5
const MAX_TABLE_ROWS = 20

let questionStartTime = 0   // Date.now() when current question was displayed
let currentRunEntries = []  // { unitId, builderId, unitName, builderName, ms }

function loadRunHistory() {
  try { return JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]') } catch { return [] }
}
function saveRunHistory(runs) { localStorage.setItem(RUNS_KEY, JSON.stringify(runs)) }

function archiveCurrentRun() {
  if (!currentRunEntries.length) return
  const history = loadRunHistory()
  history.unshift({ date: new Date().toISOString(), entries: [...currentRunEntries] })
  if (history.length > MAX_RUNS) history.length = MAX_RUNS
  saveRunHistory(history)
  currentRunEntries = []
}

function resetRunStats() {
  currentRunEntries = []
  saveRunHistory([])
  renderStatsTable()
}

function fmtCost(n) {
  if (n >= 10000) return Math.round(n / 1000) + 'k'
  if (n >= 1000)  return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

function fmtMs(ms) {
  return ms >= 10000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'
}

function timeClass(ms) {
  if (ms < 1500) return 'time-fast'
  if (ms < 4000) return 'time-mid'
  return 'time-slow'
}

function runLabel(isoDate) {
  const d   = new Date(isoDate)
  const now = new Date()
  const diffH = (now - d) / 3_600_000
  if (diffH < 1)  return `${Math.round(diffH * 60)}m ago`
  if (diffH < 24) return `${Math.round(diffH)}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function renderStatsTable() {
  const panel = $('stats-panel')
  if (!currentRunEntries.length && !runComplete) { panel.classList.add('hidden'); return }
  panel.classList.remove('hidden')

  const history = loadRunHistory()

  // ── Run-end summary ────────────────────────────────────────────────────────
  const summaryEl = $('run-summary')
  if (summaryEl) {
    if (runComplete) {
      const studyCount    = currentRunEntries.filter(e => e.studyCard).length
      const trainable     = currentRunEntries.filter(e => !e.studyCard)
      const answered      = trainable.filter(e => e.outcome !== 'wrong')
      const times         = answered.map(e => e.ms)
      const trainCount    = session.totalAnswered - studyCount

      let html = `<div class="run-summary-title">Run complete — ${trainCount} question${trainCount !== 1 ? 's' : ''}${studyCount ? ` + ${studyCount} studied` : ''}</div>`
      html += `<div class="run-summary-stats">`
      html += `<span class="rs-item"><span class="rs-val success">${session.correct}</span> first try</span>`
      html += `<span class="rs-item"><span class="rs-val warn">${session.late}</span> correct</span>`
      html += `<span class="rs-item"><span class="rs-val error">${session.wrong}</span> wrong</span>`

      if (times.length) {
        const avg   = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
        const best  = Math.min(...times)
        const worst = Math.max(...times)
        html += `<span class="rs-item"><span class="rs-val">${fmtMs(avg)}</span> avg</span>`
        html += `<span class="rs-item"><span class="rs-val success">${fmtMs(best)}</span> best</span>`
        html += `<span class="rs-item"><span class="rs-val error">${fmtMs(worst)}</span> worst</span>`

        // ── Compare to previous runs ──────────────────────────────────────────
        // Score = {wrongs, avg}: fewer wrongs wins; tie-break on lower avg time.
        // Legacy entry compat: old 'timeout' = new 'wrong'; old 'wrong' = new 'late'.
        function runScore(entries) {
          const t = entries.filter(e => !e.studyCard)
          const wc = t.filter(e => e.outcome === 'wrong' || e.outcome === 'timeout').length
          const ans = t.filter(e => e.outcome !== 'wrong' && e.outcome !== 'timeout')
          const a = ans.length ? Math.round(ans.reduce((s, e) => s + e.ms, 0) / ans.length) : Infinity
          return { wrongs: wc, avg: a }
        }
        function scoreBetter(a, b) {
          if (a.wrongs !== b.wrongs) return a.wrongs < b.wrongs
          return a.avg < b.avg
        }

        const cur        = runScore(currentRunEntries)
        const histScores = history.map(r => runScore(r.entries))

        let verdict
        if (!histScores.length) {
          verdict = '🎯 First run!'
        } else {
          const best = histScores.reduce((b, s) => scoreBetter(s, b) ? s : b)
          if (scoreBetter(cur, best) || (cur.wrongs === best.wrongs && cur.avg === best.avg)) {
            verdict = '🏆 Best run ever!'
          } else {
            const avgWrongs = histScores.reduce((s, h) => s + h.wrongs, 0) / histScores.length
            const timeable  = histScores.filter(h => h.avg !== Infinity)
            const avgTime   = timeable.length ? timeable.reduce((s, h) => s + h.avg, 0) / timeable.length : Infinity
            if (cur.wrongs < avgWrongs || (cur.wrongs <= avgWrongs && cur.avg < avgTime)) {
              verdict = '📈 Better than average'
            } else {
              verdict = '📉 Below average'
            }
          }
        }
        html += `<span class="rs-verdict">${verdict}</span>`
      }
      html += `</div>`
      summaryEl.innerHTML = html
      summaryEl.classList.remove('hidden')
    } else {
      summaryEl.classList.add('hidden')
    }
  }

  // Per (builderId:unitId) keep the LATEST time in current run; exclude study cards
  const curMap = new Map()
  for (const e of currentRunEntries) {
    if (e.studyCard) continue
    curMap.set(`${e.builderId}:${e.unitId}`, e)
  }

  // Sort: wrong (unanswered) floats to top, then slowest first
  const rows = [...curMap.values()].sort((a, b) => {
    const aSort = a.outcome === 'wrong' ? Infinity : a.ms
    const bSort = b.outcome === 'wrong' ? Infinity : b.ms
    return bSort - aSort
  }).slice(0, MAX_TABLE_ROWS)

  // Past runs: lookup maps key → best ms in that run (wrong/timeout/study excluded)
  const histMaps = history.map(run => {
    const m = new Map()
    for (const e of run.entries) {
      if (e.outcome === 'wrong' || e.outcome === 'timeout' || e.studyCard) continue
      const k = `${e.builderId}:${e.unitId}`
      if (!m.has(k) || e.ms < m.get(k)) m.set(k, e.ms)
    }
    return { label: runLabel(run.date), map: m }
  })

  // All-time best per key (wrong/timeout/study excluded)
  const bestMap = new Map()
  for (const e of currentRunEntries) {
    if (e.outcome === 'wrong' || e.studyCard) continue
    const k = `${e.builderId}:${e.unitId}`
    if (!bestMap.has(k) || e.ms < bestMap.get(k)) bestMap.set(k, e.ms)
  }
  for (const { map } of histMaps) {
    for (const [k, ms] of map) {
      if (!bestMap.has(k) || ms < bestMap.get(k)) bestMap.set(k, ms)
    }
  }

  // Header
  const thead = $('stats-thead')
  thead.innerHTML = ''
  const hr = document.createElement('tr')
  for (const text of ['#', 'Unit', 'Builder', 'This run',
    ...histMaps.map(h => h.label), 'Best']) {
    const th = document.createElement('th')
    th.textContent = text
    if (!['#','Unit','Builder'].includes(text)) th.className = 'col-time'
    hr.appendChild(th)
  }
  thead.appendChild(hr)

  // Body
  const tbody = $('stats-tbody')
  tbody.innerHTML = ''
  rows.forEach((entry, idx) => {
    const key = `${entry.builderId}:${entry.unitId}`
    const tr  = document.createElement('tr')

    const addCell = (text, cls = '') => {
      const td = document.createElement('td')
      td.textContent = text
      if (cls) td.className = cls
      tr.appendChild(td)
      return td
    }

    addCell(idx + 1, 'col-rank')
    addCell(entry.unitName, 'col-unit')
    addCell(entry.builderName, 'col-builder')
    addCell(
      entry.outcome === 'wrong' ? '⏱' : fmtMs(entry.ms),
      `col-time col-now ${entry.outcome === 'wrong' ? 'time-timeout' : entry.outcome === 'late' ? 'time-late' : timeClass(entry.ms)}`
    )

    for (const { map } of histMaps) {
      const ms = map.get(key)
      addCell(ms !== undefined ? fmtMs(ms) : '—',
              `col-time col-hist ${ms !== undefined ? timeClass(ms) : 'time-none'}`)
    }

    const best = bestMap.get(key)
    addCell(best !== undefined ? fmtMs(best) : '—',
            `col-time col-best ${best !== undefined ? timeClass(best) : 'time-none'}`)

    tbody.appendChild(tr)
  })
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id)

const screens = {
  loading:   $('screen-loading'),
  setup:     $('screen-setup'),
  training:  $('screen-training'),
  browse:    $('screen-browse'),
  shortcuts: $('screen-shortcuts'),
}

// ─── Screen switching ─────────────────────────────────────────────────────────

let currentScreen = 'loading'

function showScreen(name) {
  currentScreen = name
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('active', key === name)
  }
  if (name === 'shortcuts' && activeShortcutsGroupId) {
    selectShortcutsGroup(activeShortcutsGroupId)
  }
}

// ─── Build menu rendering ─────────────────────────────────────────────────────

/**
 * Render the full build menu for `builder` with `activeCat` category shown.
 * `highlightUnitId` puts a gold border on that slot (target hint).
 */
function renderMenu(builder, activeCat, page = 0, highlightUnitId = null) {
  const isQwertz = settings.keyboard === 'qwertz'
  renderTabs(builder, activeCat, isQwertz)
  renderGrid(builder, activeCat, page, highlightUnitId, isQwertz)
  renderPageBtn(builder, activeCat, page)
}

function renderTabs(builder, activeCatId, isQwertz) {
  const container = $('cat-tabs')
  container.innerHTML = ''

  if (isFactory(builder)) {
    // Factories have no category tabs in-game.  We still render 4 ghost tabs
    // (invisible) so the menu footer never changes height.
    container.style.visibility = 'hidden'
    for (let i = 0; i < 4; i++) {
      const tab = document.createElement('div')
      tab.className = 'cat-tab'
      container.appendChild(tab)
    }
    return
  }

  container.style.visibility = 'visible'
  for (const cat of CATEGORIES) {
    const hasCat = !!builder.categories[cat.id]
    const tab = document.createElement('div')
    tab.className = 'cat-tab' + (cat.id === activeCatId ? ' active' : '')
    tab.dataset.cat = cat.id
    tab.innerHTML = `
      <span class="tab-key">${display(cat.key, isQwertz)}</span>
      <span class="tab-label">${cat.label}</span>
    `
    if (!hasCat) tab.style.opacity = '0.25'
    container.appendChild(tab)
  }
}

function renderGrid(builder, activeCatId, page, highlightUnitId, isQwertz) {
  const container = $('menu-grid')
  container.innerHTML = ''

  const showKeys   = activeCatId !== null
  const displayCat = activeCatId   // null → empty grid until category is chosen

  const cat    = displayCat ? builder.categories[displayCat] : null
  const units  = cat ? cat.units.filter(u => u.page === page) : []
  const slotMap = {}
  for (const unit of units) slotMap[unit.key] = unit

  for (const key of GRID_KEYS) {
    const unit = slotMap[key] ?? null
    const slot = document.createElement('div')
    slot.className = 'slot' + (unit ? '' : ' empty')
    slot.dataset.key = key

    if (unit) {
      const info = uInfo(unit.id)
      slot.dataset.unitId = unit.id
      if (unit.id === highlightUnitId) slot.classList.add('is-target')

      const img = document.createElement('img')
      img.src = `data/${info.icon}`
      img.alt = info.name
      img.addEventListener('error', () => img.remove())
      slot.appendChild(img)

      // Cost badges
      const eBadge = document.createElement('span')
      eBadge.className = 'slot-energy'
      eBadge.textContent = fmtCost(info.energyCost)

      const mBadge = document.createElement('span')
      mBadge.className = 'slot-metal'
      mBadge.textContent = fmtCost(info.metalCost)

      slot.append(eBadge, mBadge)

      if (showKeys) {
        const keyLabel = document.createElement('span')
        keyLabel.className = 'slot-key'
        keyLabel.textContent = display(key, isQwertz)
        slot.appendChild(keyLabel)
      }

      slot.addEventListener('mouseenter', () => showSlotHover(unit, 'slot-hover-info'))
      slot.addEventListener('mouseleave', () => {
        if (learnPinnedUnit) showSlotHover(learnPinnedUnit, 'slot-hover-info')
        else clearSlotHover('slot-hover-info')
      })
      slot.addEventListener('click', () => {
        const wasPinned = learnPinnedUnit === unit
        clearLearnPin()
        if (!wasPinned) {
          learnPinnedUnit = unit
          slot.classList.add('slot-pinned')
          showSlotHover(unit, 'slot-hover-info')
        }
      })
    }

    container.appendChild(slot)
  }
}

function renderPageBtn(builder, activeCatId, page) {
  const btn = $('page-btn')
  if (!btn) return
  const cat = builder.categories[activeCatId]
  const totalPages = cat ? ((cat.units[cat.units.length - 1]?.page ?? 0) + 1) : 1
  if (totalPages <= 1) {
    btn.classList.remove('has-pages')
    return
  }
  $('page-cur').textContent = page + 1
  $('page-tot').textContent = totalPages
  btn.classList.add('has-pages')
}

// ─── Training question ────────────────────────────────────────────────────────

function renderQuestion(entry) {
  const { builder, unit } = entry

  // Restore build menu (was hidden for shortcut questions)
  const buildMenuWrap = document.querySelector('#screen-training .build-menu-wrap')
  if (buildMenuWrap) { buildMenuWrap.style.opacity = ''; buildMenuWrap.style.pointerEvents = '' }
  const hoverInfo = $('slot-hover-info')
  if (hoverInfo) hoverInfo.style.opacity = ''

  // Restore builder-card label for build-menu questions
  document.querySelector('#screen-training .builder-card .label-small').textContent = 'Building with'

  // Remove shortcut-target class from target card and restore hidden elements
  document.querySelector('#screen-training .target-card').classList.remove('shortcut-target')
  document.querySelector('#screen-training .target-costs').style.display     = ''
  document.querySelector('#screen-training .target-icon-wrap').style.display = ''
  $('target-icon').style.display  = ''
  $('builder-icon').style.display = ''

  // Builder card
  const bi = $('builder-icon')
  bi.src = `data/${builder.icon}`
  bi.alt = builder.name
  bi.className = 'unit-portrait'
  bi.onerror = () => bi.classList.add('err')
  $('builder-name').textContent = builder.name
  $('builder-meta').textContent = `${capitalize(builder.faction)} · T${builder.tier}`

  // Target card
  const unitInfo = uInfo(unit.id)
  const ti = $('target-icon')
  ti.src = `data/${unitInfo.icon}`
  ti.alt = unitInfo.name
  ti.className = 'unit-portrait'
  ti.onerror = () => ti.classList.add('err')
  $('target-name').textContent = unitInfo.name
  const descEl = $('target-description')
  descEl.textContent = unitInfo.description ?? ''
  descEl.classList.toggle('hidden', !unitInfo.description)
  $('target-metal').textContent  = unitInfo.metalCost.toLocaleString()
  $('target-energy').textContent = unitInfo.energyCost.toLocaleString()
  updateBuildModBadge()
}

function renderShortcutQuestion(entry) {
  // Hide the build menu but keep the menu-col visible so the mouse zone stays interactive
  const buildMenuWrap = document.querySelector('#screen-training .build-menu-wrap')
  if (buildMenuWrap) { buildMenuWrap.style.opacity = '0'; buildMenuWrap.style.pointerEvents = 'none' }
  const hoverInfo = $('slot-hover-info')
  if (hoverInfo) hoverInfo.style.opacity = '0'

  // Builder card — repurposed to show context unit
  document.querySelector('#screen-training .builder-card .label-small').textContent =
    entry.contextUnitId ? 'With selected:' : 'No unit'

  const bi = $('builder-icon')
  if (entry.contextUnitId) {
    bi.src       = entry.contextIcon || unitIconSrc(entry.contextUnitId)
    bi.alt       = entry.contextUnitName ?? entry.contextUnitId
    bi.className = 'unit-portrait'
    bi.onerror   = () => bi.classList.add('err')
    bi.style.display = ''
  } else {
    // No context unit — hide the portrait entirely so no broken-image icon shows
    bi.src             = ''
    bi.alt             = ''
    bi.style.display   = 'none'
  }
  $('builder-name').textContent = entry.contextUnitName ?? '—'
  const ctxLabel = { factory: 'Factory', builder: 'Constructor', 'builder-t2': 'T2 Constructor' }
  $('builder-meta').textContent = entry.contextFaction
    ? capitalize(entry.contextFaction) + (ctxLabel[entry.context] ? ' · ' + ctxLabel[entry.context] : '')
    : ''

  // Hide build-mod badge for shortcut questions
  const bmbShortcut = $('build-mod-badge')
  if (bmbShortcut) { bmbShortcut.innerHTML = ''; bmbShortcut.classList.add('hidden') }

  // Target card — show shortcut info, hide costs/icon via inline style (reliable)
  document.querySelector('#screen-training .target-card').classList.add('shortcut-target')
  $('build-action-label').textContent = 'Command:'
  $('target-name').textContent = entry.label
  const descEl = $('target-description')
  descEl.textContent = entry.description || ''
  descEl.classList.remove('hidden')
  $('target-icon').style.display  = 'none'
  $('target-energy').closest('.cost')?.parentElement?.style.setProperty('display', 'none')
  document.querySelector('#screen-training .target-costs').style.display  = 'none'
  document.querySelector('#screen-training .target-icon-wrap').style.display = 'none'
}

function setInstruction(html, stateClass = '') {
  const el = $('instruction')
  el.innerHTML = html
  el.className = 'instruction' + (stateClass ? ` ${stateClass}` : '')
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1) }

// ─── Stats ────────────────────────────────────────────────────────────────────

function updateStats() {
  $('stat-first-try').textContent = session.correct
  $('stat-correct').textContent   = session.late
  $('stat-wrong').textContent     = session.wrong
  const s = session.streak
  $('stat-streak').textContent    = s === 0 ? '—' : s <= 8 ? '🥇'.repeat(s) : `🥇×${s}`
}

// ─── Hint overlay ─────────────────────────────────────────────────────────────

function startHintTimer(seconds) {
  if (seconds === 0) {
    $('hint-overlay').classList.add('hidden')
    return
  }
  $('hint-overlay').classList.remove('hidden')
  $('hint-countdown').textContent = seconds

  let remaining = seconds
  hintInterval = setInterval(() => {
    remaining--
    $('hint-countdown').textContent = remaining
    if (remaining <= 0) {
      clearInterval(hintInterval)
      $('hint-overlay').classList.add('hidden')
    }
  }, 1000)
}

function clearHintTimer() {
  clearInterval(hintInterval)
  $('hint-overlay').classList.add('hidden')
}

const SHORTCUT_KEY_DELAY_MS = 3000

function startShortcutKeyTimer() {
  clearTimeout(shortcutKeyTimerId)
  shortcutKeyVisible = false
  shortcutKeyTimerId = setTimeout(() => {
    shortcutKeyVisible = true
    if (trainingState === State.WAITING_SHORTCUT) updateInstruction()
  }, SHORTCUT_KEY_DELAY_MS)
}

function clearShortcutKeyTimer() {
  clearTimeout(shortcutKeyTimerId)
  shortcutKeyVisible = false
}

// ─── Answer timer ─────────────────────────────────────────────────────────────

/**
 * True when the target unit is at the Z slot (bottom-left) of a constructor menu on page 0.
 * In-game, pressing the category tab key pre-selects that slot automatically — so only ONE
 * keypress is needed.  e.g. MEX = Z, LLT = X (not XZ), Radar = C (not CZ), etc.
 * keysMatch handles the Z/Y QWERTZ equivalence.
 */
function isBottomRowItem(entry) {
  if (entry.type === 'shortcut') return false
  const builder = DATA.builders[entry.builderId]
  if (!builder || isFactory(builder)) return false
  if (entry.page > 0) return false
  return keysMatch(entry.gridKey, 'Z')
}

/** Compute total timeout in ms for the current question based on required key presses. */
function calcTimeoutMs(entry) {
  if (!settings.timeLimit) return 0
  if (entry.type === 'shortcut') {
    return settings.timeLimit * entry.seqKeys.length * 1000
  }
  const builder = DATA.builders[entry.builderId]
  let keystrokes = 1                         // always need the grid key (or combined key)
  if (!isFactory(builder) && !isBottomRowItem(entry)) keystrokes++  // separate category key
  keystrokes += entry.page                   // one B per page to advance
  return settings.timeLimit * keystrokes * 1000
}

function startAnswerTimer() {
  clearAnswerTimer()
  if (!settings.timeLimit || !currentEntry) {
    $('timer-wrap').classList.add('hidden')
    return
  }
  const ms = calcTimeoutMs(currentEntry)
  if (!ms) { $('timer-wrap').classList.add('hidden'); return }
  currentTimeLimitMs = ms
  $('timer-wrap').classList.remove('hidden')
  answerTimerEnd = Date.now() + ms
  updateTimerDisplay(1)
  answerTimerId = setInterval(tickAnswerTimer, 50)
}

function clearAnswerTimer() {
  if (answerTimerId !== null) {
    clearInterval(answerTimerId)
    answerTimerId = null
  }
  $('timer-wrap').classList.add('hidden')
}

function tickAnswerTimer() {
  const remaining = answerTimerEnd - Date.now()
  const fraction  = Math.max(0, remaining / currentTimeLimitMs)
  updateTimerDisplay(fraction)
  if (remaining <= 0) {
    clearAnswerTimer()
    handleTimeout()
  }
}

function updateTimerDisplay(fraction) {
  const fg     = $('timer-ring-fg')
  const offset = TIMER_CIRCUMFERENCE * (1 - fraction)
  fg.style.strokeDashoffset = offset
  const hue = Math.round(fraction * 120)
  fg.style.stroke = `hsl(${hue},80%,55%)`
  const remaining = Math.max(0, answerTimerEnd - Date.now())
  $('timer-label').textContent = Math.ceil(remaining / 1000)
}

function handleTimeout() {
  if (trainingState === State.FEEDBACK || trainingState === State.SHOW_ANSWER) return
  if (!screens.training.classList.contains('active')) return
  deactivateMouseZone()
  recordResult('wrong')
  showAnswer('⏱ Time up — ')
}

/** Show the correct answer and start a 10-second auto-advance countdown. */
function showAnswer(prefix = '') {
  clearAnswerTimer()
  clearHintTimer()
  clearShortcutKeyTimer()
  clearShowAnswerCountdown()

  if (currentEntry.type === 'shortcut') {
    const keys = correctKeySequence()
    showAnswerPrefix   = prefix
    showAnswerKeysHtml = keys.map(k => `<kbd>${k}</kbd>`).join(' → ')
    const answerMods = currentEntry.seqMods?.flat() ?? []
    showAnswerKeysHtml += macSwapNote(answerMods)
    trainingState = State.SHOW_ANSWER
    $('btn-skip').textContent = 'OK Next'
    showAnswerCountdownSec = 10
    updateShowAnswerInstruction()
    showAnswerCountdownId = setInterval(() => {
      showAnswerCountdownSec--
      if (showAnswerCountdownSec <= 0) {
        clearShowAnswerCountdown()
        advanceFromAnswer()
      } else {
        updateShowAnswerInstruction()
      }
    }, 1000)
    return
  }

  activeCatId = currentEntry.categoryId
  currentPage = currentEntry.page
  renderMenu(currentEntry.builder, activeCatId, currentPage, currentEntry.unitId)

  const keys = correctKeySequence()
  showAnswerPrefix   = prefix
  showAnswerKeysHtml = keys.map(k => `<kbd>${k}</kbd>`).join(' ')
  if (isFactory(currentEntry.builder) && currentEntry.buildModifier === 'alt') {
    showAnswerKeysHtml += macSwapNote(['alt'])
  }

  trainingState = State.SHOW_ANSWER
  $('btn-skip').textContent = 'OK Next'

  showAnswerCountdownSec = 10
  updateShowAnswerInstruction()

  showAnswerCountdownId = setInterval(() => {
    showAnswerCountdownSec--
    if (showAnswerCountdownSec <= 0) {
      clearShowAnswerCountdown()
      advanceFromAnswer()
    } else {
      updateShowAnswerInstruction()
    }
  }, 1000)
}

function updateShowAnswerInstruction() {
  setInstruction(
    `${showAnswerPrefix}Answer: ${showAnswerKeysHtml}` +
    ` <span class="answer-countdown">(${showAnswerCountdownSec}s)</span>`,
    'state-wrong'
  )
}

function clearShowAnswerCountdown() {
  if (showAnswerCountdownId !== null) {
    clearInterval(showAnswerCountdownId)
    showAnswerCountdownId = null
  }
}

function advanceFromAnswer() {
  if (trainingState !== State.SHOW_ANSWER) return
  clearShowAnswerCountdown()
  $('btn-skip').textContent = '↩ Skip'
  trainingState = State.FEEDBACK
  checkRunEnd()
}

function checkRunEnd() {
  if (settings.runLength > 0 && session.totalAnswered >= settings.runLength) {
    endRun()
  } else {
    nextQuestion()
  }
}

function endRun() {
  runComplete   = true
  trainingState = State.FEEDBACK
  clearAnswerTimer()
  clearShowAnswerCountdown()

  const flawless = session.wrong === 0 && session.late === 0 && session.totalAnswered > 0
  if (flawless) {
    playFanfareSound()
  } else {
    playApplauseSound()
  }

  // Don't archive yet — startTraining() will do it; currentRunEntries is still
  // needed by renderStatsTable() for the summary (correct[], min/max/avg).
  $('btn-skip').textContent = '↩ Skip'
  $('btn-skip').classList.add('hidden')
  $('btn-pause').classList.add('hidden')
  $('btn-settings').textContent = '⌂ Home'

  // Hide the active question and build menu; reveal the celebration panel
  document.querySelector('.question-col').classList.add('hidden')
  document.querySelector('.menu-col').classList.add('hidden')
  $('run-complete-col').classList.remove('hidden')

  const content = document.querySelector('.run-complete-content')
  const trophy  = document.querySelector('.run-complete-trophy')
  const title   = document.querySelector('.run-complete-title')
  if (flawless) {
    content?.classList.add('flawless')
    if (trophy) trophy.textContent = '🌟'
    if (title)  title.textContent  = 'Flawless!'
  } else {
    content?.classList.remove('flawless')
    if (trophy) trophy.textContent = '🏆'
    if (title)  title.textContent  = 'Run Complete!'
  }

  renderStatsTable()
  startConfetti(flawless)
}

/** Return the ordered key labels the user needs to press for the current question. */
function displayMod(m) {
  if (m === 'alt' && settings.swapCmdAlt && IS_MAC) return '⌘ Cmd'
  return capitalize(m)
}

function macSwapNote(mods) {
  if (!IS_MAC || !settings.swapCmdAlt) return ''
  const hasMacAlt = (mods ?? ['alt']).some(m => m.toLowerCase() === 'alt')
  if (!hasMacAlt) return ''
  return ` <span class="mod-swap-note">(⌘ Cmd in trainer)</span>`
}

function correctKeySequence() {
  const isQwertz = settings.keyboard === 'qwertz'
  if (currentEntry.type === 'shortcut') {
    return currentEntry.seqKeys.map((key, idx) => {
      const mods  = currentEntry.seqMods[idx] ?? []
      const parts = [...mods.map(m => m.toLowerCase() === 'alt' ? 'Alt' : displayMod(m)), display(key.toUpperCase(), isQwertz)]
      return parts.join('+')
    })
  }
  const keys = []
  if (!isFactory(currentEntry.builder)) {
    const cat = CATEGORIES.find(c => c.id === currentEntry.categoryId)
    if (cat) {
      keys.push(display(cat.key, isQwertz))
      // Bottom-row item: category key press also selects the unit — no separate grid key
      if (isBottomRowItem(currentEntry)) return keys
    }
  }
  for (let page = 0; page < currentEntry.page; page++) keys.push('B')
  const gridKey = display(currentEntry.gridKey, isQwertz)
  if (isFactory(currentEntry.builder)) {
    const mod = currentEntry.buildModifier
    if (mod === 'shift')           keys.push(`Shift+${gridKey}`)
    else if (mod === 'ctrl')       keys.push(`Ctrl+${gridKey}`)
    else if (mod === 'ctrl-shift') keys.push(`Ctrl+Shift+${gridKey}`)
    else if (mod === 'alt')        keys.push(`Alt+${gridKey}`)
    else                           keys.push(gridKey)
  } else {
    keys.push(gridKey)
  }
  return keys
}

// ─── Pause ────────────────────────────────────────────────────────────────────

function togglePause() {
  if (countingDown) return
  if (!screens.training.classList.contains('active')) return

  if (paused) {
    paused = false
    $('pause-overlay').classList.add('hidden')
    $('btn-pause').textContent = '⏸ Pause'
    // Restart answer timer with saved remaining time
    if (pauseRemainingMs > 0 && currentTimeLimitMs > 0) {
      $('timer-wrap').classList.remove('hidden')
      answerTimerEnd = Date.now() + pauseRemainingMs
      updateTimerDisplay(pauseRemainingMs / currentTimeLimitMs)
      answerTimerId = setInterval(tickAnswerTimer, 50)
    }
    // Restart show-answer countdown if we paused during SHOW_ANSWER
    if (trainingState === State.SHOW_ANSWER && showAnswerCountdownSec > 0) {
      showAnswerCountdownId = setInterval(() => {
        showAnswerCountdownSec--
        if (showAnswerCountdownSec <= 0) {
          clearShowAnswerCountdown()
          advanceFromAnswer()
        } else {
          updateShowAnswerInstruction()
        }
      }, 1000)
    }
  } else {
    paused = true
    if (answerTimerId !== null) {
      pauseRemainingMs = Math.max(0, answerTimerEnd - Date.now())
      clearInterval(answerTimerId)
      answerTimerId = null
    } else {
      pauseRemainingMs = 0
    }
    // Pause the show-answer countdown too
    clearShowAnswerCountdown()
    clearHintTimer()
    $('pause-overlay').classList.remove('hidden')
    $('btn-pause').textContent = '▶ Resume'
  }
}

// ─── Run-end confetti ─────────────────────────────────────────────────────────

let confettiRaf = null

function startConfetti(flawless = false) {
  const canvas = $('confetti-canvas')
  if (!canvas) return
  const ctx  = canvas.getContext('2d')
  const col  = document.querySelector('.run-complete-col')
  const rect = col ? col.getBoundingClientRect() : { width: 600, height: 400 }
  canvas.width  = rect.width
  canvas.height = rect.height

  const COLORS = flawless
    ? ['#fbbf24','#fcd34d','#fde68a','#f59e0b','#fff','#e879f9','#60a5fa','#4ade80']
    : ['#4ade80','#60a5fa','#f59e0b','#e879f9','#f87171','#34d399','#fbbf24']
  const count = flawless ? 260 : 140
  const particles = Array.from({ length: count }, () => ({
    x:        Math.random() * rect.width,
    y:        -20 - Math.random() * rect.height * 0.4,
    vx:       (Math.random() - 0.5) * 3,
    vy:       1.5 + Math.random() * 3,
    rot:      Math.random() * 360,
    rotSpeed: (Math.random() - 0.5) * 10,
    w:        7 + Math.random() * 7,
    h:        4 + Math.random() * 4,
    color:    COLORS[Math.floor(Math.random() * COLORS.length)],
    opacity:  1,
  }))

  if (confettiRaf) cancelAnimationFrame(confettiRaf)

  function step() {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    let anyAlive = false
    for (const p of particles) {
      p.x  += p.vx
      p.y  += p.vy
      p.vy += 0.06   // gravity
      p.rot += p.rotSpeed
      if (p.y > canvas.height * 0.8) p.opacity -= 0.018
      if (p.opacity <= 0) continue
      anyAlive = true
      ctx.save()
      ctx.globalAlpha = Math.max(0, p.opacity)
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rot * Math.PI / 180)
      ctx.fillStyle = p.color
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
      ctx.restore()
    }
    confettiRaf = anyAlive ? requestAnimationFrame(step) : null
  }
  confettiRaf = requestAnimationFrame(step)
}

function stopConfetti() {
  if (confettiRaf) { cancelAnimationFrame(confettiRaf); confettiRaf = null }
  const canvas = $('confetti-canvas')
  if (canvas) { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height) }
}

// ─── New-run countdown ────────────────────────────────────────────────────────

function showNewRunCountdown() {
  const overlay = $('countdown-overlay')
  const numEl   = $('countdown-number')

  clearAnswerTimer()
  clearShowAnswerCountdown()
  countingDown = true
  overlay.classList.remove('hidden')

  const steps = ['3', '2', '1', 'Go!']
  let step = 0

  function showStep() {
    if (step >= steps.length) {
      overlay.classList.add('hidden')
      countingDown = false
      startTraining()
      return
    }
    const text = steps[step++]
    const isGo = text === 'Go!'
    if (text === '3' || text === '2' || text === '1') playCountBeep(false)
    else if (isGo) playCountBeep(true)
    // Remove class, force reflow to restart CSS animation, then re-apply
    numEl.className = ''
    void numEl.offsetWidth
    numEl.className = 'countdown-number' + (isGo ? ' go' : '')
    numEl.textContent = text
    setTimeout(showStep, 850)
  }

  showStep()
}

// ─── Factory detection ────────────────────────────────────────────────────────
// Constructors (con bots, vehicles, commanders) always have an economy category
// because they can build solar collectors, metal extractors, etc.
// Factories (bot labs, vehicle plants, shipyards …) never do — they only produce
// combat units and construction units.  The in-game build menu for factories has
// Factories (labGrids) have exactly one category: 'build'.
// Constructors/commanders have economy/combat/utility/build tabs.
// Minelayers have only 'utility' — they are NOT factories.
function isFactory(builder) {
  const cats = Object.keys(builder.categories)
  return cats.length === 1 && cats[0] === 'build'
}

// ─── Core training flow ───────────────────────────────────────────────────────

function mergeShortcutsIntoQueue(baseQueue) {
  const scItems = buildShortcutQueue()
  if (!scItems.length) return baseQueue
  const merged = []
  let si = 0
  for (let idx = 0; idx < baseQueue.length; idx++) {
    merged.push(baseQueue[idx])
    if (si < scItems.length && (idx + 1) % 3 === 0) merged.push(scItems[si++])
  }
  while (si < scItems.length) merged.push(scItems[si++])
  return merged
}

function precacheIcons(builders) {
  const paths = new Set()

  // Builder icons + every unit icon in their build menus
  for (const builder of builders) {
    if (builder.icon) paths.add(`data/${builder.icon}`)
    for (const cat of Object.values(builder.categories))
      for (const unit of cat.units) {
        const icon = uInfo(unit.id).icon
        if (icon) paths.add(`data/${icon}`)
      }
  }

  // Shortcut context unit icons (commanders, rezbots, transports) for all selected factions
  const factions = settings.factions?.length ? settings.factions : ['armada', 'cortex', 'legion']
  for (const ctxMap of Object.values(SHORTCUT_CONTEXT_UNITS)) {
    for (const faction of factions) {
      const src = unitIconSrc(ctxMap[faction])
      if (src) paths.add(src)
    }
  }

  // Fire fetches immediately — no idle delay. fetch() is explicit, not subject to GC
  // cancellation, and shares the browser's HTTP cache with <img> element loads.
  for (const src of paths) fetch(src, { priority: 'low' }).catch(() => {})
}

/** Preload the builder + unit icons for the next queued question at normal priority. */
function preloadNextQuestion() {
  const next = queue[queueIndex]
  if (!next) return
  const srcs = []
  if (next.type === 'shortcut') {
    // Context unit icon — faction is random, preload all factions for this context
    const ctxMap = SHORTCUT_CONTEXT_UNITS[next.context]
    if (ctxMap) {
      const factions = settings.factions?.length ? settings.factions : ['armada', 'cortex', 'legion']
      for (const faction of factions) srcs.push(unitIconSrc(ctxMap[faction]))
    }
  } else {
    const builder = DATA.builders[next.builderId]
    if (builder?.icon) srcs.push(`data/${builder.icon}`)
    const unit = builder?.categories[next.categoryId]?.units.find(u => u.id === next.unitId)
    if (unit) { const icon = uInfo(unit.id).icon; if (icon) srcs.push(`data/${icon}`) }
  }
  for (const src of srcs) if (src) fetch(src).catch(() => {})
}

function startTraining() {
  deactivateMouseZone()
  const builders = filteredBuilders(settings)
  const queue0   = mergeShortcutsIntoQueue(buildQueue(builders, sr))
  if (!queue0.length) {
    alert('Nothing to train — select at least one faction/tier or a shortcut group.')
    showScreen('setup')
    return
  }
  archiveCurrentRun()   // save any in-progress run before starting fresh
  stopConfetti()
  $('run-complete-col').classList.add('hidden')
  document.querySelector('.question-col').classList.remove('hidden')
  document.querySelector('.menu-col').classList.remove('hidden')
  currentRunEntries = []
  queue      = queue0
  queueIndex = 0
  session    = { correct: 0, late: 0, wrong: 0, streak: 0, totalAnswered: 0 }
  runComplete = false
  paused      = false
  $('btn-skip').classList.remove('hidden')
  $('btn-pause').classList.remove('hidden')
  $('btn-skip').textContent = '↩ Skip'
  $('btn-pause').textContent = '⏸ Pause'
  $('btn-settings').textContent = '◼ Stop'
  $('pause-overlay').classList.add('hidden')
  updateStats()
  renderStatsTable()
  showScreen('training')
  nextQuestion()
}

/** Look up the icon src for any unit ID. */
function unitIconSrc(unitId) {
  if (!unitId) return ''
  if (DATA.builders[unitId]?.icon) return `data/${DATA.builders[unitId].icon}`
  if (DATA.units[unitId]?.icon)    return `data/${DATA.units[unitId].icon}`
  return `data/icons/${unitId}.webp`
}

function resolveShortcutContextUnit(context) {
  if (context === 'none') return { contextUnitId: null, contextUnitName: null, contextFaction: null, contextIcon: '' }
  const factions = settings.factions?.length ? settings.factions : ['armada', 'cortex', 'legion']
  const faction  = factions[Math.floor(Math.random() * factions.length)]
  if (context === 'factory') {
    const allFactories = Object.values(DATA.builders).filter(isFactory)
    const factories = filteredBuilders(settings).filter(isFactory)
    const pool = factories.length ? factories : allFactories
    if (!pool.length) return { contextUnitId: null, contextUnitName: null, contextFaction: faction, contextIcon: '' }
    const picked = pool[Math.floor(Math.random() * pool.length)]
    return { contextUnitId: picked.id, contextUnitName: picked.name, contextFaction: picked.faction ?? faction, contextIcon: `data/${picked.icon}` }
  }
  if (context === 'builder' || context === 'builder-t2') {
    const tier2Only = context === 'builder-t2'
    const isMatch = b => !isFactory(b) && (!tier2Only || b.tier === 2)
    const builders = filteredBuilders(settings).filter(isMatch)
    const pool = builders.length ? builders : Object.values(DATA.builders).filter(isMatch)
    if (!pool.length) return { contextUnitId: null, contextUnitName: null, contextFaction: faction, contextIcon: '' }
    const picked = pool[Math.floor(Math.random() * pool.length)]
    return { contextUnitId: picked.id, contextUnitName: picked.name, contextFaction: picked.faction ?? faction, contextIcon: `data/${picked.icon}` }
  }
  // battle / rezbot / transport
  const ctxMap = SHORTCUT_CONTEXT_UNITS[context]
  if (!ctxMap) return { contextUnitId: null, contextUnitName: null, contextFaction: faction, contextIcon: '' }
  const unitId = ctxMap[faction]
  return {
    contextUnitId:   unitId ?? null,
    contextUnitName: DATA.builders[unitId]?.name ?? unitId ?? null,
    contextFaction:  faction,
    contextIcon:     unitIconSrc(unitId),
  }
}

// Verified by hand against the 12 grid keys (Q W E R A S D F Z X C V) in Chrome:
//   Windows/Linux — every grid key passes through with Shift, Ctrl, Ctrl+Shift and Alt,
//                   except W, which the browser keeps for Ctrl+W and Ctrl+Shift+W.
//   macOS         — every grid key passes through with Shift, Ctrl and Ctrl+Shift.
//                   Cmd+Q and Cmd+W are taken; every other grid key is fine with Cmd.
// Keys outside the grid (T, H, L, J, U, P, N, O, digits, F-keys) are untested here and
// keep their known browser bindings. Ctrl+C/V/X/D still fire keydown before the browser
// acts on them, so they are NOT reserved even though the browser reacts too.
const BROWSER_RESERVED_KEYS = {
  all:      { ctrl:      new Set(['Tab']),
              ctrlShift: new Set(['Tab']) },
  winlinux: { ctrl:      new Set(['W','T','H','L','J','U','P','N','O','1','2','3','4','5','6','7','8']),
              ctrlShift: new Set(['W','T','N','J','I']),
              altShift:  new Set() },
  mac:      { ctrl:      new Set(['F1','F2','F3','F4']),
              ctrlShift: new Set(),
              // Cmd+Q quits Chrome, Cmd+W closes the tab, Cmd+T opens one — and with the
              // Cmd↔Alt swap on, these are what Alt+Q, Alt+W and Alt+T actually become.
              cmd:       new Set(['Q','W','T']),
              // Cmd+Shift+3/4/5 are macOS screenshot shortcuts, taken before the browser sees them
              cmdShift:  new Set(['3','4','5']) },
  firefox:  { ctrl:      new Set(['Q','F1','F2']),
              ctrlShift: new Set(['K']) },
}

function isBrowserReserved(key, mods) {
  if (mods.some(m => m === 'Ctrl')) {
    const type = mods.some(m => m === 'Shift') ? 'ctrlShift' : 'ctrl'
    if (BROWSER_RESERVED_KEYS.all[type]?.has(key))                    return true
    if (!IS_MAC    && BROWSER_RESERVED_KEYS.winlinux[type]?.has(key)) return true
    if (IS_MAC     && BROWSER_RESERVED_KEYS.mac[type]?.has(key))      return true
    if (IS_FIREFOX && BROWSER_RESERVED_KEYS.firefox[type]?.has(key))  return true
  }
  const hasAlt = mods.some(m => m === 'Alt')
  if (hasAlt && mods.some(m => m === 'Shift')) {
    if (!IS_MAC && BROWSER_RESERVED_KEYS.winlinux.altShift.has(key)) return true
  }
  // With the Cmd↔Alt swap on, an Alt shortcut is pressed as Cmd — so Cmd's own
  // bindings (Cmd+Q quits, Cmd+W closes the tab) make those unreachable here.
  if (hasAlt && IS_MAC && settings.swapCmdAlt && BROWSER_RESERVED_KEYS.mac.cmd.has(key)) return true
  return false
}

// Taken by the OS before any browser sees it, so it can't even be demonstrated here.
// Unlike browser-reserved keys these get no study card — the queue just skips them,
// which is fine where sibling keys teach the same command (presets 1 and 2 cover 3).
function isOsReserved(key, mods) {
  if (!IS_MAC || !settings.swapCmdAlt) return false
  if (!(mods.some(m => m === 'Alt') && mods.some(m => m === 'Shift'))) return false
  return BROWSER_RESERVED_KEYS.mac.cmdShift.has(key)   // Cmd+Shift+3/4/5 = macOS screenshots
}

function pickFactoryBuildMod(gridKey) {
  if (!settings.buildModifiers) return 'none'
  const threshold = difficultyThreshold()
  let mods = Object.entries(FACTORY_MODS)
    .filter(([, lvl]) => threshold === Infinity || lvl <= threshold)
    .map(([mod]) => mod)
  if (!mods.length) mods = ['none']
  const key    = (gridKey ?? '').toUpperCase()
  const ctrlR   = isBrowserReserved(key, ['Ctrl'])
  const csR     = isBrowserReserved(key, ['Ctrl', 'Shift'])
  const macCmdR = IS_MAC && settings.swapCmdAlt && (BROWSER_RESERVED_KEYS.mac.cmd.has(key) || ctrlR)
  if (ctrlR)   mods = mods.filter(m => m !== 'ctrl' && m !== 'ctrl-shift')
  if (csR)     mods = mods.filter(m => m !== 'ctrl-shift')
  if (macCmdR) mods = mods.filter(m => m !== 'alt')
  if (!mods.length) mods = ['none']
  return mods[Math.floor(Math.random() * mods.length)]
}

function nextQuestion() {
  deactivateMouseZone()
  clearLearnPin()
  if (queueIndex >= queue.length) {
    // Rebuild queue from current settings every time we loop — picks up any
    // faction/tier/shortcut changes made since the last rebuild.
    queue      = mergeShortcutsIntoQueue(buildQueue(filteredBuilders(settings), sr))
    queueIndex = 0
  }

  const item = queue[queueIndex++]
  questionHadWrong = false

  if (item.type === 'shortcut') {
    const { contextUnitId, contextUnitName, contextFaction } = resolveShortcutContextUnit(item.context)
    currentEntry = { ...item, seqStep: 0, contextUnitId, contextUnitName, contextFaction }
    $('screen-training').classList.add('shortcut-mode')
    renderShortcutQuestion(currentEntry)
    questionStartTime = Date.now()
    preloadNextQuestion()

    if (item.browserReserved) {
      // Browser intercepts this key combo — can't be typed here. Show it as a study card.
      showAnswer('⌨ Browser shortcut — study it, then press Enter or Space to continue')
      return
    }

    if (settings.mouseEnabled && item.mouseAction && item.mouseAction !== 'none') showMouseZonePending(item.mouseAction)
    trainingState = State.WAITING_SHORTCUT
    startShortcutKeyTimer()   // reveals key after 3 s; updateInstruction called by timer
    updateInstruction()       // shows "What is the shortcut key?" immediately
    startAnswerTimer()
    return
  }

  // Build-menu question
  $('screen-training').classList.remove('shortcut-mode')
  const builder = DATA.builders[item.builderId]
  const cat     = builder.categories[item.categoryId]
  const unit    = cat.units.find(u => u.id === item.unitId)

  currentEntry  = { ...item, builder, unit }
  currentPage   = 0

  if (isFactory(builder)) {
    // Factories have no category tabs in-game — go straight to grid key
    trainingState = item.page > 0 ? State.WAITING_PAGE : State.WAITING_GRID
    activeCatId   = item.categoryId   // show the correct category immediately
    currentEntry.buildModifier = pickFactoryBuildMod(unit?.key)
    // No mouse zone for factory builds — modifier is held on the grid key itself
  } else {
    // Constructors: no category pre-selected — grid shows units but no key labels
    trainingState = State.WAITING_CATEGORY
    activeCatId   = null
    let buildMod = 'click'
    if (settings.mouseEnabled && settings.buildModifiers) {
      const threshold = difficultyThreshold()
      const availMods = Object.entries(CONSTRUCTOR_MODS)
        .filter(([, lvl]) => threshold === Infinity || lvl <= threshold)
        .map(([mod]) => mod)
      buildMod = availMods[Math.floor(Math.random() * availMods.length)] ?? 'click'
    }
    currentEntry.buildModifier = buildMod
    if (settings.mouseEnabled) showMouseZonePending(buildMod)
  }
  updateBuildActionLabel()

  renderQuestion(currentEntry)
  renderMenu(builder, activeCatId, 0)
  updateInstruction()
  clearHintTimer()
  startHintTimer(settings.hintTimeout)
  questionStartTime = Date.now()
  startAnswerTimer()
  preloadNextQuestion()
}

function formatShortcutKeyHtml(seqKeys, seqMods, currentStep) {
  const isQwertz = settings.keyboard === 'qwertz'
  return seqKeys.map((key, idx) => {
    const mods = seqMods[idx] ?? []
    // For single chars use display() so QWERTZ users see their physical key (Z→Y, :→Ö, ]→+)
    const rawLabel = key.length === 1 ? key.toUpperCase() : key  // Tab, F6 keep their casing
    const keyLabel = display(rawLabel, isQwertz)
    const parts = [...mods.map(m => `<kbd>${m.toLowerCase() === 'alt' ? 'Alt' : displayMod(m)}</kbd>`), `<kbd>${keyLabel}</kbd>`]
    const keyHtml = parts.join('+')
    const note = idx === currentStep ? macSwapNote(mods) : ''
    return idx === currentStep ? `<strong>${keyHtml}</strong>${note}` : keyHtml
  }).join(' → ')
}

function updateInstruction() {
  if (trainingState === State.WAITING_MOUSE) return
  if (trainingState === State.WAITING_SHORTCUT) {
    if (!shortcutKeyVisible) {
      setInstruction('What is the <strong>shortcut key</strong> for this command?')
      return
    }
    const entry   = currentEntry
    const keyHtml = formatShortcutKeyHtml(entry.seqKeys, entry.seqMods, entry.seqStep)
    setInstruction(`Press ${keyHtml}`)
    return
  }
  if (trainingState === State.WAITING_CATEGORY) {
    setInstruction('Press the <strong>category key</strong>')
  } else if (trainingState === State.WAITING_SHIFT) {
    setInstruction(`Wrong category — press <kbd>Shift</kbd> or <kbd>Esc</kbd> to go back`, 'state-wrong')
  } else if (trainingState === State.WAITING_PAGE) {
    setInstruction(`Press <kbd>B</kbd> to advance to page ${currentEntry.page + 1}`)
  } else if (trainingState === State.WAITING_GRID) {
    setInstruction(`${buildModHint()}Press the <strong>grid key</strong>`)
  }
}

function buildModHint() {
  if (trainingState !== State.WAITING_GRID) return ''
  const mod = currentEntry?.buildModifier
  if (!mod || mod === 'none') return ''
  if (!currentEntry?.builder || !isFactory(currentEntry.builder)) return ''
  const modLabels = {
    'shift':      `<kbd>Shift</kbd>`,
    'ctrl':       `<kbd>Ctrl</kbd>`,
    'ctrl-shift': `<kbd>Ctrl</kbd>+<kbd>Shift</kbd>`,
    'alt':        `<kbd>Alt</kbd>${macSwapNote(['alt'])}`,
  }
  const label = modLabels[mod]
  return label ? `Hold ${label} · ` : ''
}

const SVG_QUEUE = `<svg width="44" height="44" viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#bmbq_clip)"><path d="M64 54.5C64 61.9558 70.0442 68 77.5 68C84.9558 68 91 61.9558 91 54.5C91 47.0442 84.9558 41 77.5 41C70.0442 41 64 47.0442 64 54.5Z" fill="#2B682A" fill-opacity="0.32" stroke="#00FF00" stroke-width="2"/><g filter="url(#bmbq_f0)"><path d="M17 22L17 20L15 20L15 22L17 22ZM78 22L80 22L80 20L78 20L78 22ZM78 54.9999L89.547 34.9999L66.453 34.9999L78 54.9999ZM18.9999 54.9999L19 22L15 22L14.9999 54.9999L18.9999 54.9999ZM17 24L78 24L78 20L17 20L17 24ZM76 22L76 36.9999L80 36.9999L80 22L76 22Z" fill="white"/></g><path d="M4 54.5C4 61.9558 10.0442 68 17.5 68C24.9558 68 31 61.9558 31 54.5C31 47.0442 24.9558 41 17.5 41C10.0442 41 4 47.0442 4 54.5Z" fill="#2B682A" fill-opacity="0.32" stroke="#00FF00" stroke-width="2"/><path d="M34 23.5C34 30.9558 40.0442 37 47.5 37C54.9558 37 61 30.9558 61 23.5C61 16.0442 54.9558 10 47.5 10C40.0442 10 34 16.0442 34 23.5Z" fill="#2B682A" fill-opacity="0.32" stroke="#00FF00" stroke-width="2"/></g><defs><filter id="bmbq_f0" x="13" y="20" width="78.5471" height="43.9999" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/><feOffset dy="5"/><feGaussianBlur stdDeviation="1"/><feComposite in2="hardAlpha" operator="out"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.76 0"/><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/><feOffset dy="9"/><feComposite in2="hardAlpha" operator="out"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0"/><feBlend mode="normal" in2="effect1_dropShadow" result="effect2_dropShadow"/><feBlend mode="normal" in="SourceGraphic" in2="effect2_dropShadow" result="shape"/></filter><clipPath id="bmbq_clip"><rect width="96" height="96" fill="white"/></clipPath></defs></svg>`

const SVG_QUEUE_FRONT = `<svg width="44" height="44" viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#bmbqf_clip)"><path d="M4.5 48C4.5 55.4558 10.5442 61.5 18 61.5C25.4558 61.5 31.5 55.4558 31.5 48C31.5 40.5442 25.4558 34.5 18 34.5C10.5442 34.5 4.5 40.5442 4.5 48Z" fill="#2B682A" fill-opacity="0.32" stroke="#00FF00" stroke-width="2"/><path d="M34.5 17C34.5 24.4558 40.5442 30.5 48 30.5C55.4558 30.5 61.5 24.4558 61.5 17C61.5 9.54416 55.4558 3.5 48 3.5C40.5442 3.5 34.5 9.54416 34.5 17Z" fill="#2B682A" fill-opacity="0.32" stroke="#00FF00" stroke-width="2"/><g filter="url(#bmbqf_f0)"><path fill-rule="evenodd" clip-rule="evenodd" d="M19.4546 40H16.5454V46.5454H10V49.4546H16.5454V56H19.4546V49.4546H26V46.5454H19.4546V40Z" stroke="white" stroke-width="4"/></g><g filter="url(#bmbqf_f1)"><path d="M78.5 90.5V92.5H80.5V90.5H78.5ZM18 90.5H16V92.5H18V90.5ZM18 62L6.45296 82H29.547L18 62ZM78.5 88.5H18V92.5H78.5V88.5ZM20 90.5V80H16V90.5H20ZM80.5 90.5V48.5H76.5V90.5H80.5Z" fill="white"/></g><path d="M64.5 48C64.5 55.4558 70.5442 61.5 78 61.5C85.4558 61.5 91.5 55.4558 91.5 48C91.5 40.5442 85.4558 34.5 78 34.5C70.5442 34.5 64.5 40.5442 64.5 48Z" fill="#2B682A" fill-opacity="0.32" stroke="#00FF00" stroke-width="2"/></g><defs><filter id="bmbqf_f0" x="5" y="38" width="24" height="24" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/><feOffset dx="-1" dy="2"/><feGaussianBlur stdDeviation="1"/><feComposite in2="hardAlpha" operator="out"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.76 0"/><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow"/><feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape"/></filter><filter id="bmbqf_f1" x="4.45288" y="48.5" width="78.0471" height="53" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/><feOffset dy="5"/><feGaussianBlur stdDeviation="1"/><feComposite in2="hardAlpha" operator="out"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.76 0"/><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/><feOffset dy="9"/><feComposite in2="hardAlpha" operator="out"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0"/><feBlend mode="normal" in2="effect1_dropShadow" result="effect2_dropShadow"/><feBlend mode="normal" in="SourceGraphic" in2="effect2_dropShadow" result="shape"/></filter><clipPath id="bmbqf_clip"><rect width="96" height="96" fill="white"/></clipPath></defs></svg>`

function buildModBadgeSvg(mod, factory) {
  const img = (src) => `<img src="data/${src}" width="44" height="44" alt="">`
  if (factory) {
    if (mod === 'shift')      return img('badge-p5.avif')
    if (mod === 'ctrl')       return img('badge-p20.avif')
    if (mod === 'ctrl-shift') return img('badge-p100.avif')
    if (mod === 'alt')        return img('badge-front.avif')
    return ''
  } else {
    if (mod === 'shift-click') return SVG_QUEUE
    if (mod === 'space-click') return SVG_QUEUE_FRONT
    return ''
  }
}

function updateBuildModBadge() {
  const badge = $('build-mod-badge')
  if (!badge) return
  const mod = currentEntry?.buildModifier
  const factory = currentEntry?.builder ? isFactory(currentEntry.builder) : false
  const svg = (mod && mod !== 'none' && mod !== 'click') ? buildModBadgeSvg(mod, factory) : ''
  if (svg) {
    badge.innerHTML = svg
    badge.classList.remove('hidden')
  } else {
    badge.innerHTML = ''
    badge.classList.add('hidden')
  }
}

function updateBuildActionLabel() {
  const el = $('build-action-label')
  if (!el) return
  const mod = currentEntry?.buildModifier
  let text = 'Build'
  if (isFactory(currentEntry?.builder)) {
    if (mod === 'shift')      text = 'Queue Build ×5'
    else if (mod === 'ctrl')       text = 'Queue Build ×20'
    else if (mod === 'ctrl-shift') text = 'Queue Build ×100'
    else if (mod === 'alt')        text = 'Queue to Front'
  } else {
    if (mod === 'shift-click') text = 'Queue Build'
    else if (mod === 'space-click') text = 'Build (instant)'
  }
  el.textContent = text
}

// ─── Key handling ─────────────────────────────────────────────────────────────

// Shared handler for "go back from wrong category" — called from both keydown and keyup
// so that browsers which swallow the Shift keydown (e.g. when focus is on a button) still
// respond on keyup.
function handleGoBack() {
  if (trainingState !== State.WAITING_SHIFT) return
  activeCatId   = null
  trainingState = State.WAITING_CATEGORY
  renderMenu(currentEntry.builder, null, 0)
  updateInstruction()
}

function onKey(event) {
  // Block input during the new-run countdown
  if (countingDown) return

  // Handle shortcut state BEFORE the modifier-key bail-out, so Ctrl/Alt+key shortcuts work
  if (trainingState === State.WAITING_SHORTCUT) {
    if (effectiveMeta(event)) return
    if (['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)) return
    // Space held as modifier (Space+X = show explosion radius) — consume and wait for the chord key
    if (event.key === ' ' && !event.shiftKey && !event.repeat) {
      spaceHeld = true
      event.preventDefault()
      return
    }
    // Ignore bare modifier key presses (fire before the actual key in e.g. Ctrl+S, Alt+B)
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return
    event.preventDefault()
    const key  = normalise(event.key, settings.keyboard === 'qwertz', event.code)
    const mods = []
    if (event.ctrlKey)      mods.push('ctrl')
    if (effectiveAlt(event)) mods.push('alt')
    if (event.shiftKey)     mods.push('shift')
    if (spaceHeld)          mods.push('space')
    handleShortcutKey(key, mods)
    return
  }

  // SHOW_ANSWER: checked before the Ctrl/Alt guard so modifier+key shortcuts can also advance
  if (trainingState === State.SHOW_ANSWER) {
    if (effectiveMeta(event)) return
    if (['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)) return
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); advanceFromAnswer(); return
    }
    // Pressing the correct answer key also advances (handles the case where the
    // user presses the right key just as the timer runs out)
    if (currentEntry) {
      const pressedKey = normalise(event.key, settings.keyboard === 'qwertz', event.code)
      let isCorrect = false
      if (currentEntry.type === 'shortcut') {
        const lastIdx   = currentEntry.seqKeys.length - 1
        const lastMods  = currentEntry.seqMods[lastIdx] ?? []
        const wantsCtrl  = lastMods.some(m => m === 'ctrl')
        const wantsAlt   = lastMods.some(m => m === 'alt')
        const wantsShift = lastMods.some(m => m === 'shift')
        isCorrect = (event.ctrlKey       === wantsCtrl)  &&
                    (effectiveAlt(event) === wantsAlt)   &&
                    (event.shiftKey === wantsShift) &&
                    keysMatch(pressedKey, currentEntry.seqKeys[lastIdx].toUpperCase())
      } else {
        isCorrect = !event.ctrlKey && !event.altKey && (keysMatch(pressedKey, currentEntry.gridKey) || isEquivGridKey(pressedKey))
      }
      if (isCorrect) { event.preventDefault(); advanceFromAnswer(); return }
    }
    return
  }

  // Global Space tracking — Space is always a modifier key, never a direct action.
  // Track it here so Space held before pressing the grid key carries into the mouse phase.
  if (event.key === ' ' && !event.repeat) {
    spaceHeld = true
    event.preventDefault()
    if (trainingState === State.WAITING_MOUSE) mouseZoneSpaceHeld = true
    return
  }

  // Block keypresses while waiting for mouse interaction
  if (trainingState === State.WAITING_MOUSE) return

  // Allow modifier+key for factory grid builds (Shift/Ctrl/Alt held with grid key)
  const isFactoryGridMod = (trainingState === State.WAITING_GRID)
    && currentEntry?.builder && isFactory(currentEntry.builder)
    && currentEntry?.buildModifier && currentEntry.buildModifier !== 'none'
  // The reference screen explains modifier combos, so it needs to see them too
  const isBrowseMod = screens.browse.classList.contains('active')
  // Ignore modifier combos everywhere else
  if (!isFactoryGridMod && !isBrowseMod && (event.ctrlKey || event.altKey || event.metaKey)) return
  if (['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)) return

  // Escape: go back from wrong category first; fall through to pause toggle otherwise
  if (event.key === 'Escape' && screens.training.classList.contains('active')) {
    event.preventDefault()
    if (trainingState === State.WAITING_SHIFT) { handleGoBack(); return }
    togglePause()
    return
  }

  // While paused, block all other input
  if (paused) return

  const key = normalise(event.key, settings.keyboard === 'qwertz', event.code)

  // Browse screen: Escape/Shift = leave the category; category switching + pagination
  if (screens.browse.classList.contains('active')) {
    if (event.key === 'Escape') {
      if (browseExitCategory()) event.preventDefault()
      return
    }
    // In game Shift only backs out on release, so a chord like Shift+Q reaches the grid
    // instead of dropping you out of the category the moment Shift goes down.
    if (event.key === 'Shift') { browseShiftSolo = true; return }
    browseShiftSolo = false
    if (browseBuilder) {
      if (browseCatId === null) {
        const matched = CATEGORIES.find(c => c.key === key)
        if (matched && browseBuilder.categories[matched.id]) {
          browseCatId = matched.id
          browsePage  = 0
          renderBrowseMenu()
          return
        }
      }
      if (key === 'B') { browsePageDelta(+1); return }
      // Any other grid key explains what it builds, and what the held modifier does to it
      if (browseCatId !== null && GRID_KEYS.includes(key)) {
        event.preventDefault()
        showBrowseModResult(key, event)
        flashBrowseSlot(key)
        return
      }
    }
    return
  }

  // The shortcuts reference runs its own key handling; without this, keys pressed there
  // also reach the training logic below and act on whatever state the last run left.
  if (screens.shortcuts.classList.contains('active')) return

  // Training screen
  if (trainingState === State.WAITING_CATEGORY) {
    handleCategoryKey(key)
  } else if (trainingState === State.WAITING_SHIFT) {
    // Only Shift (handled above) gets you out — all other keys are ignored
  } else if (trainingState === State.WAITING_PAGE || trainingState === State.WAITING_GRID) {
    if (key === 'B') {
      handlePageKey()
    } else if (trainingState === State.WAITING_GRID && GRID_KEYS.includes(key)) {
        // Factory build modifiers ride on Ctrl/Alt, which collide with the browser's own
        // shortcuts (Ctrl+Shift+A opens Chrome's tab search). We accept the key either
        // way, so swallow the event to stop the browser acting on it as well.
        if (event.ctrlKey || event.altKey || event.metaKey) event.preventDefault()
        handleGridKey(key, event)
    }
  }
}

function handleCategoryKey(key) {
  if (!currentEntry) return  // stale training state with no question loaded
  const matched = CATEGORIES.find(c => keysMatch(c.key, key))
  if (!matched) return  // not a category key — ignore

  const correct = matched.id === currentEntry.categoryId

  if (correct) {
    flashTab(matched.id, 'flash-correct')
    activeCatId  = matched.id
    currentPage  = 0
    renderMenu(currentEntry.builder, activeCatId, currentPage)

    if (currentEntry.page > 0) {
      trainingState = State.WAITING_PAGE
      updateInstruction()
    } else if (isBottomRowItem(currentEntry)) {
      // The category key also activates the bottom-row slot — one press does it all
      flashSlot(currentEntry.gridKey, 'flash-correct')
      const autoSlot = $('menu-grid').querySelector(`[data-key="${currentEntry.gridKey}"]`)
      if (autoSlot && !autoSlot.classList.contains('empty')) autoSlot.classList.add('is-selected')
      playBuildSound('builder')
      if (settings.mouseEnabled) {
        trainingState = State.WAITING_MOUSE
        activateMouseZone(currentEntry.buildModifier ?? 'click')
      } else {
        clearAnswerTimer()
        recordResult(questionHadWrong ? 'late' : 'correct')
        setInstruction('✓ Correct!', 'state-correct')
        trainingState = State.FEEDBACK
        setTimeout(() => checkRunEnd(), 900)
      }
    } else {
      trainingState = State.WAITING_GRID
      updateInstruction()
    }
  } else {
    // Switch to the wrong category tab (mirrors in-game behaviour) and require
    // Shift or Escape to go back — just like the real game.
    questionHadWrong = true
    activeCatId = matched.id
    currentPage = 0
    renderMenu(currentEntry.builder, activeCatId, currentPage)
    trainingState = State.WAITING_SHIFT
    updateInstruction()
  }
}

function handlePageKey() {
  const cat        = currentEntry.builder.categories[activeCatId]
  const totalPages = cat ? ((cat.units[cat.units.length - 1]?.page ?? 0) + 1) : 1
  currentPage      = (currentPage + 1) % totalPages
  renderMenu(currentEntry.builder, activeCatId, currentPage)
  trainingState = (currentPage === currentEntry.page) ? State.WAITING_GRID : State.WAITING_PAGE
  updateInstruction()
}

function handleGridKey(key, event) {
  const correct = keysMatch(key, currentEntry.gridKey) || isEquivGridKey(key)

  if (!correct) {
    // Silently ignore wrong grid key — no flash, no message
    questionHadWrong = true
    // Stay in WAITING_GRID — timer keeps running, user can self-correct
    return
  }

  // For factory builds: modifier must be held on the grid key itself
  if (isFactory(currentEntry.builder)) {
    const mod = currentEntry.buildModifier ?? 'none'
    if (mod !== 'none') {
      let modOk = false
      let modHint = ''
      if (mod === 'shift') {
        modOk = !!(event?.shiftKey && !event?.ctrlKey && !effectiveAlt(event))
        modHint = 'Hold <kbd>Shift</kbd> while pressing the grid key!'
      } else if (mod === 'ctrl') {
        modOk = !!(event?.ctrlKey && !event?.shiftKey && !effectiveAlt(event))
        modHint = 'Hold <kbd>Ctrl</kbd> while pressing the grid key!'
      } else if (mod === 'ctrl-shift') {
        modOk = !!(event?.ctrlKey && event?.shiftKey && !effectiveAlt(event))
        modHint = 'Hold <kbd>Ctrl+Shift</kbd> while pressing the grid key!'
      } else if (mod === 'alt') {
        modOk = !!(effectiveAlt(event) && !event?.ctrlKey && !event?.shiftKey)
        modHint = `Hold <kbd>Alt</kbd>${macSwapNote(['alt'])} while pressing the grid key!`
      }
      if (!modOk) {
        questionHadWrong = true
        setInstruction(modHint, 'state-wrong')
        return  // stay in WAITING_GRID, user can retry with correct modifier
      }
    }
    // Factory: correct key (+modifier) — done, no mouse phase
    flashSlot(key, 'flash-correct')
    const selectedSlot = document.querySelector(`#menu-grid .slot[data-key="${key}"]`)
    if (selectedSlot) selectedSlot.classList.add('is-selected')
    playBuildSound('factory')
    clearAnswerTimer()
    recordResult(questionHadWrong ? 'late' : 'correct')
    setInstruction('✓ Correct!', 'state-correct')
    trainingState = State.FEEDBACK
    setTimeout(() => checkRunEnd(), 900)
    return
  }

  // Constructor: correct grid key — show mouse zone
  flashSlot(key, 'flash-correct')
  const selectedSlot = document.querySelector(`#menu-grid .slot[data-key="${key}"]`)
  if (selectedSlot) selectedSlot.classList.add('is-selected')
  playBuildSound('builder')
  if (settings.mouseEnabled) {
    trainingState = State.WAITING_MOUSE
    activateMouseZone(currentEntry.buildModifier ?? 'click')
  } else {
    clearAnswerTimer()
    recordResult(questionHadWrong ? 'late' : 'correct')
    setInstruction('✓ Correct!', 'state-correct')
    trainingState = State.FEEDBACK
    setTimeout(() => checkRunEnd(), 900)
  }
}

function handleShortcutKey(key, mods) {
  const entry       = currentEntry
  const expectedKey  = entry.seqKeys[entry.seqStep]
  const expectedMods = (entry.seqMods[entry.seqStep] ?? []).map(m => m.toLowerCase())
  const modsMatch    = JSON.stringify([...mods].sort()) === JSON.stringify([...expectedMods].sort())
  const keyMatch     = keysMatch(key, expectedKey.toUpperCase())

  if (modsMatch && keyMatch) {
    if (entry.seqStep < entry.seqKeys.length - 1) {
      // More keys in the sequence to come
      entry.seqStep++
      updateInstruction()
    } else {
      // Final key — correct!
      clearShortcutKeyTimer()
      const action = entry.mouseAction ?? 'none'
      if (settings.mouseEnabled && action && action !== 'none') {
        trainingState = State.WAITING_MOUSE
        activateMouseZone(action)
      } else {
        playBuildSound('builder')
        clearAnswerTimer()
        recordResult(questionHadWrong ? 'late' : 'correct')
        setInstruction('✓ Correct!', 'state-correct')
        trainingState = State.FEEDBACK
        setTimeout(() => checkRunEnd(), 900)
      }
    }
  } else {
    // Wrong key — reset sequence, reveal the correct key immediately
    questionHadWrong = true
    entry.seqStep = 0
    shortcutKeyVisible = true
    clearShortcutKeyTimer()
    updateInstruction()
  }
}

function recordResult(outcome) {
  // outcome: 'correct' | 'late' | 'wrong'
  // 'correct' = right on first try
  // 'late'    = correct eventually but had wrong attempts first
  // 'wrong'   = timer expired with no correct answer
  session.totalAnswered++

  const ms        = Date.now() - questionStartTime
  const studyCard = !!(currentEntry.browserReserved)

  if (currentEntry.type === 'shortcut') {
    currentRunEntries.push({
      unitId:      currentEntry.id,
      builderId:   'shortcut',
      unitName:    currentEntry.label,
      builderName: 'Shortcut',
      ms,
      outcome,
      studyCard,
    })
    renderStatsTable()
    if (outcome === 'correct') {
      session.correct++
      session.streak++
    } else if (outcome === 'late') {
      session.late++
      session.streak = 0
    } else {
      session.wrong++
      session.streak = 0
    }
    updateStats()
    return
  }

  const srKey   = `${currentEntry.builderId}:${currentEntry.unitId}`
  const quality = outcome === 'correct' ? 5 : 1
  sr[srKey] = srNext(sr[srKey], quality)
  saveSR(sr)

  currentRunEntries.push({
    unitId:      currentEntry.unitId,
    builderId:   currentEntry.builderId,
    unitName:    uInfo(currentEntry.unitId).name,
    builderName: currentEntry.builder.name,
    ms,
    outcome,
    studyCard: false,
  })
  renderStatsTable()

  if (outcome === 'correct') {
    session.correct++
    session.streak++
  } else if (outcome === 'late') {
    session.late++
    session.streak = 0
  } else {
    session.wrong++
    session.streak = 0
  }
  updateStats()
}

// ─── Mouse zone ───────────────────────────────────────────────────────────────

const MOUSE_TARGET_POSITIONS = [
  { x: 60,  y: 65  },
  { x: 150, y: 55  },
  { x: 110, y: 100 },
  { x: 55,  y: 108 },
  { x: 175, y: 98  },
]

const MOUSE_ACTION_LABELS = {
  'click':              'Click to place',
  'shift-click':        'Shift + Click (queue)',
  'space-click':        'Space + Click (instant)',
  'click-unit':         'Click the unit',
  'drag':               'Drag to set area',
  'alt-drag':           'Hold Alt · Drag area',
  'click-or-drag':      'Click or drag',
  'click-unit-or-drag': 'Click unit or drag',
}

let mouseZoneSpaceHeld = false

function showMouseZonePending(action) {
  currentMouseAction = action
  const zone = $('mouse-zone')
  if (!zone) return
  zone.classList.remove('mouse-zone-active')
  zone.classList.add('mouse-zone-pending')
  const targetEl = $('mouse-zone-target')
  if (targetEl) targetEl.style.display = 'none'
  const labelEl = $('mouse-zone-label')
  if (labelEl) labelEl.textContent = MOUSE_ACTION_LABELS[action] || ''

}

function activateMouseZone(action) {
  currentMouseAction = action
  mouseZoneSpaceHeld = spaceHeld  // carry over Space held before the grid key was pressed
  const zone = $('mouse-zone')
  if (!zone) return
  zone.classList.remove('mouse-zone-pending')
  zone.classList.add('mouse-zone-active')

  const needsUnitTarget = action === 'click-unit' || action === 'click-unit-or-drag'
  const targetEl = $('mouse-zone-target')

  if (needsUnitTarget && targetEl) {
    const pos = MOUSE_TARGET_POSITIONS[Math.floor(Math.random() * MOUSE_TARGET_POSITIONS.length)]
    targetEl.style.left    = `${pos.x}px`
    targetEl.style.top     = `${pos.y}px`
    targetEl.style.display = 'flex'
    const iconEl = $('mouse-zone-target-icon')
    if (iconEl) iconEl.src = currentEntry?.contextIcon || unitIconSrc(currentEntry?.contextUnitId) || ''
  } else if (targetEl) {
    targetEl.style.display = 'none'
  }

  const labelEl = $('mouse-zone-label')
  const labelText = MOUSE_ACTION_LABELS[action] || ''
  if (labelEl) labelEl.textContent = labelText

  const instrHtml = action === 'alt-drag'
    ? `Hold <kbd>Alt</kbd>${macSwapNote(['alt'])} · Drag area`
    : (labelText || 'Click to place')
  setInstruction(instrHtml, 'state-correct')

  // Give a fresh timer window for the mouse phase so leftover keyboard time doesn't cut it short
  if (settings.timeLimit) {
    const mouseMs = settings.timeLimit * 1000
    answerTimerEnd   = Date.now() + mouseMs
    currentTimeLimitMs = mouseMs
    updateTimerDisplay(1)
    if (answerTimerId === null) {
      $('timer-wrap').classList.remove('hidden')
      answerTimerId = setInterval(tickAnswerTimer, 50)
    }
  }
}

function deactivateMouseZone() {
  currentMouseAction = null
  mouseZoneSpaceHeld = false
  const zone = $('mouse-zone')
  if (!zone) return
  zone.classList.remove('mouse-zone-active', 'mouse-zone-pending')
  const svgEl = $('mouse-zone-svg')
  if (svgEl) svgEl.innerHTML = ''
  const targetEl = $('mouse-zone-target')
  if (targetEl) targetEl.style.display = 'none'
  document.querySelectorAll('#menu-grid .slot.is-selected').forEach(s => s.classList.remove('is-selected'))
  const labelEl = $('mouse-zone-label')
  if (labelEl) labelEl.textContent = ''
}

function handleMouseComplete(wasClick) {
  deactivateMouseZone()
  playBuildSound(wasClick ? 'builder' : 'factory')
  clearAnswerTimer()
  recordResult(questionHadWrong ? 'late' : 'correct')
  setInstruction('✓ Correct!', 'state-correct')
  trainingState = State.FEEDBACK
  setTimeout(() => checkRunEnd(), 900)
}

function initMouseZone() {
  const zone = $('mouse-zone')
  if (!zone) return

  let dragOrigin = null   // { x, y } zone-local px, set on mousedown

  zone.addEventListener('mousedown', e => {
    if (trainingState !== State.WAITING_MOUSE) return
    const rect = zone.getBoundingClientRect()
    dragOrigin = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    e.preventDefault()
  })

  zone.addEventListener('mousemove', e => {
    if (!dragOrigin || trainingState !== State.WAITING_MOUSE) return
    const action = currentMouseAction
    if (action !== 'drag' && action !== 'alt-drag' && action !== 'click-or-drag' && action !== 'click-unit-or-drag') return

    const rect = zone.getBoundingClientRect()
    const mx   = e.clientX - rect.left
    const my   = e.clientY - rect.top
    const r    = Math.hypot(mx - dragOrigin.x, my - dragOrigin.y)
    if (r < 5) return

    const svg = $('mouse-zone-svg')
    if (svg) svg.innerHTML =
      `<circle cx="${dragOrigin.x}" cy="${dragOrigin.y}" r="${r}"
        fill="rgba(0,200,0,0.10)" stroke="rgba(0,210,0,0.75)"
        stroke-width="1.5" stroke-dasharray="6 3"/>
      <circle cx="${dragOrigin.x}" cy="${dragOrigin.y}" r="4"
        fill="rgba(0,210,0,0.9)"/>`
  })

  zone.addEventListener('mouseup', e => {
    if (!dragOrigin || trainingState !== State.WAITING_MOUSE) return

    const rect   = zone.getBoundingClientRect()
    const mx     = e.clientX - rect.left
    const my     = e.clientY - rect.top
    const dist   = Math.hypot(mx - dragOrigin.x, my - dragOrigin.y)
    const origin = dragOrigin
    dragOrigin   = null
    const svg    = $('mouse-zone-svg')
    if (svg) svg.innerHTML = ''

    const action  = currentMouseAction
    const isDrag  = dist >= 20
    const isClick = dist < 10

    if (action === 'drag') {
      if (isDrag) handleMouseComplete(false)
    } else if (action === 'alt-drag') {
      if (!isDrag) return
      if (!effectiveAlt(e)) {
        questionHadWrong = true
        setInstruction(`Hold <kbd>Alt</kbd>${macSwapNote(['alt'])} while dragging!`, 'state-wrong')
        return
      }
      handleMouseComplete(false)
    } else if (action === 'shift-click') {
      if (!isClick) return
      if (!e.shiftKey) {
        questionHadWrong = true
        setInstruction('Hold <kbd>Shift</kbd> while clicking!', 'state-wrong')
        return
      }
      handleMouseComplete(true)
    } else if (action === 'space-click') {
      if (!isClick) return
      if (!mouseZoneSpaceHeld) {
        questionHadWrong = true
        setInstruction('Hold <kbd>Space</kbd> while clicking!', 'state-wrong')
        return
      }
      handleMouseComplete(true)
    } else if (action === 'click') {
      if (isClick) handleMouseComplete(true)
    } else if (action === 'click-unit') {
      if (!isClick) return
      const targetEl = $('mouse-zone-target')
      if (targetEl && targetEl.style.display !== 'none') {
        const hitDist = Math.hypot(mx - parseFloat(targetEl.style.left), my - parseFloat(targetEl.style.top))
        if (hitDist > 44) return
      }
      handleMouseComplete(true)
    } else if (action === 'click-or-drag') {
      if (isDrag)       handleMouseComplete(false)
      else if (isClick) handleMouseComplete(true)
    } else if (action === 'click-unit-or-drag') {
      if (isDrag) {
        handleMouseComplete(false)
      } else if (isClick) {
        const targetEl = $('mouse-zone-target')
        if (targetEl && targetEl.style.display !== 'none') {
          const hitDist = Math.hypot(mx - parseFloat(targetEl.style.left), my - parseFloat(targetEl.style.top))
          if (hitDist > 44) return
        }
        handleMouseComplete(true)
      }
    }
  })

  // Cancel drag if mouse leaves the zone mid-gesture
  zone.addEventListener('mouseleave', () => {
    if (!dragOrigin) return
    dragOrigin = null
    const svg = $('mouse-zone-svg')
    if (svg) svg.innerHTML = ''
  })
}

// ─── Flash helpers ────────────────────────────────────────────────────────────

function flashTab(catId, cls) {
  const tab = $('cat-tabs').querySelector(`[data-cat="${catId}"]`)
  if (!tab) return
  tab.classList.remove('flash-correct', 'flash-wrong')
  // Force reflow to restart animation
  void tab.offsetWidth
  tab.classList.add(cls)
  tab.addEventListener('animationend', () => tab.classList.remove(cls), { once: true })
}

function flashSlot(key, cls) {
  const slot = $('menu-grid').querySelector(`[data-key="${key}"]`)
  if (!slot || slot.classList.contains('empty')) return
  slot.classList.remove('flash-correct', 'flash-wrong', 'is-target')
  void slot.offsetWidth
  slot.classList.add(cls)
  if (cls !== 'is-target') {
    slot.addEventListener('animationend', () => slot.classList.remove(cls), { once: true })
  }
}

function flashBrowseSlot(key) {
  const slot = $('browse-menu-grid')?.querySelector(`[data-key="${key}"]`)
  if (!slot || slot.classList.contains('empty')) return
  slot.classList.remove('flash-correct')
  void slot.offsetWidth
  slot.classList.add('flash-correct')
  slot.addEventListener('animationend', () => slot.classList.remove('flash-correct'), { once: true })
}

// ─── Slot hover info ──────────────────────────────────────────────────────────

function showSlotHover(unit, elId) {
  const el = $(elId)
  if (!el) return
  // Hover and the key-result card share one slot, so hovering hands it back to the hover
  // text — otherwise the card would keep the hover line hidden until you changed builder.
  if (elId === 'browse-slot-hover-info') clearBrowseModResult()
  const info = uInfo(unit.id)
  const desc = info.description ? `<br><span class="slot-hover-desc">${info.description}</span>` : ''
  const link = `<a href="https://www.beyondallreason.info/unit/${unit.id}" target="_blank" rel="noopener noreferrer" class="slot-hover-link">↗ beyondallreason.info</a>`
  el.innerHTML = `${info.name}${desc}<br><span class="slot-hover-id">${unit.id}</span> ${link}`
}

function showBrowseSlotHover(unit, equivUnit, isQwertz) {
  const el = $('browse-slot-hover-info')
  if (!el) return
  clearBrowseModResult()   // see showSlotHover — the two share one reserved slot
  const info      = uInfo(unit.id)
  const equivInfo = uInfo(equivUnit.id)
  const equivKey  = display(equivUnit.key, isQwertz)
  const desc = info.description
    ? `<br><span class="slot-hover-desc">${info.description}</span>` : ''
  el.innerHTML =
    `${info.name}${desc}` +
    `<br><span class="slot-hover-equiv">≈ <kbd>${equivKey}</kbd> ${equivInfo.name}</span>`
}

function clearSlotHover(elId) {
  const el = $(elId)
  if (el) el.textContent = ''
}

function clearLearnPin() {
  learnPinnedUnit = null
  document.querySelector('#screen-training .slot-pinned')?.classList.remove('slot-pinned')
  clearSlotHover('slot-hover-info')
}

function clearBrowsePin() {
  browsePinnedUnit = null
  document.querySelector('#screen-browse .slot-pinned')?.classList.remove('slot-pinned')
  clearSlotHover('browse-slot-hover-info')
}

// ─── Setup screen ─────────────────────────────────────────────────────────────

function restoreSettingsUI() {
  for (const cb of document.querySelectorAll('input[name=faction]'))
    cb.checked = settings.factions.includes(cb.value)

  for (const cb of document.querySelectorAll('input[name=tier]')) {
    if (cb.value === 'optional') cb.checked = settings.tiers.includes('optional')
    else                         cb.checked = settings.tiers.includes(Number(cb.value))
  }

  for (const rb of document.querySelectorAll('input[name=keyboard]'))
    rb.checked = rb.value === settings.keyboard
  // With a real layout from the browser the manual QWERTY/QWERTZ pick is meaningless —
  // it only feeds the fallback path. Show what was detected instead. The Cmd↔Alt swap
  // is a separate concern (a practice aid, not a layout fact) and stays either way.
  if (KeyLayout.detected) {
    // Keep the stored value meaningful for code that still reads it, but never ask
    if (!settings.keyboard) { settings.keyboard = KeyLayout.guessLayout(); saveSettings(settings) }
    $('keyboard-manual-row').classList.add('hidden')
    $('keyboard-detected-row').classList.remove('hidden')
    $('keyboard-detected-keys').textContent = KeyLayout.gridLabels()
  } else {
    // Manual pick only covers QWERTY and QWERTZ — say why, and what fixes it
    $('keyboard-nodetect-hint').classList.remove('hidden')
  }
  $('hint-timeout').value = settings.hintTimeout
  updateHintLabel(settings.hintTimeout)
  $('time-limit').value = settings.timeLimit
  updateTimeLimitLabel(settings.timeLimit)
  $('run-length').value = settings.runLength
  updateRunLengthLabel(settings.runLength)
  $('sound-enabled').checked = settings.soundEnabled
  $('mouse-enabled').checked = settings.mouseEnabled
  if (!IS_MAC) $('swap-cmd-alt-row').style.display = 'none'
  $('swap-cmd-alt').checked = settings.swapCmdAlt

  const diff = settings.difficulty ?? 'commander'
  const diffRadio = document.querySelector(`input[name=difficulty][value="${diff}"]`)
  if (diffRadio) diffRadio.checked = true

  for (const cb of document.querySelectorAll('input[name=shortcuts]'))
    cb.checked = (settings.shortcuts ?? []).includes(cb.value)

  updateBuilderCount()
}

function initSetupScreen() {
  restoreSettingsUI()

  // Live updates
  $('hint-timeout').addEventListener('input', e => {
    const v = Number(e.target.value)
    updateHintLabel(v)
    settings.hintTimeout = v
    saveSettings(settings)
  })

  $('time-limit').addEventListener('input', e => {
    const v = Number(e.target.value)
    updateTimeLimitLabel(v)
    settings.timeLimit = v
    saveSettings(settings)
  })

  $('run-length').addEventListener('input', e => {
    const v = Number(e.target.value)
    updateRunLengthLabel(v)
    settings.runLength = v
    saveSettings(settings)
  })

  for (const radio of document.querySelectorAll('input[name=difficulty]'))
    radio.addEventListener('change', e => {
      settings.difficulty = e.target.value
      saveSettings(settings)
      updateBuilderCount()
    })

  $('sound-enabled').addEventListener('change', e => {
    settings.soundEnabled = e.target.checked
    saveSettings(settings)
  })

  $('build-modifiers').checked  = settings.buildModifiers
  $('build-modifiers-row').style.opacity = settings.mouseEnabled ? '1' : '0.4'
  $('build-modifiers').disabled = !settings.mouseEnabled

  $('mouse-enabled').addEventListener('change', e => {
    settings.mouseEnabled = e.target.checked
    saveSettings(settings)
    $('build-modifiers-row').style.opacity = e.target.checked ? '1' : '0.4'
    $('build-modifiers').disabled = !e.target.checked
  })

  $('build-modifiers').addEventListener('change', e => {
    settings.buildModifiers = e.target.checked
    saveSettings(settings)
  })

  $('swap-cmd-alt').addEventListener('change', e => {
    settings.swapCmdAlt = e.target.checked
    saveSettings(settings)
  })

  for (const cb of document.querySelectorAll('input[name=buildertype]'))
    cb.checked = (settings.builderTypes ?? ['factory', 'constructor']).includes(cb.value)

  for (const cb of document.querySelectorAll('input[name=faction], input[name=tier], input[name=buildertype]'))
    cb.addEventListener('change', onFilterChange)

  function syncShortcutSettings() {
    settings.shortcuts = [...document.querySelectorAll('input[name=shortcuts]:checked')]
      .map(el => el.value)
    saveSettings(settings)
    updateBuilderCount()
    const total   = document.querySelectorAll('input[name=shortcuts]').length
    const checked = document.querySelectorAll('input[name=shortcuts]:checked').length
    $('btn-shortcuts-toggle').textContent = (total === checked) ? 'Deselect all' : 'Select all'
    $('shortcuts-master').checked = checked > 0
  }

  for (const cb of document.querySelectorAll('input[name=shortcuts]'))
    cb.addEventListener('change', syncShortcutSettings)

  $('btn-shortcuts-toggle').addEventListener('click', () => {
    const allChecked = document.querySelectorAll('input[name=shortcuts]').length ===
                       document.querySelectorAll('input[name=shortcuts]:checked').length
    for (const cb of document.querySelectorAll('input[name=shortcuts]'))
      cb.checked = !allChecked
    syncShortcutSettings()
  })

  // Set initial toggle label
  syncShortcutSettings()

  $('shortcuts-master').addEventListener('change', () => {
    const isOn = $('shortcuts-master').checked
    for (const cb of document.querySelectorAll('input[name=shortcuts]'))
      cb.checked = isOn
    syncShortcutSettings()
  })

  for (const rb of document.querySelectorAll('input[name=keyboard]'))
    rb.addEventListener('change', e => {
      settings.keyboard = e.target.value
      saveSettings(settings)
      updateBuilderCount()
    })

  // Every screen that shows keys needs to know the layout first — the reference screens
  // label keys (Z vs Y, ^ vs `) just as much as training does. When the browser can tell
  // us the layout there is nothing to ask, so the Y/Z prompt is skipped entirely.
  const withKeyboard = fn => () =>
    (KeyLayout.detected || settings.keyboard) ? fn() : showKbdDetect(fn)

  $('btn-start').addEventListener('click', withKeyboard(() => {
    precacheIcons(filteredBuilders(settings))
    showNewRunCountdown()
  }))
  $('btn-browse').addEventListener('click', withKeyboard(() => showScreen('browse')))
  $('btn-browse-shortcuts').addEventListener('click', withKeyboard(() => showScreen('shortcuts')))
  $('btn-settings').addEventListener('click', () => {
    clearAnswerTimer()
    clearHintTimer()
    clearShowAnswerCountdown()
    if (paused) togglePause()
    archiveCurrentRun()
    showScreen('setup')
  })
  $('btn-pause').addEventListener('click', togglePause)
  $('btn-resume').addEventListener('click', togglePause)
  $('btn-skip').addEventListener('click', () => {
    if (trainingState === State.SHOW_ANSWER) {
      advanceFromAnswer()
    } else {
      clearAnswerTimer()
      nextQuestion()
    }
  })
  $('btn-reset-stats').addEventListener('click', resetRunStats)
  $('btn-newrun').addEventListener('click', (e) => {
    e.currentTarget.blur()  // prevent Space from re-triggering the button mid-training
    precacheIcons(filteredBuilders(settings))
    showNewRunCountdown()
  })

  $('btn-reset-defaults').addEventListener('click', () => {
    Object.assign(settings, defaultSettings())
    saveSettings(settings)
    restoreSettingsUI()
    // The reference screen keeps its own filter, so reset that back to "All" too
    setBrowseDifficulty('commander')
    renderBrowseList($('browse-search').value)
    renderBrowseMenu()
  })

  initAdvancedToggles()
}

function onFilterChange() {
  settings.factions = [...document.querySelectorAll('input[name=faction]:checked')]
    .map(cb => cb.value)
  settings.tiers = [...document.querySelectorAll('input[name=tier]:checked')]
    .map(cb => cb.value === 'optional' ? 'optional' : Number(cb.value))
  settings.builderTypes = [...document.querySelectorAll('input[name=buildertype]:checked')]
    .map(cb => cb.value)
  saveSettings(settings)
  updateBuilderCount()
}

function updateHintLabel(val) {
  $('hint-timeout-val').textContent = val === 0 ? 'Always visible' : `${val}s`
}

function updateTimeLimitLabel(val) {
  $('time-limit-val').textContent = val === 0 ? 'No limit' : `${val}s / key`
}

function updateRunLengthLabel(val) {
  $('run-length-val').textContent = val === 0 ? '∞' : `${val}`
}

function updateBuilderCount() {
  if (!DATA) return
  const threshold = difficultyThreshold()
  const builders  = filteredBuilders(settings)
  const unitCount = builders.reduce((total, b) =>
    total + Object.values(b.categories).reduce((n, cat) =>
      n + cat.units.filter(u => {
        if (u.trainingExcluded) return false
        if (threshold < Infinity) {
          const lvl = UNIT_LEVELS[u.id]
          if (lvl === undefined || lvl > threshold) return false
        }
        return true
      }).length, 0), 0)
  const scCount = SHORTCUTS.reduce((total, grp) => {
    if (!settings.shortcuts?.includes(grp.id)) return total
    return total + grp.shortcuts.filter(sc =>
      !sc.displayOnly && (threshold === Infinity || (sc.level !== undefined && sc.level <= threshold))
    ).length
  }, 0)
  $('builder-count').textContent =
    `${unitCount} unit${unitCount !== 1 ? 's' : ''} · ${scCount} shortcut${scCount !== 1 ? 's' : ''}`
  $('btn-start').disabled = (unitCount === 0 && scCount === 0)
}

const ADV_OPEN_KEY = 'bar-trainer-adv-open'

function initAdvancedToggles() {
  let open
  try { open = new Set(JSON.parse(localStorage.getItem(ADV_OPEN_KEY) ?? '[]')) }
  catch { open = new Set() }

  for (const btn of document.querySelectorAll('.btn-adv[data-target]')) {
    const targetId = btn.dataset.target
    const panel = document.getElementById(targetId)
    if (!panel) continue
    const apply = () => {
      const isOpen = open.has(targetId)
      panel.classList.toggle('adv-open', isOpen)
      btn.classList.toggle('btn-adv-active', isOpen)
    }
    apply()
    btn.addEventListener('click', () => {
      open.has(targetId) ? open.delete(targetId) : open.add(targetId)
      localStorage.setItem(ADV_OPEN_KEY, JSON.stringify([...open]))
      apply()
    })
  }
}

let kbdDetectPendingCallback = null

function showKbdDetect(callback) {
  kbdDetectPendingCallback = callback
  $('kbd-detect-modal').classList.remove('hidden')

  function onKey(e) {
    const key = e.key?.toUpperCase()
    if (key === 'Y') apply('qwerty')
    else if (key === 'Z') apply('qwertz')
    else if (key === 'ESCAPE') close()
  }

  function apply(layout) {
    document.removeEventListener('keydown', onKey)
    $('kbd-detect-modal').classList.add('hidden')
    settings.keyboard = layout
    document.querySelector(`input[name=keyboard][value=${layout}]`).checked = true
    saveSettings(settings)
    updateBuilderCount()
    const cb = kbdDetectPendingCallback
    kbdDetectPendingCallback = null
    if (cb) cb()
  }

  function close() {
    document.removeEventListener('keydown', onKey)
    $('kbd-detect-modal').classList.add('hidden')
    kbdDetectPendingCallback = null
  }

  document.addEventListener('keydown', onKey)
  $('btn-kbd-cancel').onclick = close
}

// ─── Browse screen ─────────────────────────────────────────────────────────────

let browseBuilder    = null
let browseCatId      = null
let browsePage       = 0
let browseDifficulty = 'commander'
let learnPinnedUnit  = null
let browsePinnedUnit = null
let browseShiftSolo  = false   // Shift held with no other key — backs out on release

// Leave the open category and return to the category picker. Factories have no
// categories, so there is nothing to back out of there. Returns whether it acted.
function browseExitCategory() {
  if (browseCatId === null || isFactory(browseBuilder)) return false
  browseCatId = null
  browsePage  = 0
  clearBrowsePin()
  renderBrowseMenu()
  return true
}

// The reference is a lookup tool, so it opens on "All" rather than inheriting the
// training difficulty — you usually browse to find what you have not learned yet.
function setBrowseDifficulty(value) {
  browseDifficulty = value
  const radio = document.querySelector(`input[name="browse-diff"][value="${value}"]`)
  if (radio) radio.checked = true
}

function initBrowseScreen() {
  $('btn-browse-back').addEventListener('click', () => showScreen('setup'))
  $('browse-search').addEventListener('input', e => renderBrowseList(e.target.value))

  setBrowseDifficulty('commander')
  for (const r of document.querySelectorAll('input[name="browse-diff"]')) {
    r.addEventListener('change', e => {
      browseDifficulty = e.target.value
      renderBrowseList($('browse-search').value)
      renderBrowseMenu()
    })
  }

  renderBrowseList('')
}

function makeBrowseItem(builder) {
  const item = document.createElement('div')
  item.className = 'browse-item' + (browseBuilder?.id === builder.id ? ' active' : '')
  item.dataset.id = builder.id

  const icon = document.createElement('img')
  icon.src   = `data/${builder.icon}`
  icon.alt   = ''
  icon.className = 'browse-item-icon'
  icon.addEventListener('error', () => icon.remove())

  const label = document.createElement('div')
  label.className = 'browse-item-label'

  const tier = document.createElement('span')
  tier.className = 'browse-item-tier'
  tier.textContent = builder.isCommander ? 'COM' : `T${builder.tier}`

  const name = document.createElement('span')
  name.textContent = builder.name

  label.append(tier, name)
  item.append(icon, label)
  item.addEventListener('click', () => selectBrowseBuilder(builder.id))
  return item
}

function renderBrowseList(filter) {
  const lc  = filter.toLowerCase()
  const out = $('browse-list')
  out.innerHTML = ''

  const FACTION_LABELS = { armada: 'Armada', cortex: 'Cortex', legion: 'Legion' }
  const groups = {
    armada: { factories: [], constructors: [] },
    cortex: { factories: [], constructors: [] },
    legion: { factories: [], constructors: [] },
  }

  for (const builder of Object.values(DATA.builders)) {
    if (builder.name === builder.id) continue
    if (/com(lvl|lv)\d/i.test(builder.id)) continue
    if (lc && !builder.name.toLowerCase().includes(lc) && !builder.id.includes(lc)) continue
    const grp = groups[builder.faction]
    if (!grp) continue
    if (isFactory(builder)) grp.factories.push(builder)
    else                     grp.constructors.push(builder)
  }

  const byTierName = (a, b) => a.tier - b.tier || a.name.localeCompare(b.name)

  for (const [faction, { factories, constructors }] of Object.entries(groups)) {
    if (!factories.length && !constructors.length) continue

    const section = document.createElement('div')
    section.className = 'browse-section'

    const heading = document.createElement('div')
    heading.className = 'browse-section-heading'
    heading.textContent = FACTION_LABELS[faction] ?? capitalize(faction)
    section.appendChild(heading)

    for (const [label, items] of [['Factories', factories], ['Constructors', constructors]]) {
      if (!items.length) continue
      items.sort(byTierName)
      const sub = document.createElement('div')
      sub.className = 'browse-subsection-heading'
      sub.textContent = label
      section.appendChild(sub)
      const browseThr = browseDifficulty === 'noob' ? 0 : browseDifficulty === 'mid' ? 1 : Infinity
      for (const builder of items) {
        const item = makeBrowseItem(builder)
        if (browseThr < Infinity) {
          const fLvl = FACTORY_LEVELS[builder.id]
          if (fLvl === undefined || fLvl > browseThr) item.classList.add('item-dim')
        }
        section.appendChild(item)
      }
    }

    out.appendChild(section)
  }
}

function selectBrowseBuilder(id) {
  clearBrowsePin()
  browseBuilder = DATA.builders[id]
  browseCatId   = isFactory(browseBuilder) ? 'build' : null
  browsePage    = 0

  for (const el of $('browse-list').querySelectorAll('.browse-item'))
    el.classList.toggle('active', el.dataset.id === id)

  $('browse-empty').classList.add('hidden')
  $('browse-content').classList.remove('hidden')

  const bi = $('browse-builder-icon')
  bi.src   = `data/${browseBuilder.icon}`
  bi.alt   = browseBuilder.name
  bi.className = 'unit-portrait'
  bi.onerror = () => bi.classList.add('err')
  $('browse-builder-name').textContent = browseBuilder.name
  $('browse-builder-meta').textContent =
    `${capitalize(browseBuilder.faction)} · ` +
    (browseBuilder.isCommander ? 'Commander' : `T${browseBuilder.tier}`) +
    (isFactory(browseBuilder) ? ' · Factory' : ' · Constructor')

  renderBrowseMenu()

  // Scroll the selected item into view
  const activeEl = $('browse-list').querySelector('.browse-item.active')
  activeEl?.scrollIntoView({ block: 'nearest' })
}

function renderBrowseMenu() {
  if (!browseBuilder) return
  clearBrowsePin()
  const isQwertz = settings.keyboard === 'qwertz'

  // Tabs
  const tabContainer = $('browse-cat-tabs')
  tabContainer.innerHTML = ''

  if (isFactory(browseBuilder)) {
    tabContainer.classList.add('hidden')
  } else {
    tabContainer.classList.remove('hidden')
    for (const cat of CATEGORIES) {
      if (!browseBuilder.categories[cat.id]) continue
      const tab = document.createElement('div')
      tab.className = 'cat-tab clickable' + (cat.id === browseCatId ? ' active' : '')
      tab.dataset.cat = cat.id
      tab.innerHTML = `
        <span class="tab-key">${display(cat.key, isQwertz)}</span>
        <span class="tab-label">${cat.label}</span>
      `
      tab.addEventListener('click', () => {
        browseCatId = cat.id
        browsePage  = 0
        renderBrowseMenu()
      })
      tabContainer.appendChild(tab)
    }
  }

  // Grid
  const gridContainer = $('browse-menu-grid')
  gridContainer.innerHTML = ''

  const cat     = browseBuilder.categories[browseCatId]
  const units   = cat ? cat.units.filter(u => u.page === browsePage) : []
  const slotMap = {}
  for (const unit of units) slotMap[unit.key] = unit

  for (const key of GRID_KEYS) {
    const unit = slotMap[key] ?? null
    const slot = document.createElement('div')
    slot.className = 'slot' + (unit ? '' : ' empty')
    slot.dataset.key = key

    if (unit) {
      const browseThr = browseDifficulty === 'noob' ? 0 : browseDifficulty === 'mid' ? 1 : Infinity
      if (browseThr < Infinity) {
        const uLvl = UNIT_LEVELS[unit.id]
        if (uLvl === undefined || uLvl > browseThr) slot.classList.add('slot-dim')
      }
      const info = uInfo(unit.id)
      const img = document.createElement('img')
      img.src = `data/${info.icon}`
      img.alt = info.name
      img.addEventListener('error', () => img.remove())

      const eBadge = document.createElement('span')
      eBadge.className = 'slot-energy'
      eBadge.textContent = fmtCost(info.energyCost)

      const mBadge = document.createElement('span')
      mBadge.className = 'slot-metal'
      mBadge.textContent = fmtCost(info.metalCost)

      const keyLabel = document.createElement('span')
      keyLabel.className = 'slot-key'
      keyLabel.textContent = display(key, isQwertz)

      slot.append(img, eBadge, mBadge, keyLabel)

      // Water/land equivalent badge
      const equivId   = WATER_EQUIVALENTS[unit.id]
      const equivUnit = equivId ? cat?.units.find(u => u.id === equivId) : null
      if (equivUnit) {
        const equivBadge = document.createElement('span')
        equivBadge.className = 'slot-equiv'
        equivBadge.textContent = display(equivUnit.key, isQwertz)
        slot.appendChild(equivBadge)
      }

      slot.addEventListener('mouseenter', () => showSlotHover(unit, 'browse-slot-hover-info'))
      slot.addEventListener('mouseleave', () => {
        if (browsePinnedUnit) showSlotHover(browsePinnedUnit, 'browse-slot-hover-info')
        else clearSlotHover('browse-slot-hover-info')
      })
      slot.addEventListener('click', () => {
        const wasPinned = browsePinnedUnit === unit
        clearBrowsePin()
        if (!wasPinned) {
          browsePinnedUnit = unit
          slot.classList.add('slot-pinned')
          showSlotHover(unit, 'browse-slot-hover-info')
        }
      })
    }

    gridContainer.appendChild(slot)
  }

  // Water/land equivalents table
  const equivTable = $('browse-equiv-table')
  if (equivTable) {
    const pairs = []
    const seen  = new Set()
    if (cat) {
      for (const unit of cat.units.filter(u => u.page === browsePage)) {
        const equivId = WATER_EQUIVALENTS[unit.id]
        if (!equivId || seen.has(unit.id) || seen.has(equivId)) continue
        const equivUnit = cat.units.find(u => u.id === equivId)
        if (!equivUnit) continue
        seen.add(unit.id); seen.add(equivId)
        pairs.push([unit, equivUnit])
      }
    }
    if (pairs.length) {
      equivTable.classList.remove('hidden')
      equivTable.innerHTML =
        `<div class="equiv-title">Land / Water Equivalents</div>` +
        pairs.map(([a, b]) => {
          const aInfo = uInfo(a.id)
          const bInfo = uInfo(b.id)
          return `
        <div class="equiv-row">
          <img src="data/${aInfo.icon}" alt="" class="equiv-icon">
          <span class="equiv-name">${aInfo.name}</span>
          <kbd class="equiv-key">${display(a.key, isQwertz)}</kbd>
          <span class="equiv-sep">≈</span>
          <img src="data/${bInfo.icon}" alt="" class="equiv-icon">
          <span class="equiv-name">${bInfo.name}</span>
          <kbd class="equiv-key">${display(b.key, isQwertz)}</kbd>
        </div>`
        }).join('') +
        `<div class="equiv-desc">BAR automatically swaps to the matching unit when your build cursor moves between land and water — one key covers both.</div>`
    } else {
      equivTable.classList.add('hidden')
      equivTable.innerHTML = ''
    }
  }

  // Key hint — the category prompt only; B and Shift/Esc live in the shortcuts box below
  const hint = $('browse-key-hint')
  if (hint) {
    if (browseCatId === null) {
      const catKeys = CATEGORIES
        .filter(c => browseBuilder.categories[c.id])
        .map(c => `<kbd>${display(c.key, isQwertz)}</kbd>`)
        .join(' ')
      hint.innerHTML = `Press ${catKeys} to select a category`
    } else {
      hint.innerHTML = ''
    }
  }

  // Page bar — B is named here as well as in the shortcuts box, because in game this
  // is where the page indicator sits and where you look for it.
  const pageBar   = $('browse-page-bar')
  const totalPages = cat ? ((cat.units[cat.units.length - 1]?.page ?? 0) + 1) : 1
  if (totalPages <= 1) {
    pageBar.classList.add('hidden')
  } else {
    pageBar.classList.remove('hidden')
    pageBar.innerHTML =
      `Page ${browsePage + 1} / ${totalPages} — press <kbd>B</kbd> to advance`
  }

  renderBrowseModLegend(totalPages)
  clearBrowseModResult()
}

// Which modifier table applies to the builder currently open in the reference screen
function browseModInfo() {
  return isFactory(browseBuilder) ? FACTORY_MOD_INFO : CONSTRUCTOR_MOD_INFO
}

function modKeysHtml(mods, lastKey, placeholder = false) {
  const parts = mods.map(m => `<kbd>${displayMod(m)}</kbd>`)
  // The legend's trailing key is a stand-in for "whichever unit key" and is drawn dashed;
  // the result card names a key the user actually pressed, so it gets a normal keycap.
  if (lastKey) parts.push(`<kbd${placeholder ? ' class="mod-anykey"' : ''}>${lastKey}</kbd>`)
  return parts.join('<span class="mod-plus">+</span>')
}

function renderBrowseModLegend(totalPages = 1) {
  const box = $('browse-mod-legend')
  if (!box || !browseBuilder) return
  const factory = isFactory(browseBuilder)
  const info    = browseModInfo()
  const anyKey  = factory ? 'key' : 'Click'

  const row = (keys, label, desc = '', note = '') => `
    <div class="bml-row">
      <div class="bml-keys">${keys}</div>
      <div class="bml-text">
        <span class="bml-label">${label}</span>${desc ? `<span class="bml-desc">${desc}</span>` : ''}
        ${note ? `<div class="bml-note">${note}</div>` : ''}
      </div>
    </div>`

  // The caveats (e.g. what Insert next does to the unit in progress) belong here rather
  // than only on the result card — you should be able to read them without guessing a key.
  const modRows = Object.values(info)
    .map(({ mods, label, desc, note }) => row(modKeysHtml(mods, anyKey, true), label, desc, note))
    .join('')

  const nav = [
    totalPages > 1 ? row('<kbd>B</kbd>', 'Next page') : '',
    (!factory && browseCatId !== null)
      ? row('<kbd>Shift</kbd><span class="mod-plus">/</span><kbd>Esc</kbd>', 'Back to categories') : '',
  ].filter(Boolean).join('')

  // Only worth mentioning the Cmd↔Alt swap when this builder actually has an Alt modifier
  const swap = Object.values(info).some(m => m.mods.includes('alt')) ? macSwapNote(['alt']) : ''
  const lead = factory
    ? 'Hold a modifier while pressing the unit key:'
    : 'Pick the unit with its key, then hold a modifier while clicking to place it:'

  box.innerHTML = `
    <div class="bml-title">Shortcuts${swap}</div>
    <div class="bml-lead">${lead}</div>
    ${modRows}
    ${nav ? `<div class="bml-sep"></div>${nav}` : ''}`
}

function clearBrowseModResult() {
  const box = $('browse-mod-result')
  if (!box) return
  box.classList.add('hidden')
  box.innerHTML = ''
  $('browse-info-slot')?.classList.remove('has-result')
}

// Spell out what the key just pressed actually does, e.g. Alt+X → "Insert next: Eraser"
function showBrowseModResult(gridKey, event) {
  const box = $('browse-mod-result')
  if (!box || !browseBuilder) return
  const cat  = browseBuilder.categories[browseCatId]
  const unit = cat?.units.find(u => u.page === browsePage && keysMatch(u.key, gridKey))
  if (!unit) return clearBrowseModResult()

  const info     = uInfo(unit.id)
  const isQwertz = settings.keyboard === 'qwertz'
  const keyCap   = display(unit.key, isQwertz)
  let head, desc, note

  if (isFactory(browseBuilder)) {
    // Factories take their modifier with the grid key, so the key press fully
    // determines the order and we can name it outright.
    const alt = event.altKey || (IS_MAC && settings.swapCmdAlt && event.metaKey)
    const modKey = event.ctrlKey && event.shiftKey ? 'ctrl-shift'
      : event.ctrlKey  ? 'ctrl'
      : event.shiftKey ? 'shift'
      : alt            ? 'alt' : 'none'
    const entry = FACTORY_MOD_INFO[modKey]
    if (!entry) return clearBrowseModResult()
    head = modKeysHtml(entry.mods, keyCap) +
      `<span class="bmr-arrow">→</span><span class="bmr-action">${entry.label}</span>`
    desc = entry.desc
    note = ''   // the Repeat caveat lives in the legend below
  } else {
    // Constructors only arm the blueprint with the key — which order you get is decided
    // by the modifier held at CLICK time, so the key press cannot say. Whether Shift was
    // already down here is irrelevant: what counts is whether it is down when you click.
    head = `<kbd>${keyCap}</kbd>` +
      `<span class="bmr-arrow">→</span><span class="bmr-action">Ready to place</span>`
    // No separate explanation line — every entry below already names the click
    desc = ''
    note = '<div class="bmr-note">' + Object.values(CONSTRUCTOR_MOD_INFO)
      .map(m => `${modKeysHtml(m.mods, 'Click')} ${m.short}`)
      .join('<span class="bmr-sep"> · </span>') + '</div>'
  }

  box.classList.remove('hidden')
  $('browse-info-slot')?.classList.add('has-result')
  box.innerHTML = `
    <img class="bmr-icon" src="data/${info.icon}" alt="">
    <div class="bmr-text">
      <div class="bmr-head">${head}</div>
      <div class="bmr-unit">${info.name}</div>
      ${desc ? `<div class="bmr-desc">${desc}</div>` : ''}
      ${note}
    </div>`
}

function browsePageDelta(delta) {
  const cat = browseBuilder?.categories[browseCatId]
  if (!cat) return
  const total = (cat.units[cat.units.length - 1]?.page ?? 0) + 1
  browsePage  = ((browsePage + delta) % total + total) % total
  renderBrowseMenu()
}

// ─── Shortcuts reference screen ───────────────────────────────────────────────

let activeShortcutsGroupId = null
let scCheckedIds = new Set()
let scSpaceHeld  = false
let scArmed      = null   // matches waiting for a pad gesture to disambiguate them
let scArmTimer   = null
let scKeySeq     = []     // buffered combos for multi-key shortcuts (Z Z = Area MEX)
let scSeqTimer   = null

const SC_PAD_IDLE = 'Press any shortcut to check it — then click or drag anywhere for its mouse action'

function formatMouseAction(mouseAction) {
  if (!mouseAction) return ''

  const isRight  = mouseAction === 'click-right' || mouseAction.startsWith('right-') || mouseAction.endsWith('-click-right')
  const isLine   = mouseAction.includes('line')
  const isDrag   = mouseAction.includes('drag')
  const modifier = mouseAction.startsWith('alt-')   ? 'Alt'
    : mouseAction.startsWith('ctrl-')  ? 'Ctrl'
    : mouseAction.startsWith('shift-') ? 'Shift'
    : mouseAction.startsWith('space-') ? 'Space' : null

  const leftBtn  = `<path d="M.75 6.5Q.75.75 7 .75L7 9.5H.75Z" fill="rgba(220,155,30,.7)"/>`
  const rightBtn = `<path d="M13.25 6.5Q13.25.75 7 .75L7 9.5H13.25Z" fill="rgba(220,155,30,.7)"/>`

  const mouseBody = (btn) => `
    <rect x=".75" y=".75" width="12.5" height="18.5" rx="5.5" fill="rgba(255,255,255,.07)" stroke="rgba(255,255,255,.35)" stroke-width="1.5"/>
    <line x1=".75" y1="9.5" x2="13.25" y2="9.5" stroke="rgba(255,255,255,.22)" stroke-width="1"/>
    <line x1="7" y1=".75" x2="7" y2="9.5" stroke="rgba(255,255,255,.22)" stroke-width="1"/>
    ${btn}`

  let svg
  if (!isDrag) {
    // Click icon: show which button (left or right)
    svg = `<svg class="sc-mouse-svg" viewBox="0 0 14 20" height="22" aria-hidden="true">
      ${mouseBody(isRight ? rightBtn : leftBtn)}
    </svg>`
  } else if (isLine) {
    // Diagonal dashed line starting just right of mouse, angled ~35° down — avoids aligning with the mouse's horizontal divider
    svg = `<svg class="sc-mouse-svg" viewBox="0 0 25 20" height="22" aria-hidden="true">
      ${mouseBody(isRight ? rightBtn : leftBtn)}
      <path d="M15 10L22 15" stroke="rgba(255,255,255,.38)" stroke-width="1.2" stroke-dasharray="2,1.5" stroke-linecap="round"/>
      <polygon points="19.2,14.6 22,15 20.7,12.5" fill="rgba(255,255,255,.38)"/>
    </svg>`
  } else {
    // Area drag: circle on the right side of mouse, sticking out past its right edge.
    // sc-mouse-bg masks the portion of the circle that sits behind the mouse body.
    svg = `<svg class="sc-mouse-svg" viewBox="0 0 25 20" height="22" aria-hidden="true">
      <circle cx="17" cy="10" r="7" fill="rgba(220,155,30,.07)" stroke="rgba(220,155,30,.55)" stroke-width="1.3" stroke-dasharray="2.5,2"/>
      <rect class="sc-mouse-bg" x=".75" y=".75" width="12.5" height="18.5" rx="5.5"/>
      ${mouseBody(leftBtn)}
    </svg>`
  }

  const modKbd = modifier ? `<kbd>${modifier}</kbd><span class="sc-mouse-plus">+</span>` : ''
  return `<span class="sc-mouse-action">${modKbd}${svg}</span>`
}

function formatShortcutKey(shortcut, isQwertz) {
  if (!shortcut.key && !shortcut.keys) return ''
  const mods = shortcut.modifiers ?? []
  const hasAlt = mods.some(m => m.toLowerCase() === 'alt')

  // Canonical combo: always show "Alt" — the game's actual key name, never "⌘ Cmd".
  // The Mac Cmd↔Alt swap is a practice aid; players must memorize "Alt" as the shortcut.
  // data-combo indexes each step of the shortcut so the learn screen can light up
  // just the keys typed so far (Z → Z shows one Z lit after the first press).
  const canonicalCombo = (key, index) => {
    const parts = [
      ...mods.map(m => m.toLowerCase() === 'alt' ? 'Alt' : capitalize(m)),
      display(key, isQwertz),
    ]
    return `<span class="sc-combo" data-combo="${index}">${
      parts.map(p => `<kbd>${p}</kbd>`).join('+')}</span>`
  }
  const canonical = shortcut.keys
    ? shortcut.keys.map(canonicalCombo).join(' <span class="sc-seq-arrow">→</span> ')
    : canonicalCombo(shortcut.key, 0)

  // When swapCmdAlt is active on Mac, Alt shortcuts are practiced with Cmd.
  // Show a small note so the user knows which key to press in this trainer.
  if (IS_MAC && settings.swapCmdAlt && hasAlt) {
    const practiceCombo = (key) => {
      const parts = [...mods.map(m => displayMod(m.toLowerCase())), display(key, isQwertz)]
      return parts.map(p => `<kbd>${p}</kbd>`).join('+')
    }
    const practice = shortcut.keys
      ? shortcut.keys.map(practiceCombo).join(' → ')
      : practiceCombo(shortcut.key)
    return `${canonical}<span class="sc-mac-practice">Practice here: ${practice}</span>`
  }

  return canonical
}

function scRangeIncludes(rangeKey, key) {
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

// A pressed combo: { key, mods } where mods is a sorted array of Ctrl/Shift/Alt/Space.
function scComboFromEvent(e, spaceHeld) {
  const mods = []
  if (e.ctrlKey)  mods.push('Ctrl')
  if (e.shiftKey) mods.push('Shift')
  if (e.altKey || (settings.swapCmdAlt && e.metaKey)) mods.push('Alt')
  if (spaceHeld)  mods.push('Space')
  return { key: normalise(e.key, settings.keyboard === 'qwertz', e.code), mods }
}

function scComboMatchesKey(combo, scKey, scMods) {
  if (scMods.length !== combo.mods.length) return false
  if (!scMods.every(m => combo.mods.includes(m))) return false
  return scKey.includes('–')
    ? scRangeIncludes(scKey, combo.key)
    : scKey.toUpperCase() === combo.key
}

// Does a shortcut's declared mouseAction match the gesture the user performed on the pad?
// Line-vs-circle drags are indistinguishable by gesture, so both satisfy a drag.
function scGestureMatches(mouseAction, gesture) {
  const wantRight = mouseAction === 'click-right'
    || mouseAction.startsWith('right-') || mouseAction.endsWith('-click-right')
  const wantDrag = mouseAction.includes('drag')
  const wantMod  = mouseAction.startsWith('alt-')   ? 'Alt'
    : mouseAction.startsWith('ctrl-')  ? 'Ctrl'
    : mouseAction.startsWith('shift-') ? 'Shift'
    : mouseAction.startsWith('space-') ? 'Space' : null
  if (wantRight !== (gesture.button === 'right')) return false
  if (mouseAction.includes('or-drag')) {
    // Either a click or a drag is acceptable
  } else if (wantDrag !== (gesture.kind === 'drag')) return false
  const gestureMod = gesture.mods.length === 1 ? gesture.mods[0] : null
  if (wantMod !== gestureMod) return false
  return true
}

// Resolve a buffered key sequence into shortcuts that are fully typed (`complete`)
// and ones still waiting for more keys (`partial`, e.g. Z of Z–Z Area MEX).
// Each entry carries `pressed`: how many of its combos are typed, so the key
// column can highlight exactly that much.
// Entries in the open category sort first so the view doesn't jump away.
function scResolveSequence(seq) {
  const combo = seq[seq.length - 1]
  const complete = [], partial = []
  for (const group of SHORTCUTS) {
    for (const sc of group.shortcuts) {
      if (sc.learnHidden) continue
      if (sc.keys) {
        const prefixOk = seq.length <= sc.keys.length && seq.every((cb, i) =>
          scComboMatchesKey(cb, sc.keys[i], i === 0 ? (sc.modifiers ?? []) : []))
        if (!prefixOk) continue
        const entry = { group, sc, pressed: seq.length }
        ;(seq.length === sc.keys.length ? complete : partial).push(entry)
      } else if (sc.key && scComboMatchesKey(combo, sc.key, sc.modifiers ?? [])) {
        complete.push({ group, sc, pressed: 1 })
      }
    }
  }
  const here = entry => entry.group.id === activeShortcutsGroupId ? 0 : 1
  const order = list => [...list].sort((a, b) => here(a) - here(b))
  return { complete: order(complete), partial: order(partial) }
}

function initShortcutsPad(scFlash, scDisarmPad, padLabel) {
  const screen = $('screen-shortcuts')
  if (!screen) return
  const svg = $('sc-pad-svg')
  let origin = null
  let button = 'left'
  let captured = false   // did we take this gesture over from the browser?

  // Sidebar entries, the Back button and links keep their normal click behaviour
  const isChrome = target => target.closest('button, a, .browse-item, input, label')

  // Selecting text is a plain unmodified left drag, so we must not swallow those.
  // Right-button and modifier-held gestures never select text, and once a key press is
  // waiting for its mouse action the gesture is unambiguous — take those over. A plain
  // left press stays with the browser and is judged at mouseup: a click still counts as
  // a gesture (clicking selects nothing), a drag is the user highlighting text.
  const capturable = e => scArmed !== null
    || e.button === 2
    || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || scSpaceHeld

  screen.addEventListener('contextmenu', e => {
    if (isChrome(e.target)) return
    e.preventDefault()
  })

  screen.addEventListener('mousedown', e => {
    if (isChrome(e.target)) return
    origin = { x: e.clientX, y: e.clientY }
    button = e.button === 2 ? 'right' : 'left'
    captured = capturable(e)
    if (captured) e.preventDefault()
  })

  screen.addEventListener('mousemove', e => {
    if (!origin || !svg || !captured) return
    const radius = Math.hypot(e.clientX - origin.x, e.clientY - origin.y)
    if (radius < 5) return
    svg.innerHTML =
      `<circle cx="${origin.x}" cy="${origin.y}" r="${radius}" fill="rgba(0,200,0,.08)"
        stroke="rgba(0,210,0,.7)" stroke-width="1.5" stroke-dasharray="6 3"/>
       <line x1="${origin.x}" y1="${origin.y}" x2="${e.clientX}" y2="${e.clientY}"
        stroke="rgba(0,210,0,.5)" stroke-width="1.2" stroke-dasharray="4 3"/>
       <circle cx="${origin.x}" cy="${origin.y}" r="4" fill="rgba(0,210,0,.9)"/>`
  })

  window.addEventListener('mouseup', e => {
    if (!origin) return
    const dist = Math.hypot(e.clientX - origin.x, e.clientY - origin.y)
    const wasCaptured = captured
    origin = null
    captured = false
    if (svg) svg.innerHTML = ''
    // A left drag we never took over is the user highlighting text, not a command
    if (!wasCaptured && dist >= 18) return

    const mods = []
    if (e.ctrlKey)  mods.push('Ctrl')
    if (e.shiftKey) mods.push('Shift')
    if (e.altKey || (settings.swapCmdAlt && e.metaKey)) mods.push('Alt')
    if (scSpaceHeld) mods.push('Space')
    const gesture = { button, kind: dist >= 18 ? 'drag' : 'click', mods }

    // Armed by a key press: narrow those candidates. Otherwise match keyless mouse-only commands.
    const wasArmed = scArmed !== null
    const pool = scArmed ?? SHORTCUTS.flatMap(group =>
      group.shortcuts.filter(sc => !sc.learnHidden && !sc.key && !sc.keys && sc.mouseAction)
        .map(sc => ({ group, sc })))
    const hits = pool.filter(m => scGestureMatches(m.sc.mouseAction, gesture))

    scDisarmPad()
    // Only a key-armed gesture may change category; a bare click stays where you are
    if (hits.length) scFlash(hits, wasArmed)
    else if (wasArmed) padLabel(`No command on that key for a ${gesture.button === 'right' ? 'right-' : ''}${gesture.kind}`)
  })
}

function initShortcutsScreen() {
  $('btn-shortcuts-back').addEventListener('click', () => {
    scCheckedIds = new Set()
    scSpaceHeld  = false
    scKeySeq     = []
    showScreen('setup')
  })

  const padLabel = txt => { const el = $('sc-pad-label'); if (el) el.innerHTML = txt }

  const scClearLit = () => {
    for (const el of document.querySelectorAll('.sc-combo-lit'))
      el.classList.remove('sc-combo-lit')
  }

  const scDisarmPad = () => {
    scArmed = null
    if (scArmTimer !== null) { clearTimeout(scArmTimer); scArmTimer = null }
    $('screen-shortcuts')?.classList.remove('sc-pad-armed')
    scClearLit()
    padLabel(SC_PAD_IDLE)
  }

  // Light up the individual keys typed so far, on every shortcut still in the running
  const scLight = entries => {
    if (!entries.length) return
    const target = entries[0].group
    if (activeShortcutsGroupId !== target.id) selectShortcutsGroup(target.id)
    requestAnimationFrame(() => {
      scClearLit()
      let first = true
      for (const { group, sc, pressed } of entries) {
        if (group.id !== target.id) continue
        const row = document.querySelector(`[data-sc-id="${sc.id}"]`)
        if (!row) continue
        for (let i = 0; i < pressed; i++)
          row.querySelector(`.sc-combo[data-combo="${i}"]`)?.classList.add('sc-combo-lit')
        if (first) { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); first = false }
      }
    })
  }

  // allowSwitch: only a deliberate key press may pull the view to another category.
  // A bare click or drag must not — those are easy to trigger by accident, and being
  // yanked to Select or Move every time you click the page is worse than no feedback.
  const scFlash = (matches, allowSwitch = true) => {
    if (!matches.length) return
    const here     = matches.find(m => m.group.id === activeShortcutsGroupId)
    const targetId = here      ? here.group.id
      : allowSwitch            ? matches[0].group.id
      : activeShortcutsGroupId
    // Switching category re-renders the table, so settle the group before querying rows
    if (activeShortcutsGroupId !== targetId) selectShortcutsGroup(targetId)
    // Only tick off what the user can actually see happen — a match in a category we
    // deliberately did not switch to would otherwise collect a checkmark invisibly.
    const visible = matches.filter(m => m.group.id === targetId)
    for (const { sc } of visible) scCheckedIds.add(sc.id)
    requestAnimationFrame(() => {
      let first = true
      for (const { sc } of visible) {
        const row = document.querySelector(`[data-sc-id="${sc.id}"]`)
        if (!row) continue
        row.classList.add('sc-row-checked')
        row.classList.remove('sc-row-flash')
        void row.offsetWidth
        row.classList.add('sc-row-flash')
        if (first) { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); first = false }
      }
    })
  }

  const scArmPad = (matches, comboHtml) => {
    scArmed = matches
    $('screen-shortcuts')?.classList.add('sc-pad-armed')
    padLabel(`${comboHtml} — now click or drag anywhere to pick the command`)
    if (scArmTimer !== null) clearTimeout(scArmTimer)
    scArmTimer = setTimeout(scDisarmPad, 10000)
  }

  document.addEventListener('keydown', e => {
    if (currentScreen !== 'shortcuts') return
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return

    if (e.key === ' ') scSpaceHeld = true
    const combo = scComboFromEvent(e, e.key === ' ' ? false : scSpaceHeld)

    // Try extending the buffered sequence (Z then Z = Area MEX); if that leads
    // nowhere, treat this press as the start of a fresh sequence.
    let seq = [...scKeySeq, combo]
    let { complete, partial } = scResolveSequence(seq)
    if (!complete.length && !partial.length && seq.length > 1) {
      seq = [combo]
      ;({ complete, partial } = scResolveSequence(seq))
    }

    scKeySeq = partial.length ? seq : []
    if (scSeqTimer !== null) clearTimeout(scSeqTimer)
    if (partial.length) scSeqTimer = setTimeout(() => { scKeySeq = []; scDisarmPad() }, 2000)

    if (!complete.length && !partial.length) return
    e.preventDefault()

    const needsMouse = complete.filter(m => m.sc.mouseAction)
    const done       = complete.filter(m => !m.sc.mouseAction)

    scLight([...partial, ...needsMouse])
    if (done.length) scFlash(done)

    if (needsMouse.length) {
      scArmPad(needsMouse, formatShortcutKey(needsMouse[0].sc, settings.keyboard === 'qwertz'))
    } else if (partial.length) {
      $('screen-shortcuts')?.classList.remove('sc-pad-armed')
      scArmed = null
      padLabel('Keep going — press the next key in the sequence')
    } else {
      scDisarmPad()
    }
  })

  document.addEventListener('keyup', e => {
    if (e.key === ' ') scSpaceHeld = false
  })

  initShortcutsPad(scFlash, scDisarmPad, padLabel)
  padLabel(SC_PAD_IDLE)

  const list = $('shortcuts-group-list')
  for (const group of SHORTCUTS) {
    const item = document.createElement('div')
    item.className = 'browse-item'
    item.dataset.id = group.id

    const label = document.createElement('div')
    label.className = 'browse-item-label'
    const name = document.createElement('span')
    name.textContent = group.name
    label.appendChild(name)
    item.appendChild(label)

    item.addEventListener('click', () => selectShortcutsGroup(group.id))
    list.appendChild(item)
  }

  if (SHORTCUTS.length) selectShortcutsGroup(SHORTCUTS[0].id)
}

function selectShortcutsGroup(id) {
  activeShortcutsGroupId = id
  const isQwertz = settings.keyboard === 'qwertz'

  for (const el of $('shortcuts-group-list').querySelectorAll('.browse-item'))
    el.classList.toggle('active', el.dataset.id === id)

  const group = SHORTCUTS.find(g => g.id === id)
  if (!group) return

  $('shortcuts-empty').classList.add('hidden')
  const content = $('shortcuts-content')
  content.classList.remove('hidden')

  const rows = group.shortcuts.filter(sc => !sc.learnHidden).map(sc => {
    // Only flag what this browser/OS actually swallows — a "Windows/Linux" warning on a
    // Mac is noise, and worse, it contradicts the key visibly working when you press it.
    const mods     = sc.modifiers ?? []
    const reserved = sc.keys ? ''
      : isBrowserReserved(sc.key, mods) ? '<span class="sc-reserved">study card — your browser keeps this one</span>'
      : isOsReserved(sc.key, mods)      ? `<span class="sc-reserved">study card — ${IS_MAC ? 'macOS' : 'your OS'} keeps this one</span>`
      : ''
    const desc = sc.description
      ? `<div class="sc-desc">${sc.description}</div>` : ''
    const lvlBadge = sc.level === 0
      ? '<span class="sc-lvl sc-lvl-0">Noob</span>'
      : sc.level === 1
        ? '<span class="sc-lvl sc-lvl-1">Mid</span>'
        : '<span class="sc-lvl sc-lvl-cmd">Commander</span>'
    const checked = scCheckedIds.has(sc.id) ? ' sc-row-checked' : ''
    return `
      <tr data-sc-id="${sc.id}"${checked ? ` class="${checked.trim()}"` : ''}>
        <td class="sc-check-col"><span class="sc-check">✓</span></td>
        <td class="sc-action"><span class="sc-label">${sc.label}</span>${desc}</td>
        <td class="sc-key">${formatShortcutKey(sc, isQwertz)}${formatMouseAction(sc.mouseAction)}${reserved}</td>
        <td class="sc-level">${lvlBadge}</td>
      </tr>`
  }).join('')

  content.innerHTML = `
    <h3 class="sc-group-heading">${group.name}</h3>
    <table class="sc-table">
      <thead>
        <tr>
          <th class="sc-check-col"></th>
          <th>Action</th>
          <th>Key</th>
          <th>Level</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  showScreen('loading')
  await KeyLayout.init()   // before anything renders a keycap or reads a key
  try {
    await loadData()
  } catch (err) {
    document.querySelector('#screen-loading p').textContent =
      `Failed to load data: ${err.message}`
    return
  }

  try {
    const scResp = await fetch('data/shortcuts.json', { cache: 'no-cache' })
    const scData = await scResp.json()
    SHORTCUTS = scData.groups || []
    if (scData.constructorModifiers) CONSTRUCTOR_MODS = scData.constructorModifiers
    if (scData.factoryModifiers)     FACTORY_MODS     = scData.factoryModifiers
    if (scData.unitLevels) {
      UNIT_LEVELS = {}
      for (const [lvl, ids] of Object.entries(scData.unitLevels)) {
        const n = Number(lvl)
        for (const id of ids)
          if (UNIT_LEVELS[id] === undefined || n < UNIT_LEVELS[id]) UNIT_LEVELS[id] = n
      }
    }
    if (scData.factoryLevels) {
      FACTORY_LEVELS = {}
      for (const [lvl, ids] of Object.entries(scData.factoryLevels)) {
        const n = Number(lvl)
        for (const id of ids)
          if (FACTORY_LEVELS[id] === undefined || n < FACTORY_LEVELS[id]) FACTORY_LEVELS[id] = n
      }
    }
  } catch {}

  await loadSounds()

  initSetupScreen()
  initBrowseScreen()
  initShortcutsScreen()
  initMouseZone()
  showScreen('setup')
  // Prevent browser-reserved keys from closing the tab/app. Ctrl+W closes tabs and
  // Ctrl+Q quits the browser on Linux/Windows; Cmd+W and Cmd+Q do the same on macOS,
  // and with the Cmd↔Alt swap on those are exactly what Alt+W and Alt+Q become.
  window.addEventListener('keydown', (event) => {
    const closeKey = event.key === 'w' || event.key === 'W'
                  || event.key === 'q' || event.key === 'Q'
    if (closeKey && (event.ctrlKey || event.metaKey)) event.preventDefault()
  }, { capture: true })

  // Belt-and-suspenders: if the keydown block didn't work (Chromium on Linux intercepts
  // Ctrl+W before JS, and macOS takes Cmd+Q outright), the beforeunload dialog is the
  // last line of defence. It covers the reference screens too, since trying shortcuts
  // out there is exactly where you press these combinations on purpose.
  window.addEventListener('beforeunload', (event) => {
    const guarded = currentScreen === 'shortcuts' || currentScreen === 'browse'
                 || (currentScreen === 'training' && !runComplete)
    if (!guarded) return
    event.preventDefault()
    event.returnValue = ''
  })

  document.addEventListener('keydown', onKey)
  // Fallback: some browsers deliver the Shift keydown to the focused element before
  // it bubbles (or swallow it entirely for focus-management shortcuts like Shift+Tab).
  // Listening on keyup guarantees we always catch the Shift release.
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Shift') {
      if (screens.browse.classList.contains('active')) {
        if (browseShiftSolo) browseExitCategory()
        browseShiftSolo = false
      } else {
        handleGoBack()
      }
    }
    if (event.key === ' ') { spaceHeld = false; mouseZoneSpaceHeld = false }
  })

  window.addEventListener('blur', () => { spaceHeld = false; mouseZoneSpaceHeld = false })
}

init()
