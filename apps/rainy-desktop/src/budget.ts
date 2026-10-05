/** Model-specific request budgets and explicit estimated token counts. */
export interface Budget {
  contextWindow: number
  outputTokens: number
  marginTokens: number
  inputLimit: number
  compactAt: number
  keepRecentTokens: number
  summaryTokens: number
  toolTokens: number
}

/** Resolve a combined input/output window; explicit output limits are never silently lowered. */
export function resolveBudget(contextWindow: number, maxOutput?: number): Budget {
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 4096)
    throw new Error('上下文长度必须是至少 4096 的整数。')
  const outputTokens = maxOutput ?? Math.min(16000, Math.floor(contextWindow * 0.16))
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 1) throw new Error('输出上限必须是正整数。')
  const marginTokens = Math.max(512, Math.floor(contextWindow * 0.08))
  const inputLimit = contextWindow - outputTokens - marginTokens
  if (inputLimit < 1024) throw new Error('输出预留过大，当前窗口没有足够的输入空间。')
  return {
    contextWindow,
    outputTokens,
    marginTokens,
    inputLimit,
    compactAt: Math.min(Math.floor(contextWindow * 0.7), inputLimit),
    keepRecentTokens: Math.min(Math.floor(contextWindow * 0.2), Math.floor(inputLimit * 0.4)),
    summaryTokens: Math.min(4000, Math.floor(contextWindow * 0.04)),
    toolTokens: Math.min(4000, Math.floor(contextWindow * 0.04)),
  }
}

/** A counter must include provider framing and tool definitions, not only visible conversation text. */
export interface TokenCounter {
  count(request: CountableRequest, signal?: AbortSignal): Promise<TokenCount>
}
/** Request fields that contribute tokens; ids, secrets and transport options are excluded. */
export interface CountableRequest {
  provider?: string
  model?: string
  system?: string
  messages: readonly { id?: string; role: string; content: readonly unknown[]; source?: { kind: string } }[]
  tools?: readonly unknown[]
}
/** Exactness is carried into the UI; estimated counts never masquerade as tokenizer measurements. */
export interface TokenCount {
  tokens: number
  kind: 'estimated' | 'exact'
  method: string
}

/** Conservative component estimates; provider-reported totals may differ from this decomposition. */
export interface PromptBreakdown {
  system: number
  tools: number
  instructions: number
  memory: number
  extensions: number
  history: number
  framing: number
}

/**
 * Explain prompt cost without retaining prompt text in the settings API.
 * @param request Final model-facing request.
 * @param extensionDescriptions Selected Skills and MCP instructions to attribute separately from ordinary system text.
 * @param memoryMessageIds Recall ids established by the durable project-memory projection.
 * @returns Estimated tokens by content source, with separate protocol framing.
 */
export function promptBreakdown(
  request: CountableRequest,
  extensionDescriptions: readonly string[] = [],
  memoryMessageIds: readonly string[] = [],
): PromptBreakdown {
  const counts: PromptBreakdown = {
    system: request.system ? estimateText(request.system) : 0,
    tools: request.tools ? estimateText(JSON.stringify(request.tools)) : 0,
    instructions: 0,
    memory: 0,
    extensions: 0,
    history: 0,
    framing: 16 * (request.messages.length + 1),
  }
  const systemTexts = [request.system ?? '']
  for (const message of request.messages) {
    const count = estimateText(JSON.stringify(message.content))
    if (message.role === 'system') {
      counts.system += count
      for (const block of message.content) {
        if (block !== null && typeof block === 'object' && 'text' in block && typeof block.text === 'string')
          systemTexts.push(block.text)
      }
    } else if (message.source?.kind === 'agent-instructions' || message.source?.kind === 'system-prompt')
      counts.instructions += count
    else if (message.id !== undefined && memoryMessageIds.includes(message.id)) counts.memory += count
    else counts.history += count
  }
  let remaining = systemTexts.join('\n')
  for (const text of extensionDescriptions) {
    if (!text || !remaining.includes(text)) continue
    counts.extensions += estimateText(text)
    remaining = remaining.replace(text, '')
  }
  counts.system = Math.max(0, counts.system - counts.extensions)
  return counts
}

/** Conservative multilingual estimate. ASCII costs one token per three characters, non-ASCII up to its UTF-8 byte count. */
export function estimateText(text: string): number {
  let ascii = 0
  let other = 0
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0
    if (point < 128) ascii++
    else other += point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return Math.ceil(ascii / 3) + other
}

/** Price the complete serialized model-facing data and fixed chat framing. */
export function estimateRequest(request: CountableRequest): number {
  const messages = request.messages.map(message => ({ role: message.role, content: message.content }))
  return (
    estimateText(JSON.stringify({ system: request.system, messages, tools: request.tools })) +
    16 * (messages.length + 1)
  )
}

/** Maintain route-local calibration using actual provider usage; calibration only increases the estimate. */
export class CalibratedCounter implements TokenCounter {
  private ratio = 1
  count(request: CountableRequest, signal?: AbortSignal): Promise<TokenCount> {
    signal?.throwIfAborted()
    return Promise.resolve({
      tokens: Math.ceil(estimateRequest(request) * this.ratio),
      kind: 'estimated',
      method: 'multilingual-conservative+usage',
    })
  }
  observe(estimated: number, actualInput: number): void {
    if (estimated > 0 && actualInput > estimated) this.ratio *= (actualInput / estimated) * 1.1
  }
}

/** An optional service-provided whole-request counter, configured explicitly for the deployed chat template. */
export class EndpointCounter implements TokenCounter {
  constructor(
    private readonly url: string,
    private readonly fallback: TokenCounter,
  ) {}
  async count(request: CountableRequest, signal?: AbortSignal): Promise<TokenCount> {
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: request.provider,
          model: request.model,
          system: request.system,
          messages: request.messages.map(message => ({ role: message.role, content: message.content })),
          tools: request.tools,
        }),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]),
      })
      if (!response.ok) throw new Error(`Token counter HTTP ${response.status}`)
      const data: unknown = await response.json()
      if (
        data === null ||
        typeof data !== 'object' ||
        !('tokens' in data) ||
        !Number.isSafeInteger(data.tokens) ||
        Number(data.tokens) < 0
      )
        throw new Error('Invalid token counter response')
      if (
        request.model !== undefined &&
        (!('model' in data) ||
          data.model !== request.model ||
          !('chatTemplate' in data) ||
          typeof data.chatTemplate !== 'string' ||
          !data.chatTemplate.trim())
      )
        return await this.fallback.count(request, signal)
      return { tokens: Number(data.tokens), kind: 'exact', method: 'configured-request-tokenizer' }
    } catch (error) {
      if (signal?.aborted) throw error
      return this.fallback.count(request, signal)
    }
  }
}

/** FIFO, cancellation-aware request admission, with one active request per endpoint. */
export class RequestQueue {
  private tails = new Map<string, Promise<void>>()
  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    this.tails.set(key, tail)
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([
        previous,
        new Promise<never>((_, reject) => {
          onAbort = () => {
            const reason: unknown = signal?.reason
            reject(reason instanceof Error ? reason : new Error('Cancelled'))
          }
          signal?.addEventListener('abort', onAbort, { once: true })
          if (signal?.aborted) onAbort()
        }),
      ])
      signal?.throwIfAborted()
    } catch (error) {
      release()
      throw error
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
    return () => {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}
