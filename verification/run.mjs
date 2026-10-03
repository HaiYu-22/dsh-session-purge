#!/usr/bin/env node
/**
 * Run the plugin verification suite against a real DSH runtime tree.
 *
 * Every script in this directory drives the real DSH packages — the Cordis
 * container, the Typert registry and loader, the client-module composer, and the
 * profile runtime resolver. Two facts shape how they run:
 *
 *   * A plugin's bare imports (`zod`, `@deepseek-ai/*`) are supplied by the DSH
 *     installation, and the installation routes them for a linked plugin only
 *     when the plugin declares them in `peerDependencies`. The plugin README
 *     documents that rule.
 *   * The plugin under test is therefore staged INSIDE the runtime tree, where
 *     those imports resolve, and `DSH_PLUGIN_DIR` points at the staged copy.
 *
 * `host-test.mjs` writes a `scratch/` directory beside itself and removes it
 * again; nothing here touches a real Harness home beyond reading its profile.
 *
 * Usage:
 *   node verification/run.mjs [--runtime <dir>] [--home <dir>] [--profile <name>] [--only a.mjs,b.mjs]
 *
 *   --runtime  DSH runtime tree carrying `node_modules`: the shipped
 *              `resources/app.asar.unpacked/dsh`, or the output of
 *              `npx @electron/asar extract resources/app.asar <dir>`.
 *              Default: <repo>/.tools/asar/dsh
 *   --home     Harness home whose profile and storage paths are read.
 *              Default: %USERPROFILE%\.dsh
 *   --profile  Profile whose patch layer is composed. Default: desktop
 *   --only     Comma-separated script names, for a single check.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

/** Read one `--flag value` pair. */
const flag = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const runtime = resolve(flag('--runtime', join(repo, '.tools', 'asar', 'dsh')))
const home = resolve(flag('--home', join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')))
const profile = flag('--profile', 'desktop')
const only = flag('--only', '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0)

const scripts = [
  'host-test.mjs',
  'integration-test.mjs',
  'cordis-load-test.mjs',
  'typert-loader-probe.mjs',
  'compat-test.mjs',
  'resolve-test.mjs',
  'client-test.mjs',
  'client-compose-test.mjs',
].filter((name) => only.length === 0 || only.includes(name))

if (!existsSync(runtime)) {
  console.error(
    `runtime tree not found: ${runtime}\n` +
      'Extract it first, for example:\n' +
      '  npx @electron/asar extract "<install>\\resources\\app.asar" .tools/asar',
  )
  process.exit(2)
}
if (!existsSync(home)) {
  console.error(`Harness home not found: ${home}`)
  process.exit(2)
}
if (scripts.length === 0) {
  console.error(`no known script matches: ${only.join(', ')}`)
  process.exit(2)
}

/* Stage the plugin inside the runtime tree so its dependencies resolve. The
 * staged directory is a full package root (manifest plus `lib/`), because every
 * script addresses the plugin as `<package>/lib/<entry>`. */
const stage = join(runtime, 'purge-harness')
mkdirSync(join(stage, 'lib'), { recursive: true })
copyFileSync(join(repo, 'dsh-session-purge', 'package.json'), join(stage, 'package.json'))
const libDir = join(repo, 'dsh-session-purge', 'lib')
for (const name of readdirSync(libDir)) {
  if (name.endsWith('.js')) copyFileSync(join(libDir, name), join(stage, 'lib', name))
}

const env = {
  ...process.env,
  DSH_RUNTIME_ROOT: runtime,
  DSH_PLUGIN_DIR: stage,
  DSH_HOME_DIR: home,
  DSH_PROFILE: profile,
}

console.log(`runtime : ${runtime}`)
console.log(`plugin  : ${stage}`)
console.log(`home    : ${home}  (profile: ${profile})`)

const failed = []
for (const script of scripts) {
  console.log(`\n==== ${script} ====`)
  /* `inherit` keeps each script's own output intact and needs no pipe. */
  const result = spawnSync(process.execPath, [join(here, script)], { stdio: 'inherit', env })
  if (result.error !== undefined) {
    console.error(`could not start ${script}: ${String(result.error)}`)
    failed.push(script)
    continue
  }
  if (result.status !== 0) failed.push(script)
}

console.log('')
if (failed.length > 0) {
  console.error(`FAILED: ${failed.join(', ')}`)
  process.exit(1)
}
console.log('ALL VERIFICATION SCRIPTS PASSED')
