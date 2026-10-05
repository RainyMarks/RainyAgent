import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { installNativeToolPack, ToolPackInstallError } from '../src/toolpack.ts'
import { runToolPackMaintenance } from '../src/toolpack-maintenance.ts'

const control = vi.hoisted(() => ({ executable: '' }))
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => control.executable },
  BrowserWindow: function () { throw new Error('Silent maintenance must not open a window') },
  ipcMain: { removeHandler: vi.fn() },
}))
vi.mock('../src/toolpack.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/toolpack.ts')>(), installNativeToolPack: vi.fn(),
}))

let fixture: string
let installRoot: string
let outside: string
let resourcesDescriptor: PropertyDescriptor | undefined

beforeEach(async () => {
  vi.resetAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fixture = await mkdtemp(join(tmpdir(), 'rainy-maintenance-'))
  installRoot = join(fixture, 'install')
  outside = join(fixture, 'outside')
  control.executable = join(installRoot, 'RainyAgent.exe')
  resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: join(installRoot, 'resources') })
  await mkdir(installRoot)
  await mkdir(outside)
})

afterEach(async () => {
  if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor)
  else Reflect.deleteProperty(process, 'resourcesPath')
  vi.restoreAllMocks()
  if (relative(tmpdir(), fixture).startsWith('..')) throw new Error('Fixture cleanup escaped the temporary directory')
  await rm(fixture, { recursive: true, force: true })
})

it('rejects a linked report directory before installation and leaves its destination intact', async () => {
  await writeFile(join(outside, 'install-result.json'), 'original result')
  await writeFile(join(outside, 'install-error.log'), 'original error')
  await symlink(outside, join(installRoot, '.rainy-toolpack'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(await runToolPackMaintenance(fixture, true)).toBe(1)
  expect(installNativeToolPack).not.toHaveBeenCalled()
  expect(await readFile(join(outside, 'install-result.json'), 'utf8')).toBe('original result')
  expect(await readFile(join(outside, 'install-error.log'), 'utf8')).toBe('original error')
})

it('preserves cancellation status when both report destinations are hard links', async () => {
  const stateRoot = join(installRoot, '.rainy-toolpack')
  await mkdir(stateRoot)
  for (const name of ['install-result.json', 'install-error.log']) {
    await writeFile(join(outside, name), `original ${name}`)
    await link(join(outside, name), join(stateRoot, name))
  }
  vi.mocked(installNativeToolPack).mockRejectedValue(new ToolPackInstallError('cancelled', 'cancelled by user'))
  expect(await runToolPackMaintenance(fixture, true)).toBe(3)
  expect(installNativeToolPack).toHaveBeenCalledOnce()
  for (const name of ['install-result.json', 'install-error.log']) {
    expect(await readFile(join(outside, name), 'utf8')).toBe(`original ${name}`)
    expect(await readFile(join(stateRoot, name), 'utf8')).toBe(`original ${name}`)
  }
})
