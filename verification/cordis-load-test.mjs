/**
 * Load the plugin into a real Cordis fiber, with a real config round trip.
 *
 * This is the last host-side unknown: whether the Loader's config resolution
 * (`Config['~standard'].validate`) accepts this plugin's schema, whether
 * defaults apply, and whether `inject`/`provide` behave.
 */
import { pathToFileURL } from 'node:url'

import { RUNTIME, DSH_HOME, PLUGIN, deepRoot as root } from './env.mjs'
const tree = RUNTIME
const pluginDir = PLUGIN
const home = DSH_HOME

const cordis = await import(pathToFileURL(`${root}/cordis/lib/index.js`).href)
const boot = await import(pathToFileURL(`${root}/dsh-app-boot/lib/index.js`).href)

const setup = new cordis.Context()
const profile = boot.loadProfile('dsh', 'desktop', `${tree}/package.json`, home)
const resolution = await boot.createRuntimeResolution({ installAnchor: `${tree}/package.json`, profile })
await setup.plugin(boot.PluginPackages, { resolution })

const plugin = await import(`${pathToFileURL(`${pluginDir}/lib/index.js`).href}`)

// zod must expose the Standard Schema face Cordis validates through
const standard = plugin.Config['~standard']
console.log('Config["~standard"].validate present:', typeof standard?.validate === 'function')
console.log('vendor:', standard?.vendor)
console.log()

/** Boot the plugin in its own context with a fake persistence service in place. */
const run = async (label, config) => {
  const ctx = new setup.constructor()
  ctx.provide('sessionPersistence', { root: 'C:/nonexistent-sessions' })
  await ctx.plugin(plugin, config)
  await ctx.fiber.await()
  const service = ctx.get('sessionManager')
  const effective = service?.config
  console.log(`${label}: fiber state=${ctx.fiber.state === 2 ? 'active' : ctx.fiber.state}`)
  console.log(`  effective config = ${JSON.stringify(effective)}`)
  console.log(`  service provided = ${service !== undefined}`)
  console.log(`  binding = ${JSON.stringify({ serviceKey: service?.typertRemote?.serviceKey, namespace: service?.typertRemote?.namespace })}`)
  await ctx.fiber.dispose()
  return effective
}

const defaults = await run('no config', undefined)
if (defaults?.stopTimeoutMs !== 8000 || defaults?.allowPermanent !== true) {
  throw new Error(`defaults were not applied: ${JSON.stringify(defaults)}`)
}
console.log('PASS defaults applied')

const explicit = await run('explicit config', { stopTimeoutMs: 1234, allowPermanent: false })
if (explicit?.stopTimeoutMs !== 1234 || explicit?.allowPermanent !== false) {
  throw new Error(`explicit config was not preserved: ${JSON.stringify(explicit)}`)
}
console.log('PASS explicit config preserved')

let rejected = false
try {
  await run('invalid config', { stopTimeoutMs: -5 })
} catch {
  rejected = true
}
console.log(rejected ? 'PASS invalid config rejected' : 'note: invalid config was not rejected')

// --- the injection callbacks must actually fire against live services
{
  const ctx = new setup.constructor()
  ctx.provide('sessionPersistence', { root: 'C:/nonexistent-sessions' })
  const registered = { commands: [], tools: [] }
  ctx.provide('commands', { register: (definition) => registered.commands.push(definition) })
  ctx.provide('tools', { register: (definition) => registered.tools.push(definition) })
  await ctx.plugin(plugin, {})
  await ctx.fiber.await()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const service = ctx.get('sessionManager')
  console.log('injected services: commands =', registered.commands.length, ', tools =', registered.tools.length)
  console.log('  command name =', registered.commands[0]?.name)
  console.log('  tool name    =', registered.tools[0]?.name)
  if (service === undefined) throw new Error('the service was not provided')
  if (registered.commands.length !== 1) throw new Error('ctx.inject([commands]) never fired')
  if (registered.tools.length !== 1) throw new Error('ctx.inject([tools]) never fired')
  await ctx.fiber.dispose()
}
console.log('PASS ctx.inject callbacks register the command and the tool against live services')

console.log('\nALL CORDIS LOAD CHECKS PASSED')
process.exit(0)
