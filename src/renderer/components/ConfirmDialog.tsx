import { useEffect, useRef } from 'react'

import type { CloseChoice } from '@shared/ipc'

/**
 * The unsaved-changes prompt (plan §8, design system "feedback/ConfirmDialog").
 *
 * This replaces a native `dialog.showMessageBox`. A native dialog cannot be
 * themed: it paints in the OS palette, ignores dark mode entirely on Windows,
 * and puts a grey system panel in the middle of an app whose whole design is one
 * neutral ladder. The design system ships a dialog of its own for exactly this,
 * so the prompt is drawn in-app.
 *
 * The tradeoff is real and worth stating: a native dialog is modal to the OS and
 * this is not, so it must not be the last line of defence against data loss. It
 * is not — main still refuses to close the window until the renderer answers,
 * and the answer is what this returns.
 */

export interface ConfirmRequest {
  name: string
  /** More than one document is dirty, so Save All / Discard All mean something. */
  manyDirty: boolean
  resolve: (choice: CloseChoice) => void
}

interface ConfirmDialogProps {
  request: ConfirmRequest
}

export function ConfirmDialog({ request }: ConfirmDialogProps): React.JSX.Element {
  const saveRef = useRef<HTMLButtonElement | null>(null)

  // Save is the default action, and the keyboard should land on it — the same
  // affordance the native dialog gave away for free.
  useEffect(() => {
    saveRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      request.resolve('cancel')
    }
    // Capture, so Escape reaches this before CodeMirror or the palette.
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [request])

  return (
    <div
      className="dialog__scrim"
      role="presentation"
      // Dismissing by clicking away means Cancel: the safe answer, never a
      // discard.
      onClick={() => request.resolve('cancel')}
    >
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dialog__title" id="dialog-title">
          Save changes to {request.name}?
        </h2>
        <p className="dialog__body">Your changes will be lost if they are not saved.</p>

        <div className="dialog__actions">
          <button
            type="button"
            className="dialog__button dialog__button--primary"
            ref={saveRef}
            onClick={() => request.resolve('save')}
          >
            Save
          </button>
          <button
            type="button"
            className="dialog__button dialog__button--ghost"
            onClick={() => request.resolve('discard')}
          >
            Do Not Save
          </button>

          {request.manyDirty ? (
            <>
              <button
                type="button"
                className="dialog__button dialog__button--ghost"
                onClick={() => request.resolve('saveAll')}
              >
                Save All
              </button>
              <button
                type="button"
                className="dialog__button dialog__button--ghost"
                onClick={() => request.resolve('discardAll')}
              >
                Discard All
              </button>
            </>
          ) : null}

          <button
            type="button"
            className="dialog__button dialog__button--link"
            onClick={() => request.resolve('cancel')}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
