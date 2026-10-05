/** Rainy's real profile keeps its attribution readable beside the central editor and tools. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type Response } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const zh = {
  ideAddFolder: '添加文件夹到工作区', ideConfirm: '确认', ideExplorer: '文件', ideNewFile: '新建文件',
  models: '模型与上下文', extensions: 'Skills 与 MCP', settings: '设置',
  settingsBaseUrl: 'Base URL（从当前执行环境访问）', settingsContext: '实际上下文长度',
  settingsMemory: '项目记忆', settingsMemoryGenerate: '自动整理此项目的记忆', settingsMemoryUse: '自动读取项目记忆',
  settingsModelId: '模型 ID', settingsPreviewAttachments: '不包含尚未发送的草稿和附件。',
  settingsProvider: '供应商 ID', settingsSavedModels: '已保存的模型配置', settingsSaveModel: '保存并选为默认',
  settingsRuntimeKind: '运行方式', settingsLocalModel: '本地模型', settingsApiModel: 'API 模型',
} as const

const RAINY_DIRECTORY = fileURLToPath(new URL('../../rainy-desktop/', import.meta.url))
const EXPECTED_DIRECTORY = fileURLToPath(new URL('./expected/rainy-branding/', import.meta.url))
const EVIDENCE_DIRECTORY = process.env.RAINY_BRANDING_EVIDENCE_DIRECTORY
let scaffold: WebScaffold | undefined
let browser: Browser | undefined
let page: Page
let fixtureDirectory: string | undefined
let primaryDirectory: string
let attachedDirectory: string

function isControlResponse(response: Response, method: string, provider?: string): boolean {
  if (!response.url().endsWith('/rainy/control') || response.request().method() !== 'POST') return false
  const data: unknown = response.request().postDataJSON()
  if (data === null || typeof data !== 'object' || !('method' in data) || data.method !== method) return false
  if (provider === undefined) return true
  return 'params' in data && data.params !== null && typeof data.params === 'object'
    && 'provider' in data.params && data.params.provider === provider
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'rainy-branding-fixture-'))
  primaryDirectory = join(fixtureDirectory, 'Primary project')
  attachedDirectory = join(fixtureDirectory, 'Shared sources')
  await mkdir(primaryDirectory); await mkdir(attachedDirectory)
  await writeFile(join(primaryDirectory, 'same.txt'), 'primary source\n')
  await writeFile(join(attachedDirectory, 'same.txt'), 'attached source\n')
  const overlay = join(fixtureDirectory, 'profile.overlay.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'rainy-runtime', config: { dataRoot: join(fixtureDirectory, 'runtime'), carrierStateRoot: join(fixtureDirectory, 'carrier'), executionTargetId: 'windows-local' } },
    { id: 'rainy-memory', config: { carrierStateRoot: join(fixtureDirectory, 'carrier') } },
  ]))
  scaffold = await launchWebScaffold({
    profile: { hmr: false, initialBundles: ['@deepseek-ai/dsh-rainy-desktop'], packages: [] },
    extraInstallAnchors: [join(RAINY_DIRECTORY, 'package.json')],
    extraOverlayPath: overlay,
    rainyModelConfiguration: true,
  })
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 950, height: 760 }, locale: 'zh-CN' })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.locator('[data-rainy-topbar]').waitFor({ state: 'visible' })
})

afterAll(async () => {
  const failures: unknown[] = []
  try { await browser?.close() } catch (error) { failures.push(error) }
  try { await scaffold?.close() } catch (error) { failures.push(error) }
  try {
    if (fixtureDirectory !== undefined) await rm(fixtureDirectory, { recursive: true, force: true })
  } catch (error) { failures.push(error) }
  if (failures.length > 0) throw new AggregateError(failures, 'Rainy branding fixture cleanup failed')
})

it('keeps the attribution readable in a 400px AI pane while central tools open at narrow and wide window sizes', async () => {
  onTestFailed(() => saveFailureShot(page, 'web-e2e-rainy-branding'))
  if (scaffold === undefined) throw new Error('Rainy branding profile is not ready')
  const headline = page.locator('[class*="headline"]').filter({ hasText: 'RainyAgent' })
  const attribution = headline.getByText('Develop by NCUCyberBase', { exact: true })
  const agent = page.getByRole('complementary', { name: /^(AI assistant|AI 助手)$/ })
  await mkdir(EXPECTED_DIRECTORY, { recursive: true })
  await compareOrRefreshGolden(join(EXPECTED_DIRECTORY, 'workspace-controls.expected.md'),
    await captureStableAria(page, '[data-rainy-topbar]', scaffold.workspaceCwd), webSnapshotMode())
  await page.locator('[data-rainy-topbar]').getByRole('button', { name: /Show or hide AI assistant|显示或隐藏 AI 助手/ }).click()
  await attribution.waitFor({ state: 'visible' })
  expect(await page.title()).toBe('RainyAgent')
  expect(await headline.getByText('预览版', { exact: true }).count()).toBe(0)
  await mkdir(EXPECTED_DIRECTORY, { recursive: true })
  await compareOrRefreshGolden(join(EXPECTED_DIRECTORY, 'hero.expected.md'),
    await captureStableAria(page, '[class*="headline"]', scaffold.workspaceCwd), webSnapshotMode())
  const observations = []
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe(colorScheme === 'dark' ? '' : null)
    for (const windowWidth of [950, 1380]) {
      await page.setViewportSize({ width: windowWidth, height: 760 })
      await expect.poll(() => agent.evaluate(element => element.getBoundingClientRect().width)).toBe(400)
      const headlineWidth = await headline.evaluate(element => element.clientWidth)
      for (const toolsOpen of [false, true]) {
        if (toolsOpen) {
          await page.locator('[data-rainy-topbar]').getByRole('button', { name: 'CTF 工具', exact: true }).click()
          await page.locator('[data-rainy-ctf-workbench]').waitFor({ state: 'visible' })
          await expect.poll(() => agent.evaluate(element => element.getBoundingClientRect().width)).toBe(400)
          await expect.poll(() => headline.evaluate(element => element.clientWidth)).toBe(headlineWidth)
          const toolBounds = await page.locator('[data-rainy-ctf-workbench]').boundingBox()
          const agentBounds = await agent.boundingBox()
          expect(toolBounds).not.toBeNull()
          expect(agentBounds).not.toBeNull()
          if (toolBounds !== null && agentBounds !== null) expect(toolBounds.x + toolBounds.width).toBeLessThanOrEqual(agentBounds.x + 1)
        }
        await expect.poll(() => headline.evaluate((element) => {
          const parent = element.getBoundingClientRect()
          return [...element.querySelectorAll('span, img')].every((child) => {
            const rect = child.getBoundingClientRect()
            return rect.left >= parent.left - 1 && rect.right <= parent.right + 1
          }) && element.scrollWidth <= element.clientWidth + 1
        })).toBe(true)
        const measure = await headline.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }))
        observations.push({ colorScheme, windowWidth, toolsOpen, ...measure, documentTitle: await page.title() })
        if (EVIDENCE_DIRECTORY !== undefined) {
          await mkdir(EVIDENCE_DIRECTORY, { recursive: true })
          await page.screenshot({ path: join(EVIDENCE_DIRECTORY, `hero-${colorScheme}-${windowWidth}-${toolsOpen ? 'tools' : 'editor'}.png`) })
        }
        if (toolsOpen) {
          await page.getByRole('button', { name: '收起 CTF 工具', exact: true }).click()
          await expect.poll(() => headline.evaluate(element => element.clientWidth)).toBe(headlineWidth)
        }
      }
    }
  }
  if (EVIDENCE_DIRECTORY !== undefined) {
    await writeFile(join(EVIDENCE_DIRECTORY, 'layout.json'), `${JSON.stringify(observations, null, 2)}\n`)
  }
})

it('opens the chosen project, attaches an independent directory, and keeps all settings in one themed dialog', async () => {
  onTestFailed(() => saveFailureShot(page, 'web-e2e-rainy-project-settings'))
  const pick = async (path: string): Promise<void> => {
    const picker = page.getByRole('dialog', { name: '选择工作区目录', exact: true })
    await picker.getByRole('button', { name: '编辑路径', exact: true }).click()
    await picker.getByRole('textbox', { name: '编辑路径', exact: true }).fill(path)
    await picker.getByRole('textbox', { name: '编辑路径', exact: true }).press('Enter')
    await picker.getByRole('button', { name: '打开', exact: true }).click()
    await picker.waitFor({ state: 'hidden' })
  }
  await page.getByRole('button', { name: zh.ideAddFolder, exact: true }).click()
  await pick(primaryDirectory)
  const tree = page.getByRole('tree', { name: zh.ideExplorer, exact: true })
  await tree.getByText('same.txt', { exact: true }).waitFor()
  await page.getByRole('button', { name: zh.ideAddFolder, exact: true }).click()
  await pick(attachedDirectory)
  await expect.poll(() => tree.getByText('same.txt', { exact: true }).count()).toBe(2)
  await tree.getByRole('button', { name: 'Shared sources', exact: true }).click()
  await page.getByRole('button', { name: zh.ideNewFile, exact: true }).click()
  const create = page.getByRole('dialog', { name: zh.ideNewFile, exact: true })
  await create.getByRole('textbox').fill('new.txt')
  await create.getByRole('button', { name: zh.ideConfirm, exact: true }).click()
  await expect.poll(() => readFile(join(attachedDirectory, 'new.txt'), 'utf8')).toBe('')
  await expect(readFile(join(primaryDirectory, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await page.reload({ waitUntil: 'load' })
  await expect.poll(() => tree.getByText('same.txt', { exact: true }).count()).toBe(2)
  await page.locator('[data-rainy-topbar]').getByRole('button', { name: zh.settings, exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.locator('[data-rainy-settings="models"]').waitFor()
  expect(await page.getByRole('dialog').count()).toBe(1)
  expect(await settings.getByRole('button', { name: '授权', exact: true }).count()).toBe(0)
  if (scaffold === undefined) throw new Error('Rainy profile is not ready')
  await compareOrRefreshGolden(join(EXPECTED_DIRECTORY, 'settings-navigation.expected.md'),
    await captureStableAria(page, '[data-shortcut-modal="settings"] nav', scaffold.workspaceCwd), webSnapshotMode())
  const sessionsBeforePreview = scaffold.ctx.agents.list().length
  const contextField = '[data-rainy-settings="models"] label:has(input[type="number"])'
  await compareOrRefreshGolden(join(EXPECTED_DIRECTORY, 'local-context-default.expected.md'),
    await captureStableAria(page, contextField, scaffold.workspaceCwd), webSnapshotMode())
  await settings.getByRole('button', { name: zh.settingsRuntimeKind, exact: true }).click()
  await page.getByRole('menuitem', { name: zh.settingsApiModel, exact: true }).click()
  expect(await settings.getByLabel(zh.settingsContext, { exact: true }).inputValue()).toBe('1000000')
  await compareOrRefreshGolden(join(EXPECTED_DIRECTORY, 'api-context-default.expected.md'),
    await captureStableAria(page, contextField, scaffold.workspaceCwd), webSnapshotMode())
  await settings.getByRole('button', { name: zh.settingsRuntimeKind, exact: true }).click()
  await page.getByRole('menuitem', { name: zh.settingsLocalModel, exact: true }).click()
  await settings.getByLabel(zh.settingsProvider, { exact: true }).fill('preview-fixture')
  await settings.getByLabel(zh.settingsBaseUrl, { exact: true }).fill('http://127.0.0.1:9/v1')
  await settings.getByLabel(zh.settingsModelId, { exact: true }).fill('small-model')
  expect(await settings.getByLabel(zh.settingsContext, { exact: true }).inputValue()).toBe('100000')
  const configuredResponse = page.waitForResponse(response => isControlResponse(response, 'configure-model'))
  const previewResponse = page.waitForResponse(response => isControlResponse(response, 'preview-budget', 'preview-fixture'))
  await settings.getByRole('button', { name: zh.settingsSaveModel, exact: true }).click()
  expect(await (await configuredResponse).json()).toEqual({ result: { provider: 'preview-fixture', model: 'small-model' } })
  expect(await (await previewResponse).json()).toMatchObject({ result: { preview: true, model: 'small-model', contextWindow: 100000 } })
  await settings.getByText(zh.settingsPreviewAttachments, { exact: true }).waitFor()
  expect(await settings.getByRole('alert').count()).toBe(0)
  expect(scaffold.ctx.agents.list()).toHaveLength(sessionsBeforePreview)
  await settings.getByRole('heading', { name: zh.models, exact: true }).scrollIntoViewIfNeeded()
  if (EVIDENCE_DIRECTORY !== undefined) await page.screenshot({ path: join(EVIDENCE_DIRECTORY, 'first-message-budget.png') })
  const colors: string[] = []
  for (const appearance of ['深色', '浅色']) {
    await settings.getByRole('button', { name: '通用设置', exact: true }).click()
    await settings.getByRole('button', { name: appearance, exact: true }).click()
    await settings.getByRole('button', { name: zh.models, exact: true }).click()
    await settings.getByRole('button', { name: zh.settingsSavedModels, exact: true }).click()
    const menu = page.getByRole('menu')
    await menu.waitFor()
    colors.push(await menu.locator('[class*="material"]').evaluate(element => getComputedStyle(element).backgroundColor))
    if (EVIDENCE_DIRECTORY !== undefined) await page.screenshot({ path: join(EVIDENCE_DIRECTORY, `settings-menu-${appearance === '深色' ? 'dark' : 'light'}.png`) })
    await page.keyboard.press('Escape')
    expect(await settings.count()).toBe(1)
  }
  expect(colors[0]).not.toBe(colors[1])
  await settings.getByRole('button', { name: zh.extensions, exact: true }).click()
  await settings.locator('[data-rainy-settings="extensions"]').waitFor()
  expect(await page.getByRole('dialog').count()).toBe(1)
  await settings.getByRole('button', { name: zh.settingsMemory, exact: true }).click()
  const memoryRead = settings.getByLabel(zh.settingsMemoryUse, { exact: true })
  await memoryRead.waitFor()
  await memoryRead.click()
  await expect.poll(async () => [await memoryRead.isEnabled(), await memoryRead.isChecked()]).toEqual([true, false])
  expect(await settings.getByLabel(zh.settingsMemoryGenerate, { exact: true }).isChecked()).toBe(true)
  await memoryRead.click()
  await expect.poll(async () => [await memoryRead.isEnabled(), await memoryRead.isChecked()]).toEqual([true, true])
  if (EVIDENCE_DIRECTORY !== undefined) await page.screenshot({ path: join(EVIDENCE_DIRECTORY, 'unified-project-settings.png') })
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
})
