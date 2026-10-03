/**
 * Session storage-path vocabulary, mirrored from
 * `@deepseek-ai/dsh-session-persistence-jsonl`'s `format` module.
 *
 * The backend keeps those helpers private (the package exports only its plugin
 * default), and the seam publishes no deletion API, so a purge plugin has to
 * reproduce the *layout* — never the encoding — to locate one session's owned
 * directory. Only `encodeSegment` is duplicated for lookup; the authoritative
 * implementation stays in the backend, and these helpers are used to scan
 * directories and to validate a scanned name, not to write anything.
 *
 * @module dsh-session-purge/paths
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Encode one arbitrary string as a single safe path segment, injectively over
 * all JS strings. Copied exactly from the JSONL backend so a scanned directory
 * name can be compared against a Session id.
 *
 * @param raw - the string to encode; must be non-empty.
 * @returns the escaped single path segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Whether one directory entry name can be the encoded form of a session id.
 *
 * @param name - one entry name inside a project directory.
 * @returns true when the name is a safe session segment.
 */
export function looksLikeSessionSegment(name) {
  return name.length > 0 && /^[A-Za-z0-9._~-]+$/.test(name) && name !== '.' && name !== '..'
}

/**
 * Describe one stored session artifact without reading its event log: the
 * session-owned directory, the project directory holding it, and the log files
 * inside it.
 *
 * @param sessionsRoot - the persistence backend's configured root.
 * @param projectDir - one project directory under that root.
 * @param directoryName - the session's encoded directory name.
 * @returns the locator record.
 */
export function locatorFor(sessionsRoot, projectDir, directoryName) {
  return {
    projectDir,
    sessionDir: join(projectDir, directoryName),
    sessionsRoot,
  }
}

/**
 * The directory name, inside the sessions root, that this plugin's trash uses.
 * Declared here so the layout scan can skip it without importing the service.
 */
export const TRASH_DIRNAME = '.purge-trash'

/**
 * Project directories the store itself owns and that are never a session
 * project: the backend's no-cwd group and this plugin's trash root.
 */
const NON_PROJECT_DIRS = new Set(['_no-cwd', TRASH_DIRNAME])

/**
 * Find every session-owned directory whose encoded name matches `id`.
 *
 * Session directories live under a project directory keyed by the session's
 * cwd, and a cwd is not published by the persistence seam, so the layout is
 * resolved by scanning the root's project directories. Duplicate matches are
 * reported rather than guessed at: two directories for one id mean the store
 * itself is ambiguous and a destructive operation must not pick one.
 *
 * @param sessionsRoot - the persistence backend's configured root.
 * @param id - the Session id to locate.
 * @returns the matching locators, in scan order.
 */
export async function findSessionLocators(sessionsRoot, id) {
  const segment = encodeSegment(id)
  const matches = []
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return matches
    throw error
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    if (NON_PROJECT_DIRS.has(project.name)) continue
    const projectDir = join(sessionsRoot, project.name)
    let entries
    try {
      entries = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name !== segment) continue
      matches.push(locatorFor(sessionsRoot, projectDir, entry.name))
    }
  }
  return matches
}

/**
 * List every session directory the store holds, without reading logs.
 *
 * @param sessionsRoot - the persistence backend's configured root.
 * @returns one entry per stored session directory.
 */
export async function listStoredSessionDirs(sessionsRoot) {
  const found = []
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return found
    throw error
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    if (NON_PROJECT_DIRS.has(project.name)) continue
    const projectDir = join(sessionsRoot, project.name)
    let entries
    try {
      entries = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!looksLikeSessionSegment(entry.name)) continue
      found.push({
        directoryName: entry.name,
        project: project.name,
        ...locatorFor(sessionsRoot, projectDir, entry.name),
      })
    }
  }
  return found
}
