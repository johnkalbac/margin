import { describe, expect, it } from 'vitest'

import { renderMarkdown } from '@core/markdown/render'
import { SOURCE_LINE_ATTR } from '@core/markdown/sourceLine'
import { FLAVORS, nextFlavor } from '@core/markdown/flavors'

/**
 * Rendering runs in plain Node with no DOM — that is the point of keeping core/
 * free of Electron and of the browser (plan §12). The sanitizer suite, which
 * genuinely needs a DOM, lives in sanitize.test.ts.
 */

describe('flavors', () => {
  it('cycles through every flavor and returns to the start', () => {
    let flavor = FLAVORS[0]!
    const seen = [flavor]
    for (let i = 0; i < FLAVORS.length - 1; i++) {
      flavor = nextFlavor(flavor)
      seen.push(flavor)
    }
    expect(seen).toEqual([...FLAVORS])
    expect(nextFlavor(flavor)).toBe(FLAVORS[0])
  })
})

describe('raw HTML', () => {
  it.each([...FLAVORS])('is not passed through in %s', (flavor) => {
    const html = renderMarkdown('<script>alert(1)</script>\n\nText', flavor)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('GFM constructs', () => {
  it('renders tables', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |', 'gfm')
    expect(html).toContain('<table')
    expect(html).toContain('<td>1</td>')
  })

  it('renders strikethrough and task lists', () => {
    expect(renderMarkdown('~~gone~~', 'gfm')).toContain('<s>gone</s>')
    expect(renderMarkdown('- [x] done', 'gfm')).toContain('type="checkbox"')
  })

  it('autolinks bare URLs', () => {
    expect(renderMarkdown('See https://example.com now', 'gfm')).toContain(
      '<a href="https://example.com">'
    )
  })

  it('does not render tables or task lists in CommonMark', () => {
    expect(renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |', 'commonmark')).not.toContain(
      '<table'
    )
    expect(renderMarkdown('- [x] done', 'commonmark')).not.toContain('type="checkbox"')
  })
})

describe('GFM + extras', () => {
  it('renders footnotes', () => {
    const html = renderMarkdown('Text[^1]\n\n[^1]: The note.', 'gfm-extras')
    expect(html).toContain('footnote')
  })

  it('renders definition lists', () => {
    const html = renderMarkdown('Term\n:   Definition', 'gfm-extras')
    expect(html).toContain('<dl')
    expect(html).toContain('<dd>')
  })

  it('does not render footnotes in plain GFM', () => {
    expect(renderMarkdown('Text[^1]\n\n[^1]: The note.', 'gfm')).not.toContain('footnote')
  })
})

describe('source line annotation', () => {
  it('annotates block elements with their 1-based source line', () => {
    const html = renderMarkdown('# Title\n\nParagraph one.\n\nParagraph two.', 'gfm')
    expect(html).toContain(`<h1 ${SOURCE_LINE_ATTR}="1">`)
    expect(html).toContain(`<p ${SOURCE_LINE_ATTR}="3">`)
    expect(html).toContain(`<p ${SOURCE_LINE_ATTR}="5">`)
  })

  it('annotates fenced code blocks, which use a bespoke renderer', () => {
    const html = renderMarkdown('Intro\n\n```js\nconst a = 1\n```', 'gfm')
    expect(html).toMatch(new RegExp(`<pre ${SOURCE_LINE_ATTR}="3"`))
  })

  it('annotates blockquotes and lists', () => {
    const html = renderMarkdown('> Quote\n\n- item', 'gfm')
    expect(html).toContain(`<blockquote ${SOURCE_LINE_ATTR}="1">`)
    expect(html).toContain(`<ul ${SOURCE_LINE_ATTR}="3">`)
  })

  it('produces strictly ascending anchors, which scroll sync relies on', () => {
    const html = renderMarkdown('# A\n\nB\n\n## C\n\nD\n\n> E\n', 'gfm')
    const lines = [...html.matchAll(new RegExp(`${SOURCE_LINE_ATTR}="(\\d+)"`, 'g'))].map((match) =>
      Number(match[1])
    )
    expect(lines.length).toBeGreaterThan(3)
    const outermost = lines.filter((line, index) => index === 0 || line >= lines[index - 1]!)
    expect(outermost).toEqual(lines)
  })
})
