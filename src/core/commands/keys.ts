import type { Platform } from './registry'

/**
 * Matching an Electron accelerator against a DOM keyboard event (plan §7).
 *
 * Kept pure and in core/ so the parity and binding tests run without a browser.
 *
 * The important detail is `event.code`. On macOS, Option+1 does not produce "1"
 * in `event.key` — it produces "¡" — so any matcher that only reads `key` will
 * silently fail for every Alt-modified binding on one platform. `code` is
 * layout-independent for the digit and letter rows and covers that case.
 */

const PRIMARY_TOKENS = new Set(['cmdorctrl', 'commandorcontrol', 'cmd', 'command', 'super'])
const ALT_TOKENS = new Set(['alt', 'option'])
const CTRL_TOKENS = new Set(['ctrl', 'control'])

export interface KeyLikeEvent {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export function matchesAccelerator(
  event: KeyLikeEvent,
  accelerator: string,
  platform: Platform
): boolean {
  const parts = accelerator.split('+').map((part) => part.trim().toLowerCase())
  const key = parts[parts.length - 1]
  if (!key) return false

  const wantsPrimary = parts.some((part) => PRIMARY_TOKENS.has(part))
  const wantsCtrl = parts.some((part) => CTRL_TOKENS.has(part))
  const wantsAlt = parts.some((part) => ALT_TOKENS.has(part))
  const wantsShift = parts.includes('shift')

  // CmdOrCtrl resolves to Command on macOS and Control everywhere else.
  const primaryHeld = platform === 'darwin' ? event.metaKey : event.ctrlKey
  const otherHeld = platform === 'darwin' ? event.ctrlKey : event.metaKey

  if (wantsPrimary && !primaryHeld) return false
  if (wantsCtrl && !event.ctrlKey) return false
  if (!wantsPrimary && !wantsCtrl && (event.ctrlKey || event.metaKey)) return false
  // An unrequested second primary-class modifier means this is a different chord.
  if (wantsPrimary && !wantsCtrl && otherHeld) return false

  if (wantsAlt !== event.altKey) return false
  if (wantsShift !== event.shiftKey) return false

  return matchesKey(event, key)
}

function matchesKey(event: KeyLikeEvent, key: string): boolean {
  if (event.key.toLowerCase() === key) return true

  const code = event.code.toLowerCase()
  if (/^[0-9]$/.test(key)) return code === `digit${key}`
  if (/^[a-z]$/.test(key)) return code === `key${key}`

  const named: Record<string, string> = {
    esc: 'escape',
    escape: 'escape',
    enter: 'enter',
    return: 'enter',
    tab: 'tab',
    space: 'space',
    backspace: 'backspace',
    delete: 'delete',
    up: 'arrowup',
    down: 'arrowdown',
    left: 'arrowleft',
    right: 'arrowright'
  }
  const mapped = named[key]
  return mapped ? event.key.toLowerCase() === mapped || code === mapped : false
}
