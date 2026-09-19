import branding from '../../branding.json'
// A named import, so the bundler inlines the one string rather than the whole
// manifest. package.json stays the only place the version is written — the
// release workflow already fails a tag that disagrees with it.
import { license, version } from '../../package.json'

/**
 * The product name lives in exactly one place. Everything that displays it —
 * app menu, window titles, About panel, installer metadata, `productName` in the
 * electron-builder config — reads from here or from branding.json directly.
 *
 * The literal sits in branding.json rather than in this file so that
 * electron-builder.cjs (plain CommonJS, run by Node without a TypeScript
 * loader) can `require` the same source. This module is the typed surface for
 * application code; do not hardcode the name anywhere else.
 */

export const PRODUCT_NAME: string = branding.productName
export const BINARY_NAME: string = branding.binaryName
export const APP_ID: string = branding.appId
export const TAGLINE: string = branding.tagline
export const COPYRIGHT: string = branding.copyright
export const SOURCE_URL: string = branding.sourceUrl
export const VERSION: string = version
/** The SPDX id from package.json, which is also what npm and GitHub read. */
export const LICENSE: string = license
/** The LICENSE file on the default branch — the text the id stands for. */
export const LICENSE_URL = `${SOURCE_URL}/blob/main/LICENSE`

/** Window title. Dirty documents are prefixed with a bullet (plan §8). */
export function windowTitle(documentName: string | null, dirty: boolean): string {
  if (!documentName) return PRODUCT_NAME
  return `${dirty ? '• ' : ''}${documentName} — ${PRODUCT_NAME}`
}
