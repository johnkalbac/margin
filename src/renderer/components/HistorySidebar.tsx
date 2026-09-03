import { useEffect, useState } from 'react'

import type { HistoryVersion } from '@shared/ipc'
import type { DocId } from '@shared/types'

/**
 * Edit history (plan §9, §13 Phase 5).
 *
 * Lists timestamped versions of the active document, previews one, and restores
 * it. Restore does not rewrite the journal: it applies the old content as an
 * ordinary edit, so a new entry is appended and the version you restored *from*
 * is still there. §13 states that as an acceptance criterion, and it is also
 * the only behaviour that makes restore safe to try.
 *
 * Untitled documents have no journal — there is no canonical path to key one on
 * — so the panel says so rather than showing an empty list that looks broken.
 */

interface HistorySidebarProps {
  docId: DocId | null
  hasFile: boolean
  onRestore: (content: string) => void
  /** Show an inline diff of the buffer against this version (§13 Phase 6). */
  onCompare: (content: string, label: string) => void
  onClose: () => void
}

function timeLabel(iso: string): string {
  const when = new Date(iso)
  const today = new Date()
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate()

  // The design system's metadata voice: lowercase, plain, no cheer.
  return sameDay
    ? when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : when.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
}

export function HistorySidebar({
  docId,
  hasFile,
  onRestore,
  onCompare,
  onClose
}: HistorySidebarProps): React.JSX.Element {
  const [versions, setVersions] = useState<HistoryVersion[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    if (!docId || !hasFile) {
      setVersions([])
      setLoading(false)
      return
    }
    void window.margin.history.versions(docId).then((list) => {
      if (cancelled) return
      setVersions(list)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [docId, hasFile])

  useEffect(() => {
    let cancelled = false
    if (!docId || selected === null) {
      setPreview(null)
      return
    }
    void window.margin.history.contentAt(docId, selected).then((content) => {
      if (!cancelled) setPreview(content)
    })
    return () => {
      cancelled = true
    }
  }, [docId, selected])

  return (
    <aside className="history" aria-label="Edit history">
      <div className="history__head">
        <span className="history__title">History</span>
        <button type="button" className="history__close" onClick={onClose}>
          Close
        </button>
      </div>

      {!hasFile ? (
        <p className="history__empty">
          This document has not been saved, so it has no history yet.
        </p>
      ) : loading ? (
        <p className="history__empty">Reading the journal…</p>
      ) : versions.length === 0 ? (
        <p className="history__empty">No versions recorded yet.</p>
      ) : (
        <ol className="history__list">
          {versions.map((version) => (
            <li key={version.v}>
              <button
                type="button"
                className={
                  version.v === selected ? 'history__item history__item--active' : 'history__item'
                }
                onClick={() => setSelected(version.v)}
              >
                <span className="history__time">{timeLabel(version.iso)}</span>
                {/* A snapshot is a full copy; the distinction matters when
                    reasoning about what survives a damaged journal. */}
                <span className="history__kind">{version.type}</span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {preview !== null ? (
        <div className="history__preview">
          <pre className="history__previewBody">{preview.slice(0, 4000)}</pre>
          <div className="history__actions">
            <button
              type="button"
              className="history__restore"
              onClick={() => {
                const version = versions.find((entry) => entry.v === selected)
                onCompare(preview, version ? timeLabel(version.iso) : 'an earlier version')
              }}
            >
              Compare with current
            </button>
            <button
              type="button"
              className="history__restore"
              onClick={() => onRestore(preview)}
            >
              Restore this version
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  )
}
