/**
 * Ask the live install's own compatibility gate whether this plugin may load.
 *
 * This is the guard for the failure that has no visible symptom: DSH evaluates a
 * plugin's dsh requirement **before importing it**, and a row judged incompatible
 * is dropped — the application starts normally, the plugin simply never runs, and
 * nothing is logged where a user would look.
 *
 * Two properties matter, and both are asserted here rather than assumed:
 *
 *   1. The plugin's **own manifest** passes the gate. The suite's other scripts
 *      mount the plugin directly and therefore stay green even while the
 *      application refuses it, which is exactly how a `engines.dsh` exact pin
 *      went unnoticed after DSH moved from 0.2.0-rc.2 to 0.2.1-rc.5.
 *   2. The plugin does not rely on a field the gate may stop honouring: since
 *      0.2.1 the gate prefers `engines.dsh` and only falls back to peer ranges
 *      when that field is absent, so `engines.dsh` is what decides.
 */
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { RUNTIME, PLUGIN } from './env.mjs'

const boot = await import(pathToFileURL(`${RUNTIME}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`).href)

const runtimeVersion = boot.getDshRuntimeVersion()
const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))

console.log('runtime version          :', runtimeVersion)
console.log('plugin                   :', `${manifest.name}@${manifest.version}`)
console.log('plugin engines.dsh       :', manifest.engines?.dsh ?? '(absent — the gate falls back to peers)')
console.log('plugin peerDependencies  :', JSON.stringify(manifest.peerDependencies ?? {}))

const verdict = boot.evaluatePluginCompatibility(manifest, {}, runtimeVersion)
if (verdict !== undefined) {
  console.error('')
  console.error('DENIED: the application drops this entry without importing it, so the')
  console.error('plugin would silently never run. Unmet requirements:')
  console.error('  ', JSON.stringify(verdict.requirements ?? verdict.peers ?? verdict))
  console.error('Widen the offending range (never pin an exact version) and re-run.')
  process.exit(1)
}
console.log('\nPASS the live gate accepts this manifest — the entry may load')

/* An exact pin is the trap this file exists for: it passes on the day it is
 * written and fails on the first upgrade, invisibly. */
const pinned = manifest.engines?.dsh
if (typeof pinned === 'string' && !/^[><=^~*]|\|\||\s/.test(pinned)) {
  console.error(`\nFAIL engines.dsh is pinned to an exact version (${pinned}); it will be denied on the next DSH update.`)
  process.exit(1)
}
console.log('PASS engines.dsh is a range, not an exact pin')

/* The peer ranges are the fallback the gate uses when engines.dsh is absent, so
 * they must also admit the running version. */
const peersOnly = { ...manifest, engines: { node: manifest.engines?.node } }
const fallback = boot.evaluatePluginCompatibility(peersOnly, {}, runtimeVersion)
if (fallback !== undefined) {
  console.error('\nFAIL without engines.dsh the peer ranges would deny this runtime:', JSON.stringify(fallback.peers ?? fallback))
  process.exit(1)
}
console.log('PASS the peer ranges alone would also admit this runtime')

console.log('\nALL COMPATIBILITY CHECKS PASSED')
