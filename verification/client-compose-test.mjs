/**
 * Run the real client-module composer over this plugin's Loader entry.
 *
 * `ClientModuleRegistry` performs the browser half's host-side composition:
 * it reads the entry package's `dsh.client` declaration and `./client` export,
 * snapshots the bundle, and publishes a boot row. Its constructor throws for a
 * malformed declaration or a missing bundle, so a clean `graph()` here means
 * the page should have been handed this row.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

import { RUNTIME, DSH_HOME, PLUGIN, deepRoot as root, profileManifestUrl } from './env.mjs'
const cordis = await import(pathToFileURL(`${root}/cordis/lib/index.js`).href)
const modules = await import(pathToFileURL(`${root}/dsh-client-modules/lib/index.js`).href)

const profileUrl = profileManifestUrl()
const require = createRequire(profileUrl)

const entries = [
  {
    options: { name: '@dsh-local/dsh-session-purge' },
    fiber: {},
    disabled: false,
    /* The composer reads the owning tree's base URL to resolve the entry. */
    parent: { tree: { ctx: { baseUrl: profileUrl } } },
  },
]

const loader = {
  entries: () => entries,
  internal: {
    version: 'v2',
    resolveSync(baseUrl, { specifier }) {
      const file = require.resolve(specifier)
      return { url: pathToFileURL(file).href }
    },
  },
}

const ctx = new cordis.Context()
ctx.provide('loader', loader)

let registry
try {
  registry = new modules.ClientModuleRegistry(ctx)
} catch (error) {
  console.log('COMPOSITION FAILED:', String(error?.message ?? error))
  if (error?.failures) for (const failure of error.failures) console.log('  -', String(failure?.message ?? failure))
  process.exit(1)
}

const graph = registry.graph()
console.log('composed rows:', graph.entries.length)
for (const entry of graph.entries) console.log('  row:', JSON.stringify(entry))

const clientPath = registry.clientPath('@dsh-local/dsh-session-purge')
console.log('clientPath:', clientPath)
console.log('bundle exists:', clientPath !== undefined && existsSync(clientPath))

// Serve the bundle the way the Web route does and confirm the served bytes are
// this package's client half, registered under the id the boot row names.
const url = graph.entries[0]?.url
if (url === undefined) throw new Error('the graph carries no row to serve')
const captured = { status: undefined, headers: undefined, body: '' }
const fakeResponse = {
  writeHead(status, headers) {
    captured.status = status
    captured.headers = headers
  },
  end(body) {
    captured.body += body === undefined ? '' : String(body)
  },
  write(body) {
    captured.body += String(body)
  },
  setHeader() {},
}
await registry.serveBundle({ method: 'GET', url: new URL(`http://x/${url}`) }, fakeResponse)
console.log('served status:', captured.status, 'bytes:', captured.body.length)
if (captured.status !== 200) throw new Error(`the bundle route answered ${String(captured.status)}`)
if (!captured.body.includes('__ModuleLoader__.load')) throw new Error('the served body is not a client bundle registration')
if (!captured.body.includes('@dsh-local/dsh-session-purge')) throw new Error('the served body is not this package')
console.log('PASS the served bundle is this package\'s client half')

console.log('\nCLIENT COMPOSITION OK')
process.exit(0)
