/**
 * Integration check against the real runtime pieces: a Cordis context, the real
 * Typert registry, and this plugin's own `apply()`.
 *
 * Anything the gateway would reject at startup — a malformed host manifest, a
 * duplicate invocation id, an unusable codec factory, an invalid service
 * binding — throws here without needing the application restart.
 */
import { pathToFileURL } from 'node:url'

import { RUNTIME, DSH_HOME, PLUGIN, deepRoot as root } from './env.mjs'
const load = (name) => import(pathToFileURL(`${root}/${name}/lib/index.js`).href)
const tree = RUNTIME
const pluginDir = PLUGIN
const home = DSH_HOME

const cordis = await import(pathToFileURL(`${root}/cordis/lib/index.js`).href)
const registry = await load('dsh-typert-registry')
const loader = await load('dsh-typert-loader')
const boot = await load('dsh-app-boot')

/* Install the same profile runtime resolution the application installs, so the
 * plugin's bare imports resolve exactly as they do at startup. */
const context = new cordis.Context()
const profile = boot.loadProfile('dsh', 'desktop', `${tree}/package.json`, home)
const resolution = await boot.createRuntimeResolution({ installAnchor: `${tree}/package.json`, profile })
await context.plugin(boot.PluginPackages, { resolution })

const { TYPERT } = await import(`${pathToFileURL(`${pluginDir}/lib/typert.host.js`).href}`)

// --- 1. the host manifest passes the loader's own boundary validation
const validated = loader.validateTypertManifest('@dsh-local/dsh-session-purge', TYPERT)
console.log('PASS validateTypertManifest:', validated.invocations.length, 'invocations,', validated.model.services.length, 'service(s)')

// --- 2. the real registry accepts it as one atomic contribution
const ctx = new cordis.Context()
await ctx.plugin(registry.TypertRegistry)
const dispose = ctx.typert.register(TYPERT)
console.log('PASS ctx.typert.register')
const locals = ctx.typert.local
const invocations = typeof locals.list === 'function' ? locals.list() : undefined
console.log('     registered invocation ids:', Array.isArray(invocations)
  ? invocations.map((entry) => entry.id ?? entry.descriptor?.id).join(', ')
  : '(local registry exposes no list)')

// --- 3. each descriptor resolves through the registry and materializes its codecs
for (const invocation of TYPERT.invocations) {
  for (const parameter of invocation.parameters) {
    const schema = parameter.codec.create()
    if (typeof schema?.safeParse !== 'function') throw new Error(`${invocation.id}: parameter codec did not produce a schema`)
  }
  if (typeof invocation.result.create()?.safeParse !== 'function') throw new Error(`${invocation.id}: result codec did not produce a schema`)
}
console.log('PASS every codec factory materializes a usable schema')

// --- 4. the plugin applies into a real context and provides a valid binding
const provided = new Map()
const registered = { commands: [], tools: [] }
const hostCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  get: (key) => (key === 'sessionPersistence' ? { root: 'C:/nonexistent' } : undefined),
  provide: (key, value) => {
    provided.set(key, value)
    return () => provided.delete(key)
  },
  set: (key, value) => provided.set(key, value),
  effect: (fn) => fn(),
  inject: (deps, callback) => {
    callback({
      commands: { register: (definition) => registered.commands.push(definition) },
      tools: { register: (definition) => registered.tools.push(definition) },
    })
  },
}
const { apply } = await import(`${pathToFileURL(`${pluginDir}/lib/index.js`).href}`)
apply(hostCtx, {})

const service = provided.get('sessionManager')
if (service === undefined) throw new Error('apply did not provide the sessionManager service')
const binding = service.typertRemote
console.log('     binding:', JSON.stringify({ serviceKey: binding.serviceKey, namespace: binding.namespace, self: binding.service === service }))
if (binding.service !== service || binding.serviceKey !== 'sessionManager' || binding.namespace !== 'sessionManager') {
  throw new Error('the typert binding does not match what the descriptors name')
}
console.log('PASS apply() provides a sessionManager binding the descriptors can select')

// --- 5. descriptor service/namespace/method agree with the implementation
for (const invocation of TYPERT.invocations) {
  const method = service[invocation.method]
  if (typeof method !== 'function') throw new Error(`service has no callable ${invocation.method}`)
  if (invocation.service !== binding.serviceKey) throw new Error(`${invocation.id}: service does not match the binding`)
  if (invocation.namespace !== binding.namespace) throw new Error(`${invocation.id}: namespace does not match the binding`)
}
console.log('PASS descriptor service/namespace/method all resolve on the live service')

// --- 6. the registered tool and command are shaped as the runtime requires
const tool = registered.tools[0]
const command = registered.commands[0]
if (tool?.name !== 'session_purge') throw new Error('the tool did not register')
if (command?.name !== 'purge') throw new Error('the command did not register')
const json = JSON.stringify(tool)
if (json.includes('undefined')) console.log('note: the compiled tool schema mentions undefined')
console.log('PASS tool', tool.name, 'and command', '/' + command.name, 'registered')

// --- 7. delete() on an empty store reports failure instead of throwing
const result = await service.delete({ sessionIds: ['session-does-not-exist'] })
console.log('     delete() on an unknown id ->', JSON.stringify(result.failed))
if (result.failed.length !== 1 || result.deleted.length !== 0) throw new Error('an unknown id must be reported as a failure')
console.log('PASS delete() reports instead of throwing for an unknown session')

dispose()
await ctx.fiber.dispose()
console.log('\nALL INTEGRATION CHECKS PASSED')
process.exit(0)
