// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HomeScreen } from '@renderer/components/HomeScreen'
import type { RecentFile } from '@shared/ipc'

/**
 * The home screen as the window's only empty state (§4.1), and its startup.
 *
 * Three ways in, in the order someone wants them: Open File…, the recent list,
 * and the sample last. What this file asserts is that order, the recent list's
 * two states — entries, or the bare "No recent history." line — and that the
 * list is what main returned rather than an optimistic guess: clearing renders
 * the emptied list the IPC call answers with.
 */

function stubFiles(recent: RecentFile[], clear?: () => Promise<RecentFile[]>): {
  recent: ReturnType<typeof vi.fn>
  clearRecent: ReturnType<typeof vi.fn>
} {
  const files = {
    recent: vi.fn(async () => recent),
    clearRecent: vi.fn(clear ?? (async () => []))
  }
  // Only the two members the home screen touches; the rest of the bridge is
  // irrelevant here and a partial stub keeps the failure legible if that changes.
  ;(globalThis as unknown as { window: { margin: unknown } }).window.margin = { files }
  return files
}

const entry = (path: string, name: string): RecentFile => ({ path, name, openedAt: 1 })

describe('HomeScreen', () => {
  /*
   * vitest.config.ts runs with globals: false, which disables testing-library's
   * auto-cleanup (it hooks globals' afterEach). Without this, each render stays
   * in the document and the next test queries two screens.
   */
  afterEach(cleanup)
  beforeEach(() => stubFiles([]))

  it('offers Open File… with its accelerator, and the sample last', async () => {
    render(
      <HomeScreen
        onOpen={vi.fn()}
        onOpenPath={vi.fn()}
        onOpenSample={vi.fn()}
        openAccelerator="Ctrl O"
      />
    )

    const actions = document.querySelectorAll('.home__action')
    expect(actions).toHaveLength(1)
    expect(actions[0]?.textContent).toBe('Open File…Ctrl O')
    expect(screen.getByText('Ctrl O').className).toBe('kbd')

    // The sample is a text link at the foot, not one of the rows above.
    const sample = screen.getByRole('button', { name: 'Open the sample document' })
    expect(sample.className).toBe('home__sample')
    expect(
      actions[0]?.compareDocumentPosition(sample) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('runs each action from its own control', async () => {
    const onOpen = vi.fn()
    const onOpenSample = vi.fn()
    const onOpenPath = vi.fn()
    stubFiles([entry('/tmp/notes.md', 'notes.md')])

    render(
      <HomeScreen
        onOpen={onOpen}
        onOpenPath={onOpenPath}
        onOpenSample={onOpenSample}
        openAccelerator={null}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Open File/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Open the sample document' }))
    await waitFor(() => expect(screen.getByText('notes.md')).toBeTruthy())
    fireEvent.click(screen.getByText('notes.md').closest('button') as HTMLElement)

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpenSample).toHaveBeenCalledTimes(1)
    expect(onOpenPath).toHaveBeenCalledWith('/tmp/notes.md')
  })

  it('lists recent files by name, with the folder as the disambiguator', async () => {
    stubFiles([entry('/home/me/work/notes.md', 'notes.md'), entry('/home/me/spec.md', 'spec.md')])

    const { container } = render(
      <HomeScreen
        onOpen={vi.fn()}
        onOpenPath={vi.fn()}
        onOpenSample={vi.fn()}
        openAccelerator={null}
      />
    )

    await waitFor(() => expect(container.querySelectorAll('.home__recentItem')).toHaveLength(2))
    const names = [...container.querySelectorAll('.home__recentName')].map((n) => n.textContent)
    expect(names).toEqual(['notes.md', 'spec.md'])
    const where = [...container.querySelectorAll('.home__recentWhere')].map((n) => n.textContent)
    expect(where).toEqual(['work', 'me'])
    // The full path is the title, so a name alone is never ambiguous on hover.
    expect(container.querySelector('.home__recentItem')?.getAttribute('title')).toBe(
      '/home/me/work/notes.md'
    )
    expect(container.querySelector('.home__recentEmpty')).toBeNull()
  })

  it('shows one bare line when nothing has been opened yet', async () => {
    const { container } = render(
      <HomeScreen
        onOpen={vi.fn()}
        onOpenPath={vi.fn()}
        onOpenSample={vi.fn()}
        openAccelerator={null}
      />
    )

    await waitFor(() =>
      expect(container.querySelector('.home__recentEmpty')?.textContent).toBe('No recent history.')
    )
    expect(container.querySelectorAll('.home__recentItem')).toHaveLength(0)
    // Nothing to clear, so the control that clears is not offered.
    expect(screen.queryByRole('button', { name: 'Clear recent files' })).toBeNull()
  })

  it('arms before clearing, and renders the list main returned', async () => {
    const files = stubFiles([entry('/tmp/notes.md', 'notes.md')])

    const { container } = render(
      <HomeScreen
        onOpen={vi.fn()}
        onOpenPath={vi.fn()}
        onOpenSample={vi.fn()}
        openAccelerator={null}
      />
    )

    await waitFor(() => expect(container.querySelectorAll('.home__recentItem')).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Clear recent files' }))
    expect(files.clearRecent).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm clearing recent files' }))
    expect(files.clearRecent).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(container.querySelector('.home__recentEmpty')?.textContent).toBe('No recent history.')
    )
  })

  it('carries the mark and the wordmark', () => {
    const { container } = render(
      <HomeScreen
        onOpen={vi.fn()}
        onOpenPath={vi.fn()}
        onOpenSample={vi.fn()}
        openAccelerator={null}
      />
    )

    expect(container.querySelector('.home__mark svg')).not.toBeNull()
    expect(container.querySelector('.home__wordmark')?.textContent).toBe('margin')
    // New Document stays out: the tab strip's + and Cmd+N already carry it.
    expect(screen.queryByText('New Document')).toBeNull()
    expect(container.querySelector('.home__line')).toBeNull()
  })
})
