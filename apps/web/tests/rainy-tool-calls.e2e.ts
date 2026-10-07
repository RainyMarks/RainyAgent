/** Replay recorded tool calls through the shipped Rainy profile. */
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage } from './support.ts'

const rainy = fileURLToPath(new URL('../../rainy-desktop/', import.meta.url))
const fixture = fileURLToPath(new URL('../../../snapshots/web/tool-details/session.v3.jsonl', import.meta.url))
const expected = fileURLToPath(new URL('./expected/rainy-tool-calls/', import.meta.url))
let scaffold: WebScaffold
let browser: Browser
let page: Page
beforeAll(async () => {
  scaffold = await launchWebScaffold({ profile: { hmr: false, initialBundles: ['@deepseek-ai/dsh-rainy-desktop'], packages: [] },
    extraInstallAnchors: [join(rainy, 'package.json')] })
  await seedSession(scaffold, await readFile(fixture, 'utf8'), 'rainy-tool-renderer-replay')
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  await page.setViewportSize({ width:1380,height:900 })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.locator('[data-rainy-topbar]').waitFor()
  const agent = page.getByRole('complementary', { name: /^(AI assistant|AI 助手)$/ })
  if (!await agent.isVisible()) await page.getByRole('button', { name: /Show or hide AI assistant|显示或隐藏 AI 助手/ }).click()
  await agent.getByRole('button', { name: /^(Chat history|对话历史)$/ }).click()
  const rows = page.locator('[role="treeitem"]')
  await rows.first().click()
  const selected = page.waitForResponse((response) => {
    if (!response.url().endsWith('/rainy/ide') || response.request().method() !== 'POST') return false
    const body: unknown = response.request().postDataJSON()
    return body !== null && typeof body === 'object' && 'op' in body && body.op === 'state.selection.save'
  })
  await rows.nth(1).click()
  await selected
  // Opening a chat from another project's history keeps the AI panel open even though that project saved it hidden.
  const toggle = page.locator('[data-rainy-topbar]').getByRole('button', { name: /Show or hide AI assistant|显示或隐藏 AI 助手/ })
  await toggle.and(page.locator('[aria-pressed="true"]')).waitFor({ state: 'visible' })
  await agent.waitFor({ state: 'visible' })
  await expandOwningTurnProcess(page, page.locator('[data-chat-call-id]').first())
})
afterAll(async () => { try { await browser?.close() } finally { await scaffold?.close() } })
it('renders stored tool calls instead of unknown surface events', async () => {
  const rows = page.locator('[data-chat-call-id]')
  await rows.first().waitFor()
  expect(await rows.count()).toBeGreaterThan(0)
  expect(await page.getByText(/Unknown surface event: tool-call|未知 surface 事件.*tool-call/).count()).toBe(0)
  await mkdir(expected, { recursive: true })
  await compareOrRefreshGolden(join(expected, 'tool-call.expected.md'),
    await captureStableAria(page, '[data-chat-call-id="details-call-1"]', scaffold.workspaceCwd), webSnapshotMode())
})
