/** Native tool windows and the trusted desktop catalog bridge. */
import { BrowserWindow, ipcMain } from 'electron'
import { NativeToolsLibrary, parseNativeFavorites, parseNativeLaunch } from './native-tools.ts'
import { startNativeProcess } from './native-tool-process.ts'
import { serveNativeTool, type NativeToolWebPage } from './native-tool-web.ts'

/**
 * Attach human tool operations to one authenticated main window.
 * @param options - main window, authenticated Host origin, and installed tool paths.
 * @returns complete cleanup of IPC handlers and owned offline webpage servers.
 */
export function installNativeTools(options: {
  readonly window: BrowserWindow
  readonly origin: string
  readonly installRoot: string
  readonly userData: string
}): { close(): Promise<void> } {
  const webpages = new Map<BrowserWindow, NativeToolWebPage>()
  const closingPages = new Set<Promise<void>>()
  let closed = false
  const isClosed = (): boolean => closed
  const closePage = (page: NativeToolWebPage): Promise<void> => {
    const closing = page.close()
    closingPages.add(closing)
    void closing.catch((error: unknown) => { console.error('Offline tool resource cleanup failed', error) }).finally(() => { closingPages.delete(closing) })
    return closing
  }
  const library = new NativeToolsLibrary({ installRoot: options.installRoot, userData: options.userData,
    start: async (invocation) => {
      if (isClosed()) throw new Error('RainyAgent 正在关闭')
      if (invocation.kind !== 'web') {
        await startNativeProcess(invocation, globalThis.process.env)
        return
      }
      const page = await serveNativeTool(invocation)
      if (isClosed()) { await page.close(); throw new Error('RainyAgent 正在关闭') }
      const window = new BrowserWindow({ title: invocation.name, width: 1240, height: 860, minWidth: 700, minHeight: 500,
        show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
          partition: `rainy-tool-${invocation.id}`, spellcheck: false } })
      window.setMenu(null)
      webpages.set(window, page)
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== page.origin) event.preventDefault() })
      window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => { callback(permission === 'clipboard-sanitized-write') })
      window.on('closed', () => { webpages.delete(window); void closePage(page) })
      try { await window.loadURL(page.url); window.show() }
      catch (error) { if (!window.isDestroyed()) window.destroy(); await page.close(); throw error }
    },
  })
  const trusted = (event: Electron.IpcMainInvokeEvent): void => {
    if (closed || event.sender !== options.window.webContents || event.senderFrame !== options.window.webContents.mainFrame
      || new URL(event.senderFrame.url).origin !== options.origin) throw new Error('工具请求来源无效')
  }
  ipcMain.handle('rainy:tools-list', async (event) => { trusted(event); return library.listTools() })
  ipcMain.handle('rainy:tools-launch', async (event, value: unknown) => { trusted(event); const request = parseNativeLaunch(value); return library.launchTool(request.id, request.variant) })
  ipcMain.handle('rainy:tools-favorites', async (event, value: unknown) => { trusted(event); await library.setFavorites(parseNativeFavorites(value)) })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closing) return closing
    closed = true
    ipcMain.removeHandler('rainy:tools-list')
    ipcMain.removeHandler('rainy:tools-launch')
    ipcMain.removeHandler('rainy:tools-favorites')
    closing = Promise.resolve().then(async () => {
      const owned = [...webpages]
      webpages.clear()
      for (const [window] of owned) if (!window.isDestroyed()) window.destroy()
      await library.waitForIdle()
      const results = await Promise.allSettled([...owned.map(([, page]) => page.close()), ...closingPages])
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map((result): unknown => result.reason), 'Offline tool resources did not finish closing')
    })
    return closing
  }
  options.window.on('closed', () => { void close().catch((error: unknown) => { console.error('Native tool window cleanup failed', error) }) })
  return { close }
}
