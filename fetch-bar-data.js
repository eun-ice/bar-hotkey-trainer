#!/usr/bin/env node
/**
 * BAR Hotkey Trainer — Local Game Data Cache
 *
 * Downloads all BAR game files needed by extract-data.js, fix-order.js, and
 * fix-grid-layout.js into bar-data/ so subsequent runs work offline and never
 * hit GitHub's rate limits.
 *
 * bar-data/ mirrors the repo layout:
 *   bar-data/language/en/units.json
 *   bar-data/luaui/configs/buildmenu_sorting.lua
 *   bar-data/luaui/configs/gridmenu_layouts.lua
 *   bar-data/units/<subdir>/<unit>.lua
 *   bar-data/units-index.json   ← id→path map so scripts skip the tree API
 *   bar-data/manifest.json      ← download timestamp
 *
 * Usage:
 *   node fetch-bar-data.js            # download only if bar-data/ is absent
 *   node fetch-bar-data.js --refresh  # force re-download everything
 *   GITHUB_TOKEN=xxx node fetch-bar-data.js
 *
 * Alternatively you can use bar-data/ as a git sparse checkout:
 *   git clone --filter=blob:none --sparse \
 *       https://github.com/beyond-all-reason/Beyond-All-Reason.git bar-data
 *   cd bar-data
 *   git sparse-checkout set language/en luaui/configs units
 *   cd ..
 * Then all scripts will use the local files automatically.
 * Run  git -C bar-data pull  to refresh.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const RAW = 'https://raw.githubusercontent.com/beyond-all-reason/Beyond-All-Reason/master'
const API = 'https://api.github.com/repos/beyond-all-reason/Beyond-All-Reason'
const HEADERS = {
  'User-Agent': 'bar-hotkey-trainer-extractor',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {}),
}

const BAR_DATA = join(__dirname, 'bar-data')

async function apiGet(url) {
  const res = await fetch(url, { headers: HEADERS })
  if (res.status === 403 || res.status === 429) {
    const body = await res.json().catch(() => ({}))
    const msg  = body.message ?? `HTTP ${res.status}`
    if (msg.toLowerCase().includes('rate limit')) {
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
  return res.json()
}

async function rawGet(url) {
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return res.text()
}

async function rawGetBinary(url) {
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

function saveFile(relPath, content) {
  const fullPath = join(BAR_DATA, relPath)
  const dir = fullPath.slice(0, fullPath.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(fullPath, content, 'utf8')
}

async function batch(items, size, fn) {
  const results = []
  for (let i = 0; i < items.length; i += size) {
    results.push(...await Promise.all(items.slice(i, i + size).map(fn)))
  }
  return results
}

async function main() {
  const refresh = process.argv.includes('--refresh')
  const manifestPath = join(BAR_DATA, 'manifest.json')

  // Always ensure third-party sounds are present regardless of --refresh
  const thirdPartySoundsDir = join(__dirname, 'data', 'sounds')
  mkdirSync(thirdPartySoundsDir, { recursive: true })
  const applausePath = join(thirdPartySoundsDir, 'applause.mp3')
  if (!existsSync(applausePath)) {
    process.stdout.write('Downloading applause sound (CC0 — freesound.org/s/462362 by Breviceps) … ')
    try {
      const res = await fetch('https://cdn.freesound.org/previews/462/462362_9159316-lq.mp3',
        { headers: { 'User-Agent': 'bar-hotkey-trainer-extractor' } })
      if (res.ok) {
        writeFileSync(applausePath, Buffer.from(await res.arrayBuffer()))
        console.log('done')
      } else {
        console.log(`skipped (HTTP ${res.status})`)
      }
    } catch (err) {
      console.log(`skipped (${err.message})`)
    }
  }

  if (!refresh && existsSync(manifestPath)) {
    const mf = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const ageDays = (Date.now() - new Date(mf.downloadedAt).getTime()) / 86_400_000
    console.log(`bar-data/ already downloaded on ${mf.downloadedAt.slice(0, 10)} (${ageDays.toFixed(0)} days ago)`)
    console.log(`  ${mf.unitFiles} unit files, ${mf.configFiles} config files cached`)
    console.log(`Use --refresh to re-download.`)
    return
  }

  mkdirSync(BAR_DATA, { recursive: true })

  // 1. Fetch units/ tree via API
  process.stdout.write('Fetching units/ file tree … ')
  const rootTree  = await apiGet(`${API}/git/trees/master`)
  const unitsNode = rootTree.tree.find(e => e.path === 'units' && e.type === 'tree')
  if (!unitsNode) throw new Error('Could not find units/ in repo tree')
  const unitsTree = await apiGet(`${API}/git/trees/${unitsNode.sha}?recursive=1`)
  const unitFiles = unitsTree.tree.filter(e => e.type === 'blob' && e.path.endsWith('.lua'))
  console.log(`${unitFiles.length} unit .lua files`)

  // Build units-index.json: unitId → repo-relative path (prefixed with units/)
  const unitsIndex = {}
  for (const entry of unitFiles) {
    const id = entry.path.replace(/^.*\//, '').replace(/\.lua$/i, '').toLowerCase()
    unitsIndex[id] = `units/${entry.path}`
  }
  writeFileSync(join(BAR_DATA, 'units-index.json'), JSON.stringify(unitsIndex, null, 2))

  // 2. Download all unit .lua files
  console.log(`Downloading ${unitFiles.length} unit .lua files …`)
  let done = 0, failed = 0
  await batch(unitFiles, 12, async (entry) => {
    try {
      const content = await rawGet(`${RAW}/units/${entry.path}`)
      saveFile(`units/${entry.path}`, content)
      done++
    } catch {
      failed++
    }
    if ((done + failed) % 100 === 0)
      process.stdout.write(`\r  ${done} downloaded, ${failed} failed …`)
  })
  console.log(`\r  ${done} downloaded, ${failed} failed      `)

  // 3. Download config files
  const configFiles = [
    'language/en/units.json',
    'luaui/configs/buildmenu_sorting.lua',
    'luaui/configs/gridmenu_layouts.lua',
    'luaui/Widgets/cmd_context_build.lua',
  ]
  for (const relPath of configFiles) {
    process.stdout.write(`Downloading ${relPath} … `)
    const content = await rawGet(`${RAW}/${relPath}`)
    saveFile(relPath, content)
    console.log('done')
  }

  // 4. Sound files (saved outside bar-data/ into data/sounds/)
  const soundsDir = join(__dirname, 'data', 'sounds')
  mkdirSync(soundsDir, { recursive: true })
  const soundFiles = [
    { src: 'luaui/sounds/buildbar_click.wav', dest: join(soundsDir, 'buildbar_click.wav') },
    { src: 'luaui/sounds/buildbar_add.wav',   dest: join(soundsDir, 'buildbar_add.wav')   },
  ]
  for (const sf of soundFiles) {
    process.stdout.write(`Downloading ${sf.src} … `)
    const buf = await rawGetBinary(`${RAW}/${sf.src}`)
    writeFileSync(sf.dest, buf)
    console.log('done')
  }

  // 5. Manifest
  writeFileSync(manifestPath, JSON.stringify({
    downloadedAt: new Date().toISOString(),
    unitFiles:    done,
    configFiles:  configFiles.length,
    soundFiles:   soundFiles.length,
  }, null, 2))

  console.log(`\nbar-data/ ready — ${done} unit files + ${configFiles.length} config files`)
  console.log(`data/sounds/ ready — ${soundFiles.length} sound files`)
  console.log('All extract/fix scripts will now use local files automatically.')
}

main().catch(e => { console.error(e.message ?? e); process.exit(1) })
