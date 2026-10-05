import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { migrateSavedModelThinking } from '../src/models.ts'

it('repairs only earlier Rainy thinking-off profiles and performs no second write', async ({ onTestFinished }) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const model = { id: 'example-model', contextWindow: 4096, maxTokens: 384, reasoningEfforts: false }
  const legacy = { displayName: '本地模型', api: 'openai-completions', baseURL: 'http://127.0.0.1:1234/v1',
    apiKeyEnv: 'RAINY_LOCAL_KEY', reasoning: 'off', defaultMaxTokens: 384, timeoutMs: 180000, models: [model] }
  const initial = { extra: 'preserved', providers: {
    local: legacy,
    'rainy-deepseek': { ...legacy, displayName: 'DeepSeek V4.1 Flash', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' },
    correct: { ...legacy, apiKeyEnv: 'RAINY_CORRECT_KEY', models: [{ ...model, reasoningEfforts: { off: 'none', high: 'high' } }] },
    unset: { ...legacy, apiKeyEnv: 'RAINY_UNSET_KEY', reasoning: undefined },
    foreign: { ...legacy, displayName: 'External profile', apiKeyEnv: 'THIRD_PARTY_KEY' },
  } }
  let config: object = structuredClone(initial)
  const entry = { options: { id: 'llm-pi-ai', get config() { return config } } }
  const edit = vi.fn(async (_entry: object, update: (current: object) => object) => { config = update(config) })
  ctx.provide('configEditor', { entries: () => [entry], edit } as never)
  expect(await migrateSavedModelThinking(ctx)).toBe(2)
  const repairedModels = [{ ...model, reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' } }]
  expect(config).toEqual({ ...initial, providers: { ...initial.providers,
    local: { ...initial.providers.local, models: repairedModels },
    'rainy-deepseek': { ...initial.providers['rainy-deepseek'], models: repairedModels },
  } })
  expect(await migrateSavedModelThinking(ctx)).toBe(0)
  expect(edit).toHaveBeenCalledTimes(1)
  expect(initial.providers.local.models[0]?.reasoningEfforts).toBe(false)
})

it('propagates a failed profile write', async ({ onTestFinished }) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const config = { providers: { local: { displayName: '本地模型', apiKeyEnv: 'RAINY_LOCAL_KEY', reasoning: 'off',
    models: [{ id: 'example-model', reasoningEfforts: false }] } } }
  ctx.provide('configEditor', { entries: () => [{ options: { id: 'llm-pi-ai', config } }],
    edit: async () => { throw new Error('Fixture profile is read-only') },
  } as never)
  await expect(migrateSavedModelThinking(ctx)).rejects.toThrow('Fixture profile is read-only')
  expect(config.providers.local.models[0]?.reasoningEfforts).toBe(false)
})
