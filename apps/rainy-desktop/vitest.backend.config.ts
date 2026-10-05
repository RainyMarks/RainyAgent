/** Platform-neutral sandbox profile and grant ownership checks used by Rainy's multi-root assembly. */
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { resolve } from 'node:path'
import { standardDecoratorPlugin, vitestExecArgv } from '../../vitest.shared.ts'
const root = resolve(import.meta.dirname, '../..')
export default defineConfig({
  root,
  plugins: [tsconfigPaths({ projects: [resolve(root, 'tsconfig.base.json')] }), standardDecoratorPlugin()],
  test: { include: ['packages/sandbox/sandbox-local/tests/local.spec.ts', 'packages/sandbox/sandbox-local/tests/acl-grants.spec.ts'],
    testTimeout: 30000, execArgv: vitestExecArgv },
})
