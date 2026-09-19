/**
 * `npm run check:store [mas|appx]` — refuses a store build whose store-issued
 * identity is missing or inconsistent. Both targets when no argument is given.
 *
 * Every value checked here fails LATE if it is wrong: electron-builder builds
 * happily with a placeholder publisher or Team ID, and the mistake surfaces
 * minutes later as an upload rejection (or, for the entitlements, as an app
 * that launches unsandboxed in review). The release workflow runs this before
 * building, so a wrong value costs seconds instead.
 *
 * It reads electron-builder.cjs itself rather than a copy of its values, so the
 * config stays the one place they are written.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const config = require(join(root, 'electron-builder.cjs'))

const which = process.argv[2]
const targets = which ? [which] : ['mas', 'appx']
const problems = []

const placeholder = (value) => typeof value !== 'string' || value.includes('REPLACE')

for (const target of targets) {
  if (target === 'mas') {
    const team = config.mas?.identity
    if (placeholder(team)) {
      problems.push('mas: STORE.appleTeamId in electron-builder.cjs is still a placeholder')
    } else if (!/^[A-Z0-9]{10}$/.test(team)) {
      problems.push(`mas: Team ID "${team}" is not ten upper-case letters and digits`)
    }
    if (config.mas?.extendInfo?.ElectronTeamID !== team) {
      problems.push('mas: extendInfo.ElectronTeamID does not match the signing Team ID')
    }

    const plist = readFileSync(join(root, config.mas.entitlements), 'utf8')
    // Strip comments first: the file's own header mentions the keys it sets.
    const body = plist.replace(/<!--[\s\S]*?-->/g, '')
    if (!body.includes('<key>com.apple.security.app-sandbox</key>')) {
      problems.push(`mas: ${config.mas.entitlements} does not enable the App Sandbox`)
    }
    const group = `<string>${team}.${config.appId}</string>`
    if (!body.includes(group)) {
      problems.push(
        `mas: ${config.mas.entitlements} must list the application group ${team}.${config.appId}`
      )
    }

    if (!existsSync(join(root, config.mas.provisioningProfile))) {
      problems.push(
        `mas: ${config.mas.provisioningProfile} is missing (the release workflow writes it from a secret)`
      )
    }
  } else if (target === 'appx') {
    const { identityName, publisher } = config.appx ?? {}
    if (placeholder(identityName)) {
      problems.push('appx: STORE.msIdentityName in electron-builder.cjs is still a placeholder')
    }
    if (placeholder(publisher)) {
      problems.push('appx: STORE.msPublisher in electron-builder.cjs is still a placeholder')
    } else if (!/^CN=[0-9A-F-]{36}$/i.test(publisher)) {
      problems.push(`appx: publisher "${publisher}" should be CN= followed by the GUID Partner Center shows`)
    }
  } else {
    problems.push(`unknown target "${target}" (expected mas or appx)`)
  }
}

if (problems.length > 0) {
  console.error('check:store failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`check:store: ${targets.join(', ')} ok`)
