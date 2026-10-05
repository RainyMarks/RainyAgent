/** Host configuration for Rainy's browser workbench. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Config } from './config.ts'

export { Config } from './config.ts'

/**
 * Embed validated workbench deadlines in the served page.
 * @param ctx - Host context serving the workbench carrier.
 * @param config - deadlines adopted when the page loads.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__RAINY_WORKBENCH_CONFIG__', value: config })
  })
}
