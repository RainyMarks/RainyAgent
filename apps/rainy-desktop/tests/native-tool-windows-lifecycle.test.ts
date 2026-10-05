import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { BrowserWindow } from 'electron'
import { NativeToolsLibrary } from '../src/native-tools.ts'
import { installNativeTools } from '../src/native-tool-windows.ts'

const control = vi.hoisted(() => ({
  windows: [] as Array<{ destroy(): void }>, release: Promise.withResolvers<undefined>(),
  pageClose: vi.fn<() => Promise<void>>(),
  handle: vi.fn<Electron.IpcMain['handle']>(),
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    private destroyed = false
    readonly webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: 'http://127.0.0.1:43210/' },
      setWindowOpenHandler: vi.fn(), session: { setPermissionRequestHandler: vi.fn() },
    })
    constructor() { super(); control.windows.push(this) }
    setMenu() {}
    async loadURL() {}
    show() {}
    isDestroyed() { return this.destroyed }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
  }
  return { BrowserWindow: Window, ipcMain: { handle: control.handle, removeHandler: vi.fn() } }
})

vi.mock('../src/native-tool-web.ts', () => ({
  serveNativeTool: async () => ({ origin: 'http://127.0.0.1:43211', url: 'http://127.0.0.1:43211/index.html', close: control.pageClose }),
}))

let fixture: string
let owner: ReturnType<typeof installNativeTools> | undefined

beforeEach(async () => {
  vi.clearAllMocks()
  control.windows.length = 0
  control.release = Promise.withResolvers<undefined>()
  control.pageClose.mockImplementation(() => control.release.promise)
  fixture = await mkdtemp(join(tmpdir(), 'rainy-window-close-'))
  await mkdir(join(fixture, 'tools/cyberchef'), { recursive: true })
  await writeFile(join(fixture, 'tools/cyberchef/index.html'), '<html>offline</html>')
  await writeFile(join(fixture, 'tools/manifest.json'), JSON.stringify({ version: 1, tools: [{
    id: 'cyberchef', category: 'web', name: 'CyberChef', version: 'test', roots: ['tools/cyberchef'],
    entry: { kind: 'web', path: 'tools/cyberchef/index.html', cwd: 'tools/cyberchef', args: [] },
  }] }))
})

afterEach(async () => {
  control.release.resolve(undefined)
  await owner?.close()
  owner = undefined
  vi.restoreAllMocks()
  if (relative(tmpdir(), fixture).startsWith('..')) throw new Error('Fixture cleanup escaped the temporary directory')
  await rm(fixture, { recursive: true, force: true })
})

it('keeps cleanup owned after a tool window has emitted closed', async () => {
  const main = new BrowserWindow({})
  owner = installNativeTools({ window: main, origin: 'http://127.0.0.1:43210', installRoot: fixture, userData: join(fixture, 'user') })
  const launch = control.handle.mock.calls.find(([name]) => name === 'rainy:tools-launch')?.[1]
  if (!launch) throw new Error('Missing launch handler')
  const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame } as Electron.IpcMainInvokeEvent
  expect(await launch(event, { id: 'cyberchef' })).toEqual({ ok: true })
  const tool = control.windows[1]
  if (!tool) throw new Error('Missing tool window fixture')
  tool.destroy()
  expect(control.pageClose).toHaveBeenCalledOnce()
  const idle = Promise.withResolvers<undefined>()
  // Called with the library receiver below so the real pending queue still drains.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalWait = NativeToolsLibrary.prototype.waitForIdle
  vi.spyOn(NativeToolsLibrary.prototype, 'waitForIdle').mockImplementation(async function (this: NativeToolsLibrary) {
    await originalWait.call(this)
    idle.resolve(undefined)
  })
  let completed = false
  const closing = owner.close().then(() => { completed = true })
  await idle.promise
  await new Promise<undefined>((resolve) => { setImmediate(() => { resolve(undefined) }) })
  expect(completed).toBe(false)
  control.release.resolve(undefined)
  await closing
  expect(completed).toBe(true)
})

it('refuses native-tool requests from an untrusted frame', async () => {
  const main = new BrowserWindow({})
  owner = installNativeTools({ window: main, origin: 'http://127.0.0.1:43210', installRoot: fixture, userData: join(fixture, 'user') })
  const launch = control.handle.mock.calls.find(([name]) => name === 'rainy:tools-launch')?.[1]
  if (!launch) throw new Error('Missing launch handler')
  const event = { sender: main.webContents, senderFrame: null } as Electron.IpcMainInvokeEvent
  await expect(launch(event, { id: 'cyberchef' })).rejects.toThrow('工具请求来源无效')
  expect(control.windows).toHaveLength(1)
  expect(control.pageClose).not.toHaveBeenCalled()
})
