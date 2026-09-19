/**
 * Writes out/THIRD_PARTY_NOTICES.txt — the license text of every package that
 * ships inside Margin.
 *
 * MIT, ISC, BSD and the OFL all require their notice to travel with every copy,
 * and Vite's bundle does not carry it: minification strips the header comments,
 * and a font or a CodeMirror mode arrives as bytes with no attribution attached.
 * electron-builder copies this file into the app's resources folder
 * (extraResources) on every platform. The runtime's own two notices,
 * LICENSE.electron.txt and LICENSES.chromium.html, ship separately: electron-builder
 * leaves them where Electron's distribution has them, one level up on Windows.
 *
 * "Ships" means production dependencies in package-lock.json: everything not
 * flagged `dev`. That is the lockfile's answer, not a hand-kept list, so a new
 * dependency is covered the day it is installed. Electron is a devDependency
 * (electron-builder supplies the binary) and is covered by the two files above.
 *
 * Generated, never committed: a checked-in copy drifts the first time a
 * dependency is bumped and nobody remembers to regenerate it. It runs as the
 * last step of `npm run build`, after electron-vite has emptied out/.
 *
 * A package with neither a license file nor a `license` field fails the build.
 * Shipping code whose terms nobody has read is the one outcome this exists to
 * prevent, so it is not a warning.
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'out', 'THIRD_PARTY_NOTICES.txt')

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const branding = JSON.parse(readFileSync(join(root, 'branding.json'), 'utf8'))

function licenseFiles(dir) {
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name))
    .sort()
    .map((name) => readFileSync(join(dir, name), 'utf8').trim())
}

function declaredLicense(manifest) {
  if (typeof manifest.license === 'string') return manifest.license
  // The deprecated forms: { type } and [{ type }].
  if (manifest.license?.type) return manifest.license.type
  if (Array.isArray(manifest.licenses)) return manifest.licenses.map((each) => each.type).join(' OR ')
  return null
}

const seen = new Set()
const entries = []
const unlicensed = []

for (const [key, meta] of Object.entries(lock.packages)) {
  // '' is Margin itself; `dev` marks what never reaches the package.
  if (key === '' || meta.dev) continue

  const dir = join(root, key)
  // An optional dependency for another platform is in the lockfile but not on
  // disk, and does not ship in this build either.
  if (!existsSync(join(dir, 'package.json'))) continue

  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const id = `${manifest.name}@${manifest.version}`
  if (seen.has(id)) continue
  seen.add(id)

  const texts = licenseFiles(dir)
  const license = declaredLicense(manifest)
  if (texts.length === 0 && !license) unlicensed.push(id)

  entries.push({ id, name: manifest.name, license, texts })
}

if (unlicensed.length > 0) {
  console.error('third-party-notices: no license file or license field for:')
  for (const id of unlicensed) console.error(`  ${id}`)
  process.exit(1)
}

entries.sort((a, b) => a.name.localeCompare(b.name))

const rule = '-'.repeat(78)
const sections = entries.map(({ id, license, texts }) =>
  [
    rule,
    `${id}${license ? ` (${license})` : ''}`,
    rule,
    '',
    texts.length > 0
      ? texts.join('\n\n')
      : `This package ships no license file. Its package.json declares: ${license}`,
    ''
  ].join('\n')
)

const header = [
  `${branding.productName} includes the following third-party software.`,
  '',
  'The Electron runtime and Chromium are distributed under their own terms, in',
  'LICENSE.electron.txt and LICENSES.chromium.html, which ship with the app.',
  '',
  `${entries.length} packages.`,
  ''
].join('\n')

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${header}\n${sections.join('\n')}`, 'utf8')
console.log(`third-party-notices: ${entries.length} packages -> ${output}`)
