import { afterEach, describe, expect, it } from 'vitest'
import type { Model } from '@earendil-works/pi-ai'
import { buildBaseOptions, clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(closeMockServers)

function model(contextWindow: number, maxTokens: number): Model<'openai-completions'> {
  return {
    id: 'local-model', name: 'Local model', api: 'openai-completions', provider: 'local',
    baseUrl: 'http://127.0.0.1:9/v1', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens,
  }
}

const prompt = 'a'.repeat(12_000)
const context = normalizeContext({ messages: [{ role: 'user', content: prompt, timestamp: 0 }] })

describe('explicit output budgets (patched pi-ai)', () => {
  it.each([{ contextWindow: 4096, maxTokens: 655 }, { contextWindow: 8192, maxTokens: 1310 }])(
    'preserves the configured $maxTokens-token output budget in a $contextWindow-token request',
    async ({ contextWindow, maxTokens }) => {
      const server = await mockServer([{ events: textEvents }])
      const adapter = new PiAiAdapter({
        profiles: () => resolveProfiles({ local: {
          api: 'openai-completions', baseURL: server.url, compat: { maxTokensField: 'max_tokens' },
          models: [{ id: 'local-model', contextWindow, maxTokens }],
        } }),
        resolveApiKey: () => Promise.resolve('test-key'),
        auth: memoryAuth(),
      })
      const chunks = []
      for await (const chunk of adapter.stream({
        provider: 'local', model: 'local-model', maxTokens,
        messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })],
      })) chunks.push(chunk)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(server.requests[0]).toMatchObject({ max_tokens: maxTokens })
    },
  )

  it('keeps the provider default safety reserve when the caller omits an output budget', () => {
    expect(buildBaseOptions(model(8192, 8192), context).maxTokens).toBe(1096)
  })

  it('limits an explicit output budget to the model output capability', () => {
    expect(buildBaseOptions(model(8192, 256), context, { maxTokens: 1024 }).maxTokens).toBe(256)
  })

  it('limits an explicit output budget to the estimated remaining context', () => {
    expect(buildBaseOptions(model(4096, 4096), context, { maxTokens: 2048 }).maxTokens).toBe(1096)
  })

  it('retains the provider thinking adjustment safety clamp', () => {
    expect(clampMaxTokensToContext(model(8192, 8192), context, 4096)).toBe(1096)
  })
})
