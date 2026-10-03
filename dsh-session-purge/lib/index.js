/**
 * Host half of the session purge plugin.
 *
 * DSH stores one zstd-compressed log per Session under `$DSH_HOME/sessions`,
 * and its Workspace registry "deletes" a Session by adding the id to a durable
 * archive set: the row disappears from the sidebar, but every byte stays on
 * disk forever. The persistence seam documents that on purpose ("Nothing
 * deletes session files … the seam has no deletion API"), so nothing in the
 * shipped composition can reclaim the space.
 *
 * This plugin adds the missing maintenance path. It resolves one Session id to
 * its owned storage directory and removes that directory — plus the derived
 * projection-cache document keyed by the same id and the archive entry that
 * hid it — from the *cold* store. Removal is refused for a live Session,
 * because the persistence backend holds a write handle for it and would
 * re-materialize the log on the next append; callers can ask this service to
 * stop the Session through the archive seam first.
 *
 * Two removal modes are offered and the reversible one is the default: a
 * `trash` removal moves the directory into a self-describing
 * `<root>/.purge-trash/<operation>/` folder with a manifest, so it can be put
 * back by hand or through this plugin; a `permanent` removal unlinks it
 * outright.
 *
 * @module dsh-session-purge
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { encodeSegment, findSessionLocators, listStoredSessionDirs, TRASH_DIRNAME } from './paths.js'

/** Cordis service key and Typert wire namespace of this plugin. */
export const SERVICE_KEY = 'sessionManager'

export { TRASH_DIRNAME }

/** How long a stop request waits for a Session to leave the live store. */
const DEFAULT_STOP_TIMEOUT_MS = 8_000

/**
 * The plugin configuration schema. The Loader resolves a row's YAML config
 * through the Standard Schema face of this value, and it validates `undefined`
 * when the row declares no config at all, so the schema itself must accept
 * omission — `.default({})` turns a missing config into the empty object whose
 * field defaults then apply.
 */
const Config = z
  .object({
    stopTimeoutMs: z.number().int().min(1).default(DEFAULT_STOP_TIMEOUT_MS),
    allowPermanent: z.boolean().default(true),
    loadBeacon: z.string().optional(),
  })
  .default({})

/**
 * Append one line to the configured load beacon file.
 *
 * A plugin that fails to import never reaches `apply`, and the Desktop host
 * keeps no readable log, so a local plugin has no way to prove it loaded. A
 * beacon path in the configuration turns "did the host half load?" into a file
 * on disk. It is off by default and never throws: a debugging aid must not be
 * able to break a load.
 *
 * @param path - configured beacon path, if any.
 */
function writeLoadBeacon(path) {
  if (typeof path !== 'string' || path.length === 0) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} session-purge loaded (pid ${process.pid})\n`, 'utf8')
  } catch {
    /* a beacon write failure is never a load failure */
  }
}

/** One Session's storage and lifecycle facts, as the client and tools see them. */
const sessionRowSchema = z.object({
  sessionId: z.string().readonly(),
  cwd: z.string().readonly().optional(),
  live: z.boolean().readonly(),
  archived: z.boolean().readonly(),
  stored: z.boolean().readonly(),
  trashed: z.boolean().readonly(),
  sessionDir: z.string().readonly().optional(),
  project: z.string().readonly().optional(),
  sizeBytes: z.number().readonly().optional(),
})

const failedRowSchema = z.object({
  sessionId: z.string().readonly(),
  code: z.string().readonly(),
  message: z.string().readonly(),
})

const deleteRequestSchema = z.object({
  sessionIds: z.array(z.string()).readonly(),
  permanent: z.boolean().readonly().optional(),
})

const deleteResultSchema = z.object({
  deleted: z.array(sessionRowSchema).readonly(),
  failed: z.array(failedRowSchema).readonly(),
  sweptArchiveIds: z.array(z.string()).readonly(),
})

const listRequestSchema = z.object({
  includeLive: z.boolean().readonly().optional(),
  includeTrashed: z.boolean().readonly().optional(),
})

const listResultSchema = z.object({
  sessions: z.array(sessionRowSchema).readonly(),
  sessionsRoot: z.string().readonly().optional(),
  trashRoot: z.string().readonly().optional(),
  permanentAllowed: z.boolean().readonly(),
})

const restoreRequestSchema = z.object({
  operationIds: z.array(z.string()).readonly(),
})

const restoreResultSchema = z.object({
  restored: z.array(sessionRowSchema).readonly(),
  failed: z.array(failedRowSchema).readonly(),
})

const PACKAGE_NAME = '@dsh-local/dsh-session-purge'

/**
 * Lazy schema factories, exactly as the Typert generator emits them: a
 * descriptor's codec carries a `create()` that returns the schema, so the
 * registry materializes it at most once per process.
 */
const listRequest$schema = () => listRequestSchema
const listResult$schema = () => listResultSchema
const deleteRequest$schema = () => deleteRequestSchema
const deleteResult$schema = () => deleteResultSchema
const restoreRequest$schema = () => restoreRequestSchema
const restoreResult$schema = () => restoreResultSchema

/** The zod schemas the Typert descriptors reference, keyed by descriptor slot. */
export const PURGE_SCHEMAS = Object.freeze({
  listRequest: listRequestSchema,
  listResult: listResultSchema,
  deleteRequest: deleteRequestSchema,
  deleteResult: deleteResultSchema,
  restoreRequest: restoreRequestSchema,
  restoreResult: restoreResultSchema,
})

/**
 * Typert invocation descriptors for this service, in the shape the generator
 * emits for a first-party package. The client half embeds the same descriptors
 * so `ctx.remote.$mount()` can install the `sessionManager` namespace.
 */
export const PURGE_INVOCATIONS = Object.freeze([
  {
    id: `${PACKAGE_NAME}#${SERVICE_KEY}/list`,
    service: SERVICE_KEY,
    namespace: SERVICE_KEY,
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: {
          mode: 'strict',
          typeSymbol: `${PACKAGE_NAME}#${SERVICE_KEY}/list:request`,
          create: listRequest$schema,
        },
      },
    ],
    result: {
      mode: 'strict',
      typeSymbol: `${PACKAGE_NAME}#${SERVICE_KEY}/list:result`,
      create: listResult$schema,
    },
  },
  {
    id: `${PACKAGE_NAME}#${SERVICE_KEY}/delete`,
    service: SERVICE_KEY,
    namespace: SERVICE_KEY,
    method: 'delete',
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: {
          mode: 'strict',
          typeSymbol: `${PACKAGE_NAME}#${SERVICE_KEY}/delete:request`,
          create: deleteRequest$schema,
        },
      },
    ],
    result: {
      mode: 'strict',
      typeSymbol: `${PACKAGE_NAME}#${SERVICE_KEY}/delete:result`,
      create: deleteResult$schema,
    },
  },
  {
    id: `${PACKAGE_NAME}#${SERVICE_KEY}/restore`,
    service: SERVICE_KEY,
    namespace: SERVICE_KEY,
    method: 'restore',
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: {
          mode: 'strict',
          typeSymbol: `${PACKAGE_NAME}#${SERVICE_KEY}/restore:request`,
          create: restoreRequest$schema,
        },
      },
    ],
    result: {
      mode: 'strict',
      typeSymbol: `${PACKAGE_NAME}#${SERVICE_KEY}/restore:result`,
      create: restoreResult$schema,
    },
  },
])

/** One session-removal failure carrying a stable machine-readable code. */
export class SessionPurgeError extends Error {
  /**
   * @param code - stable `<domain>/<reason>` code.
   * @param sessionId - the Session the failure names.
   * @param message - operator-facing explanation.
   */
  constructor(code, sessionId, message) {
    super(message)
    this.name = 'SessionPurgeError'
    this.code = code
    this.sessionId = sessionId
  }
}

/**
 * Reject ids that cannot name a storage segment, so a caller-supplied value is
 * never joined into a path before the store's own escaping has run.
 *
 * @param id - the candidate Session id.
 */
function assertUsableId(id) {
  if (typeof id !== 'string' || id.length === 0) throw new Error('session id must be a non-empty string')
  if (id.length > 512) throw new Error('session id is implausibly long')
  encodeSegment(id)
}

/** Whether `child` is `parent` itself or strictly inside it. */
function isInside(parent, child) {
  const normalizedParent = resolve(parent)
  const normalizedChild = resolve(child)
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + sep)
}

/** Directory size in bytes, best-effort; unreadable entries count as zero. */
async function directoryBytes(dir) {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += await directoryBytes(child)
      else if (entry.isFile()) total += (await stat(child)).size
    } catch {
      /* a concurrent removal or an unreadable entry contributes nothing */
    }
  }
  return total
}

/** Human-readable byte size for command and tool text. */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

/**
 * The session purge service: the host-side maintenance path the persistence
 * seam deliberately does not own.
 */
export class SessionPurge {
  /**
   * @param ctx - the owning Cordis context.
   * @param config - resolved plugin configuration.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.sessionsRoot = undefined
    this.trashRoot = undefined
    this.typertRemote = bindTypertRemote(this, SERVICE_KEY, { namespace: SERVICE_KEY })
  }

  /**
   * Derive the sessions root once. The JSONL backend resolves its configured
   * root in its constructor and keeps it as a plain `root` field; the seam
   * publishes no accessor, so this reads that field.
   *
   * @returns the sessions root, or undefined when no backend exposes one.
   */
  resolveSessionsRoot() {
    if (this.sessionsRoot !== undefined) return this.sessionsRoot
    const backend = this.ctx.get('sessionPersistence')
    const configured = backend?.root ?? backend?.config?.root
    if (typeof configured === 'string' && configured.length > 0) {
      this.sessionsRoot = resolve(configured)
      this.trashRoot = join(this.sessionsRoot, TRASH_DIRNAME)
    }
    return this.sessionsRoot
  }

  /** Require a resolvable sessions root. */
  requireSessionsRoot() {
    const root = this.resolveSessionsRoot()
    if (root === undefined) {
      throw new Error('session purge: no session persistence backend exposes a storage root in this composition')
    }
    return root
  }

  /** The durable archive set, or an empty list when no registry is mounted yet. */
  archivedIds() {
    try {
      const registry = this.ctx.get('workspaceRegistry')
      const ids = registry?.archivedSessionIds
      return Array.isArray(ids) ? [...ids] : []
    } catch {
      return []
    }
  }

  /** Whether one Session is currently held in the live store. */
  isLive(id) {
    try {
      return this.ctx.get('sessions')?.get(id) !== undefined
    } catch {
      return false
    }
  }

  /** The stored header for one Session, read without opening its event log. */
  async storedHeader(id) {
    try {
      const snapshot = await this.ctx.sessionPersistence.stat(id)
      return snapshot?.header
    } catch {
      return undefined
    }
  }

  /** Stored size in bytes, best-effort. */
  async storedSize(id) {
    try {
      const snapshot = await this.ctx.sessionPersistence.stat(id)
      return typeof snapshot?.sizeBytes === 'number' ? snapshot.sizeBytes : undefined
    } catch {
      return undefined
    }
  }

  /** Trash operation manifests on disk. */
  async trashManifests() {
    const root = this.trashRoot
    if (root === undefined || !existsSync(root)) return []
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    const manifests = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const directory = join(root, entry.name)
      try {
        const parsed = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
        manifests.push({ operationId: entry.name, directory, ...parsed })
      } catch {
        /* an unreadable manifest is not a restorable operation */
      }
    }
    return manifests
  }

  /** The set of Session ids that currently sit in the trash. */
  async trashedIds() {
    const ids = new Set()
    for (const manifest of await this.trashManifests()) {
      for (const item of manifest.items ?? []) if (typeof item?.sessionId === 'string') ids.add(item.sessionId)
    }
    return ids
  }

  /** Build one row describing a Session's storage and lifecycle facts. */
  async buildRow(id, context) {
    const { live, archived, trashed, locator, header, sizeBytes } = context
    return {
      sessionId: id,
      ...(typeof header?.cwd === 'string' ? { cwd: header.cwd } : {}),
      live,
      archived,
      stored: locator !== undefined,
      trashed,
      ...(locator !== undefined
        ? { sessionDir: locator.sessionDir, project: basename(locator.projectDir) }
        : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    }
  }

  /**
   * One stored Session's locator, refusing the ambiguous case.
   *
   * @param id - the Session id to locate.
   * @returns the unique locator, or undefined when nothing is stored.
   */
  async locate(id) {
    assertUsableId(id)
    const root = this.requireSessionsRoot()
    const matches = await findSessionLocators(root, id)
    if (matches.length > 1) {
      throw new SessionPurgeError(
        'session-purge/ambiguous-store',
        id,
        `session "${id}" is stored in ${matches.length} project directories; refusing to guess which one to remove`,
      )
    }
    return matches[0]
  }

  /**
   * List stored Sessions with the facts a purge decision needs.
   *
   * @param request - optional live and trash inclusion.
   * @returns the listing plus the resolved roots.
   */
  async list(request = {}) {
    const root = this.resolveSessionsRoot()
    const archived = new Set(this.archivedIds())
    const trashed = await this.trashedIds()
    const includeLive = request?.includeLive !== false
    const includeTrashed = request?.includeTrashed === true

    const rows = []
    if (root !== undefined) {
      for (const entry of await listStoredSessionDirs(root)) {
        const id = entry.directoryName
        const live = this.isLive(id)
        const isTrashed = trashed.has(id)
        if (live && !includeLive) continue
        if (isTrashed && !includeTrashed) continue
        rows.push(await this.buildRow(id, {
          live,
          archived: archived.has(id),
          trashed: isTrashed,
          locator: entry,
          header: await this.storedHeader(id),
          sizeBytes: await directoryBytes(entry.sessionDir),
        }))
      }
    }
    for (const id of archived) {
      if (rows.some((row) => row.sessionId === id)) continue
      const live = this.isLive(id)
      const isTrashed = trashed.has(id)
      if (live && !includeLive) continue
      if (isTrashed && !includeTrashed) continue
      rows.push(await this.buildRow(id, {
        live,
        archived: true,
        trashed: isTrashed,
        locator: undefined,
        header: await this.storedHeader(id),
        sizeBytes: await this.storedSize(id),
      }))
    }
    rows.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    return {
      sessions: rows,
      ...(root !== undefined ? { sessionsRoot: root, trashRoot: this.trashRoot } : {}),
      permanentAllowed: this.config.allowPermanent,
    }
  }

  /**
   * Stop one live Session through the archive seam so its log stops being
   * written, then wait for it to leave the live store.
   *
   * @param id - the Session to stop.
   */
  async stopSession(id) {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) {
      throw new SessionPurgeError(
        'session-purge/live',
        id,
        `session "${id}" is live; this composition has no workspace registry to stop it through`,
      )
    }
    if (!this.archivedIds().includes(id)) {
      await registry.archiveSession(id, { stopActivity: true })
    }
    /* Archiving stops the Session's work, but it does not necessarily close the
     * Session: DSH keeps an entered Session live until its owner releases it, and
     * the persistence backend keeps that Session's log writable. Removing the log
     * under a live writer would leave the two out of step, so the removal waits
     * and then refuses with something the operator can act on. */
    const deadline = Date.now() + this.config.stopTimeoutMs
    while (this.isLive(id)) {
      if (Date.now() > deadline) {
        throw new SessionPurgeError(
          'session-purge/live',
          id,
          `session "${id}" is still open in this application, and its log stays writable while it is. ` +
            `Its work was stopped and it is now archived. Quit and reopen DeepSeek Harness, then remove it: ` +
            `a Session that is not opened again stays cold and is removable, and /purge delete <id> works from a fresh start.`,
        )
      }
      await new Promise((done) => setTimeout(done, 100))
    }
  }

  /**
   * Move one session-owned directory into this plugin's trash.
   *
   * @param locator - the session's storage locator.
   * @param operationDir - the operation directory inside the trash root.
   * @returns the path the directory now occupies.
   */
  async moveToTrash(locator, operationDir) {
    const destination = join(operationDir, 'session')
    await mkdir(dirname(destination), { recursive: true })
    try {
      await rename(locator.sessionDir, destination)
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
      /* A trash root on another volume: copy, then unlink only after the copy landed. */
      const { cp } = await import('node:fs/promises')
      await cp(locator.sessionDir, destination, { recursive: true, errorOnExist: true })
      await rm(locator.sessionDir, { recursive: true, force: true })
    }
    return destination
  }

  /**
   * Write one operation's manifest, so a trashed Session stays identifiable and
   * restorable without this process.
   *
   * @param operationDir - the operation directory inside the trash root.
   * @param manifest - the manifest payload.
   */
  async writeManifest(operationDir, manifest) {
    await writeFile(join(operationDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  }

  /**
   * Drop one Session id from the durable archive set.
   *
   * @param id - the Session id to unarchive.
   * @returns true when the id was archived and is now gone from the set.
   */
  async sweepArchiveEntry(id) {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return false
    if (!this.archivedIds().includes(id)) return false
    await registry.unarchiveSession(id)
    return true
  }

  /** Remove the projection-cache document keyed by this Session id, if present. */
  async dropProjectionCache(id) {
    const cache = this.ctx.get('sessionProjectionCache')
    const table = cache?.table
    if (table !== undefined && typeof table.delete === 'function') {
      try {
        await table.delete(id)
        return
      } catch {
        /* fall through to the document path: the cache is disposable derived data */
      }
    }
    const storeRoot = this.resolveStorageRoot()
    if (storeRoot === undefined) return
    const documentPath = join(storeRoot, 'session_projcache', 'sessions', `${encodeSegment(id)}.json`)
    try {
      await rm(documentPath, { force: true })
    } catch {
      /* a cache document that cannot be removed costs a longer tail replay, never correctness */
    }
  }

  /** The non-session storage hub's root, when it exposes one. */
  resolveStorageRoot() {
    const backend = this.ctx.get('storage')
    const configured = backend?.root ?? backend?.config?.root
    if (typeof configured === 'string' && configured.length > 0) return resolve(configured)
    /* The storage hub publishes no root either, and the shipped sessions root is
     * `<home>/sessions` beside `<home>/storages`, so the derived candidate is
     * confirmed against the projection-cache directory before it is used. */
    const sessionsRoot = this.resolveSessionsRoot()
    if (sessionsRoot === undefined) return undefined
    const candidate = join(dirname(sessionsRoot), 'storages')
    return existsSync(join(candidate, 'session_projcache')) ? candidate : undefined
  }

  /**
   * Remove a project directory once its last Session directory is gone.
   *
   * `recursive` is required: Node's `fs.rm` refuses a directory without it
   * (`ERR_FS_EISDIR`), so the earlier `recursive: false` version silently left
   * every emptied project directory behind — the failure was invisible because
   * the throw was contained. The emptiness check above is what makes the
   * recursion harmless: only a directory with no entries at all is removed.
   */
  async pruneEmptyProjectDir(projectDir) {
    if (projectDir === undefined) return
    try {
      const remaining = await readdir(projectDir)
      if (remaining.length === 0) await rm(projectDir, { recursive: true, force: true })
    } catch {
      /* a non-empty or unreadable project directory is left alone */
    }
  }

  /**
   * Remove one stored Session: its archive entry, its projection-cache
   * document, and its session-owned directory.
   *
   * @param id - the Session id to remove.
   * @param permanent - unlink instead of moving to this plugin's trash.
   * @returns the removed row, the archive sweep flag, or a failure record.
   */
  async removeOne(id, permanent) {
    let locator
    try {
      locator = await this.locate(id)
    } catch (error) {
      if (error instanceof SessionPurgeError) {
        return { failed: { sessionId: id, code: error.code, message: error.message } }
      }
      return {
        failed: { sessionId: id, code: 'session-purge/locate-failed', message: String(error?.message ?? error) },
      }
    }

    const header = await this.storedHeader(id)
    const sizeBytes = await this.storedSize(id)
    const live = this.isLive(id)
    if (live) {
      return {
        failed: {
          sessionId: id,
          code: 'session-purge/live',
          message: `session "${id}" is live; its log would be re-created by the next write`,
        },
      }
    }

    if (locator === undefined) {
      const swept = await this.sweepArchiveEntry(id)
      await this.dropProjectionCache(id)
      if (!swept) {
        return {
          failed: {
            sessionId: id,
            code: 'session-purge/unknown-session',
            message: `session "${id}" has no stored log and no archive entry`,
          },
        }
      }
      return {
        row: await this.buildRow(id, { live, archived: true, trashed: false, locator: undefined, header, sizeBytes }),
        sweptArchive: true,
      }
    }

    if (permanent) {
      await rm(locator.sessionDir, { recursive: true, force: true })
    } else {
      const stamp = new Date().toISOString().replaceAll(':', '-')
      const operationId = `${stamp}-${id.slice(0, 24)}-${randomUUID().slice(0, 8)}`
      const operationDir = join(this.trashRoot, operationId)
      await this.moveToTrash(locator, operationDir)
      await this.writeManifest(operationDir, {
        version: 1,
        operationId,
        removedAt: new Date().toISOString(),
        mode: 'trash',
        items: [
          {
            sessionId: id,
            cwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
            createdAt: typeof header?.createdAt === 'number' ? header.createdAt : undefined,
            originalSessionDir: locator.sessionDir,
            originalProject: basename(locator.projectDir),
            storedDirectory: 'session',
            sizeBytes,
          },
        ],
      })
    }

    await this.dropProjectionCache(id)
    const swept = await this.sweepArchiveEntry(id)
    await this.pruneEmptyProjectDir(locator.projectDir)

    return {
      row: await this.buildRow(id, { live, archived: false, trashed: !permanent, locator: undefined, header, sizeBytes }),
      sweptArchive: swept,
    }
  }

  /**
   * Remove Sessions: the public maintenance operation.
   *
   * @param request - Session ids and the removal mode.
   * @returns the removed rows, the failures, and the archive ids this call swept.
   */
  async delete(request) {
    const ids = Array.isArray(request?.sessionIds) ? request.sessionIds : []
    if (ids.length === 0) throw new Error('session purge: delete needs at least one session id')
    if (ids.length > 500) throw new Error('session purge: delete accepts at most 500 sessions per call')
    const permanent = request?.permanent === true
    if (permanent && !this.config.allowPermanent) {
      throw new Error('session purge: permanent removal is disabled by configuration')
    }
    const deleted = []
    const failed = []
    const sweptArchiveIds = []
    for (const id of ids) {
      try {
        assertUsableId(id)
      } catch (error) {
        failed.push({
          sessionId: String(id),
          code: 'session-purge/invalid-id',
          message: String(error?.message ?? error),
        })
        continue
      }
      try {
        if (this.isLive(id)) await this.stopSession(id)
        const outcome = await this.removeOne(id, permanent)
        if (outcome.failed !== undefined) {
          failed.push(outcome.failed)
          continue
        }
        deleted.push(outcome.row)
        if (outcome.sweptArchive) sweptArchiveIds.push(id)
      } catch (error) {
        failed.push({
          sessionId: id,
          code: error instanceof SessionPurgeError ? error.code : 'session-purge/failed',
          message: String(error?.message ?? error),
        })
      }
    }
    return { deleted, failed, sweptArchiveIds }
  }

  /**
   * Put trashed Sessions back where they were stored.
   *
   * @param request - the operation ids to restore.
   * @returns the restored rows and the failures.
   */
  async restore(request) {
    const operationIds = Array.isArray(request?.operationIds) ? request.operationIds : []
    const restored = []
    const failed = []
    for (const operationId of operationIds) {
      const manifest = (await this.trashManifests()).find((candidate) => candidate.operationId === operationId)
      if (manifest === undefined) {
        failed.push({
          sessionId: operationId,
          code: 'session-purge/unknown-operation',
          message: `no trash operation is recorded as "${operationId}"`,
        })
        continue
      }
      for (const item of manifest.items ?? []) {
        const id = String(item.sessionId)
        const target = String(item.originalSessionDir)
        try {
          const root = this.requireSessionsRoot()
          if (!isInside(root, target)) throw new Error(`refusing to restore outside the sessions root: ${target}`)
          if (this.isLive(id)) {
            throw new SessionPurgeError('session-purge/live', id, `session "${id}" is live again; restore refused`)
          }
          await mkdir(dirname(target), { recursive: true })
          await rename(join(manifest.directory, String(item.storedDirectory ?? 'session')), target)
          restored.push(await this.buildRow(id, {
            live: false,
            archived: false,
            trashed: false,
            locator: { sessionDir: target, projectDir: dirname(target) },
            header: { cwd: item.cwd },
            sizeBytes: item.sizeBytes,
          }))
        } catch (error) {
          failed.push({
            sessionId: id,
            code: error instanceof SessionPurgeError ? error.code : 'session-purge/restore-failed',
            message: String(error?.message ?? error),
          })
        }
      }
      await rm(manifest.directory, { recursive: true, force: true })
    }
    return { restored, failed }
  }

  /**
   * Delete trashed operations for good, which is what actually reclaims their
   * space: a trashed Session was moved, not removed, so until its operation
   * directory is gone the bytes still occupy the same volume.
   *
   * @param request - the operation ids to empty; omitting them empties everything.
   * @returns the emptied operations and the bytes freed.
   */
  async emptyTrash(request) {
    const requested = Array.isArray(request?.operationIds) ? request.operationIds : []
    const manifests = await this.trashManifests()
    const selected = requested.length === 0 ? manifests : manifests.filter((manifest) => requested.includes(manifest.operationId))
    const emptied = []
    const failed = []
    if (requested.length > 0) {
      for (const operationId of requested) {
        if (!manifests.some((manifest) => manifest.operationId === operationId)) {
          failed.push({
            sessionId: operationId,
            code: 'session-purge/unknown-operation',
            message: `no trash operation is recorded as "${operationId}"`,
          })
        }
      }
    }
    let freedBytes = 0
    for (const manifest of selected) {
      try {
        freedBytes += await directoryBytes(manifest.directory)
        await rm(manifest.directory, { recursive: true, force: true })
        emptied.push(manifest.operationId)
      } catch (error) {
        failed.push({
          sessionId: manifest.operationId,
          code: 'session-purge/empty-failed',
          message: String(error?.message ?? error),
        })
      }
    }
    /* The trash root itself goes once nothing is left, so an emptied store has
     * no footprint of this plugin at all. */
    if (this.trashRoot !== undefined) {
      try {
        const remaining = await readdir(this.trashRoot)
        if (remaining.length === 0) await rm(this.trashRoot, { recursive: true, force: true })
      } catch {
        /* an absent or non-empty trash root is left alone */
      }
    }
    return { emptied, failed, freedBytes }
  }

  /** One line per Session for command and tool text. */
  describeRow(row) {
    const flags = [row.live ? 'live' : undefined, row.archived ? 'archived' : undefined, row.trashed ? 'trashed' : undefined]
      .filter((flag) => flag !== undefined)
      .join(',')
    return `${row.sessionId}\t${formatBytes(row.sizeBytes)}${flags.length > 0 ? `\t(${flags})` : ''}`
  }
}

/**
 * Normalize the plugin configuration into the exact values the service uses.
 *
 * Cordis resolves a row's YAML config through the Standard Schema face of the
 * exported `Config` and passes that result to `apply` — an empty object when
 * the row declares no config. The defaults are therefore applied here, from the
 * one source of truth, rather than relying on schema-level defaults: a
 * `z.default({})` wrapper only admits the missing value, it does not re-parse
 * it through the inner object.
 *
 * @param value - the configuration the Loader resolved, if any.
 * @returns the effective configuration.
 */
function resolveConfig(value) {
  const raw = value === undefined || value === null || typeof value !== 'object' ? {} : value
  const timeout = raw.stopTimeoutMs
  return {
    stopTimeoutMs:
      typeof timeout === 'number' && Number.isInteger(timeout) && timeout > 0 ? timeout : DEFAULT_STOP_TIMEOUT_MS,
    allowPermanent: raw.allowPermanent !== false,
    loadBeacon: typeof raw.loadBeacon === 'string' && raw.loadBeacon.length > 0 ? raw.loadBeacon : undefined,
  }
}

/**
 * Register the purge service, the `/purge` command, and the model-facing
 * `session_purge` tool.
 *
 * @param ctx - the owning Cordis context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  writeLoadBeacon(resolved.loadBeacon)
  const service = new SessionPurge(ctx, resolved)

  ctx.provide(SERVICE_KEY, service)
  ctx.set(SERVICE_KEY, service)

  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'purge',
      description: 'Permanently remove archived sessions from disk (deep delete)',
      input: { hint: '[list|candidates|delete <id...>|delete-archived [permanent]|trash|restore <operationId...>]' },
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim()
        const [verb = 'candidates', ...rest] = raw.split(/\s+/).filter((part) => part.length > 0)
        try {
          switch (verb) {
            case 'list': {
              const result = await service.list({ includeLive: true, includeTrashed: true })
              if (result.sessions.length === 0) return { kind: 'success', text: 'No stored sessions.' }
              return {
                kind: 'success',
                text: result.sessions.map((row) => service.describeRow(row)).join('\n'),
              }
            }
            case 'candidates': {
              const result = await service.list({ includeLive: false, includeTrashed: false })
              const removable = result.sessions.filter((row) => row.archived || !row.live)
              if (removable.length === 0) return { kind: 'success', text: 'No archived or cold sessions to remove.' }
              const total = removable.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0)
              return {
                kind: 'success',
                text:
                  `${removable.length} session(s), ${formatBytes(total)} reclaimable:\n` +
                  removable.map((row) => service.describeRow(row)).join('\n') +
                  '\n\nUse /purge delete <id...> (reversible) or /purge delete <id...> permanent.',
              }
            }
            case 'delete': {
              const ids = rest.filter((part) => part !== 'permanent')
              const permanent = rest.includes('permanent')
              if (ids.length === 0) return { kind: 'error', text: 'Usage: /purge delete <sessionId...> [permanent]' }
              const conflict = ids.find((id) => id === invocation?.agent?.session?.id)
              if (conflict !== undefined) {
                return { kind: 'error', text: `Refusing to remove the session running this command (${conflict}).` }
              }
              const result = await service.delete({ sessionIds: ids, permanent })
              const lines = [
                ...result.deleted.map(
                  (row) => `removed ${row.sessionId} (${formatBytes(row.sizeBytes)})${permanent ? ' permanently' : ' → trash'}`,
                ),
                ...result.failed.map((row) => `failed ${row.sessionId}: ${row.code} — ${row.message}`),
              ]
              return { kind: result.failed.length > 0 ? 'error' : 'success', text: lines.join('\n') || 'Nothing to do.' }
            }
            case 'delete-archived': {
              const permanent = rest.includes('permanent')
              const result = await service.list({ includeLive: false, includeTrashed: false })
              const ids = result.sessions.map((row) => row.sessionId).filter((id) => id !== invocation?.agent?.session?.id)
              if (ids.length === 0) return { kind: 'success', text: 'No archived or cold sessions to remove.' }
              const outcome = await service.delete({ sessionIds: ids, permanent })
              return {
                kind: outcome.failed.length > 0 ? 'error' : 'success',
                text:
                  `removed ${outcome.deleted.length} of ${ids.length} session(s)` +
                  (permanent ? ' permanently' : ' to trash') +
                  (outcome.failed.length > 0
                    ? '\n' + outcome.failed.map((row) => `failed ${row.sessionId}: ${row.code}`).join('\n')
                    : ''),
              }
            }
            case 'trash': {
              const manifests = await service.trashManifests()
              if (manifests.length === 0) return { kind: 'success', text: 'The purge trash is empty.' }
              return {
                kind: 'success',
                text: manifests
                  .map(
                    (manifest) =>
                      `${manifest.operationId}\t${manifest.items?.length ?? 0} session(s)\t${manifest.removedAt ?? ''}`,
                  )
                  .join('\n') + '\n\nUse /purge restore <operationId...>.',
              }
            }
            case 'restore': {
              if (rest.length === 0) return { kind: 'error', text: 'Usage: /purge restore <operationId...>' }
              const result = await service.restore({ operationIds: rest })
              const lines = [
                ...result.restored.map((row) => `restored ${row.sessionId}`),
                ...result.failed.map((row) => `failed ${row.sessionId}: ${row.code} — ${row.message}`),
              ]
              return { kind: result.failed.length > 0 ? 'error' : 'success', text: lines.join('\n') || 'Nothing to do.' }
            }
            case 'empty': {
              const result = await service.emptyTrash({ operationIds: rest })
              if (result.emptied.length === 0 && result.failed.length === 0) {
                return { kind: 'success', text: 'The purge trash is already empty.' }
              }
              const lines = [
                `emptied ${result.emptied.length} trash operation(s), freeing ${formatBytes(result.freedBytes)}`,
                ...result.failed.map((row) => `failed ${row.sessionId}: ${row.code} — ${row.message}`),
              ]
              return { kind: result.failed.length > 0 ? 'error' : 'success', text: lines.join('\n') }
            }
            default:
              return {
                kind: 'error',
                text:
                  'Usage: /purge [list|candidates|delete <id...> [permanent]|delete-archived [permanent]|trash|restore <operationId...>|empty [<operationId...>]]',
              }
          }
        } catch (error) {
          return { kind: 'error', text: String(error?.message ?? error) }
        }
      },
    })
  })

  ctx.inject(['tools'], (scope) => {
    scope.tools.register(
      defineTool({
        name: 'session_purge',
        description:
          'List or permanently remove DeepSeek Harness sessions from disk. Removal is the only way to reclaim a session\'s storage: archiving only hides it. Defaults to a reversible trash move; permanent removal unlinks the session directory. Cannot remove the session running this call.',
        parameters: {
          action: {
            type: 'string',
            required: true,
            enum: ['list', 'delete', 'restore', 'trash', 'empty'],
            description:
              'list stored sessions, delete sessions, list trash operations, restore a trash operation, or empty the trash to reclaim its space.',
          },
          sessionIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Session ids to remove (action=delete).',
          },
          operationIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Trash operation ids to restore (action=restore) or to empty (action=empty).',
          },
          permanent: {
            type: 'boolean',
            description: 'When true, unlink instead of moving to the purge trash. Only after the user asked for it.',
          },
          includeLive: {
            type: 'boolean',
            description: 'When true (default), list also includes sessions still held live.',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args, exec) {
          const selfId = exec?.agent?.session?.id
          switch (args.action) {
            case 'list': {
              const result = await service.list({ includeLive: args.includeLive !== false, includeTrashed: true })
              if (result.sessions.length === 0) return 'No stored sessions.'
              return (
                `${result.sessions.length} stored session(s) under ${result.sessionsRoot ?? 'unknown root'}:\n` +
                result.sessions.map((row) => service.describeRow(row)).join('\n')
              )
            }
            case 'trash': {
              const manifests = await service.trashManifests()
              if (manifests.length === 0) return 'The purge trash is empty.'
              return manifests
                .map((manifest) => `${manifest.operationId}\t${manifest.items?.length ?? 0} session(s)\t${manifest.removedAt ?? ''}`)
                .join('\n')
            }
            case 'restore': {
              const result = await service.restore({ operationIds: args.operationIds ?? [] })
              return [
                ...result.restored.map((row) => `restored ${row.sessionId}`),
                ...result.failed.map((row) => `failed ${row.sessionId}: ${row.code} — ${row.message}`),
              ].join('\n') || 'Nothing to do.'
            }
            case 'empty': {
              const result = await service.emptyTrash({ operationIds: args.operationIds ?? [] })
              if (result.emptied.length === 0 && result.failed.length === 0) return 'The purge trash is already empty.'
              return [
                `emptied ${result.emptied.length} trash operation(s), freeing ${formatBytes(result.freedBytes)}`,
                ...result.failed.map((row) => `failed ${row.sessionId}: ${row.code} — ${row.message}`),
              ].join('\n')
            }
            case 'delete': {
              const ids = (args.sessionIds ?? []).filter((id) => id !== selfId)
              if (ids.length === 0) return 'No removable session ids were given (the running session cannot be removed).'
              const result = await service.delete({ sessionIds: ids, permanent: args.permanent === true })
              return [
                ...result.deleted.map(
                  (row) =>
                    `removed ${row.sessionId} (${formatBytes(row.sizeBytes)})${args.permanent === true ? ' permanently' : ' to trash'}`,
                ),
                ...result.failed.map((row) => `failed ${row.sessionId}: ${row.code} — ${row.message}`),
              ].join('\n') || 'Nothing to do.'
            }
            default:
              return `Unknown action "${String(args.action)}".`
          }
        },
      }),
    )
  })

  ctx.logger?.info?.(
    'session purge: deep session removal is available from the session menu, /purge, and the session_purge tool',
  )
}

export const name = 'dsh-session-purge'
export const inject = ['sessionPersistence']
export { Config }
