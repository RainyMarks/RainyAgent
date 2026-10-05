import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { standardDecoratorPlugin, vitestExecArgv } from '../../vitest.shared.ts';
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['../../tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30000, execArgv: vitestExecArgv },
});
