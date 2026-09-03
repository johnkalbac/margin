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

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: branding.appId,
  productName: branding.productName,
  copyright: branding.copyright,

  directories: {
    output: 'release',
    buildResources: 'build'
  },

  files: ['out/**/*', 'package.json', '!**/*.map'],

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
