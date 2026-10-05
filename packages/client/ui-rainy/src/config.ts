/** Workbench timing, output retention and initial terminal dimensions. */
import z from '@deepseek-ai/schemastery'

/** Host-resolved browser workbench limits. */
export interface Config {
  /** Maximum wait for the workbench's application-ready acknowledgement. */
  readyTimeoutMs: number
  /** Maximum wait for a durable draft-save acknowledgement. */
  flushTimeoutMs: number
  /** Interval between observations of open editor files, idle execution, and visible model settings. */
  editorPollMs: number
  /** Quiet interval before recovery buffers are durably saved. */
  editorStateDebounceMs: number
  /** Poll interval while a user-owned run or debug operation is active. */
  executionPollMs: number
  /** Maximum retained output characters per workspace execution view. */
  editorMaxOutputCharacters: number
  /** Maximum workspace execution views retained in the renderer. */
  editorMaxRetainedWorkspaces: number
  /** Initial terminal columns before its panel reports actual geometry. */
  editorTerminalCols: number
  /** Initial terminal rows before its panel reports actual geometry. */
  editorTerminalRows: number
  /** Initial context window for a new local model configuration. */
  localModelContextWindow: number
  /** Initial context window for a new API model configuration. */
  apiModelContextWindow: number
}

/** Workbench limits can be changed through the Rainy profile. */
export const Config: z<Partial<Config>, Config> = z.object({
  readyTimeoutMs: z.number().min(1000).max(60000).step(1).default(15000),
  flushTimeoutMs: z.number().min(1000).max(60000).step(1).default(15000),
  editorPollMs: z.number().min(500).max(60000).step(1).default(2000),
  editorStateDebounceMs: z.number().min(100).max(10000).step(1).default(500),
  executionPollMs: z.number().min(50).max(5000).step(1).default(200),
  editorMaxOutputCharacters: z.number().min(1024).max(16 * 1024 * 1024).step(1).default(1048576),
  editorMaxRetainedWorkspaces: z.number().min(1).max(64).step(1).default(8),
  editorTerminalCols: z.number().min(2).max(500).step(1).default(80),
  editorTerminalRows: z.number().min(2).max(200).step(1).default(24),
  localModelContextWindow: z.number().min(4096).max(Number.MAX_SAFE_INTEGER).step(1).default(100000),
  apiModelContextWindow: z.number().min(4096).max(Number.MAX_SAFE_INTEGER).step(1).default(1000000),
})
