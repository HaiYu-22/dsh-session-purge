/**
 * Standalone harness for the purge plugin's host logic.
 *
 * Runs the real `lib/index.js` against a fake sessions root inside a scratch
 * directory: listing, trashed removal, permanent removal, archive sweeping,
 * projection-cache dropping, and restore. Nothing here touches a real DSH
 * account, and no real Cordis runtime is needed because the harness drives the
 * service class directly.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { pluginUrl } from './env.mjs'

const { SessionPurge, apply, PURGE_INVOCATIONS } = await import(pluginUrl())

const scratch = join(import.meta.dirname, 'scratch')
await rm(scratch, { recursive: true, force: true })

const sessionsRoot = join(scratch, 'sessions')
const storagesRoot = join(scratch, 'storages')
const cwd = process.cwd()
const projectKeyOf = (path) => {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

const archived = new Set()
const writes = []
let nextId = 0
const makeSession = async (id, bytes, cwdValue) => {
  const dir = join(sessionsRoot, projectKeyOf(cwdValue), id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(bytes, 7))
  return dir
}

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  get: (key) => {
    if (key === 'sessionPersistence') {
      return {
        root: sessionsRoot,
        stat: async (id) => {
          const found = await findDir(id)
          if (found === undefined) return undefined
          return { header: { id, cwd: found.cwd }, sizeBytes: 4096, revision: 'test' }
        },
      }
    }
    if (key === 'workspaceRegistry') {
      return {
        get archivedSessionIds() {
          return [...archived]
        },
        archiveSession: async (id) => {
          writes.push(`archive:${id}`)
          archived.add(id)
        },
        unarchiveSession: async (id) => {
          writes.push(`unarchive:${id}`)
          archived.delete(id)
        },
      }
    }
    if (key === 'sessionProjectionCache') return { table: { delete: async () => { writes.push('projcache') } } }
    if (key === 'storage') return { root: storagesRoot }
    if (key === 'sessions') return { get: () => undefined }
    return undefined
  },
}

/** Locate one session's project directory by scanning, mirroring the plugin's own scan. */
const findDir = async (id) => {
  if (!existsSync(sessionsRoot)) return undefined
  for (const project of await readdir(sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    if (existsSync(join(sessionsRoot, project.name, id))) {
      return { dir: join(sessionsRoot, project.name, id), cwd, project: project.name }
    }
  }
  return undefined
}

const service = new SessionPurge(ctx, { stopTimeoutMs: 1000, allowPermanent: true })

// --- listing -----------------------------------------------------------------
const coldId = 'session-cold-0001'
const archivedId = 'session-archived-0002'
const liveId = 'session-live-0003'
const trashedId = 'session-trashed-0004'
await makeSession(coldId, 2048, cwd)
await makeSession(archivedId, 1024, cwd)
await makeSession(trashedId, 512, cwd)
archived.add(archivedId)

const listed = await service.list({ includeLive: true, includeTrashed: true })
const listedIds = listed.sessions.map((row) => row.sessionId).sort()
assert.deepEqual(listedIds, [archivedId, coldId, trashedId], 'list must find every stored session directory')
const archivedRow = listed.sessions.find((row) => row.sessionId === archivedId)
assert.equal(archivedRow.archived, true, 'list must report the archive flag')
assert.equal(archivedRow.stored, true, 'list must report stored directory facts')
assert.equal(typeof archivedRow.sizeBytes, 'number', 'list must report a size')
assert.match(archivedRow.sessionDir, /session-archived-0002$/, 'list must report the session directory')
console.log('PASS list')

// --- the live guard ----------------------------------------------------------
const liveCtx = {
  ...ctx,
  get: (key) => (key === 'sessions' ? { get: (id) => (id === liveId ? { id } : undefined) } : ctx.get(key)),
}
const liveService = new SessionPurge(liveCtx, { stopTimeoutMs: 50, allowPermanent: true })
const liveOutcome = await liveService.removeOne(liveId, false)
assert.equal(liveOutcome.failed.code, 'session-purge/live', 'a live session must be refused, not deleted')
console.log('PASS live guard')

// --- trashed removal ---------------------------------------------------------
const before = await findDir(archivedId)
assert.notEqual(before, undefined)
const trashOutcome = await service.removeOne(archivedId, false)
assert.equal(trashOutcome.failed, undefined, 'a cold archived session must be removable')
assert.equal(trashOutcome.row.trashed, true, 'trash mode must report the trash flag')
assert.equal(trashOutcome.sweptArchive, true, 'the archive entry must be swept')
assert.equal(await findDir(archivedId), undefined, 'the session directory must be gone from the store')
assert.ok(writes.includes('projcache'), 'the projection cache must be dropped')
assert.ok(writes.includes(`unarchive:${archivedId}`), 'the archive set must be updated')

const trashEntries = await readdir(join(sessionsRoot, '.purge-trash'), { withFileTypes: true })
assert.equal(trashEntries.length, 1, 'one trash operation directory must exist')
const operationId = trashEntries[0].name
const manifest = JSON.parse(await readFile(join(sessionsRoot, '.purge-trash', operationId, 'manifest.json'), 'utf8'))
assert.equal(manifest.items[0].sessionId, archivedId, 'the manifest must name the removed session')
assert.equal(manifest.items[0].originalSessionDir, before.dir, 'the manifest must record the original directory')
assert.ok(existsSync(join(sessionsRoot, '.purge-trash', operationId, 'session', 'session.v4.jsonl.zstd')), 'the log must be preserved in the trash')
console.log('PASS trashed removal')

// --- restore -----------------------------------------------------------------
const restored = await service.restore({ operationIds: [operationId] })
assert.deepEqual(restored.failed, [], 'restore must not fail')
assert.equal(restored.restored.length, 1, 'restore must report one session')
assert.notEqual(await findDir(archivedId), undefined, 'the session directory must be back')
assert.equal(existsSync(join(sessionsRoot, '.purge-trash', operationId)), false, 'the empty trash operation must be cleaned up')
const relisted = await service.list({ includeTrashed: true })
assert.ok(relisted.sessions.some((row) => row.sessionId === archivedId), 'the restored session must be listed again')
assert.ok(relisted.sessions.every((row) => row.trashed === false), 'no row may still report the trash flag')
console.log('PASS restore')

// --- permanent removal -------------------------------------------------------
const permanentOutcome = await service.removeOne(coldId, true)
assert.equal(permanentOutcome.row.trashed, false, 'permanent mode must not report the trash flag')
assert.equal(await findDir(coldId), undefined, 'the directory must be unlinked')
assert.equal(existsSync(join(sessionsRoot, '.purge-trash')), true, 'the trash root still holds nothing new')
const trashAfter = await readdir(join(sessionsRoot, '.purge-trash'))
assert.deepEqual(trashAfter, [], 'permanent removal must not add a trash operation')
console.log('PASS permanent removal')

// --- unknown session ---------------------------------------------------------
const unknown = await service.removeOne('session-does-not-exist', false)
assert.equal(unknown.failed.code, 'session-purge/unknown-session', 'an unknown session must fail with its own code')
console.log('PASS unknown session')

// --- batch delete + failure isolation ---------------------------------------
const restoredSessionId = archivedId
await makeSession(trashedId, 512, cwd)
const batch = await service.delete({ sessionIds: [trashedId, 'session-missing-9999'], permanent: false })
assert.equal(batch.deleted.length, 1, 'the existing session must be removed')
assert.equal(batch.failed.length, 1, 'the missing session must be reported as a failure')
assert.equal(batch.failed[0].code, 'session-purge/unknown-session')
assert.equal(await findDir(trashedId), undefined)
console.log('PASS batch delete')

// --- project directory cleanup ----------------------------------------------
const remainingProjects = await readdir(sessionsRoot, { withFileTypes: true })
const sessionProjects = remainingProjects.filter(
  (entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '_no-cwd',
)
assert.equal(sessionProjects.length, 1, 'the project directory stays while its trash operation exists')
const leftover = await readdir(join(sessionsRoot, sessionProjects[0].name))
assert.deepEqual(leftover, [restoredSessionId], 'only the restored session may remain under the project directory')
const aboveTrash = remainingProjects.filter((entry) => entry.name !== '.purge-trash')
assert.equal(aboveTrash.length, 1, 'only the one project directory may remain beside the trash root')
assert.ok(aboveTrash[0].isDirectory(), 'a session project entry is a directory')
console.log('PASS project directory cleanup')

// --- the emptied project directory itself goes away --------------------------
//
// This is the case the earlier suite missed: `fs.rm` refuses a directory without
// `recursive`, so pruning silently left every emptied project directory behind.
const loneProject = join(sessionsRoot, '--lone-project--')
const loneId = 'session-lone-0001'
await mkdir(join(loneProject, loneId), { recursive: true })
await writeFile(join(loneProject, loneId, 'session.v4.jsonl.zstd'), Buffer.alloc(64, 3))
const loneCtx = {
  ...ctx,
  get: (key) => {
    if (key === 'sessionPersistence') {
      return {
        root: sessionsRoot,
        stat: async (id) => (id === loneId ? { header: { id, cwd: 'C:\\lone' }, sizeBytes: 64 } : undefined),
      }
    }
    return ctx.get(key)
  },
}
const loneService = new SessionPurge(loneCtx, { stopTimeoutMs: 50, allowPermanent: true })
const loneOutcome = await loneService.removeOne(loneId, false)
assert.equal(loneOutcome.failed, undefined, 'the lone session must be removable')
assert.equal(
  existsSync(loneProject),
  false,
  'an emptied project directory must be removed, not left as an empty shell',
)
console.log('PASS emptied project directory removed')

// --- emptying the trash actually reclaims its space -------------------------
const trashBefore = await service.trashManifests()
assert.ok(trashBefore.length >= 2, 'the trash must hold the operations the suite created')
const freed = await service.emptyTrash({})
assert.equal(freed.emptied.length, trashBefore.length, 'every operation must be emptied')
assert.ok(freed.freedBytes > 0, 'emptying must report the bytes it reclaimed')
assert.equal(existsSync(join(sessionsRoot, '.purge-trash')), false, 'an emptied trash root is removed too')
const emptyAgain = await service.emptyTrash({})
assert.deepEqual(emptyAgain.emptied, [], 'emptying an empty trash is a no-op')
const unknownOperation = await service.emptyTrash({ operationIds: ['nope'] })
assert.equal(unknownOperation.failed[0].code, 'session-purge/unknown-operation')
console.log('PASS empty trash reclaims space')

// --- descriptor shape --------------------------------------------------------
assert.equal(PURGE_INVOCATIONS.length, 3, 'three Remote descriptors must ship')
for (const invocation of PURGE_INVOCATIONS) {
  assert.equal(invocation.namespace, 'sessionManager')
  assert.equal(invocation.invocation.kind, 'direct')
  assert.equal(invocation.result.mode, 'strict')
  assert.equal(typeof invocation.result.create(), 'object', 'a codec create() must return a schema')
  for (const parameter of invocation.parameters) {
    assert.equal(parameter.source, 'json')
    assert.equal(parameter.codec.mode, 'strict')
    assert.equal(typeof parameter.codec.create, 'function', 'a codec create must be a factory')
    assert.equal(typeof parameter.codec.create().safeParse, 'function', 'a codec factory must return a zod schema')
  }
}
console.log('PASS descriptors')

// --- apply() wiring ----------------------------------------------------------
const provided = new Map()
const registered = { commands: [], tools: [] }
const applyCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  get: () => undefined,
  provide: (key, value) => provided.set(key, value),
  set: (key, value) => provided.set(key, value),
  inject: (deps, callback) => {
    callback({
      commands: { register: (definition) => registered.commands.push(definition) },
      tools: { register: (definition) => registered.tools.push(definition) },
    })
  },
}
apply(applyCtx, {})
assert.ok(provided.has('sessionManager'), 'apply must provide the sessionManager service')
assert.equal(provided.get('sessionManager').typertRemote.serviceKey, 'sessionManager')
assert.equal(registered.commands.length, 1, 'apply must register the /purge command')
assert.equal(registered.commands[0].name, 'purge')
assert.equal(registered.tools.length, 1, 'apply must register the session_purge tool')
assert.equal(registered.tools[0].name, 'session_purge')
console.log('PASS apply wiring')

await rm(scratch, { recursive: true, force: true })
console.log('\nALL HOST CHECKS PASSED')
