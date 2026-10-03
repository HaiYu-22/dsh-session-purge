/**
 * Mount the real typert loader over this plugin's Loader entry.
 *
 * The client half can only call `sessionManager/*` if the *Host* holds the same
 * invocation descriptors, and the Host gets them from `dsh-typert-loader`
 * scanning the entry's `./typert` export. Registering the manifest by hand
 * proved the manifest is valid; this proves the loader actually finds it.
 */
import { pathToFileURL } from 'node:url'

import { RUNTIME, DSH_HOME, profileManifestUrl, deepRoot } from './env.mjs'

const root = RUNTIME
const deep = `${root}/node_modules/@deepseek-ai`
const home = DSH_HOME
const profileUrl = profileManifestUrl()

const cordis = await import(pathToFileURL(`${deep}/cordis/lib/index.js`).href)
const boot = await import(pathToFileURL(`${deep}/dsh-app-boot/lib/index.js`).href)
const registry = await import(pathToFileURL(`${deep}/dsh-typert-registry/lib/index.js`).href)
const loaderPlugin = await import(pathToFileURL(`${deep}/dsh-typert-loader/lib/index.js`).href)

const profile = boot.loadProfile('dsh', 'desktop', `${root}/package.json`, home)
const resolution = await boot.createRuntimeResolution({ installAnchor: `${root}/package.json`, profile })

const ctx = new cordis.Context()
await ctx.plugin(boot.PluginPackages, { resolution })

// --- what the loader's own package lookup returns for our entry
const packages = ctx.get('pluginPackages')
const found = packages?.packageOf('@dsh-local/dsh-session-purge', profileUrl)
console.log('pluginPackages.packageOf(@dsh-local/dsh-session-purge) ->', found === undefined ? 'UNDEFINED (the loader would fail)' : found.manifestPath ?? found)
if (found !== undefined) {
  console.log('  manifest dsh.bundle:', JSON.stringify(found.manifest?.dsh?.bundle))
  console.log('  manifest exports["./typert"]:', JSON.stringify(found.manifest?.exports?.['./typert']))
}

// --- the loader's own activation over a loader service carrying our entry
const entries = [
  {
    options: { name: '@dsh-local/dsh-session-purge', id: 'session-purge' },
    fiber: { uid: 1 },
    disabled: false,
    parent: { tree: { ctx: { baseUrl: profileUrl } } },
  },
]
ctx.provide('loader', {
  entries: () => entries,
  internal: { version: 'v2', resolveSync: (baseUrl, request) => ({ url: new URL(request.specifier, baseUrl).href }) },
})
await ctx.plugin(registry.TypertRegistry)
ctx.baseUrl = profileUrl

let failure
try {
  await ctx.plugin(loaderPlugin)
  await ctx.fiber.await()
  await new Promise((resolve) => setTimeout(resolve, 200))
} catch (error) {
  failure = error
}
if (failure !== undefined) {
  console.log('LOADER ACTIVATION THREW:', String(failure?.message ?? failure))
  if (failure?.errors) for (const inner of failure.errors) console.log('   -', String(inner?.message ?? inner))
}

const endpoints = ctx.typert.local.list().map((endpoint) => (typeof endpoint === 'string' ? endpoint : endpoint?.id ?? endpoint?.endpoint))
console.log(`ctx.typert.local holds ${endpoints.length} endpoint(s):`)
for (const endpoint of endpoints) console.log(`   ${endpoint}`)

const wanted = [
  '@dsh-local/dsh-session-purge#sessionManager/list',
  '@dsh-local/dsh-session-purge#sessionManager/delete',
  '@dsh-local/dsh-session-purge#sessionManager/restore',
]
const missing = wanted.filter((id) => !endpoints.includes(id))
if (missing.length === 0) {
  console.log('\nHOST DESCRIPTORS REGISTERED — the client call should resolve')
} else {
  console.log('\nMISSING HOST DESCRIPTORS:', missing.join(', '))
  console.log('=> the client call cannot be dispatched; the gateway would answer gateway/*')
}
process.exit(0)
