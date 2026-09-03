// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { renderAndSanitize, sanitizeHtml } from '@core/markdown'
import { SOURCE_LINE_ATTR } from '@core/markdown/sourceLine'

/**
 * The hostile-input suite (plan §12). Markdown files are untrusted input, and
 * every one of these is a string a user could plausibly open.
 */

const HOSTILE: Array<[name: string, input: string, mustNotContain: string]> = [
  ['script tags', '<script>alert(1)</script>', '<script'],
  ['img onerror', '<img src=x onerror="alert(1)">', 'onerror'],
  ['svg onload', '<svg onload="alert(1)"></svg>', 'onload'],
  ['iframe', '<iframe src="https://example.com"></iframe>', '<iframe'],
  ['object', '<object data="x.swf"></object>', '<object'],
  ['embed', '<embed src="x.swf">', '<embed'],
  ['form', '<form action="/x"><input name="p"></form>', '<form'],
  ['inline style', '<p style="position:fixed;inset:0">x</p>', 'style='],
  ['base tag', '<base href="https://evil.example">', '<base'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">', '<meta'],
  ['link stylesheet', '<link rel="stylesheet" href="https://evil.example/x.css">', '<link'],
  ['event handler on div', '<div onclick="alert(1)">x</div>', 'onclick'],
  ['malformed nesting', '<p><script>alert(1)', '<script']
]

describe('sanitizeHtml', () => {
  it.each(HOSTILE)('strips %s', (_name, input, mustNotContain) => {
    expect(sanitizeHtml(input)).not.toContain(mustNotContain)
  })

  it.each([
    ['javascript:', '<a href="javascript:alert(1)">x</a>'],
    ['data: html', '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>'],
    ['vbscript:', '<a href="vbscript:msgbox(1)">x</a>']
  ])('strips a %s URL', (_name, input) => {
    const output = sanitizeHtml(input)
    expect(output).not.toMatch(/javascript:/i)
    expect(output).not.toMatch(/vbscript:/i)
    expect(output).not.toMatch(/data:text\/html/i)
  })

  it('keeps ordinary formatting intact', () => {
    const output = sanitizeHtml('<p>Hello <strong>there</strong> <em>friend</em></p>')
    expect(output).toBe('<p>Hello <strong>there</strong> <em>friend</em></p>')
  })

  it('preserves data-source-line, which scroll sync depends on', () => {
    const output = sanitizeHtml(`<p ${SOURCE_LINE_ATTR}="7">x</p>`)
    expect(output).toContain(`${SOURCE_LINE_ATTR}="7"`)
  })

  it('adds rel to external links', () => {
    expect(sanitizeHtml('<a href="https://example.com">x</a>')).toContain(
      'rel="noopener noreferrer"'
    )
  })

  it('disables task-list checkboxes', () => {
    expect(sanitizeHtml('<input type="checkbox" checked>')).toContain('disabled')
  })
})

/**
 * Assert against parsed attributes rather than the raw string. A blocked
 * construct often survives as escaped literal text — markdown-it refuses to
 * build a link from `javascript:`, so the characters remain in the document as
 * prose. That is correct and harmless; a substring assertion would flag it while
 * missing the case that actually matters, which is a live attribute value.
 */
function dangerousAttributes(html: string): string[] {
  const host = document.createElement('div')
  host.innerHTML = html
  const found: string[] = []
  for (const element of host.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim().toLowerCase()
      if (name.startsWith('on')) found.push(`${name}=${value}`)
      if (/^(javascript|vbscript|data:text\/html)/i.test(value)) found.push(`${name}=${value}`)
    }
  }
  return found
}

describe('renderAndSanitize', () => {
  it('is safe for a document that mixes prose and injection attempts', () => {
    const source = [
      '# Title',
      '',
      '<script>alert(1)</script>',
      '',
      '[link](javascript:alert(1))',
      '',
      '![img](x" onerror="alert(1))',
      '',
      'Ordinary **text**.'
    ].join('\n')

    const html = renderAndSanitize(source, 'gfm')

    expect(html).not.toContain('<script')
    expect(dangerousAttributes(html)).toEqual([])
    expect(html).toContain('<strong>text</strong>')
  })

  it('never produces a live link from a javascript: URL', () => {
    const html = renderAndSanitize('[click](javascript:alert(1))', 'gfm')
    const host = document.createElement('div')
    host.innerHTML = html
    // Either no anchor at all (markdown-it declined) or one with a safe href.
    for (const anchor of host.querySelectorAll('a')) {
      expect(anchor.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
    }
    expect(dangerousAttributes(html)).toEqual([])
  })

  it('strips attributes injected through markdown-it-attrs in gfm-extras', () => {
    const html = renderAndSanitize('Paragraph{onclick="alert(1)" style="color:red"}', 'gfm-extras')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('style=')
  })
})
