/**
 * Ask the real installer what runtime version it reports and whether candidate
 * peer ranges would pass its compatibility gate. A denied row is dropped
 * silently at startup, so this must be exact.
 */
import { pathToFileURL } from 'node:url'

import { RUNTIME } from './env.mjs'

const root = RUNTIME
const boot = await import(pathToFileURL(`${root}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`).href)

const runtimeVersion = boot.getDshRuntimeVersion()
console.log('getDshRuntimeVersion() =', runtimeVersion)

const manifest = {
  name: '@dsh-local/dsh-session-purge',
  version: '0.1.0',
}

for (const range of ['0.2.0-rc.2', '^0.2.0-rc.2', 'workspace:*', '>=0.2.0-rc.2', '*', '0.1.0']) {
  const issue = boot.evaluatePluginCompatibility(
    {
      ...manifest,
      peerDependencies: {
        '@deepseek-ai/dsh-tools': range,
        '@deepseek-ai/dsh-typert-protocol': range,
        zod: '^4.0.0',
      },
    },
    {},
    runtimeVersion,
  )
  console.log(`${range.padEnd(16)} ->`, issue === undefined ? 'COMPATIBLE' : `DENIED (peers: ${JSON.stringify(issue.peers)})`)
}
