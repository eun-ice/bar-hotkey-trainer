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

// On QWERTZ keyboards the physical Z key fires 'Y' and vice versa.
// We normalise all incoming keys to their QWERTY equivalent so the
// rest of the app only deals with QWERTY names.
function normalise(key, isQwertz, code) {
  const k = key.toUpperCase()
  if (isQwertz && k === 'Y') return 'Z'
  if (isQwertz && k === 'Z') return 'Y'
  if (isQwertz && k === 'Ö') return ';'  // physical ;/Ö key position → ; shortcut
  if (isQwertz && k === '+') return ']'  // physical ] key position → ] shortcut
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
    if (code === 'BracketRight') return ']'
    if (code === 'Semicolon')    return ';'
  }
  return k
}

function keysMatch(pressed, expected) {
  return pressed === expected
}

// For display: remap QWERTY scan-code key names to their physical QWERTZ labels.
// Z and Y are swapped: the key in the QWERTY-Z position is labeled Y on QWERTZ and
// vice versa. All other keys are unaffected.
function display(key, isQwertz) {
  if (!isQwertz) return key
  if (key === 'Z') return 'Y'
  if (key === 'Y') return 'Z'
  if (key === ';') return 'Ö'
  if (key === ']') return '+'
  return key
}

// ─── Audio ────────────────────────────────────────────────────────────────────

const audioCtx = (() => {
  try { return new (window.AudioContext || window.webkitAudioContext)() } catch { return null }
})()

// Loaded AudioBuffer cache: { builder: AudioBuffer|null, factory: AudioBuffer|null }
const loadedSounds = { builder: null, factory: null }

async function loadSounds() {
  if (!audioCtx) return
  const files = [
    { key: 'builder', path: 'data/sounds/buildbar_click.wav' },
    { key: 'factory', path: 'data/sounds/buildbar_add.wav'   },
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
  if (!audioCtx) return
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

// ─── Settings (localStorage) ──────────────────────────────────────────────────

const SETTINGS_KEY = 'bar-trainer-settings'

function defaultSettings() {
  return {
    factions:     ['armada', 'cortex', 'legion'],
    tiers:        [0, 1, 2, 3, 'optional'],
    builderTypes: ['factory', 'constructor'],
    keyboard:     '',
    hintTimeout:  0,
    timeLimit:    5,   // seconds per required key press
    runLength:    20,  // questions per run (0 = unlimited)
    shortcuts:    ['general', 'battle', 'factory', 'builder', 'blueprint', 'rezbot', 'transport', 'camera'],
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

let DATA      = null   // parsed buildmenus.json
let SHORTCUTS = []     // groups from shortcuts.json

const SHORTCUT_CONTEXT_UNITS = {
  battle:    { armada: 'armcom',   cortex: 'corcom',   legion: 'legcom'    },
  rezbot:    { armada: 'armrectr', cortex: 'cornecro', legion: 'legrezbot' },
  transport: { armada: 'armatlas', cortex: 'corvalk',  legion: 'legatrans' },
}

async function loadData() {
  const res = await fetch('data/buildmenus.json')
  if (!res.ok) throw new Error(`Could not load data/buildmenus.json (${res.status})`)
  DATA = await res.json()
}

/** Return builders matching current settings */
function filteredBuilders(settings) {
  const types = settings.builderTypes ?? ['factory', 'constructor']
  return Object.values(DATA.builders).filter(b => {
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
      for (const unit of cat.units) {
        if (unit.trainingExcluded) continue
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
    for (const shortcut of group.shortcuts) {
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
        context:         group.context,
        seqKeys,
        seqMods,
        browserReserved: (shortcut.browserReserved ?? false) || (IS_FIREFOX && (shortcut.browserReservedFirefox ?? false)) || (!IS_MAC && (shortcut.browserReservedWindows ?? false)),
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
let countingDown     = false

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
      html += `<span class="rs-item"><span class="rs-val success">${session.correct}</span> correct</span>`
      if (session.late > 0)
        html += `<span class="rs-item"><span class="rs-val warn">${session.late}</span> retried</span>`
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

function showScreen(name) {
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
      slot.dataset.unitId = unit.id
      if (unit.id === highlightUnitId) slot.classList.add('is-target')

      const img = document.createElement('img')
      img.src = `data/${unit.icon}`
      img.alt = unit.name
      img.addEventListener('error', () => img.remove())
      slot.appendChild(img)

      // Cost badges
      const eBadge = document.createElement('span')
      eBadge.className = 'slot-energy'
      eBadge.textContent = fmtCost(unit.energyCost)

      const mBadge = document.createElement('span')
      mBadge.className = 'slot-metal'
      mBadge.textContent = fmtCost(unit.metalCost)

      slot.append(eBadge, mBadge)

      if (showKeys) {
        const keyLabel = document.createElement('span')
        keyLabel.className = 'slot-key'
        keyLabel.textContent = display(key, isQwertz)
        slot.appendChild(keyLabel)
      }

      slot.addEventListener('mouseenter', () => showSlotHover(unit, 'slot-hover-info'))
      slot.addEventListener('mouseleave', () => clearSlotHover('slot-hover-info'))
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

  // Restore menu column (was hidden for shortcut questions)
  const menuCol = document.querySelector('#screen-training .menu-col')
  if (menuCol) { menuCol.style.opacity = ''; menuCol.style.pointerEvents = '' }

  // Restore builder-card label for build-menu questions
  document.querySelector('#screen-training .builder-card .label-small').textContent = 'Building with'

  // Remove shortcut-target class from target card and restore hidden elements
  document.querySelector('#screen-training .target-card').classList.remove('shortcut-target')
  document.querySelector('#screen-training .target-card .label-small').textContent = 'Build:'
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
  const ti = $('target-icon')
  ti.src = `data/${unit.icon}`
  ti.alt = unit.name
  ti.className = 'unit-portrait'
  ti.onerror = () => ti.classList.add('err')
  $('target-name').textContent = unit.name
  const descEl = $('target-description')
  descEl.textContent = unit.description ?? ''
  descEl.classList.toggle('hidden', !unit.description)
  $('target-metal').textContent  = unit.metalCost.toLocaleString()
  $('target-energy').textContent = unit.energyCost.toLocaleString()
}

function renderShortcutQuestion(entry) {
  // opacity:0 hides the entire column including children that have visibility:visible
  // (visibility:hidden can be overridden by child rules like .page-btn.has-pages)
  const menuCol = document.querySelector('#screen-training .menu-col')
  if (menuCol) { menuCol.style.opacity = '0'; menuCol.style.pointerEvents = 'none' }

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
  $('builder-meta').textContent = entry.contextFaction
    ? capitalize(entry.contextFaction) + ' · ' + entry.context
    : ''

  // Target card — show shortcut info, hide costs/icon via inline style (reliable)
  document.querySelector('#screen-training .target-card').classList.add('shortcut-target')
  document.querySelector('#screen-training .target-card .label-small').textContent = 'Command:'
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
  // Don't archive yet — startTraining() will do it; currentRunEntries is still
  // needed by renderStatsTable() for the summary (correct[], min/max/avg).
  $('btn-skip').textContent = '↩ Skip'
  $('btn-skip').disabled    = true
  $('btn-pause').disabled   = true

  // Hide the active question and build menu; reveal the celebration panel
  document.querySelector('.question-col').classList.add('hidden')
  document.querySelector('.menu-col').classList.add('hidden')
  $('run-complete-col').classList.remove('hidden')

  renderStatsTable()
  startConfetti()
}

/** Return the ordered key labels the user needs to press for the current question. */
function correctKeySequence() {
  const isQwertz = settings.keyboard === 'qwertz'
  if (currentEntry.type === 'shortcut') {
    return currentEntry.seqKeys.map((key, idx) => {
      const mods  = currentEntry.seqMods[idx] ?? []
      const parts = [...mods.map(m => capitalize(m)), display(key.toUpperCase(), isQwertz)]
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
  keys.push(display(currentEntry.gridKey, isQwertz))
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

function startConfetti() {
  const canvas = $('confetti-canvas')
  if (!canvas) return
  const ctx  = canvas.getContext('2d')
  const col  = document.querySelector('.run-complete-col')
  const rect = col ? col.getBoundingClientRect() : { width: 600, height: 400 }
  canvas.width  = rect.width
  canvas.height = rect.height

  const COLORS = ['#4ade80','#60a5fa','#f59e0b','#e879f9','#f87171','#34d399','#fbbf24']
  const particles = Array.from({ length: 140 }, () => ({
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
      for (const unit of cat.units)
        if (unit.icon) paths.add(`data/${unit.icon}`)
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
    if (unit?.icon) srcs.push(`data/${unit.icon}`)
  }
  for (const src of srcs) if (src) fetch(src).catch(() => {})
}

function startTraining() {
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
  $('btn-skip').disabled  = false
  $('btn-pause').disabled = false
  $('btn-skip').textContent = '↩ Skip'
  $('btn-pause').textContent = '⏸ Pause'
  $('pause-overlay').classList.add('hidden')
  updateStats()
  renderStatsTable()
  showScreen('training')
  nextQuestion()
}

/** Look up the icon src for any unit ID, checking builders then build menus. */
function unitIconSrc(unitId) {
  if (!unitId) return ''
  if (DATA.builders[unitId]?.icon) return `data/${DATA.builders[unitId].icon}`
  for (const bld of Object.values(DATA.builders)) {
    for (const cat of Object.values(bld.categories)) {
      const found = cat.units.find(u => u.id === unitId)
      if (found?.icon) return `data/${found.icon}`
    }
  }
  return `data/icons/${unitId}.webp`  // best-guess fallback
}

function resolveShortcutContextUnit(context) {
  if (context === 'none') return { contextUnitId: null, contextUnitName: null, contextFaction: null, contextIcon: '' }
  const factions = settings.factions?.length ? settings.factions : ['armada', 'cortex', 'legion']
  const faction  = factions[Math.floor(Math.random() * factions.length)]
  if (context === 'factory') {
    const factories = filteredBuilders(settings).filter(isFactory)
    if (!factories.length) return { contextUnitId: null, contextUnitName: null, contextFaction: faction, contextIcon: '' }
    const picked = factories[Math.floor(Math.random() * factories.length)]
    return { contextUnitId: picked.id, contextUnitName: picked.name, contextFaction: faction, contextIcon: `data/${picked.icon}` }
  }
  if (context === 'builder') {
    const builders = filteredBuilders(settings).filter(b => !isFactory(b))
    if (!builders.length) return { contextUnitId: null, contextUnitName: null, contextFaction: faction, contextIcon: '' }
    const picked = builders[Math.floor(Math.random() * builders.length)]
    return { contextUnitId: picked.id, contextUnitName: picked.name, contextFaction: faction, contextIcon: `data/${picked.icon}` }
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

function nextQuestion() {
  clearSlotHover('slot-hover-info')
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
  } else {
    // Constructors: no category pre-selected — grid shows units but no key labels
    trainingState = State.WAITING_CATEGORY
    activeCatId   = null
  }

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
    const parts = [...mods.map(m => `<kbd>${capitalize(m)}</kbd>`), `<kbd>${keyLabel}</kbd>`]
    const keyHtml = parts.join('+')
    return idx === currentStep ? `<strong>${keyHtml}</strong>` : keyHtml
  }).join(' → ')
}

function updateInstruction() {
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
    setInstruction(`Press the <strong>category key</strong> for this unit`)
  } else if (trainingState === State.WAITING_SHIFT) {
    setInstruction(`Wrong category — press <kbd>Shift</kbd> or <kbd>Esc</kbd> to go back`, 'state-wrong')
  } else if (trainingState === State.WAITING_PAGE) {
    setInstruction(`Press <kbd>B</kbd> to advance to page ${currentEntry.page + 1}`)
  } else if (trainingState === State.WAITING_GRID) {
    setInstruction(`Press the <strong>grid key</strong> for this unit`)
  }
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
    if (event.metaKey) return
    if (['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)) return
    // Ignore bare modifier key presses (fire before the actual key in e.g. Ctrl+S, Alt+B)
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return
    event.preventDefault()
    const key  = normalise(event.key, settings.keyboard === 'qwertz', event.code)
    const mods = []
    if (event.ctrlKey) mods.push('ctrl')
    if (event.altKey)  mods.push('alt')
    handleShortcutKey(key, mods)
    return
  }

  // SHOW_ANSWER: checked before the Ctrl/Alt guard so modifier+key shortcuts can also advance
  if (trainingState === State.SHOW_ANSWER) {
    if (event.metaKey) return
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
        const wantsCtrl = lastMods.some(m => m === 'ctrl')
        const wantsAlt  = lastMods.some(m => m === 'alt')
        isCorrect = (event.ctrlKey === wantsCtrl) &&
                    (event.altKey  === wantsAlt)  &&
                    keysMatch(pressedKey, currentEntry.seqKeys[lastIdx].toUpperCase())
      } else {
        isCorrect = !event.ctrlKey && !event.altKey && keysMatch(pressedKey, currentEntry.gridKey)
      }
      if (isCorrect) { event.preventDefault(); advanceFromAnswer(); return }
    }
    return
  }

  // Ignore modifier combos and text input
  if (event.ctrlKey || event.altKey || event.metaKey) return
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

  // Browse screen: category switching + pagination
  if (screens.browse.classList.contains('active')) {
    if (browseBuilder) {
      const matched = CATEGORIES.find(c => c.key === key)
      if (matched && browseBuilder.categories[matched.id]) {
        browseCatId = matched.id
        browsePage  = 0
        renderBrowseMenu()
        return
      }
      if (key === 'B') { browsePageDelta(+1); return }
    }
    return
  }

  // Training screen
  if (trainingState === State.WAITING_CATEGORY) {
    handleCategoryKey(key)
  } else if (trainingState === State.WAITING_SHIFT) {
    // Only Shift (handled above) gets you out — all other keys are ignored
  } else if (trainingState === State.WAITING_PAGE || trainingState === State.WAITING_GRID) {
    if (key === 'B') {
      handlePageKey()
    } else if (trainingState === State.WAITING_GRID && GRID_KEYS.includes(key)) {
      handleGridKey(key)
    }
  }
}

function handleCategoryKey(key) {
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
      playBuildSound('builder')
      clearAnswerTimer()
      recordResult(questionHadWrong ? 'late' : 'correct')
      setInstruction('✓ Correct!', 'state-correct')
      trainingState = State.FEEDBACK
      setTimeout(() => checkRunEnd(), 900)
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

function handleGridKey(key) {
  const correct = keysMatch(key, currentEntry.gridKey)

  if (correct) {
    flashSlot(key, 'flash-correct')
    playBuildSound(isFactory(currentEntry.builder) ? 'factory' : 'builder')
    clearAnswerTimer()
    // Count as 'wrong' if any key was pressed incorrectly during this question
    recordResult(questionHadWrong ? 'late' : 'correct')
    setInstruction('✓ Correct!', 'state-correct')
    trainingState = State.FEEDBACK
    setTimeout(() => checkRunEnd(), 900)
  } else {
    // Silently ignore wrong grid key — no flash, no message
    questionHadWrong = true
    // Stay in WAITING_GRID — timer keeps running, user can self-correct
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
      playBuildSound('builder')
      clearAnswerTimer()
      clearShortcutKeyTimer()
      recordResult(questionHadWrong ? 'late' : 'correct')
      setInstruction('✓ Correct!', 'state-correct')
      trainingState = State.FEEDBACK
      setTimeout(() => checkRunEnd(), 900)
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
    unitName:    currentEntry.unit.name,
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

// ─── Slot hover info ──────────────────────────────────────────────────────────

function showSlotHover(unit, elId) {
  const el = $(elId)
  if (!el) return
  if (unit.description) {
    el.innerHTML =
      `${unit.name}<br><span class="slot-hover-desc">${unit.description}</span>`
  } else {
    el.textContent = unit.name
  }
}

function clearSlotHover(elId) {
  const el = $(elId)
  if (el) el.textContent = ''
}

// ─── Setup screen ─────────────────────────────────────────────────────────────

function initSetupScreen() {
  // Restore saved settings into the form
  for (const cb of document.querySelectorAll('input[name=faction]'))
    cb.checked = settings.factions.includes(cb.value)

  for (const cb of document.querySelectorAll('input[name=tier]')) {
    if (cb.value === 'optional') cb.checked = settings.tiers.includes('optional')
    else                         cb.checked = settings.tiers.includes(Number(cb.value))
  }

  if (settings.keyboard)
    document.querySelector(`input[name=keyboard][value=${settings.keyboard}]`).checked = true
  $('hint-timeout').value = settings.hintTimeout
  updateHintLabel(settings.hintTimeout)
  $('time-limit').value = settings.timeLimit
  updateTimeLimitLabel(settings.timeLimit)
  $('run-length').value = settings.runLength
  updateRunLengthLabel(settings.runLength)

  // Restore shortcuts checkboxes
  for (const cb of document.querySelectorAll('input[name=shortcuts]'))
    cb.checked = (settings.shortcuts ?? []).includes(cb.value)

  updateBuilderCount()

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

  for (const cb of document.querySelectorAll('input[name=buildertype]'))
    cb.checked = (settings.builderTypes ?? ['factory', 'constructor']).includes(cb.value)

  for (const cb of document.querySelectorAll('input[name=faction], input[name=tier], input[name=buildertype]'))
    cb.addEventListener('change', onFilterChange)

  function syncShortcutSettings() {
    settings.shortcuts = [...document.querySelectorAll('input[name=shortcuts]:checked')]
      .map(el => el.value)
    saveSettings(settings)
    updateBuilderCount()
    const allChecked = document.querySelectorAll('input[name=shortcuts]').length ===
                       document.querySelectorAll('input[name=shortcuts]:checked').length
    $('btn-shortcuts-toggle').textContent = allChecked ? 'Deselect all' : 'Select all'
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

  for (const rb of document.querySelectorAll('input[name=keyboard]'))
    rb.addEventListener('change', e => {
      settings.keyboard = e.target.value
      saveSettings(settings)
      updateBuilderCount()
    })

  $('btn-start').addEventListener('click', () => {
    precacheIcons(filteredBuilders(settings))
    showNewRunCountdown()
  })
  $('btn-browse').addEventListener('click', () => showScreen('browse'))
  $('btn-browse-shortcuts').addEventListener('click', () => showScreen('shortcuts'))
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
  $('btn-newrun').addEventListener('click', () => {
    precacheIcons(filteredBuilders(settings))
    showNewRunCountdown()
  })
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
  const count   = filteredBuilders(settings).length
  const scCount = SHORTCUTS.reduce((total, grp) =>
    (settings.shortcuts?.includes(grp.id) ? total + grp.shortcuts.length : total), 0)
  $('builder-count').textContent =
    `${count} builder${count !== 1 ? 's' : ''} · ${scCount} shortcut${scCount !== 1 ? 's' : ''} selected`
  if (!settings.keyboard) {
    $('builder-count').textContent = '⚠ Choose a keyboard layout above to start'
    $('btn-start').disabled = true
    return
  }
  $('btn-start').disabled = (count === 0 && scCount === 0)
}

// ─── Browse screen ─────────────────────────────────────────────────────────────

let browseBuilder = null
let browseCatId   = null
let browsePage    = 0

function initBrowseScreen() {
  $('btn-browse-back').addEventListener('click', () => showScreen('setup'))
  $('browse-search').addEventListener('input', e => renderBrowseList(e.target.value))
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
      for (const builder of items) section.appendChild(makeBrowseItem(builder))
    }

    out.appendChild(section)
  }
}

function selectBrowseBuilder(id) {
  browseBuilder = DATA.builders[id]
  browseCatId   = Object.keys(browseBuilder.categories)[0] ?? null
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
      const img = document.createElement('img')
      img.src = `data/${unit.icon}`
      img.alt = unit.name
      img.addEventListener('error', () => img.remove())

      const eBadge = document.createElement('span')
      eBadge.className = 'slot-energy'
      eBadge.textContent = fmtCost(unit.energyCost)

      const mBadge = document.createElement('span')
      mBadge.className = 'slot-metal'
      mBadge.textContent = fmtCost(unit.metalCost)

      const keyLabel = document.createElement('span')
      keyLabel.className = 'slot-key'
      keyLabel.textContent = display(key, isQwertz)

      slot.append(img, eBadge, mBadge, keyLabel)
      slot.addEventListener('mouseenter', () => showSlotHover(unit, 'browse-slot-hover-info'))
      slot.addEventListener('mouseleave', () => clearSlotHover('browse-slot-hover-info'))
    }

    gridContainer.appendChild(slot)
  }

  // Page bar
  const pageBar   = $('browse-page-bar')
  const totalPages = cat ? ((cat.units[cat.units.length - 1]?.page ?? 0) + 1) : 1
  if (totalPages <= 1) {
    pageBar.classList.add('hidden')
  } else {
    pageBar.classList.remove('hidden')
    pageBar.innerHTML =
      `Page ${browsePage + 1} / ${totalPages} — press <kbd>B</kbd> to advance`
  }
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

function formatShortcutKey(shortcut, isQwertz) {
  const mods = shortcut.modifiers ?? []
  const renderCombo = (key) => {
    const parts = [...mods, display(key, isQwertz)]
    return parts.map(p => `<kbd>${p}</kbd>`).join('+')
  }
  if (shortcut.keys) {
    return shortcut.keys.map(renderCombo).join(' <span class="sc-seq-arrow">→</span> ')
  }
  return renderCombo(shortcut.key)
}

function initShortcutsScreen() {
  $('btn-shortcuts-back').addEventListener('click', () => showScreen('setup'))

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

  const rows = group.shortcuts.map(sc => {
    const reserved = sc.browserReserved
      ? '<span class="sc-reserved">study card — all browsers</span>'
      : sc.browserReservedFirefox
        ? '<span class="sc-reserved">study card — Firefox only</span>'
        : ''
    const desc = sc.description
      ? `<div class="sc-desc">${sc.description}</div>` : ''
    return `
      <tr>
        <td class="sc-action"><span class="sc-label">${sc.label}</span>${desc}</td>
        <td class="sc-key">${formatShortcutKey(sc, isQwertz)}${reserved}</td>
      </tr>`
  }).join('')

  content.innerHTML = `
    <h3 class="sc-group-heading">${group.name}</h3>
    <table class="sc-table">
      <thead>
        <tr>
          <th>Action</th>
          <th>Key</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  showScreen('loading')
  try {
    await loadData()
  } catch (err) {
    document.querySelector('#screen-loading p').textContent =
      `Failed to load data: ${err.message}`
    return
  }

  try {
    const scResp = await fetch('data/shortcuts.json')
    SHORTCUTS = (await scResp.json()).groups || []
  } catch {}

  await loadSounds()

  initSetupScreen()
  initBrowseScreen()
  initShortcutsScreen()
  showScreen('setup')
  // Prevent browser-reserved keys from closing the tab/app while training.
  // Ctrl+W closes tabs and Ctrl+Q quits the browser on Linux/Windows.
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && (event.key === 'w' || event.key === 'W' ||
                          event.key === 'q' || event.key === 'Q')) {
      event.preventDefault()
    }
  }, { capture: true })

  // Belt-and-suspenders: if the keydown block didn't work (e.g. Chromium on Linux
  // intercepts Ctrl+W before JS), the beforeunload dialog is the last line of defence.
  window.addEventListener('beforeunload', (event) => {
    if (document.getElementById('screen-training')?.classList.contains('active') && !runComplete) {
      event.preventDefault()
      event.returnValue = ''
    }
  })

  document.addEventListener('keydown', onKey)
  // Fallback: some browsers deliver the Shift keydown to the focused element before
  // it bubbles (or swallow it entirely for focus-management shortcuts like Shift+Tab).
  // Listening on keyup guarantees we always catch the Shift release.
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Shift') handleGoBack()
  })
}

init()
