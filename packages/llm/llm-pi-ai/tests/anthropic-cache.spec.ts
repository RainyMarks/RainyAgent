import { describe, expect, it } from 'vitest'
import { markPreviousTurn } from '../src/anthropic-cache.ts'

const ephemeral = { type: 'ephemeral', ttl: '1h' }

interface Payload {
  system: Record<string, unknown>[]
  tools: Record<string, unknown>[]
  messages: { role: string; content: unknown }[]
}

function agentStep(): Payload {
  return {
    system: [{ type: 'text', text: 'prompt', cache_control: ephemeral }],
    tools: [{ name: 'read', cache_control: ephemeral }],
    messages: [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', cache_control: ephemeral }] },
    ],
  }
}

describe('previous-turn cache breakpoint', () => {
  it('marks the user message that ended the previous request with the same TTL', () => {
    const payload = agentStep()
    expect(markPreviousTurn(payload)).toBeUndefined()
    expect(payload.messages[2]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'a', cache_control: ephemeral }])
    expect(payload.messages[0]?.content).toBe('task')
  })

  it('turns a plain-text previous message into a marked text block', () => {
    const payload = agentStep()
    payload.messages.splice(1, 2)
    markPreviousTurn(payload)
    expect(payload.messages[0]?.content).toEqual([{ type: 'text', text: 'task', cache_control: ephemeral }])
  })

  it('skips mid-conversation system messages between the turns', () => {
    const payload = agentStep()
    payload.messages.splice(3, 0, { role: 'system', content: [{ type: 'text', text: 'effort' }] })
    markPreviousTurn(payload)
    expect(payload.messages[2]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'a', cache_control: ephemeral }])
  })

  it('leaves the first request, an uncached request and a full breakpoint set unchanged', () => {
    const first = { messages: [{ role: 'user', content: [{ type: 'text', text: 'task', cache_control: ephemeral }] }] }
    markPreviousTurn(first)
    expect(first.messages).toHaveLength(1)

    const uncached = agentStep()
    uncached.system = [{ type: 'text', text: 'prompt' }]
    uncached.tools = [{ name: 'read' }]
    uncached.messages[4] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b' }] }
    markPreviousTurn(uncached)
    expect(JSON.stringify(uncached)).not.toContain('cache_control')

    const full = agentStep()
    full.system.push({ type: 'text', text: 'second', cache_control: ephemeral })
    markPreviousTurn(full)
    expect(full.messages[2]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'a' }])
  })
})
