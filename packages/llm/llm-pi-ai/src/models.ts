/** pi-ai model helpers assembled from public narrow entry points. */

import { createModels as createPiModels, createProvider as createPiProvider } from '@earendil-works/pi-ai/models'
import type {
  Api,
  CreateModelsOptions,
  Model,
  ModelThinkingLevel,
  MutableModels,
  Provider,
  ProviderAuth,
  ProviderStreams,
} from '@earendil-works/pi-ai'
import { THINKING_LEVELS } from './catalog.ts'

/** Input accepted by the static, single-protocol providers this package builds. */
interface StaticProviderOptions {
  id: string
  name: string
  baseUrl?: string
  auth: ProviderAuth
  models: readonly Model<Api>[]
  api: ProviderStreams
}

/**
 * Create an empty pi-ai collection without importing its aggregate entry point.
 * @param options - credential storage and ambient authentication integrations.
 * @returns a mutable collection with no registered providers.
 */
export function createModels(options?: CreateModelsOptions): MutableModels {
  return createPiModels(options)
}

/**
 * Create the static, single-protocol provider used by configured custom routes.
 * @param input - provider identity, models, authentication, and protocol implementation.
 * @returns a provider that delegates each operation to the supplied protocol.
 */
export function createProvider(input: StaticProviderOptions): Provider {
  return createPiProvider(input)
}

/**
 * Resolve selectable reasoning levels from pi-ai's public model metadata.
 * @param model - model descriptor carrying reasoning support and wire mappings.
 * @returns supported levels in pi-ai's escalation order.
 */
export function getSupportedThinkingLevels(model: Model<Api>): ModelThinkingLevel[] {
  if (!model.reasoning) return ['off']
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}
