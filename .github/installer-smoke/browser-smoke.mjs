/** The installed carrier's own CDP page supplies authentication, version, and native status. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This installation smoke runs only in the fixed hosted job')
const [dataArgument, evidenceArgument] = process.argv.slice(2)
assert(dataArgument && evidenceArgument)
const data = resolve(dataArgument)
const evidence = resolve(evidenceArgument)
const expected = JSON.parse(await readFile(new URL('./artifact.json', import.meta.url), 'utf8'))
const [port, endpoint] = (await readFile(join(data, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/u)
assert(/^\d+$/u.test(port) && endpoint.startsWith('/devtools/browser/'))
const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`)
const report = { passed: false, version: expected.version, checks: [], pageErrors: [], consoleErrorCount: 0 }
let page
let primaryFailure
try {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('http://127.0.0.1:'))
    if (page) break
    assert(browser.isConnected(), 'Carrier closed before the native Host page appeared')
    await new Promise(accept => setTimeout(accept, 100))
  }
  assert(page, 'The installed native Host did not expose its authenticated workbench')
  page.setDefaultTimeout(60000)
  page.on('pageerror', error => report.pageErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') report.consoleErrorCount++ })
  await page.locator('[data-rainy-topbar]').waitFor()
  assert.equal(await page.evaluate(() => globalThis.__RAINY_AGENT__?.version), expected.version)
  assert.equal(await page.evaluate(() => '__RAINY_LICENSE__' in globalThis), false)
  const target = await page.evaluate(() => globalThis.__RAINY_RUNTIME_NATIVE__.targets())
  assert.equal(target.current.kind, 'windows')
  const response = await page.context().request.get(new URL('/', page.url()).href)
  assert.equal(response.status(), 200)
  assert(response.headers()['content-type']?.includes('text/html'))
  assert((await response.text()).includes('<html'), 'The installed Host did not serve the real frontend HTML')
  const control = await page.context().request.get(new URL('/rainy/control', page.url()).href)
  assert.equal(control.status(), 200)
  assert(Array.isArray((await control.json()).models), 'The current authenticated Host control route is unavailable')
  report.checks.push('installed Windows Host serves authenticated HTML and control routes')
  report.checks.push('real workbench publishes version 1.0.0 without an activation bridge')
  const strata = await page.evaluate(() => globalThis.__RAINY_STRATA_NATIVE__.status())
  assert.equal(strata.runtime.available, true)
  assert.equal(strata.runtime.version, '0.1.39')
  assert.equal(strata.phase, 'unconfigured')
  assert.equal(strata.settings.modelPath, '')
  assert.equal(strata.model, null)
  assert.equal(strata.server, null)
  report.checks.push('bundled Strata is present without loading weights or creating a model service')
  await page.locator('[data-rainy-topbar]').getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '通用设置', exact: true }).click()
  await settings.getByText(`当前版本：${expected.version}`, { exact: true }).waitFor()
  assert.equal(await settings.getByRole('button', { name: '授权', exact: true }).count(), 0)
  await page.screenshot({ path: join(evidence, 'installed-version.png') })
  await page.keyboard.press('Escape')
  report.checks.push('the installed General Settings displays 1.0.0 without activation controls')
  assert.deepEqual(report.pageErrors, [])
  assert.equal(report.consoleErrorCount, 0)
  report.passed = true
} catch (error) {
  primaryFailure = error
  report.failure = error instanceof Error ? error.message : String(error)
  if (page && !page.isClosed()) {
    try { await page.screenshot({ path: join(evidence, 'failure.png') }) }
    catch (captureError) { report.captureFailure = captureError instanceof Error ? captureError.message : String(captureError) }
  }
  throw error
} finally {
  // The parent runner verifies process exit; retain transport diagnostics without replacing the primary failure.
  if (page && !page.isClosed()) {
    try { await page.evaluate(() => { window.close() }) }
    catch (closeError) { report.closeFailure = closeError instanceof Error ? closeError.message : String(closeError) }
  }
  try { await browser.close() }
  catch (disconnectError) { report.disconnectFailure = disconnectError instanceof Error ? disconnectError.message : String(disconnectError) }
  try { await writeFile(join(evidence, 'browser.json'), JSON.stringify(report, null, 2) + '\n') }
  catch (writeError) {
    if (primaryFailure === undefined) throw writeError
    console.error('Could not save browser diagnostics:', writeError)
  }
}
