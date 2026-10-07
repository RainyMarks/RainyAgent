/** Borrowed recorded conversation rendered by Rainy's real workbench and durable draft routes. */
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Frame, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, seedSession,
  selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'
import type { NativeToolCatalog, NativeToolId, NativeToolPreferences, NativeToolsBridge } from '../../../packages/client/ui-rainy/src/native-tools-protocol.ts'

const require = createRequire(new URL('../package.json', import.meta.url))
const { chromium } = require('playwright') as typeof import('playwright')
const RAINY_DIRECTORY = fileURLToPath(new URL('../../rainy-desktop/', import.meta.url))
const SNAPSHOT_DIRECTORY = fileURLToPath(new URL('../../../snapshots/web/rainy-ctf-workbench/', import.meta.url))
const CATALOG_DIRECTORY = fileURLToPath(new URL('./expected/rainy-catalog/', import.meta.url))
const EVIDENCE_DIRECTORY = process.env.RAINY_CTF_EVIDENCE_DIRECTORY
const SOURCE_FIXTURE = fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v4.jsonl', import.meta.url))
const SEED_ID = 'rainy-ctf-recorded-conversation'
const DRAFT = 'Rainy draft fixture\n普通文本 😀'
const MODE = webSnapshotMode()

async function closeHistoryDrawer(page: Page): Promise<void> {
  const close = page.getByRole('complementary', { name: /^(Workspace|工作区)$/ })
    .getByRole('button', { name: /^(Close|关闭)$/ })
  if (await close.isVisible()) await close.click()
}

async function openRecordedConversation(page: Page): Promise<void> {
  const welcome = page.locator('[class*="onboardingOverlay"]')
  if (await welcome.count() > 0) {
    await welcome.getByRole('button').click()
    await welcome.waitFor({ state: 'detached' })
  }
  const reply = page.getByText('LIGHTHOUSE', { exact: true })
  const agent = page.getByRole('complementary', { name: /^(AI assistant|AI 助手)$/ })
  // The toggle's pressed state is the restored layout; a visibility probe can run before restoration settles.
  const toggle = page.locator('[data-rainy-topbar]').getByRole('button', { name: /Show or hide AI assistant|显示或隐藏 AI 助手/ })
  await expect.poll(() => toggle.getAttribute('aria-pressed')).toMatch(/^(true|false)$/)
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-pressed')).toBe('true')
  await agent.waitFor({ state: 'visible' })
  if (!await reply.isVisible()) {
    await agent.getByRole('button', { name: /^(Chat history|对话历史)$/ }).click()
    const shortcut = await page.getByRole('button', { name: /Search sessions|搜索会话/ }).getAttribute('aria-keyshortcuts')
    if (shortcut === null) throw new Error('Session search must expose its keyboard shortcut.')
    await page.keyboard.press(shortcut)
    const search = page.locator('input[placeholder]').filter({ visible: true }).first()
    await search.fill('LIGHTHOUSE')
    const result = page.getByRole('tree', { name: /Search results|搜索结果/ }).getByRole('treeitem')
    await expect.poll(() => result.count()).toBe(1)
    await result.click()
  }
  await reply.waitFor({ state: 'visible' })
  await closeHistoryDrawer(page)
}

async function openWorkbench(page: Page): Promise<Frame> {
  await page.locator('[data-rainy-topbar]').getByRole('button', { name: /^CTF/ }).click()
  await page.getByRole('tab', { name: 'IceSky', exact: true }).click()
  const carrier = page.locator('[data-rainy-ctf-workbench] iframe')
  await carrier.waitFor({ state: 'visible' })
  await expect.poll(() => page.frames().find(frame => frame.url().includes('/rainy/icesky/'))?.url()).toBeTruthy()
  const frame = page.frames().find(candidate => candidate.url().includes('/rainy/icesky/'))
  if (frame === undefined) throw new Error('The Rainy workbench frame did not load.')
  await frame.getByRole('button', { name: /All tools|全部工具/, exact: true }).click()
  await frame.getByRole('tab', { name: /变换|Transform/ }).first().click()
  await frame.locator('#transform-input').waitFor({ state: 'visible' })
  return frame
}

const INSTALLED = { outdated: false, downloadBytes: 0 }
const CATALOG: NativeToolCatalog = { tools: [
  { ...INSTALLED, id: 'cyberchef', name: 'CyberChef', category: 'web', version: '10.19.4', launchKind: 'web', status: 'ready', verified: false, missing: [] },
  { ...INSTALLED, id: 'ffmpeg', name: 'FFmpeg', category: 'misc', version: '7.1', launchKind: 'terminal', status: 'ready', verified: true, missing: [] },
  { ...INSTALLED, id: 'x64dbg', name: 'x64dbg', category: 'reverse', version: '2026-09-01', launchKind: 'desktop', status: 'ready', verified: true,
    missing: [], variants: [{ id: 'x32', name: 'x32dbg', status: 'ready' }] },
  { ...INSTALLED, id: '7zip', name: '7-Zip', category: 'misc', version: '25.01', launchKind: 'desktop', status: 'missing', verified: false, missing: ['7zFM.exe'] },
  { id: 'exiftool', name: 'ExifTool', category: 'misc', version: '13.30', launchKind: 'terminal', status: 'available', verified: false, missing: [],
    outdated: false, downloadBytes: 12_345_678 },
], preferences: { favorites: [], recent: [] }, catalogOutdated: false }

async function installCatalogFixture(page: Page): Promise<void> {
  // Only the native preload is substituted: Rainy's profile, rendering and Session routes remain real.
  await page.addInitScript((catalog: NativeToolCatalog) => {
    if (window.top !== window) return
    const storageKey = 'rainy-tool-catalog-fixture'
    const preferences = (): NativeToolPreferences => JSON.parse(localStorage.getItem(storageKey)
      ?? JSON.stringify(catalog.preferences)) as NativeToolPreferences
    const save = (value: NativeToolPreferences): void => { localStorage.setItem(storageKey, JSON.stringify(value)) }
    // Downloads survive reloads like the native installation does.
    const downloadedKey = 'rainy-tool-catalog-downloaded'
    const downloaded = new Set<string>(JSON.parse(localStorage.getItem(downloadedKey) ?? '[]') as string[])
    const operations: string[] = []
    Object.defineProperty(globalThis, '__RAINY_TOOL_OPERATIONS__', { value: operations })
    const bridge: NativeToolsBridge = {
      async checkToolUpdates() { return { phase: 'current', version: '1.0.0', error: '' } },
      async getDownloadState() { return { phase: operations.length ? 'complete' : 'idle', completedBytes: 0, totalBytes: 0, error: '' } },
      async installTools(ids) {
        operations.push(`install ${ids.join(',')}`)
        for (const id of ids) downloaded.add(id)
        localStorage.setItem(downloadedKey, JSON.stringify([...downloaded]))
      },
      async removeTool(id) { operations.push(`remove ${id}`) },
      async repairTools() { operations.push('repair') },
      async cancelDownload() {},
      onDownloadProgress() { return () => {} },
      async listTools() {
        return { ...catalog, preferences: preferences(), tools: catalog.tools.map(tool => downloaded.has(tool.id)
          ? { ...tool, status: 'ready' as const, downloadBytes: 0 } : tool) }
      },
      async setFavorites(favorites) { save({ ...preferences(), favorites }) },
      async launchTool(id: NativeToolId, variant?: 'x32') {
        if (id === 'x64dbg' && variant === undefined) return { ok: false, error: 'Fixture: debugger could not open' }
        const current = preferences()
        save({ ...current, recent: [id, ...current.recent.filter(entry => entry !== id)] })
        return { ok: true }
      },
    }
    Object.defineProperty(globalThis, '__RAINY_TOOLS__', { value: bridge })
  }, CATALOG)
}

describe.skipIf(MODE === 'record')('web e2e: Rainy CTF recorded conversation drafts', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const bootErrors: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      profile: { hmr: false, initialBundles: ['@deepseek-ai/dsh-rainy-desktop'], packages: [] },
      extraInstallAnchors: [join(RAINY_DIRECTORY, 'package.json')],
      welcomeNoticePending: true,
    })
    const fixture = await selectedSessionFixture(SOURCE_FIXTURE)
    await seedSession(scaffold, await readFile(fixture, 'utf8'), SEED_ID, undefined, { createdAt: Date.UTC(2026, 0, 1) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') bootErrors.push(message.text())
    })
    page.on('pageerror', (error) => { bootErrors.push(error.stack ?? error.message) })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    try { await page.locator('[data-rainy-topbar]').waitFor({ state: 'visible', timeout: 15000 }) }
    catch (error) { throw new Error(`Rainy UI boot failed:\n${await page.locator('body').innerText()}\n${bootErrors.join('\n')}`, { cause: error }) }
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('retains one frame on hide and restores the session draft after reloading the application', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-rainy-ctf'))
    const welcome = page.locator('[class*="onboardingOverlay"]')
    if (await welcome.count() > 0) {
      await welcome.getByRole('button').click()
      await welcome.waitFor({ state: 'detached' })
    }
    await page.locator('[data-rainy-topbar]').getByRole('button', { name: /^CTF/ }).click()
    await page.getByText(/Use common tools in the RainyAgent desktop app|在 RainyAgent 桌面应用中使用常用工具/, { exact: true }).waitFor({ state: 'visible' })
    expect(await page.locator('[data-rainy-ctf-workbench] iframe').count()).toBe(0)
    await page.getByRole('button', { name: /Hide CTF tools|收起 CTF 工具/ }).click()
    const blank = await openWorkbench(page)
    const standaloneSave = page.waitForResponse(response => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === '/rainy/icesky/state'
      && new URL(response.url()).searchParams.get('scope') === 'standalone' && response.status() === 200)
    await blank.locator('#transform-input').fill('Standalone fixture 普通文本')
    await standaloneSave
    const standalone = await page.request.get(`${scaffold.baseUrl}/rainy/icesky/state?scope=standalone`)
    expect(await standalone.json()).toMatchObject({ data: { tools: { transforms: { fields: { transformInput: 'Standalone fixture 普通文本' } } } } })
    await page.getByRole('button', { name: /Hide CTF tools|收起 CTF 工具/ }).click()
    await openRecordedConversation(page)
    const frame = await openWorkbench(page)
    const input = frame.locator('#transform-input')
    expect(await input.inputValue()).not.toBe('Standalone fixture 普通文本')
    const saved = page.waitForResponse(response => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === '/rainy/icesky/state' && response.status() === 200)
    await input.fill(DRAFT)
    await saved
    const draft = await page.request.get(`${scaffold.baseUrl}/rainy/icesky/state?scope=${encodeURIComponent(`session:${SEED_ID}`)}`)
    expect(draft.ok()).toBe(true)
    expect(await draft.json()).toMatchObject({ data: { tools: { transforms: { fields: { transformInput: DRAFT } } } } })
    await page.getByRole('button', { name: /Hide CTF tools|收起 CTF 工具/ }).click()
    const retained = await openWorkbench(page)
    expect(retained).toBe(frame)
    expect(await retained.locator('#transform-input').inputValue()).toBe(DRAFT)
    expect(await page.locator('[data-rainy-ctf-workbench] iframe').count()).toBe(1)
    const warningsBeforeReload = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await openRecordedConversation(page)
    const restored = await openWorkbench(page)
    await expect.poll(() => restored.locator('#transform-input').inputValue()).toBe(DRAFT)
    const count = await page.locator('[data-rainy-ctf-workbench] iframe').count()
    const reply = await page.getByText('LIGHTHOUSE', { exact: true }).innerText()
    const text = await restored.locator('#transform-input').inputValue()
    acknowledgeReloadConnectionLoss(tripwire, warningsBeforeReload)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    await page.locator('[data-rainy-topbar]').getByRole('button', { name: /^(View|视图)$/ }).click()
    await page.getByRole('menuitem', { name: /^(Focus editor|专注编辑)$/ }).click()
    await page.locator('[data-rainy-topbar]').getByRole('button', { name: /Show or hide AI assistant|显示或隐藏 AI 助手/ }).click()
    const retainedReply = await page.getByText('LIGHTHOUSE', { exact: true }).innerText()
    const reopened = await openWorkbench(page)
    expect(await reopened.locator('#transform-input').inputValue()).toBe(DRAFT)
    await mkdir(SNAPSHOT_DIRECTORY, { recursive: true })
    await compareOrRefreshGolden(join(SNAPSHOT_DIRECTORY, 'draft-recovery.expected.md'), [
      '# Rainy CTF recorded conversation draft', '',
      `- Recorded reply: ${reply}`,
      `- Retained workbench frames: ${count}`,
      `- Recorded reply after Focus editor: ${retainedReply}`,
      '- Restored text:', '', text,
    ].join('\n'), MODE)
    await assertFixtureInventory(SNAPSHOT_DIRECTORY, ['draft-recovery.expected.md'])
  })

  it('keeps native catalog preferences across conversations and reloads with an isolated preload fixture', async () => {
    const catalogPage = await newEnglishPage(browser, 850)
    onTestFailed(() => saveFailureShot(catalogPage, 'web-e2e-rainy-catalog'))
    try {
      await installCatalogFixture(catalogPage)
      await catalogPage.emulateMedia({ colorScheme: 'light' })
      await catalogPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await openRecordedConversation(catalogPage)
      await catalogPage.locator('[data-rainy-topbar]').getByRole('button', { name: /^CTF/ }).click()
      const directory = catalogPage.locator('[data-rainy-tool-catalog]')
      await directory.getByRole('heading', { name: 'CyberChef', exact: true }).waitFor({ state: 'visible' })
      expect(await catalogPage.locator('[data-rainy-ctf-workbench] iframe').count()).toBe(0)
      expect(await directory.getByRole('button', { name: /^(Open|打开) 7-Zip$/ }).isDisabled()).toBe(true)
      expect(await directory.locator('[data-tool-id="cyberchef"]').innerText()).toMatch(/Not verified|待验证/)
      const missingTool = directory.locator('[data-tool-id="7zip"]')
      const repairHint = await missingTool.getByText(/^(Download missing or damaged files again|重新下载缺失或损坏的文件)$/).innerText()
      await missingTool.getByRole('button', { name: /^(Repair|修复)$/ }).click()
      await expect.poll(() => catalogPage.evaluate(() => (globalThis as typeof globalThis & { __RAINY_TOOL_OPERATIONS__: string[] })
        .__RAINY_TOOL_OPERATIONS__.join(';'))).toBe('repair')
      const summary = await directory.getByText(/^(\d+ of \d+ tools downloaded|已下载 \d+ \/ \d+ 款工具)/).innerText()
      const pending = directory.locator('[data-tool-id="exiftool"]')
      const download = pending.getByRole('button', { name: /^(Download|下载) ExifTool$/ })
      const downloadLabel = await download.innerText()
      expect(await pending.getByRole('button', { name: /^(Open|打开) ExifTool$/ }).count()).toBe(0)
      if (EVIDENCE_DIRECTORY !== undefined) {
        await mkdir(EVIDENCE_DIRECTORY, { recursive: true })
        await catalogPage.screenshot({ path: join(EVIDENCE_DIRECTORY, 'catalog-repair-light.png') })
      }
      await download.click()
      await pending.getByRole('button', { name: /^(Open|打开) ExifTool$/ }).waitFor({ state: 'visible' })
      if (EVIDENCE_DIRECTORY !== undefined) {
        await mkdir(EVIDENCE_DIRECTORY, { recursive: true })
        await catalogPage.screenshot({ path: join(EVIDENCE_DIRECTORY, 'catalog-light.png') })
      }
      await directory.getByRole('button', { name: /^(Favorite|收藏) CyberChef$/ }).click()
      await directory.getByRole('button', { name: /^(Unfavorite|取消收藏) CyberChef$/ }).waitFor({ state: 'visible' })
      await directory.getByRole('button', { name: /^(Open|打开) CyberChef$/ }).click()
      const launchNotice = catalogPage.getByText(/^(Launch request sent for CyberChef|已发送 CyberChef 的启动请求)$/)
      await launchNotice.waitFor({ state: 'visible' })
      const launchFeedback = await launchNotice.innerText()
      await directory.getByRole('button', { name: /^(Open|打开) x64dbg$/ }).click()
      await catalogPage.getByText('Fixture: debugger could not open', { exact: true }).waitFor({ state: 'visible' })
      expect(await directory.getByRole('listitem').count()).toBe(5)
      await directory.getByRole('button', { name: /^(Reverse engineering|逆向调试)$/ }).click()
      expect(await directory.getByRole('heading').allTextContents()).toEqual(['x64dbg'])
      await directory.getByRole('button', { name: /^(All|全部)$/ }).click()
      await directory.getByRole('textbox').fill('ffprobe')
      expect(await directory.getByRole('heading').allTextContents()).toEqual(['FFmpeg'])
      await directory.getByRole('textbox').fill('')
      await directory.getByRole('button', { name: /^(Recent|最近使用)$/ }).click()
      expect(await directory.getByRole('heading').allTextContents()).toEqual(['CyberChef'])
      const agent = catalogPage.getByRole('complementary', { name: /^(AI assistant|AI 助手)$/ })
      if (!await agent.isVisible()) await catalogPage.locator('[data-rainy-topbar]')
        .getByRole('button', { name: /Show or hide AI assistant|显示或隐藏 AI 助手/ }).click()
      await agent
        .getByRole('button', { name: /^(New chat|新建对话)$/ }).click()
      expect(await directory.getByRole('heading').allTextContents()).toEqual(['CyberChef'])
      await catalogPage.setViewportSize({ width: 950, height: 850 })
      await closeHistoryDrawer(catalogPage)
      const overflow = await directory.evaluate(element => element.scrollWidth > element.clientWidth)
      expect(overflow).toBe(false)
      await directory.getByRole('button', { name: /^(All|全部)$/ }).click()
      const light = await directory.locator('[data-tool-id="cyberchef"]').evaluate(element => getComputedStyle(element).color)
      await catalogPage.emulateMedia({ colorScheme: 'dark' })
      await expect.poll(() => catalogPage.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
      const dark = await directory.locator('[data-tool-id="cyberchef"]').evaluate(element => getComputedStyle(element).color)
      expect(dark).not.toBe(light)
      await expect.poll(async () => {
        const tab = await catalogPage.locator('#rainy-tools-tab').evaluate(element => getComputedStyle(element).color)
        const text = await directory.evaluate(element => getComputedStyle(element).color)
        return tab === text
      }).toBe(true)
      if (EVIDENCE_DIRECTORY !== undefined) await catalogPage.screenshot({ path: join(EVIDENCE_DIRECTORY, 'catalog-dark-950.png') })
      await catalogPage.reload({ waitUntil: 'load' })
      await openRecordedConversation(catalogPage)
      await catalogPage.locator('[data-rainy-topbar]').getByRole('button', { name: /^CTF/ }).click()
      await directory.getByRole('button', { name: /^(Unfavorite|取消收藏) CyberChef$/ }).waitFor({ state: 'visible' })
      await directory.getByRole('button', { name: /^(Favorites|收藏)$/ }).click()
      const favorites = await directory.getByRole('heading').allTextContents()
      expect(favorites).toEqual(['CyberChef'])
      await directory.getByRole('button', { name: /^(Recent|最近使用)$/ }).click()
      const recent = await directory.getByRole('heading').allTextContents()
      expect(recent).toEqual(['CyberChef'])
      await mkdir(CATALOG_DIRECTORY, { recursive: true })
      await directory.getByRole('button', { name: /^(Check tool updates|检查工具更新)$/ }).click()
      await directory.getByText(/^(Tools are up to date|工具已是最新版本)$/).waitFor({ state: 'visible' })
      expect(await directory.getByRole('button', { name: /^(Download all|全部下载)/ }).count()).toBe(0)
      await compareOrRefreshGolden(join(CATALOG_DIRECTORY, 'common-tools.expected.md'), [
        '# Rainy common tools (native preload fixture)', '',
        '- Profile: Rainy desktop, with a recorded conversation',
        '- Common tools is the initial tab; IceSky frames before visiting: 0',
        `- Per-tool downloads: ${summary}`,
        `- Not downloaded entry: ExifTool — ${downloadLabel}; afterwards Open is available and Download all disappears`,
        '- Signed channel check: tools are up to date; installed catalog retained',
        '- Unverified entry: CyberChef — launch enabled',
        `- Launch feedback: ${launchFeedback}`,
        '- Missing entry: 7-Zip — launch disabled (7zFM.exe)',
        `- Missing entry repair: ${repairHint}; the repair request reaches the desktop`,
        '- Reverse filter: x64dbg',
        '- Search ffprobe: FFmpeg',
        '- Failed launch leaves all five tool rows visible',
        `- Favorites after reload: ${favorites.join(', ')}`,
        `- Recent after reload: ${recent.join(', ')}`,
        '- 950 px window: no horizontal directory overflow',
        '- Light and dark mode: native catalog follows the host palette',
      ].join('\n'), MODE)
    } catch (error) {
      await saveFailureShot(catalogPage, 'web-e2e-rainy-catalog')
      throw error
    } finally {
      await catalogPage.close()
    }
  })
})
