import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { describe, expect, it } from 'vitest'
import { mountAgentLoopTestDependencies } from '../../../packages/test-support/agent-loop-testkit/src/index.ts'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as Policy from '../src/policy.ts'

class WindowAdapter extends MockAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: model === 'small' ? 4096 : 32768 },
      defaultMaxTokens: 512,
    })
  }
}

describe('Rainy request admission', () => {
  it('rechecks selected extension costs when the active model changes to a smaller window', async ({
    onTestFinished,
  }) => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SandboxPolicy)
    ctx.provide('compaction', {} as never)
    ctx.provide('tokenMeter', {} as never)
    ctx.provide('spillStore', {} as never)
    ctx.provide('configEditor', { entries: () => [] } as never)
    ctx.provide('rainyProjectRoots', { forSessionCwd: () => [] } as never)
    ctx.provide('workspaceRegistry', {} as never)
    ctx.provide('agentDefaultModel', {} as never)
    await ctx.plugin(Policy, {})
    const adapter = new WindowAdapter([textResponse('Accepted.')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const sessionId = SessionId('extension-window-fixture')
    const description = 'Selected skill detail. '.repeat(100)
    ctx.rainy.extensionDescriptions.set(sessionId, [description])
    ctx.rainy.extensionBudgets.set(sessionId, { maxTokens: 4096, inputRatio: 0.2 })
    const request = {
      provider: 'mock',
      system: description,
      sessionId,
      maxTokens: 512,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue.' }] })],
    }
    const collect = async (model: string) => {
      const chunks = []
      for await (const chunk of ctx.llm.stream({ ...request, model })) chunks.push(chunk)
      return chunks
    }
    expect((await collect('large')).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect((await collect('small')).at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'EXTENSION_BUDGET_EXCEEDED' } },
    })
    expect(adapter.requests).toHaveLength(1)
  })
})
