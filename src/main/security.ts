import { shell, type BrowserWindow, type Session } from 'electron'

/**
 * Renderer hardening (plan §10). Markdown files are untrusted input, and a
 * preview is a rendering surface for content the user did not write.
 */

/**
 * `style-src 'unsafe-inline'` is required, not sloppiness: CodeMirror 6 injects
 * its own <style> elements at runtime and has no nonce hook. Everything else is
 * locked down — in particular `default-src 'none'` and no remote origins, so a
 * Markdown file cannot phone home through an image, a font, or a fetch.
 *
 * Remote images are the tracking-pixel vector called out in the plan; the
 * per-document opt-in that relaxes `img-src` is a Phase 2 setting.
 */
function policy(isDev: boolean): string {
  const directives = [
    "default-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: file:",
    "font-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'"
  ]

  if (isDev) {
    // Vite's dev client injects inline scripts and holds an HMR websocket.
    directives.push("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
    directives.push("connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*")
  } else {
    directives.push("script-src 'self'")
    directives.push("connect-src 'self'")
  }

  return directives.join('; ')
}

export function applyContentSecurityPolicy(session: Session, isDev: boolean): void {
  const csp = policy(isDev)
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })
}

/** Everything that is not the app's own UI is refused or handed to the OS. */
export function hardenWindow(window: BrowserWindow, appOrigin: string): void {
  const { webContents } = window

  // A link in a Markdown file must never replace the application UI.
  webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(appOrigin)) return
    event.preventDefault()
    void openExternalSafely(url)
  })

  // window.open, target=_blank, and anything else that asks for a new window.
  webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(url)
    return { action: 'deny' }
  })

  // No permission a Markdown preview asks for is one this app grants.
  webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  webContents.session.setPermissionCheckHandler(() => false)

  // Refuse attaching a webview under any circumstances.
  webContents.on('will-attach-webview', (event) => event.preventDefault())
}

/**
 * Only http(s) and mailto reach the OS. `file:` links inside a document are a
 * document-open concern and route through doc:open in Phase 2 — never through
 * the shell, which would hand an arbitrary path to the system handler.
 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export async function openExternalSafely(url: string): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) return false
  await shell.openExternal(parsed.href)
  return true
}
