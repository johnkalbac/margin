import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// The design system's fonts.css @imports Geist from Google Fonts; a desktop app
// must not. These are the same faces, bundled, so the app works offline and the
// CSP admits no remote origins. Variable fonts, so one file covers every weight
// the system's type scale asks for (400/450/500/600).
import '@fontsource-variable/geist'
// Markdown emphasis is semantic, so a real italic is needed even though the
// design system declares no italic face for marketing use. See fonts.css.
import '@fontsource-variable/geist/wght-italic.css'
import '@fontsource-variable/geist-mono'

import './styles/fonts.css'
import './styles/tokens.css'
import './styles/app.css'
import './styles/preview.css'

import { App } from './App'

// Drives the title bar's height and insets in tokens.css — the native window
// controls are drawn over that row and sit on opposite sides per platform.
document.documentElement.dataset.platform = window.margin.platform

const container = document.getElementById('root')
if (!container) throw new Error('Renderer root element is missing')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
