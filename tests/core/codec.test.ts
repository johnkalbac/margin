import { describe, expect, it } from 'vitest'

import {
  decode,
  detectBom,
  detectEncoding,
  encode,
  type EncodingDetection
} from '@core/text/codec'
import { ENCODINGS, bomFor, fromDetectorName, type Encoding } from '@core/text/encoding'
import { applyEol, detectEol, normalizeToLf, type Eol } from '@core/text/eol'

/**
 * Round-trip suite (plan §6, §12).
 *
 * Every supported encoding x every EOL style: read, mutate, write, assert at the
 * byte level. This is the suite the compare phase depends on — a byte lost here
 * surfaces in Phase 6 as a diff on a line nobody edited.
 */

/**
 * Sample text per encoding, using only characters that encoding can represent.
 * ISO-8859-1 has no em dash or curly quote; Windows-1252 has both, in the
 * 0x80-0x9F range that is exactly where the two disagree.
 */
const SAMPLES: Record<Encoding, string> = {
  utf8: '# Notes\n\nCafé — naïve “quoted” 日本語 ✓\n',
  utf8bom: '# Notes\n\nCafé — naïve “quoted” 日本語 ✓\n',
  utf16le: '# Notes\n\nCafé — naïve “quoted” 日本語 ✓\n',
  utf16be: '# Notes\n\nCafé — naïve “quoted” 日本語 ✓\n',
  windows1252: '# Notes\n\nCafé — naïve “quoted” ± µ\n',
  iso88591: '# Notes\n\nCafé naïve ± µ ÷ ¿\n'
}

const EOLS: Eol[] = ['LF', 'CRLF']

describe('encode/decode round trip', () => {
  for (const encoding of ENCODINGS) {
    for (const eol of EOLS) {
      it(`${encoding} + ${eol} survives decode -> encode byte-identically`, () => {
        const text = applyEol(SAMPLES[encoding], eol)
        const onDisk = encode(text, encoding)

        // What a read does: decode the bytes back to a string.
        const readBack = decode(onDisk, encoding)
        expect(readBack).toBe(text)

        // What a write does: encode that string again. Byte-identical or the
        // file grew or lost a BOM.
        expect(encode(readBack, encoding).equals(onDisk)).toBe(true)
      })
    }
  }

  it('round-trips a CRLF Windows-1252 file byte-identically (§13 Phase 2)', () => {
    // Built as raw bytes, the way the file would actually sit on disk: no BOM,
    // 0x92 is the Windows-1252 curly apostrophe, 0xE9 is e-acute.
    const onDisk = Buffer.from([
      0x49, 0x74, 0x92, 0x73, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a, // It's café\r\n
      0x6c, 0x69, 0x6e, 0x65, 0x20, 0x32, 0x0d, 0x0a // line 2\r\n
    ])

    const detected = detectEncoding(onDisk)
    const text = decode(onDisk, 'windows1252')
    const eol = detectEol(text)

    expect(text).toBe('It’s café\r\nline 2\r\n')
    expect(eol.eol).toBe('CRLF')

    // The editor holds LF internally; DocMeta.eol is what restores CRLF on write.
    const inBuffer = normalizeToLf(text)
    expect(inBuffer).toBe('It’s café\nline 2\n')

    const written = encode(applyEol(inBuffer, eol.eol), detected.encoding)
    expect(written.equals(onDisk)).toBe(true)
  })

  it('preserves BOM presence as a property of the encoding', () => {
    const text = 'hello\n'
    expect(encode(text, 'utf8').subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false)
    expect(encode(text, 'utf8bom').subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true)
    expect(encode(text, 'utf16le').subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))).toBe(true)
    expect(encode(text, 'utf16be').subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))).toBe(true)
  })

  it('does not eat a U+FEFF that is real document content', () => {
    // A zero-width no-break space mid-document is not a BOM. Stripping it would
    // silently alter the file, so decode only removes a leading mark.
    const text = 'a﻿b'
    expect(decode(encode(text, 'utf8'), 'utf8')).toBe(text)
    expect(decode(encode(text, 'utf8bom'), 'utf8bom')).toBe(text)
  })

  it('round-trips an empty file as zero bytes', () => {
    for (const encoding of ENCODINGS) {
      const bytes = encode('', encoding)
      // Only the BOM, if the encoding carries one.
      expect(bytes.length).toBe(bomFor(encoding).length)
      expect(decode(bytes, encoding)).toBe('')
    }
  })
})

describe('detectBom', () => {
  it('identifies each mark', () => {
    expect(detectBom(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('utf8bom')
    expect(detectBom(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toBe('utf16le')
    expect(detectBom(Buffer.from([0xfe, 0xff, 0x00, 0x61]))).toBe('utf16be')
  })

  it('returns null for unmarked bytes and for a truncated mark', () => {
    expect(detectBom(Buffer.from([0x61, 0x62]))).toBe(null)
    expect(detectBom(Buffer.from([0xef, 0xbb]))).toBe(null)
    expect(detectBom(Buffer.from([]))).toBe(null)
  })
})

describe('detectEncoding', () => {
  const expectDetection = (bytes: Buffer, match: Partial<EncodingDetection>): void => {
    expect(detectEncoding(bytes)).toMatchObject(match)
  }

  it('trusts a BOM completely', () => {
    expectDetection(encode('hello', 'utf8bom'), { encoding: 'utf8bom', source: 'bom', confidence: 1 })
    expectDetection(encode('hello', 'utf16le'), { encoding: 'utf16le', source: 'bom' })
    expectDetection(encode('hello', 'utf16be'), { encoding: 'utf16be', source: 'bom' })
  })

  it('never guesses UTF-16 without a BOM', () => {
    // Adding a BOM on write to a file that never had one is the failure this
    // rule exists to prevent.
    const noBom = Buffer.from('h\0e\0l\0l\0o\0 \0w\0o\0r\0l\0d\0', 'binary')
    expect(detectEncoding(noBom).encoding).not.toBe('utf16le')
    expect(detectEncoding(noBom).encoding).not.toBe('utf16be')
  })

  it('assumes UTF-8 for an empty file rather than reporting a guess', () => {
    expectDetection(Buffer.from([]), { encoding: 'utf8', source: 'default' })
  })

  it('reads plain ASCII as UTF-8', () => {
    expect(detectEncoding(Buffer.from('# Title\n\nordinary prose.\n')).encoding).toBe('utf8')
  })

  it('recognizes multi-byte UTF-8 without a BOM', () => {
    const bytes = encode('日本語のテキストです。これは十分な長さがあります。\n', 'utf8')
    expectDetection(bytes, { encoding: 'utf8' })
  })
})

describe('fromDetectorName', () => {
  it('maps the names the detector actually returns', () => {
    expect(fromDetectorName('UTF-8')).toBe('utf8')
    expect(fromDetectorName('ascii')).toBe('utf8')
    expect(fromDetectorName('windows-1252')).toBe('windows1252')
    expect(fromDetectorName('ISO-8859-1')).toBe('iso88591')
  })

  it('falls back to Windows-1252 for other western single-byte sets', () => {
    expect(fromDetectorName('ISO-8859-2')).toBe('windows1252')
    expect(fromDetectorName('windows-1250')).toBe('windows1252')
  })

  it('returns null for names outside the supported set', () => {
    expect(fromDetectorName('Big5')).toBe(null)
    expect(fromDetectorName('')).toBe(null)
    expect(fromDetectorName(null)).toBe(null)
  })
})
