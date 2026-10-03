/**
 * Reproduce the Loader's own module resolution for this plugin.
 *
 * Boots a bare Cordis context with the real `PluginPackages` service over the
 * desktop profile's runtime resolution, then imports the plugin through its
 * absolute file URL exactly as the Loader would after resolving the entry name.
 * Any failure here is the failure the application hit at startup.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

import { RUNTIME, DSH_HOME, PLUGIN } from './env.mjs'

const root = RUNTIME
const installAnchor = `${root}/package.json`
const home = DSH_HOME
const pluginEntry = join(PLUGIN, 'lib', 'index.js')

const boot = await import(pathToFileURL(`${root}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`).href)
const cordis = await import(pathToFileURL(`${root}/node_modules/@deepseek-ai/cordis/lib/index.js`).href)

const profile = boot.loadProfile('dsh', 'desktop', installAnchor, home)
const resolution = await boot.createRuntimeResolution({ installAnchor, profile })

console.log('profile.dir          =', profile.dir)
console.log('linkedRoots          =', JSON.stringify(resolution.linkedRoots))
console.log('profile-scope entries=', resolution.entries.filter((entry) => entry.scope === 'profile').map((entry) => entry.name).join(', ') || '(none)')
console.log('install-scope has zod=', resolution.entries.some((entry) => entry.name === 'zod'))
console.log('install-scope has typert-protocol =', resolution.entries.some((entry) => entry.name === '@deepseek-ai/dsh-typert-protocol'))
console.log('install-scope has dsh-tools       =', resolution.entries.some((entry) => entry.name === '@deepseek-ai/dsh-tools'))
console.log()

const ctx = new cordis.Context()
await ctx.plugin(boot.PluginPackages, { resolution })
console.log('PluginPackages mounted; interception installed')

for (const name of ['zod', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-tools']) {
  try {
    const dir = ctx.pluginPackages.packageOf(name, pathToFileURL(pluginEntry).href)
    console.log('packageOf', name, '->', dir ?? '(unresolved)')
  } catch (error) {
    console.log('packageOf', name, '-> threw', String(error?.message ?? error))
  }
}
console.log()

try {
  const mod = await import(pathToFileURL(pluginEntry).href)
  console.log('IMPORT OK. named exports:', Object.keys(mod).join(', '))
} catch (error) {
  console.log('IMPORT FAILED:', String(error?.message ?? error))
  console.log('code:', error?.code)
  if (error?.stack) console.log(error.stack.split('\n').slice(0, 6).join('\n'))
}

process.exit(0)
