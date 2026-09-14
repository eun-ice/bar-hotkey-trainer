/**
 * Where the BAR game files come from.
 *
 * `bar-data/` is the downloaded cache, and it only ever holds the handful of files the
 * scripts were told to fetch. A full checkout of the game repo has all of them, so if you
 * have one, point at it and skip the download entirely:
 *
 *   BAR_REPO=~/Projects/bar/Beyond-All-Reason npm run check:bindings
 *
 * Put the same line in your shell profile to make it the default. Paths are relative to
 * the repo root either way, so nothing else has to know which of the two it is reading.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** `~/…` only expands in a shell, and BAR_REPO is usually typed by hand. */
function expandHome(path) {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path
}

/**
 * The directory BAR files are read from, and whether it is a real checkout.
 * A BAR_REPO that does not exist is an error worth saying out loud rather than a silent
 * fall back to the cache, which would then look like the checkout was simply out of date.
 */
export function barSource() {
  const configured = process.env.BAR_REPO?.trim()
  if (configured) {
    const root = expandHome(configured)
    if (!existsSync(root))
      throw new Error(`BAR_REPO points at ${root}, which does not exist`)
    return { root, kind: 'checkout' }
  }
  return { root: join(here, 'bar-data'), kind: 'cache' }
}

/** Absolute path for a repo-relative file, whichever source is in use. */
export function barPath(relPath) {
  return join(barSource().root, relPath)
}

/** Read a repo-relative file, or return null when this source does not carry it. */
export function readBarFile(relPath, encoding = 'utf8') {
  const full = barPath(relPath)
  return existsSync(full) ? readFileSync(full, encoding) : null
}

/** Read and parse a repo-relative JSON file, or null when it is not there. */
export function readBarJson(relPath) {
  const raw = readBarFile(relPath)
  return raw === null ? null : JSON.parse(raw)
}

/** Entries of a repo-relative directory, or [] when it does not exist. */
export function listBarDir(relPath) {
  const full = barPath(relPath)
  return existsSync(full) ? readdirSync(full) : []
}

/** One line naming what was read, so a surprising result is traceable to its source. */
export function barSourceLabel() {
  const { root, kind } = barSource()
  return kind === 'checkout' ? `checkout ${root}` : 'bar-data/ cache'
}
