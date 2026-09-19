/**
 * The filename matters. electron-builder auto-discovers only
 * `electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts}`
 * (app-builder-lib/out/util/config/load.js, `findAndReadConfig`). It does NOT
 * look for `electron-builder.config.cjs`, which this file used to be called —
 * and a config it cannot find produces no error, just a build that silently
 * falls back to defaults: `dist/` instead of `release/`, the package.json `name`
 * instead of `productName`, a one-click NSIS installer, no mac universal target.
 * Do not rename this file, and do not rely on a `--config` flag in package.json
 * either — a bare `npx electron-builder` would drop back to the defaults.
 *
 * The product name is not written here. It comes from branding.json, which
 * src/shared/branding.ts also re-exports — see plan preamble: the name lives in
 * exactly one place.
 */
const branding = require('./branding.json')

/**
 * Distributable filenames are built from `binaryName`, not `productName`: the
 * product name has a capital and could grow a space, and these strings end up in
 * URLs, `curl` lines and CI globs. The name still lives in exactly one place.
 *
 * `${...}` below is electron-builder's own template syntax, expanded by the
 * builder — hence the plain quotes and concatenation rather than a JS template
 * literal, which would try to expand them here.
 */
const binary = branding.binaryName

/**
 * Identities the two stores issue. None is a secret — each is printed on the
 * store's own pages — but none can be derived either, and a value that is off
 * by one character fails at upload, not at build. They are collected here so
 * there is one place to fill them in; `npm run check:store` refuses a store
 * build while any is still a placeholder.
 *
 * The Team ID appears once more, in build/entitlements.mas.plist (a plist
 * cannot read this file). check:store asserts the two agree.
 */
const STORE = {
  /** Apple Developer > Membership details > Team ID (ten characters). */
  appleTeamId: 'P92RML36N5',
  /** Partner Center > Product management > Product identity. */
  msIdentityName: 'JohnKalbac.MarginMarkdownEditor',
  msPublisher: 'CN=499F155C-F04C-417B-9297-7EDE5471EC5A',
  msPublisherDisplayName: 'John Kalbac',
  /**
   * branding.json's storeName — the name reserved in Partner Center, which the
   * package's DisplayName must EQUAL, not merely resemble. electron-builder's
   * manifest template writes the same value as the Start menu name, so Start
   * reads "Margin Markdown Editor" too; the window, menus and title bar keep
   * productName. (On the Mac the store name lives only in App Store Connect,
   * and the bundle keeps productName.)
   */
  msDisplayName: branding.storeName
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: branding.appId,
  productName: branding.productName,
  copyright: branding.copyright,

  directories: {
    output: 'release',
    buildResources: 'build'
  },

  // The notices are generated into out/ but belong beside the app, not inside
  // app.asar where nobody could read them — hence excluded here and placed below.
  files: ['out/**/*', 'package.json', '!**/*.map', '!out/THIRD_PARTY_NOTICES.txt'],

  /**
   * License texts, in the app's resources folder (`resources` beside Margin.exe
   * on Windows, Contents/Resources on macOS). The runtime's two notices, LICENSE.electron.txt
   * and LICENSES.chromium.html, electron-builder ships on its own, beside the
   * executable on Windows. THIRD_PARTY_NOTICES.txt is written by
   * scripts/third-party-notices.mjs as the last step of `npm run build`, which
   * every dist:* script runs first. A bare `npx electron-builder` against a stale
   * out/ would pick up whatever notices that build left.
   */
  extraResources: [
    { from: 'LICENSE', to: 'LICENSE.txt' },
    { from: 'out/THIRD_PARTY_NOTICES.txt', to: 'THIRD_PARTY_NOTICES.txt' }
  ],

    /**
   * The icons are named explicitly even though `buildResources: 'build'` would
   * find build/icon.icns and build/icon.ico on its own — same reasoning as the
   * filename note above: auto-discovery that misses is silent, and the symptom
   * is a shipped installer wearing the default Electron icon. They are built by
   * `npm run icons` (scripts/make-icons.cjs) and committed.
   */

  mac: {
    icon: 'build/icon.icns',
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] }
    ],
    // Applies to the zip; the dmg block below overrides it for the dmg.
    artifactName: binary + '-${version}-${arch}-mac.${ext}',
    category: 'public.app-category.productivity',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    identity: '-'
  },

  win: {
    icon: 'build/icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }]
  },

  /**
   * Mac App Store. `mas` is deep-merged over `mac` (macPackager.js,
   * getPlatformConfig), so every key below that `mac` also sets is restated on
   * purpose — left out, it leaks into the store build:
   *
   *  · identity: `mac` says '-' (ad-hoc). Inherited, the store build is ad-hoc
   *    signed and App Store Connect rejects it. Not null either: null means
   *    "skip signing". The Team ID alone selects both certificates, because
   *    electron-builder matches the identity as a substring of the name —
   *    "Apple Distribution: … (TEAMID)" and "Mac Installer Distribution: … (TEAMID)".
   *  · hardenedRuntime: `mac` turns it on. Under the hardened runtime V8's JIT
   *    needs cs.allow-jit; under the sandbox alone it does not, and the store
   *    does not require the hardened runtime.
   *
   * The entitlements are named explicitly for the same reason the icons are: if
   * build/entitlements.mas.plist is missing, electron-builder silently signs
   * with its NON-sandboxed mac template, and the upload is rejected. The target
   * and arch come from the dist:mas script (`--mac mas --universal`).
   */
  mas: {
    type: 'distribution',
    identity: STORE.appleTeamId,
    hardenedRuntime: false,
    entitlements: 'build/entitlements.mas.plist',
    entitlementsInherit: 'build/entitlements.mas.inherit.plist',
    // Written by the release workflow from a secret; gitignored.
    provisioningProfile: 'build/embedded.provisionprofile',
    /**
     * CFBundleVersion. App Store Connect wants a new one on every upload and
     * accepts at most three integer fields — which is why this is not
     * BUILD_NUMBER: electron-builder appends that one to the version, and
     * 1.0.0.57 is four. Unset outside the release workflow, where the version
     * is used as before.
     */
    bundleVersion: process.env.MAS_BUILD_NUMBER || undefined,
    extendInfo: {
      ElectronTeamID: STORE.appleTeamId,
      // Export compliance: no non-exempt encryption. Answers the question at upload.
      ITSAppUsesNonExemptEncryption: false
    },
    artifactName: binary + '-${version}-mas.${ext}'
  },

  /**
   * Microsoft Store package (`npm run dist:store`). Built UNSIGNED on purpose:
   * the Store re-signs what it ingests, and a package carrying any other
   * signature is refused. The identity must match Partner Center exactly.
   *
   * No setBuildNumber: the Store reserves the fourth version field and requires
   * it to be 0, and electron-builder writes 1.0.0 as 1.0.0.0 by default.
   * runFullTrust is added by electron-builder; fileAssociations (top level)
   * become windows.fileTypeAssociation extensions.
   */
  appx: {
    identityName: STORE.msIdentityName,
    publisher: STORE.msPublisher,
    publisherDisplayName: STORE.msPublisherDisplayName,
    displayName: STORE.msDisplayName,
    applicationId: branding.productName,
    // The default is #464646, a grey plate behind every tile. The tiles in
    // build/appx/ are full-bleed paper, so they want nothing behind them.
    backgroundColor: 'transparent',
    languages: ['en-US'],
    artifactName: binary + '-${version}-${arch}.${ext}'
  },

  /**
   * Register Margin as a handler for Markdown files, on every target:
   *
   *  · NSIS writes the HKCU ProgID/OpenWithProgids keys, so right-click > Open
   *    with lists Margin and a double-clicked .md can be routed to it.
   *  · AppX writes windows.fileTypeAssociation extensions into the manifest.
   *  · macOS (dmg and mas) gets CFBundleDocumentTypes in Info.plist — what puts
   *    Margin in Finder's Open With menu, and what makes the `open-file` event
   *    in src/main/index.ts fire at all.
   *
   * Top level, and only here: the AppX target CONCATENATES top-level and `win`
   * associations, so a second copy under `win` would declare each type twice.
   * The extension set is the association's half of OPENABLE_EXTENSIONS; txt is
   * deliberately left out — claiming it would make Margin a candidate for every
   * plain-text file on the machine.
   */
  fileAssociations: [
    {
      ext: ['md', 'markdown', 'mdown', 'mkd'],
      name: 'Markdown Document',
      description: 'Markdown Document',
      role: 'Editor'
    }
  ],

  dmg: {
    artifactName: binary + '-${version}-${arch}.${ext}'
  },

  nsis: {
    artifactName: binary + '-${version}-setup.${ext}',
    // The installer and uninstaller executables. Without these two, `win.icon`
    // dresses the installed app but the setup .exe the user actually downloads
    // still shows the NSIS default.
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: branding.productName
  },

  // No native modules by design (plan §1) — nothing to rebuild.
  npmRebuild: false
}
