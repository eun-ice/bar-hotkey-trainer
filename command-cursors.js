/**
 * The in-game command icons shown next to each command in the shortcut list — output name
 * → repo-relative source image. Most are the first frame of the command's cursor animation
 * under anims/icexuick_166 (most start at `_0`; pickup, unload and wait start at `_1`);
 * repeat is the order-menu icon. Reclaim takes a late frame: the animation fades from
 * white to the green the game gives that order, and the infographics use the green.
 *
 * Shared by fetch-bar-data.js (downloads the sources) and extract-data.js (converts them to
 * data/commands/*.webp). app.js COMMAND_ICONS maps BAR actions onto these names.
 */
const CURSORS = 'anims/icexuick_166'

export const COMMAND_CURSORS = {
  reclaim:    { src: `${CURSORS}/cursorreclamate_50.png` },
  repair:     { src: `${CURSORS}/cursorrepair_0.png` },
  resurrect:  { src: `${CURSORS}/cursorrevive_0.png` },
  attack:     { src: `${CURSORS}/cursorattack_0.png` },
  fight:      { src: `${CURSORS}/cursorfight_0.png` },
  capture:    { src: `${CURSORS}/cursorcapture_0.png` },
  settarget:  { src: `${CURSORS}/cursorsettarget_0.png` },
  load:       { src: `${CURSORS}/cursorpickup_1.png` },
  unload:     { src: `${CURSORS}/cursorunload_1.png` },
  move:       { src: `${CURSORS}/cursormove_0.png` },
  patrol:     { src: `${CURSORS}/cursorpatrol_0.png` },
  guard:      { src: `${CURSORS}/cursordefend_0.png` },
  wait:       { src: `${CURSORS}/cursorwait_1.png` },
  gather:     { src: `${CURSORS}/cursorgather_0.png` },
  manualfire: { src: `${CURSORS}/cursordgun_0.png` },
  selfd:      { src: `${CURSORS}/cursorselfd_0.png` },
  areamex:    { src: `${CURSORS}/cursorareamex_0.png` },
  restore:    { src: `${CURSORS}/cursorrestore_0.png` },
  repeat:     { src: 'luaui/images/repeat.png' },
}

/** ImageMagick arguments that turn a source image into its 64px webp icon. */
export function commandIconArgs(srcPath, outPath) {
  return [srcPath, '-resize', '64x64', '-quality', '90', outPath]
}
