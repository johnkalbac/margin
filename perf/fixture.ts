/**
 * The 2,000-line document behind Phase 1's preview budget.
 *
 * Shared by the Vitest regression check and the Chromium benchmark so both
 * measure the same work. Deliberately varied: prose, headings, lists, fenced
 * code, tables and quotes all take different paths through markdown-it.
 */
export function buildFixture(sections = 112): string {
  const lines: string[] = ['# Performance fixture', '']
  for (let i = 0; i < sections; i++) {
    lines.push(
      `## Section ${i}`,
      '',
      `Paragraph with **bold**, _italic_, \`code\` and a [link](https://example.com/${i}).`,
      '',
      `- first item ${i}`,
      `- second item ${i}`,
      `- third item ${i}`,
      '',
      '```typescript',
      `export const value${i} = ${i} * 2`,
      '```',
      '',
      '| key | value |',
      '| --- | --- |',
      `| ${i} | ${i * 2} |`,
      '',
      `> A quoted remark about section ${i}.`,
      ''
    )
  }
  return lines.join('\n')
}
