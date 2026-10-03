/**
 * Shared environment for the verification suite.
 *
 * The suite runs against a real DSH installation, because a plugin's bare
 * imports (`zod`, `@deepseek-ai/*`) are resolved by DSH's own runtime resolver —
 * and by the `peerDependencies` rule the host applies to a linked plugin. That
 * is exactly what makes this reproducible on another machine, but it also means
 * three paths differ per installation, so every script reads them from here:
 *
 * | Input | Meaning | Default |
 * |---|---|---|
 * | `DSH_RUNTIME_ROOT` | A DSH runtime tree that carries `node_modules` — the extracted `app.asar` (`…/app.asar.unpacked` or an `asar extract` output) | `<repo>/.tools/asar/dsh` |
 * | `DSH_PLUGIN_DIR` | The plugin package to test. `run.ps1` points it at a copy placed inside the runtime tree, so the plugin's dependencies resolve | `<repo>/dsh-session-purge` |
 * | `DSH_HOME_DIR` | The Harness home, for the profile and storage paths | `%USERPROFILE%\.dsh` |
 * | `DSH_PROFILE` | The profile whose patch layer is composed | `desktop` |
 *
 * @module verification/env
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** Absolute DSH runtime tree carrying `node_modules`. */
export const RUNTIME = resolve(process.env.DSH_RUNTIME_ROOT ?? join(here, '..', '.tools', 'asar', 'dsh'))

/** Absolute plugin package under test. */
export const PLUGIN = resolve(process.env.DSH_PLUGIN_DIR ?? join(here, '..', 'dsh-session-purge'))

/** Absolute Harness home. */
export const DSH_HOME = resolve(
  process.env.DSH_HOME_DIR ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'),
)

/** Profile whose patch layer the composition and resolution tests compose. */
export const PROFILE = process.env.DSH_PROFILE ?? 'desktop'

/** The installation's scope directory, which every `@deepseek-ai/*` package lives under. */
export const deepRoot = join(RUNTIME, 'node_modules', '@deepseek-ai')

/**
 * Absolute path of one deep package artifact.
 *
 * @param parts - package name and the path inside it.
 * @returns the absolute path.
 */
export const deepPath = (...parts) => join(deepRoot, ...parts)

/**
 * Import URL of one deep package's built entry.
 *
 * @param name - package name under the `@deepseek-ai` scope.
 * @param entry - path inside the package.
 * @returns the file URL to import.
 */
export const deepUrl = (name, entry = 'lib/index.js') => pathToFileURL(join(deepRoot, name, entry)).href

/** Import URL of one artifact of the plugin under test. */
export const pluginUrl = (entry = 'lib/index.js') => pathToFileURL(join(PLUGIN, entry)).href

/** File URL of the active profile's manifest, which anchors profile resolution. */
export const profileManifestUrl = () => pathToFileURL(join(DSH_HOME, 'profiles', PROFILE, 'package.json')).href

/** Absolute path of the active profile directory. */
export const profileDir = () => join(DSH_HOME, 'profiles', PROFILE)
