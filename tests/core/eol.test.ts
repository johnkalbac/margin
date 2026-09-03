import { describe, expect, it } from 'vitest'

import { applyEol, detectEol, normalizeToLf, platformEol } from '@core/text/eol'

describe('detectEol', () => {
  it('reports LF for a Unix file', () => {
    expect(detectEol('one\ntwo\nthree')).toMatchObject({ eol: 'LF', mixed: false, lf: 2, crlf: 0 })
  })

  it('reports CRLF for a Windows file', () => {
    expect(detectEol('one\r\ntwo\r\nthree')).toMatchObject({
      eol: 'CRLF',
      mixed: false,
      lf: 0,
      crlf: 2
    })
  })

  it('takes the majority and flags a mixed file', () => {
    const result = detectEol('a\r\nb\r\nc\nd')
    expect(result.eol).toBe('CRLF')
    expect(result.mixed).toBe(true)
    expect(result).toMatchObject({ crlf: 2, lf: 1 })
  })

  it('breaks ties toward LF, the normalized in-memory form', () => {
    expect(detectEol('a\r\nb\nc').eol).toBe('LF')
  })

  it('does not guess from a file with no line break', () => {
    expect(detectEol('single line')).toMatchObject({ eol: 'LF', crlf: 0, lf: 0 })
  })
})

describe('normalizeToLf', () => {
  it('collapses CRLF and lone CR', () => {
    expect(normalizeToLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })
})

describe('applyEol', () => {
  it('round-trips CRLF content byte-for-byte', () => {
    const original = 'alpha\r\nbeta\r\ngamma'
    const detected = detectEol(original)
    const buffer = normalizeToLf(original)

    expect(buffer).toBe('alpha\nbeta\ngamma')
    expect(applyEol(buffer, detected.eol)).toBe(original)
  })

  it('round-trips LF content byte-for-byte', () => {
    const original = 'alpha\nbeta\ngamma'
    expect(applyEol(normalizeToLf(original), detectEol(original).eol)).toBe(original)
  })

  it('never emits CRCRLF when the buffer already holds CRLF', () => {
    expect(applyEol('a\r\nb', 'CRLF')).toBe('a\r\nb')
  })

  it('writes a consistent file from a buffer with stray CR', () => {
    expect(applyEol('a\rb\nc', 'LF')).toBe('a\nb\nc')
  })
})

describe('platformEol', () => {
  it('is CRLF on Windows and LF elsewhere', () => {
    expect(platformEol('win32')).toBe('CRLF')
    expect(platformEol('darwin')).toBe('LF')
    expect(platformEol('linux')).toBe('LF')
  })
})
