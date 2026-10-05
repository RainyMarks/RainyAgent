/** Required project instructions fail visibly when a deployment refuses truncation. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as AgentInstructions from '../src/index.ts'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { loadBaselineInstructionSet } from '../src/files.ts'
import { renderInstructionChanges } from '../src/render.ts'

describe('required instruction budgets', () => {
  it('refuses an oversized source by name instead of quietly dropping it', async ({ onTestFinished }) => {
    const root = await mkdtemp(join(tmpdir(), 'instruction-budget-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, '.git'))
    await writeFile(join(root, 'AGENTS.md'), 'mandatory constraint '.repeat(80))
    await expect(loadBaselineInstructionSet({ cwd: root, dshHome: join(root, 'home'), maxBytes: 4096, maxSourceBytes: 512, budgetOverflow: 'error' }))
      .rejects.toThrow(/AGENTS\.md/)
    const compatible = await loadBaselineInstructionSet({ cwd: root, dshHome: join(root, 'home'), maxBytes: 4096, maxSourceBytes: 512 })
    expect(compatible).toBeUndefined()
  })
  it('refuses cumulative baseline overflow while retaining the source files', async ({ onTestFinished }) => {
    const root = await mkdtemp(join(tmpdir(), 'instruction-total-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, '.git')); await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'AGENTS.md'), 'outer '.repeat(50))
    await writeFile(join(root, 'sub', 'AGENTS.md'), 'inner '.repeat(50))
    await expect(loadBaselineInstructionSet({ cwd: join(root, 'sub'), dshHome: join(root, 'home'), maxBytes: 512, maxSourceBytes: 4096, budgetOverflow: 'error' }))
      .rejects.toThrow('512-byte budget')
  })
  it('also refuses a dynamic update rather than silently truncating new constraints', () => {
    const items = [{ change: { action: 'replace' as const, scope: 'project', path: 'AGENTS.md', digest: 'next' },
      file: { absolutePath: '/project/AGENTS.md', displayPath: 'AGENTS.md', content: 'new constraint '.repeat(100) } }]
    expect(() => renderInstructionChanges(items, 512, 'error')).toThrow('AGENTS.md')
    expect(renderInstructionChanges(items, 512).text.length).toBeGreaterThan(0)
  })
  it('blocks continuation after an oversized edited instruction and retries the corrected source on the next turn', async ({ onTestFinished }) => {
    const root = await mkdtemp(join(tmpdir(), 'instruction-dynamic-budget-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, '.git'))
    const path = join(root, 'AGENTS.md')
    await writeFile(path, 'Original project rule.')
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeHarnessIdentity: false, includeRuntimeContext: false } })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(ToolFs)
    await ctx.plugin(AgentInstructions, { maxBytes: 512, maxSourceBytes: 1024, budgetOverflow: 'error', dshHome: join(root, 'home') })
    const adapter = new MockAdapter([
      toolCallResponse('write-instruction', 'write', { file_path: path, content: 'Mandatory project rule. '.repeat(200) }),
      textResponse('Corrected rules received.'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const loop = await mountAgentLoopTestHarness(ctx)
    const agent = await loop.create(SessionId('instruction-budget'), { provider: 'mock', model: 'mock' }, { cwd: root })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Update the project rule.' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (end?.data.reason.kind !== 'error') throw new Error('Expected instruction-budget rejection.')
    expect(end.data.reason.error.message).toContain('1024-byte budget')
    await writeFile(path, 'Corrected project constraint.')
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue with the corrected rule.' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('Corrected project constraint.')
  })
})
