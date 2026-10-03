window.__ModuleLoader__.load({
	id: '@dsh-local/dsh-session-purge',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')
		const jsxRuntime = require('react/jsx-runtime')
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

		//#region typert.remote-client — the client half of this package's Remote descriptors
		/**
		 * Hand-authored in the shape the Typert generator emits for a client face.
		 * `ctx.remote.$mount()` validates the descriptors and installs the
		 * `sessionManager` namespace on the calling fiber; the strict codecs make the
		 * Host accept the call, because gateway strict mode never accepts a
		 * Client-supplied field without a generated codec.
		 *
		 * The Client carrier never executes these schemas — `requireStrictCodec()`
		 * checks only that `mode` is `'strict'`, and invocation sends the typed values
		 * without Client-side validation. A generated artifact still attaches real
		 * zod factories here, but zod is not a platform seed word, so requiring it
		 * would fail at module materialization. These validators keep the bundle free
		 * of non-baseline requests while leaving `create()` usable for anything that
		 * ever does call it.
		 */
		const isOptionalBoolean = (value) => value === undefined || typeof value === 'boolean'
		const stringField = (value) => typeof value === 'string'
		const optionalStringField = (value) => value === undefined || typeof value === 'string'
		const booleanField = (value) => typeof value === 'boolean'
		const optionalNumberField = (value) => value === undefined || typeof value === 'number'

		/**
		 * Build one tiny standard-schema-shaped validator from per-field checks.
		 *
		 * @param fields - field name to predicate.
		 * @returns an object exposing `safeParse`, matching the codec contract.
		 */
		const shape = (fields) => ({
			safeParse(value) {
				if (typeof value !== 'object' || value === null || Array.isArray(value)) {
					return { success: false, error: new Error('expected an object') }
				}
				for (const [name, check] of Object.entries(fields)) {
					if (!check(value[name])) return { success: false, error: new Error(`invalid field ${name}`) }
				}
				return { success: true, data: value }
			},
		})

		const arrayOf = (itemCheck) => ({
			safeParse(value) {
				if (!Array.isArray(value)) return { success: false, error: new Error('expected an array') }
				for (const item of value) {
					if (!itemCheck(item)) return { success: false, error: new Error('invalid array item') }
				}
				return { success: true, data: value }
			},
		})

		const sessionRowSchema = shape({
			sessionId: stringField,
			cwd: optionalStringField,
			live: booleanField,
			archived: booleanField,
			stored: booleanField,
			trashed: booleanField,
			sessionDir: optionalStringField,
			project: optionalStringField,
			sizeBytes: optionalNumberField,
		})
		const failedRowSchema = shape({
			sessionId: stringField,
			code: stringField,
			message: stringField,
		})
		const stringList = arrayOf(stringField)
		const rowList = arrayOf((row) => sessionRowSchema.safeParse(row).success)
		const failedList = arrayOf((row) => failedRowSchema.safeParse(row).success)

		const listRequestSchema = shape({ includeLive: isOptionalBoolean, includeTrashed: isOptionalBoolean })
		const listResultSchema = shape({
			sessions: (value) => rowList.safeParse(value).success,
			sessionsRoot: optionalStringField,
			trashRoot: optionalStringField,
			permanentAllowed: booleanField,
		})
		const deleteRequestSchema = shape({ sessionIds: (value) => stringList.safeParse(value).success, permanent: isOptionalBoolean })
		const deleteResultSchema = shape({
			deleted: (value) => rowList.safeParse(value).success,
			failed: (value) => failedList.safeParse(value).success,
			sweptArchiveIds: (value) => stringList.safeParse(value).success,
		})
		const restoreRequestSchema = shape({ operationIds: (value) => stringList.safeParse(value).success })
		const restoreResultSchema = shape({
			restored: (value) => rowList.safeParse(value).success,
			failed: (value) => failedList.safeParse(value).success,
		})

		const TYPERT_REMOTE = {
			package: '@dsh-local/dsh-session-purge',
			descriptors: [
				{
					id: '@dsh-local/dsh-session-purge#sessionManager/list',
					service: 'sessionManager',
					namespace: 'sessionManager',
					method: 'list',
					invocation: { kind: 'direct' },
					parameters: [
						{
							name: 'request',
							wire: 'request',
							source: 'json',
							codec: {
								mode: 'strict',
								typeSymbol: '@dsh-local/dsh-session-purge#sessionManager/list:request',
								create: () => listRequestSchema,
							},
						},
					],
					result: {
						mode: 'strict',
						typeSymbol: '@dsh-local/dsh-session-purge#sessionManager/list:result',
						create: () => listResultSchema,
					},
				},
				{
					id: '@dsh-local/dsh-session-purge#sessionManager/delete',
					service: 'sessionManager',
					namespace: 'sessionManager',
					method: 'delete',
					invocation: { kind: 'direct' },
					parameters: [
						{
							name: 'request',
							wire: 'request',
							source: 'json',
							codec: {
								mode: 'strict',
								typeSymbol: '@dsh-local/dsh-session-purge#sessionManager/delete:request',
								create: () => deleteRequestSchema,
							},
						},
					],
					result: {
						mode: 'strict',
						typeSymbol: '@dsh-local/dsh-session-purge#sessionManager/delete:result',
						create: () => deleteResultSchema,
					},
				},
				{
					id: '@dsh-local/dsh-session-purge#sessionManager/restore',
					service: 'sessionManager',
					namespace: 'sessionManager',
					method: 'restore',
					invocation: { kind: 'direct' },
					parameters: [
						{
							name: 'request',
							wire: 'request',
							source: 'json',
							codec: {
								mode: 'strict',
								typeSymbol: '@dsh-local/dsh-session-purge#sessionManager/restore:request',
								create: () => restoreRequestSchema,
							},
						},
					],
					result: {
						mode: 'strict',
						typeSymbol: '@dsh-local/dsh-session-purge#sessionManager/restore:result',
						create: () => restoreResultSchema,
					},
				},
			],
		}
		//#endregion

		//#region locale
		const NS = 'sessionPurge'
		const zh = {
			'menu.delete': '永久删除',
			'menu.deleteHint': '从磁盘删除此会话，可在回收站中恢复',
			'confirm.title': '永久删除此会话？',
			'confirm.desc':
				'“{title}”的会话日志、投影缓存和归档记录都会被移除；若它仍在运行，会先停止它再删除。默认先移入回收站，可恢复。',
			'confirm.permanent': '同时永久抹除，不进入回收站（不可恢复）',
			'confirm.action': '删除',
			'confirm.pending': '正在删除…',
			'confirm.close': '关闭删除确认',
			'toast.done': '已删除会话，可',
			'toast.doneTrashed': '已删除 {n} 个会话（移入回收站，可恢复）',
			'toast.donePermanent': '已永久删除 {n} 个会话',
			'toast.partial': '已删除 {done} 个，{failed} 个失败：{reason}',
			'toast.failed': '删除会话失败：{reason}',
			'cancel': '取消',
		}
		const en = {
			'menu.delete': 'Delete permanently',
			'menu.deleteHint': 'Remove this session from disk; recoverable from the purge trash',
			'confirm.title': 'Delete this session permanently?',
			'confirm.desc':
				'The session log, projection cache, and archive entry for “{title}” are removed; a session still running is stopped first. The default moves it to a trash folder you can restore from.',
			'confirm.permanent': 'Also erase it permanently instead of moving it to the trash (unrecoverable)',
			'confirm.action': 'Delete',
			'confirm.pending': 'Deleting…',
			'confirm.close': 'Close the delete confirmation',
			'toast.done': 'Session deleted',
			'toast.doneTrashed': 'Deleted {n} session(s) to the purge trash (recoverable)',
			'toast.donePermanent': 'Permanently deleted {n} session(s)',
			'toast.partial': 'Deleted {done}, {failed} failed: {reason}',
			'toast.failed': 'Could not delete the session: {reason}',
			'cancel': 'Cancel',
		}
		//#endregion

		//#region notice store
		/**
		 * One observable snapshot cell: the shape the renderer binds when a value
		 * is injected under `hooks`.
		 *
		 * @param initial - the first snapshot.
		 * @returns the observable plus its setter.
		 */
		function createObservable(initial) {
			const listeners = new Set()
			let snapshot = initial
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener)
					return () => listeners.delete(listener)
				},
				set: (next) => {
					snapshot = next
					for (const listener of listeners) listener()
				},
			}
		}

		/** One notice at a time, sequence-keyed so a repeated outcome still re-renders. */
		function createNoticeStore() {
			const cell = createObservable(null)
			let seq = 0
			return {
				getSnapshot: cell.getSnapshot,
				subscribe: cell.subscribe,
				report: (notice) => {
					seq += 1
					cell.set({ ...notice, seq })
				},
				dismiss: () => {
					cell.set(null)
				},
			}
		}
		//#endregion

		//#region UI
		/**
		 * The `sidebar.workspaces.session.menu.item` row, offered on every ordinary
		 * Session row.
		 *
		 * Removal is not restricted to archives: the Host stops a live Session
		 * through the archive seam before it removes anything, so the action is
		 * valid wherever a Session exists. Gating it on archive membership instead
		 * would hide it behind a second step — archived rows are filtered out of the
		 * default view — which is exactly where a destructive maintenance action
		 * should not live.
		 *
		 * The row only *raises* a request. It renders no dialog: the row unmounts
		 * with the menu it sits in, so a dialog rendered here is torn down by the
		 * very click that would confirm it — the click then looks like it did
		 * nothing at all. The confirmation belongs to `shell.overlay`, which the
		 * `SessionDeleteDialog` entry below owns.
		 *
		 * The row reads only what the slot supplies — `sessionId` and
		 * `displayTitle` from the owner's `renderSlot` call, `useMenuOpenState` from
		 * the slot's declared hook factory, `t` from this entry's locale seat, and
		 * `requestDelete` from this entry's own inject — plus no hook source at all.
		 * An entry's `inject` may only supply a hook through `hooks`, and a value
		 * there is bound as an observable that must expose
		 * `getSnapshot`/`subscribe`; handing that contract a plain value throws on
		 * every render, which the slot's error boundary swallows into an invisible
		 * dead cell.
		 *
		 * @param props - the owner's Session identity and title, the slot's menu hook,
		 *   the request raiser, and the locale seat.
		 * @returns the menu row.
		 */
		function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete, t }) {
			const [, setMenuOpen] = useMenuOpenState()
			return jsxRuntime.jsx(primitives.MenuItemButton, {
				danger: true,
				icon: jsxRuntime.jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen(false)
					requestDelete(sessionId, displayTitle ?? sessionId)
				},
				children: t('menu.delete'),
			})
		}

		/**
		 * The `shell.overlay` entry: nothing while no confirmation is pending,
		 * otherwise one dialog per request, keyed by the Session so a new request
		 * starts a fresh draft.
		 *
		 * @param props - the pending-request hook, its settlement, the purge share,
		 *   and the locale seat.
		 * @returns the open dialog, or null.
		 */
		function SessionDeleteDialog({ useDeleteRequest, settleDelete, purgeSession, t }) {
			const request = useDeleteRequest((current) => current ?? null)
			if (request === null) return null
			return jsxRuntime.jsx(
				DeleteConfirmForm,
				{ request, settleDelete, purgeSession, t },
				request.sessionId,
			)
		}

		/**
		 * One request's dialog: draft, in-flight state, and error die with it, so a
		 * cancelled or failed attempt never leaks into the next one.
		 *
		 * @param props - the request, its settlement, the purge share, and the locale seat.
		 * @returns the modal.
		 */
		function DeleteConfirmForm({ request, settleDelete, purgeSession, t }) {
			const [permanent, setPermanent] = react.useState(false)
			const [busy, setBusy] = react.useState(false)
			const [error, setError] = react.useState(null)

			const close = () => {
				if (busy) return
				settleDelete()
			}
			const confirm = async () => {
				setBusy(true)
				setError(null)
				try {
					await purgeSession(request.sessionId, permanent)
					setBusy(false)
					settleDelete()
				} catch (reason) {
					setBusy(false)
					setError(reason instanceof Error ? reason.message : String(reason))
				}
			}

			return jsxRuntime.jsxs(primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t('confirm.close'),
				title: t('confirm.title'),
				description: t('confirm.desc', { title: request.displayTitle }),
				footer: jsxRuntime.jsxs(jsxRuntime.Fragment, {
					children: [
						jsxRuntime.jsx(primitives.Button, {
							variant: 'outline',
							disabled: busy,
							onClick: close,
							children: t('cancel'),
						}),
						jsxRuntime.jsx(primitives.Button, {
							variant: 'outline',
							disabled: busy,
							onClick: () => {
								void confirm()
							},
							children: t('confirm.action'),
						}),
					],
				}),
				children: [
					jsxRuntime.jsx(primitives.Checkbox, {
						checked: permanent,
						disabled: busy,
						onChange: setPermanent,
						label: t('confirm.permanent'),
					}),
					busy ? jsxRuntime.jsx('div', { role: 'status', children: t('confirm.pending') }) : null,
					error !== null ? jsxRuntime.jsx('div', { role: 'alert', children: error }) : null,
				],
			})
		}

		/**
		 * The `shell.overlay` notice for one purge outcome.
		 *
		 * @param props - the notice hook, its dismissal, and the locale seat.
		 * @returns the notice, or null.
		 */
		function PurgeNotice({ useNotice, dismissNotice, t }) {
			const notice = useNotice((current) => current ?? null)
			if (notice === null) return null
			const text =
				notice.kind === 'done'
					? t(notice.permanent ? 'toast.donePermanent' : 'toast.doneTrashed', { n: String(notice.count) })
					: t(notice.kind === 'partial' ? 'toast.partial' : 'toast.failed', {
							done: String(notice.count ?? 0),
							failed: String(notice.failed ?? 0),
							reason: notice.reason ?? '',
						})
			return jsxRuntime.jsx(
				primitives.Toast,
				{
					text,
					tone: notice.kind === 'done' ? 'success' : 'warning',
					icon: notice.kind === 'done' ? undefined : jsxRuntime.jsx(primitives.IconTrashOutlineRegular, {}),
					/* A failure has to be readable, not blink past: activation errors land here too. */
					holdMs: notice.kind === 'done' ? 6000 : 30000,
					onDone: dismissNotice,
				},
				`session-purge-${String(notice.seq)}`,
			)
		}
		//#endregion

		//#region apply
		/**
		 * Static dependencies. `remote.sessionManager` is deliberately NOT among
		 * them: this plugin's own `apply()` installs that namespace, so declaring it
		 * here would park the plugin forever waiting for a service only it provides.
		 * The UI that needs the namespace registers inside a child scope below.
		 */
		const inject = ['remote', 'slots', 'locale', 'workspaces', 'sessions']

		/**
		 * Mount the purge Remote namespace and its two UI seats.
		 *
		 * A browser half whose activation throws leaves no trace on the page: the row
		 * simply never appears, and only whoever opens DevTools learns why. Two
		 * things prevent that silence. The notice seat is registered first, and a
		 * failed Remote mount is *contained* rather than rethrown — rethrowing would
		 * unwind this fiber and dispose that very seat before its notice could
		 * render. A contained failure keeps the seat alive to show the reason.
		 *
		 * The UI then registers through `ctx.inject(['remote.sessionManager'], …)`:
		 * Cordis refuses `ctx.remote.sessionManager` on a context whose `inject` does
		 * not name that service ("cannot get property … without inject"), so the call
		 * site must run in a scope that declares the namespace this apply mounted.
		 * That ordering is the whole reason the UI is nested rather than registered
		 * inline.
		 *
		 * @param ctx - the browser runtime owning the Remote, dictionaries, and slots.
		 * @returns a disposer joining the Remote withdrawal and the UI.
		 */
		async function apply(ctx) {
			const notice = createNoticeStore()
			ctx.effect(
				() =>
					ctx.locale.register(NS, {
						zh,
						en,
					}),
				'dsh-session-purge: dictionaries',
			)
			const t = ctx.locale.bind(NS)

			const noticeInjected = () => ({ hooks: { notice: notice }, dismissNotice: notice.dismiss })
			ctx.slots.inject('shell.overlay', () =>
				ctx.slots.register(
					{
						name: 'shell.overlay',
						id: 'session-purge-notice',
						locale: NS,
						inject: noticeInjected,
					},
					PurgeNotice,
				),
			)

			let disposeRemote = () => {}
			let mountFailure
			try {
				disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
			} catch (error) {
				mountFailure = String(error?.message ?? error)
				console.error('[dsh-session-purge] Remote mount failed:', error)
				notice.report({ kind: 'failed', reason: `Remote 挂载失败：${mountFailure}` })
			}

			const ui = ctx.inject(['remote.sessionManager'], (scope) => {
				/** Remove one Session and resynchronize the client's session and workspace rows. */
				const purgeSession = async (sessionId, permanent) => {
					if (mountFailure !== undefined) throw new Error(`Remote sessionManager unavailable — ${mountFailure}`)
					const result = await scope.remote.sessionManager.delete({ sessionIds: [sessionId], permanent })
					if (!result.ok) {
						notice.report({ kind: 'failed', reason: result.error.message })
						throw new Error(result.error.message)
					}
					const { deleted, failed } = result.value
					if (failed.length > 0) {
						notice.report({
							kind: deleted.length > 0 ? 'partial' : 'failed',
							count: deleted.length,
							failed: failed.length,
							reason: failed.map((entry) => `${entry.sessionId}: ${entry.message}`).join('; '),
							permanent,
						})
						throw new Error(failed[0].message)
					}
					notice.report({ kind: 'done', count: deleted.length, permanent })
					try {
						await ctx.sessions.refresh()
					} catch {
						/* the refresh is best-effort: the next list read drops the removed row anyway */
					}
					try {
						if (typeof ctx.workspaces.refresh === 'function') await ctx.workspaces.refresh()
					} catch {
						/* an unavailable workspace refresh leaves the archive set to the next follow generation */
					}
				}

				/**
				 * The pending confirmation, shared by the two seats: the row raises it
				 * and the overlay answers it. It is an observable cell, so the overlay
				 * can read it through a bound hook.
				 */
				const deleteCell = createObservable(null)
				const requestDelete = (sessionId, displayTitle) => {
					deleteCell.set({ sessionId, displayTitle })
				}
				const settleDelete = () => {
					deleteCell.set(null)
				}

				/** Plain named values only: `hooks` is reserved for observable sources. */
				const menuInjected = () => ({ requestDelete })
				const dialogInjected = () => ({
					hooks: { deleteRequest: deleteCell },
					settleDelete,
					purgeSession,
				})

				ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
					ctx.slots.register(
						{
							name: 'sidebar.workspaces.session.menu.item',
							id: 'session-purge-delete',
							order: 500,
							locale: NS,
							inject: menuInjected,
						},
						DeleteSessionMenuItem,
					),
				)
				ctx.slots.inject('shell.overlay', () =>
					ctx.slots.register(
						{
							name: 'shell.overlay',
							id: 'session-purge-delete-dialog',
							locale: NS,
							inject: dialogInjected,
						},
						SessionDeleteDialog,
					),
				)
			})
			await ui

			return async () => {
				await ui.dispose()
				await disposeRemote()
			}
		}
		//#endregion

		exports.apply = apply
		exports.inject = inject
		exports.name = 'dsh-session-purge/client'
		return module.exports
	},
})
