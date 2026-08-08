#!/usr/bin/env node
/**
 * Bump the cache-busting query on the assets index.html loads.
 *
 *   npm run bump            # every asset whose file changed since the last bump
 *   npm run bump -- --all   # every asset, changed or not
 *
 * The browser caches app.js and style.css by URL, so a deploy that reuses a URL can be
 * served the old file. Each `?v=N` is bumped here rather than by hand, and logic.js —
 * imported from app.js, not from index.html — is carried along, since a module import is
 * cached on its own and a stale copy of the matching rules would outlive an app.js update.
 */

import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'

const dir   = dirname(fileURLToPath(import.meta.url))
const all   = process.argv.includes('--all')
const INDEX = join(dir, 'index.html')

// Assets referenced from index.html with a ?v= query, plus modules they pull in that need
// their own query. `via` names the file whose import carries the version.
const ASSETS = [
  { file: 'style.css' },
  { file: 'app.js', carries: ['logic.js'] },
]

/** Files touched since the last bump, by mtime against index.html. Falls back to git. */
function changedFiles() {
  const changed = new Set()
  try {
    const out = execSync('git diff --name-only HEAD', { cwd: dir, encoding: 'utf8' })
    for (const line of out.split('\n')) if (line.trim()) changed.add(line.trim())
  } catch {
    // Not a repo, or git unavailable — fall back to mtimes
    const indexAt = statSync(INDEX).mtimeMs
    for (const { file, carries = [] } of ASSETS)
      for (const name of [file, ...carries])
        if (existsSync(join(dir, name)) && statSync(join(dir, name)).mtimeMs > indexAt)
          changed.add(name)
  }
  return changed
}

let html = readFileSync(INDEX, 'utf8')
const changed = all ? null : changedFiles()
const bumped = []

for (const { file, carries = [] } of ASSETS) {
  const touched = all || [file, ...carries].some(name => changed.has(name))
  if (!touched) continue

  const pattern = new RegExp(`(${file.replace('.', '\\.')}\\?v=)(\\d+)`, 'g')
  let next = null
  html = html.replace(pattern, (_, prefix, version) => {
    next = Number(version) + 1
    return prefix + next
  })
  if (next === null) {
    console.error(`  ! ${file} has no ?v= in index.html — skipped`)
    continue
  }
  bumped.push(`${file} → v${next}`)

  // Keep the version on an imported module in step with the file that imports it
  for (const name of carries) {
    const importer = join(dir, file)
    const src = readFileSync(importer, 'utf8')
    const importPattern = new RegExp(`(${name.replace('.', '\\.')}\\?v=)(\\d+)`, 'g')
    if (!importPattern.test(src)) {
      console.error(`  ! ${file} does not import ${name} with a ?v= — skipped`)
      continue
    }
    writeFileSync(importer, src.replace(importPattern, `$1${next}`))
    bumped.push(`${name} → v${next} (imported by ${file})`)
  }
}

if (!bumped.length) {
  console.log('Nothing to bump — no asset changed. Use --all to bump anyway.')
} else {
  writeFileSync(INDEX, html)
  for (const line of bumped) console.log('  ' + line)
}
