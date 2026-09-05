// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HomeScreen } from '@renderer/components/HomeScreen'

/**
 * The home screen as the window's only empty state (§4.1).
 *
 * It used to offer New Document, Open File, and a recent list — three ways to
 * ask for what the menu, the tab strip, and the accelerators already provide.
 * Startup no longer seeds a welcome buffer either, so this screen is also what
 * a launch lands on. What it keeps is the mark, the name, and one link: the
 * sample document. Everything this file asserts is that narrowing — and the
 * absence of what was taken out, because the buttons only "still work" if the
 * surfaces that removed them do not also delete the commands.
 */

describe('HomeScreen', () => {
  /*
   * vitest.config.ts runs with globals: false, which disables testing-library's
   * auto-cleanup (it hooks globals' afterEach). Without this, each render stays
   * in the document and the next test queries two screens.
   */
  afterEach(cleanup)

  it('offers exactly one action, the sample-document link', () => {
    render(<HomeScreen onOpenSample={vi.fn()} />)

    const actions = document.querySelectorAll('.home__action')
    expect(actions).toHaveLength(1)
    expect(actions[0]?.textContent).toBe('Open the sample document')
  })

  it('opens the sample when the link is clicked', () => {
    const onOpenSample = vi.fn()
    render(<HomeScreen onOpenSample={onOpenSample} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open the sample document' }))
    expect(onOpenSample).toHaveBeenCalledTimes(1)
  })

  it('carries the mark and the wordmark, and nothing else', () => {
    const { container } = render(<HomeScreen onOpenSample={vi.fn()} />)

    expect(container.querySelector('.home__mark svg')).not.toBeNull()
    expect(container.querySelector('.home__wordmark')?.textContent).toBe('margin')
    // The removed surfaces stay removed: no New/Open rows, no recent list, no
    // prose line under the wordmark.
    expect(screen.queryByText('New Document')).toBeNull()
    expect(screen.queryByText('Open File…')).toBeNull()
    expect(container.querySelector('.home__recent')).toBeNull()
    expect(container.querySelector('.home__line')).toBeNull()
  })
})
