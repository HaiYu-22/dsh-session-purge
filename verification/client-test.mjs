/**
 * Load-check for the purge plugin's browser half.
 *
 * The bundle is plain browser code that registers itself on the page's module
 * loader, so this harness stands in for the page: it supplies a
 * `window.__ModuleLoader__`, a stub module table for the bundle's externals, and
 * a Cordis-like context, then runs `apply()` and asserts the Remote mounts and
 * both UI seats register.
 */
import { readFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, deepRoot } from './env.mjs'
import assert from 'node:assert/strict'

/**
 * React is not on disk in this installation — the page seeds it in its module
 * table — so this harness stands in with the smallest surface the bundle and
 * the primitives it calls actually touch: element constructors, hooks, and
 * portals. Everything else is the real bundle under test.
 */
const Fragment = Symbol.for('purge-test.fragment')
const react = {
  Fragment,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useMemo: (factory) => factory(),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  forwardRef: (render) => render,
}
const jsxRuntime = {
  Fragment,
  jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
  jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
}
/** Stand-in for the shared primitives package: tags only, no rendering. */
const primitives = {
  MenuItemButton: 'MenuItemButton',
  Modal: 'Modal',
  Button: 'Button',
  Checkbox: 'Checkbox',
  Toast: 'Toast',
  Tooltip: 'Tooltip',
  IconTrashOutlineRegular: 'IconTrashOutlineRegular',
  IconWarningOutlineRegular: 'IconWarningOutlineRegular',
  IconCheckCircleOutlineRegular: 'IconCheckCircleOutlineRegular',
}

const source = await readFile(join(PLUGIN, 'lib', 'client.js'), 'utf8')

// --- the bundle may require only specifiers the page's module table can answer
const distDir = join(deepRoot, 'dsh-web-frontend', 'dist', 'assets')
const seedWords = (() => {
  for (const file of readdirSync(distDir).filter((name) => name.endsWith('.js'))) {
    const text = readFileSync(join(distDir, file), 'utf8')
    const at = text.indexOf('function rM(){return{')
    if (at < 0) continue
    const body = text.slice(at, text.indexOf('}}', at) + 1)
    return [...body.matchAll(/(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*:/g)].map(
      (match) => match[1] ?? match[2],
    )
  }
  throw new Error('could not find the shell platform seed table in the frontend build')
})()
console.log('platform seed words:', seedWords.join(', '))

const requires = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1])
assert.ok(requires.length > 0, 'the bundle must require something')
for (const specifier of requires) {
  assert.ok(
    seedWords.includes(specifier),
    `the bundle requires "${specifier}", which is not a platform seed word and would miss the module table`,
  )
}
console.log('PASS every require() is answered by the platform seed table:', requires.join(', '))

const registrations = new Map()
const moduleTable = new Map([
  ['react', react],
  ['react/jsx-runtime', jsxRuntime],
  ['@deepseek-ai/dsh-client-ui-primitives', primitives],
])

globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.set(registration.id, registration)
    },
  },
}

// Run the bundle the way the loader does: evaluating it only registers a factory.
new Function('window', source)(globalThis.window)
const registration = registrations.get('@dsh-local/dsh-session-purge')
assert.ok(registration, 'the bundle must register under its package id')
const loaded = registration.factory((specifier) => {
  const mod = moduleTable.get(specifier)
  if (mod === undefined) throw new Error(`unexpected external request: ${specifier}`)
  return mod
})
assert.equal(typeof loaded.apply, 'function', 'the bundle must export apply')
assert.ok(Array.isArray(loaded.inject), 'the bundle must export inject')

const mounted = []
const slotRegistrations = []
const dictionaries = new Map()
const remoteCalls = []
const refreshCalls = []
const injectScopes = []

/**
 * Cordis refuses a service a context did not declare in `inject`:
 * `cannot get property "remote.sessionManager" without inject`. This context
 * mirrors that — `remote.sessionManager` exists ONLY on the scope that
 * `ctx.inject(['remote.sessionManager'], …)` hands the callback, so reaching for
 * it on the plugin's own context fails exactly as it does in the browser.
 */
const makeServices = () => ({
  sessions: {
    refresh: async () => {
      refreshCalls.push('sessions')
    },
  },
  workspaces: {
    list: { getSnapshot: () => ({ archivedSessionIds: ['session-a'] }) },
    refresh: async () => {
      refreshCalls.push('workspaces')
    },
  },
})

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => {
      dictionaries.set(ns, dicts)
      return () => {}
    },
    bind: (ns) => (key, params) => {
      const dict = dictionaries.get(ns) ?? {}
      const text = dict.en?.[key] ?? dict.zh?.[key] ?? key
      if (params === undefined) return text
      return Object.entries(params).reduce((acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)), text)
    },
  },
  remote: {
    $mount: async (contribution) => {
      mounted.push(contribution)
      return () => {}
    },
    /* no sessionManager here on purpose: it belongs to the injected scope */
  },
  ...makeServices(),
  /* Cordis resolves a dependency before running the callback; a service that never
   * arrives leaves the callback parked, which is the deadlock the plugin avoids by
   * not listing `remote.sessionManager` in its static inject. */
  inject: (deps, callback) => {
    assert.ok(deps.includes('remote.sessionManager'), 'the UI scope must declare the Remote namespace it calls')
    assert.ok(
      !loaded.inject.includes('remote.sessionManager'),
      'the static inject must not name a service this plugin mounts itself',
    )
    const scope = {
      ...ctx,
      ...makeServices(),
      remote: {
        ...ctx.remote,
        sessionManager: {
          delete: async (request) => {
            remoteCalls.push(request)
            return {
              ok: true,
              value: {
                deleted: [{ sessionId: request.sessionIds[0], sizeBytes: 12, trashed: request.permanent !== true }],
                failed: [],
                sweptArchiveIds: [],
              },
            }
          },
        },
      },
    }
    injectScopes.push(scope)
    callback(scope)
    return { then: (resolve) => resolve(undefined), dispose: async () => {} }
  },
  slots: {
    inject: (key, callback) => {
      const value = callback()
      slotRegistrations.push({ key, value })
    },
    register: (options, component) => {
      return { options, component, dispose: () => {} }
    },
  },
}

const dispose = await loaded.apply(ctx)
assert.equal(typeof dispose, 'function', 'apply must return a disposer')
assert.equal(injectScopes.length, 1, 'the UI must register inside one namespace-declaring scope')
assert.equal(mounted.length, 1, 'exactly one Remote contribution must mount')
assert.equal(mounted[0].package, '@dsh-local/dsh-session-purge')
assert.equal(mounted[0].descriptors.length, 3, 'three descriptors must be mounted')
for (const descriptor of mounted[0].descriptors) {
  assert.equal(descriptor.namespace, 'sessionManager')
  assert.equal(typeof descriptor.parameters[0].codec.create, 'function', 'client codecs must be factories')
  assert.equal(typeof descriptor.parameters[0].codec.create().safeParse, 'function', 'client codecs must yield schemas')
  assert.equal(typeof descriptor.result.create, 'function')
}
assert.ok(dictionaries.has('sessionPurge'), 'the bundle must register its dictionaries')
assert.ok(dictionaries.get('sessionPurge').zh['menu.delete'], 'a Chinese label must exist')
assert.ok(dictionaries.get('sessionPurge').en['menu.delete'], 'an English label must exist')

const slotKeys = [...new Set(slotRegistrations.map((entry) => entry.key))].sort()
assert.deepEqual(slotKeys, ['shell.overlay', 'sidebar.workspaces.session.menu.item'], 'both seats must register')

/**
 * Reproduce the renderer's binding of an `inject` face.
 *
 * `bindInjectSources()` hands every `hooks` value to `observableHook()` →
 * `bindSnapshotSelector()`, which calls `source.subscribe(fn)` and
 * `source.getSnapshot()`. A plain value there therefore throws on every render,
 * and the slot's error boundary turns that into an invisible dead cell — a
 * failure mode with no visible symptom. This binding fails the same way, so the
 * harness can never again accept one.
 */
const bindInjectFace = (face) => {
  const sources = face?.hooks
  if (sources === undefined) return { ...face }
  const { hooks: _hooks, ...rest } = face
  const bound = { ...rest }
  for (const [name, source] of Object.entries(sources)) {
    const hookName = `use${name[0].toUpperCase()}${name.slice(1)}`
    assert.equal(typeof source.subscribe, 'function', `hooks.${name} must expose subscribe`) // mirrors w.subscribe(fn)
    assert.equal(typeof source.getSnapshot, 'function', `hooks.${name} must expose getSnapshot`) // mirrors w.getSnapshot()
    source.getSnapshot()
    source.subscribe(() => {})
    bound[hookName] = (selector) => selector(source.getSnapshot())
  }
  return bound
}

const tr = ctx.locale.bind('sessionPurge')
const menu = slotRegistrations.find((entry) => entry.key === 'sidebar.workspaces.session.menu.item')
assert.equal(menu.value.options.id, 'session-purge-delete')
assert.equal(menu.value.options.order, 500)
const menuInjected = bindInjectFace(menu.value.options.inject())
assert.equal(typeof menuInjected.requestDelete, 'function')
assert.equal(menuInjected.hooks, undefined, 'the menu entry must inject no hook sources')

const overlays = slotRegistrations.filter((entry) => entry.key === 'shell.overlay')
assert.equal(overlays.length, 2, 'both overlay seats must register: the dialog and the notice')
const dialogSeat = overlays.find((entry) => entry.value.options.id === 'session-purge-delete-dialog')
const noticeSeat = overlays.find((entry) => entry.value.options.id === 'session-purge-notice')
assert.ok(dialogSeat !== undefined, 'the delete dialog must live on shell.overlay, not inside the row menu')
const dialogInjected = bindInjectFace(dialogSeat.value.options.inject())
assert.equal(typeof dialogInjected.useDeleteRequest, 'function', 'the dialog seat binds its request cell as a hook')
assert.equal(typeof dialogInjected.settleDelete, 'function')
assert.equal(typeof dialogInjected.purgeSession, 'function')
const noticeInjected = bindInjectFace(noticeSeat.value.options.inject())
assert.equal(typeof noticeInjected.useNotice, 'function', 'the notice seat binds its observable as a hook')
assert.equal(typeof noticeInjected.dismissNotice, 'function')

// --- the menu row raises a request and renders ONLY the row
//
// Regression guard: the row is unmounted together with the menu it sits in, so a
// dialog rendered here would be torn down by its own confirming click — the click
// looks like it did nothing. The row must therefore contain no Modal at all.
const raised = []
const rowProps = {
  /* exactly what `renderSlot("sidebar.workspaces.session.menu.item", …)` passes */
  sessionId: 'session-a',
  displayTitle: 'A session',
  /* exactly what the slot's declared hook factory supplies */
  useMenuOpenState: () => [false, () => {}],
  ...menuInjected,
  requestDelete: (sessionId, displayTitle) => raised.push([sessionId, displayTitle]),
  t: tr,
}
const row = menu.value.component(rowProps)
assert.equal(row.type, 'MenuItemButton', 'the row renders a single menu item')
assert.equal(row.props.danger, true, 'the destructive row must be marked dangerous')
assert.equal(row.props.children, tr('menu.delete'))
assert.ok(
  !JSON.stringify(row).includes('Modal'),
  'the menu row must not render a dialog: the row unmounts with its menu',
)

// --- the dialog seat answers the request, and is inert while none is pending
const purgeCalls = []
const dialogProps = {
  useDeleteRequest: (selector) => selector(dialogInjected.deleteRequestCapture),
  settleDelete: () => purgeCalls.push('settle'),
  purgeSession: async (sessionId, permanent) => {
    purgeCalls.push([sessionId, permanent])
  },
  t: tr,
}
const inert = dialogSeat.value.component({
  ...dialogProps,
  useDeleteRequest: (selector) => selector(null),
})
assert.equal(inert, null, 'an empty request renders nothing')

const pending = { sessionId: 'session-a', displayTitle: 'Archived one' }
const seat = dialogSeat.value.component({
  ...dialogProps,
  useDeleteRequest: (selector) => selector(pending),
})
assert.notEqual(seat, null, 'a pending request renders one dialog entry')
/* The seat renders one form component per request, keyed by the Session; render it
 * to reach the modal. React state is stubbed, so calling it directly is enough. */
const dialog = typeof seat.type === 'function' ? seat.type(seat.props) : seat
assert.equal(dialog.type, 'Modal')
assert.equal(dialog.props.open, true, 'a pending request opens the dialog')
assert.equal(dialog.props.title, tr('confirm.title'))
assert.equal(dialog.props.description, tr('confirm.desc', { title: 'Archived one' }), 'the dialog names the session')
assert.equal(dialog.props.footer.props.children.length, 2, 'the dialog offers cancel and confirm')
assert.ok(
  dialog.props.children.some((child) => child?.type === 'Checkbox'),
  'the dialog must offer the permanent option',
)

// --- confirming drives the purge and then settles the request
const confirmButton = dialog.props.footer.props.children[1]
await confirmButton.props.onClick()
assert.deepEqual(purgeCalls[0], ['session-a', false], 'confirming purges the requested session')
assert.equal(purgeCalls[1], 'settle', 'confirming settles the request')
console.log('note: React state is stubbed, so intermediate busy state is not exercised here')

// --- the notice renders text from the shared Toast
const notice = noticeSeat.value.component({
  useNotice: (selector) => selector({ kind: 'done', count: 2, permanent: false, seq: 1 }),
  dismissNotice: () => {},
  t: ctx.locale.bind('sessionPurge'),
})
assert.ok(notice !== null && notice.props.text.includes('2'), 'the notice must interpolate its count')

console.log('ALL CLIENT CHECKS PASSED')
