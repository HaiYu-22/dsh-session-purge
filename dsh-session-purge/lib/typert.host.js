/* Hand-authored in the shape '@deepseek-ai/dsh-typert-generator' emits from a FaceModel.
 *
 * The generator is not available outside the Harness repository, so this file
 * mirrors its output by hand. `dsh-typert-loader` picks it up through the
 * package's `./typert` export and registers the host face while the plugin is
 * mounted; the gateway then validates every argument and result with the zod
 * factories the descriptors carry.
 */
import { PURGE_INVOCATIONS } from './index.js'

const packageName = '@dsh-local/dsh-session-purge'

/** The Host-face Typert contribution for this package. */
export const TYPERT = {
  package: packageName,
  face: 'host',
  schemas: [],
  invocations: PURGE_INVOCATIONS.map((invocation) => ({
    ...invocation,
    parameters: invocation.parameters.map((parameter) => ({ ...parameter })),
    result: { ...invocation.result },
  })),
  model: {
    services: [
      {
        key: 'sessionManager',
        exportName: 'default',
        tags: [],
        summary:
          'Deep session removal: locate, trash, permanently remove, and restore stored Sessions that the archive set only hides.',
        members: [
          {
            kind: 'method',
            name: 'list',
            signature: 'list(request?: SessionPurgeListRequest): Promise<SessionPurgeListValue>',
            summary: 'List stored sessions with live, archived, trash, and size facts.',
          },
          {
            kind: 'method',
            name: 'delete',
            signature: 'delete(request: SessionPurgeDeleteRequest): Promise<SessionPurgeDeleteValue>',
            summary: 'Remove stored sessions, to the purge trash or permanently.',
          },
          {
            kind: 'method',
            name: 'restore',
            signature: 'restore(request: SessionPurgeRestoreRequest): Promise<SessionPurgeRestoreValue>',
            summary: 'Restore sessions recorded in a purge trash operation.',
          },
        ],
        types: [
          {
            name: 'SessionPurgeDeleteRequest',
            declaration:
              'export interface SessionPurgeDeleteRequest {\n    readonly sessionIds: readonly string[];\n    readonly permanent?: boolean;\n}',
          },
          {
            name: 'SessionPurgeDeleteValue',
            declaration:
              'export interface SessionPurgeDeleteValue {\n    readonly deleted: readonly SessionPurgeRow[];\n    readonly failed: readonly SessionPurgeFailure[];\n    readonly sweptArchiveIds: readonly string[];\n}',
          },
          {
            name: 'SessionPurgeFailure',
            declaration:
              'export interface SessionPurgeFailure {\n    readonly sessionId: string;\n    readonly code: string;\n    readonly message: string;\n}',
          },
          {
            name: 'SessionPurgeListRequest',
            declaration:
              'export interface SessionPurgeListRequest {\n    readonly includeLive?: boolean;\n    readonly includeTrashed?: boolean;\n}',
          },
          {
            name: 'SessionPurgeListValue',
            declaration:
              'export interface SessionPurgeListValue {\n    readonly sessions: readonly SessionPurgeRow[];\n    readonly sessionsRoot?: string;\n    readonly trashRoot?: string;\n    readonly permanentAllowed: boolean;\n}',
          },
          {
            name: 'SessionPurgeRestoreRequest',
            declaration:
              'export interface SessionPurgeRestoreRequest {\n    readonly operationIds: readonly string[];\n}',
          },
          {
            name: 'SessionPurgeRestoreValue',
            declaration:
              'export interface SessionPurgeRestoreValue {\n    readonly restored: readonly SessionPurgeRow[];\n    readonly failed: readonly SessionPurgeFailure[];\n}',
          },
          {
            name: 'SessionPurgeRow',
            declaration:
              'export interface SessionPurgeRow {\n    readonly sessionId: string;\n    readonly cwd?: string;\n    readonly live: boolean;\n    readonly archived: boolean;\n    readonly stored: boolean;\n    readonly trashed: boolean;\n    readonly sessionDir?: string;\n    readonly project?: string;\n    readonly sizeBytes?: number;\n}',
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
}
