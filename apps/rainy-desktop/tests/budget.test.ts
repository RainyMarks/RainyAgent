import { describe, it, expect, vi } from 'vitest'
import {
  CalibratedCounter,
  EndpointCounter,
  estimateRequest,
  estimateText,
  promptBreakdown,
  RequestQueue,
  resolveBudget,
} from '../src/budget.ts'

describe('request budget', () => {
  it('separates project memory and instructions without retaining their content', () => {
    const count = promptBreakdown(
      {
        messages: [
          {
            id: 'memory-recall',
            role: 'user',
            source: { kind: 'session-reference' },
            content: [{ type: 'text', text: 'Historical project fact' }],
          },
          {
            role: 'user',
            source: { kind: 'agent-instructions' },
            content: [{ type: 'text', text: 'Project constraint' }],
          },
        ],
      },
      [],
      ['memory-recall'],
    )
    expect(count.memory).toBeGreaterThan(0)
    expect(count.instructions).toBeGreaterThan(0)
    expect(count.history).toBe(0)
    expect(JSON.stringify(count)).not.toContain('Historical')
  })
  it('attributes selected extension descriptions once without double-counting system text', () => {
    const system = 'Core instructions.\n\nSelected skill details.'
    const count = promptBreakdown({ system, messages: [] }, ['Selected skill details.', 'absent server details'])
    expect(count.extensions).toBe(estimateText('Selected skill details.'))
    expect(count.system + count.extensions).toBe(estimateText(system))
    const inHistory = promptBreakdown({ messages: [{ role: 'system', content: [{ type: 'text', text: system }] }] }, [
      'Selected skill details.',
    ])
    expect(inHistory.extensions).toBe(count.extensions)
  })
  it('requires the exact counter to identify its chat template', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"tokens":42,"model":"local-model"}'))
      .mockResolvedValueOnce(
        new Response('{"tokens":42,"model":"local-model","chatTemplate":"deployment-template-v1"}'),
      )
    try {
      const counter = new EndpointCounter('http://tokenizer.test/count', new CalibratedCounter())
      expect((await counter.count({ model: 'local-model', messages: [] })).kind).toBe('estimated')
      expect((await counter.count({ model: 'local-model', messages: [] })).kind).toBe('exact')
    } finally {
      fetch.mockRestore()
    }
  })
  it('requires an exact counter to acknowledge the deployed model', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"tokens":42,"model":"wrong-model"}'))
    try {
      const counter = new EndpointCounter('http://tokenizer.test/count', new CalibratedCounter())
      expect((await counter.count({ model: 'local-model', messages: [] })).kind).toBe('estimated')
      const body = fetch.mock.calls[0]?.[1]?.body
      if (typeof body !== 'string') throw new Error('Expected a JSON tokenizer request body.')
      const parsed: unknown = JSON.parse(body)
      expect(parsed).toMatchObject({ model: 'local-model' })
    } finally {
      fetch.mockRestore()
    }
  })
  it('reserves input, output and error margin for 100K', () => {
    expect(resolveBudget(100000)).toEqual({
      contextWindow: 100000,
      outputTokens: 16000,
      marginTokens: 8000,
      inputLimit: 76000,
      compactAt: 70000,
      keepRecentTokens: 20000,
      summaryTokens: 4000,
      toolTokens: 4000,
    })
  })
  it.each([32768, 65536, 100000, 1000000])('fits the deployed %i window', (window) => {
    const budget = resolveBudget(window)
    expect(budget.inputLimit + budget.outputTokens + budget.marginTokens).toBe(window)
    expect(budget.keepRecentTokens).toBeLessThan(budget.compactAt)
    expect(budget.compactAt).toBeLessThanOrEqual(budget.inputLimit)
  })
  it('preserves official DeepSeek maximum output instead of applying local caps', () => {
    expect(resolveBudget(1048576, 393216).outputTokens).toBe(393216)
  })
  it('rejects an impossible output reservation', () => {
    expect(() => resolveBudget(32768, 32000)).toThrow()
  })
  it('prices multilingual text, framing and full tool schemas', () => {
    expect(estimateText('中文')).toBe(6)
    const request = { messages: [{ role: 'user', content: [{ type: 'text', text: '你好 hello' }] }] }
    expect(estimateRequest({ ...request, tools: [{ name: 'read', description: 'x'.repeat(1000) }] })).toBeGreaterThan(
      estimateRequest(request) + 300,
    )
  })
  it('increases estimates after observed undercount', async () => {
    const counter = new CalibratedCounter()
    const request = { messages: [] }
    const before = await counter.count(request)
    counter.observe(before.tokens, before.tokens * 2)
    expect((await counter.count(request)).tokens).toBeGreaterThan(before.tokens * 2)
  })
  it('marks unavailable exact counters as estimates', async () => {
    const counter = new EndpointCounter('http://127.0.0.1:1', new CalibratedCounter())
    expect((await counter.count({ messages: [] })).kind).toBe('estimated')
  })
  it('passes only countable fields to the configured tokenizer', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"tokens":42}', { status: 200 }))
    try {
      const request = { messages: [], tools: [], transportOnly: 'must-not-leave' }
      const counter = new EndpointCounter('http://tokenizer.test/count', new CalibratedCounter())
      expect(await counter.count(request)).toEqual({
        tokens: 42,
        kind: 'exact',
        method: 'configured-request-tokenizer',
      })
      const body = fetch.mock.calls[0]?.[1]?.body
      if (typeof body !== 'string') throw new Error('Expected a JSON tokenizer request body.')
      const parsed: unknown = JSON.parse(body)
      expect(parsed).toEqual({ messages: [], tools: [] })
    } finally {
      fetch.mockRestore()
    }
  })
})

describe('local request admission', () => {
  it('serializes one endpoint while other endpoints run independently', async () => {
    const queue = new RequestQueue()
    const release = await queue.acquire('local')
    let admitted = false
    const next = queue.acquire('local').then((done) => {
      admitted = true
      done()
    })
    ;(await queue.acquire('other'))()
    await Promise.resolve()
    expect(admitted).toBe(false)
    release()
    await next
    expect(admitted).toBe(true)
  })
  it('cancelled waiters never release the active request', async () => {
    const queue = new RequestQueue()
    const active = await queue.acquire('local')
    const abort = new AbortController()
    const cancelled = queue.acquire('local', abort.signal)
    abort.abort(new Error('stop'))
    await expect(cancelled).rejects.toThrow('stop')
    let admitted = false
    const next = queue.acquire('local').then((done) => {
      admitted = true
      done()
    })
    await Promise.resolve()
    expect(admitted).toBe(false)
    active()
    await next
    expect(admitted).toBe(true)
  })
})
