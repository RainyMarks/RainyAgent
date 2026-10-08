/**
 * Anthropic prompt-cache breakpoint on the previous request's tail.
 *
 * pi-ai marks the system prompt, the last tool and the last user message.
 * Anthropic looks back only about 20 content blocks from a breakpoint for an
 * earlier cache entry, so one agent step that adds more blocks than that (a
 * batch of parallel tool calls and their results) would write the whole
 * conversation again. Marking the user message that ended the previous request
 * as well turns that entry into an exact hit, within the four-breakpoint limit.
 *
 * @module dsh-llm-pi-ai/anthropic-cache
 */

const MAX_BREAKPOINTS = 4
const MARKABLE = new Set(['text', 'image', 'tool_result'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function marks(blocks: unknown): number {
  return Array.isArray(blocks) ? blocks.filter(block => isRecord(block) && block.cache_control !== undefined).length : 0
}

/**
 * Add a cache breakpoint to the user message that precedes the last assistant turn.
 * The request is changed in place, so pi-ai keeps sending its own object.
 * @param payload - the Anthropic Messages request pi-ai is about to send.
 * @returns `undefined`, which tells pi-ai to send the payload it built.
 */
export function markPreviousTurn(payload: unknown): undefined {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return undefined
  const messages = payload.messages.filter(isRecord)
  const used = marks(payload.system) + marks(payload.tools) + messages.reduce((total, message) => total + marks(message.content), 0)
  // No marker means this request opted out of caching; a full set leaves no room.
  if (used === 0 || used >= MAX_BREAKPOINTS) return undefined
  const before = (from: number, role: string): number => {
    let index = from
    while (index >= 0 && messages[index]?.role !== role) index--
    return index
  }
  // Past the last user message (pi-ai's breakpoint) and the assistant turn
  // before it lies the user message that ended the previous request.
  const previous = before(before(before(messages.length - 1, 'user') - 1, 'assistant') - 1, 'user')
  const message = messages[previous]
  if (message === undefined) return undefined
  const cacheControl = cacheControlOf(payload)
  if (typeof message.content === 'string') {
    message.content = [{ type: 'text', text: message.content, cache_control: cacheControl }]
    return undefined
  }
  if (!Array.isArray(message.content) || marks(message.content) > 0) return undefined
  const last: unknown = message.content.at(-1)
  if (isRecord(last) && typeof last.type === 'string' && MARKABLE.has(last.type)) last.cache_control = cacheControl
  return undefined
}

/** The cache marker pi-ai chose for this request, so both message breakpoints share one TTL. */
function cacheControlOf(payload: Record<string, unknown>): unknown {
  for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    for (const block of message.content) if (isRecord(block) && block.cache_control !== undefined) return block.cache_control
  }
  return { type: 'ephemeral' }
}
