/** Adapt native file references to the selected WSL Host without exposing Electron APIs. */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { installWindowChrome } from './preload-chrome.ts'
import type { EnvironmentAction, EnvironmentSnapshot } from './environment.ts'
import type { NativeToolCatalog, NativeToolId, NativeToolLaunchResult } from '@deepseek-ai/dsh-client-ui-rainy/native-tools-protocol'
import type { ToolPackWindowProgress } from './toolpack-maintenance.ts'
import type { IdeNativeDirectory } from './ide-native.ts'
import type { IdeEnvironmentAction, IdeEnvironmentSnapshot } from './ide-environment.ts'
import type { StrataNativeHost, StrataModelPicker, StrataSettings } from '@deepseek-ai/dsh-client-ui-rainy/strata-protocol'


const toolpackArgument = process.argv.find(value => value.startsWith('--rainy-toolpack-page='))
const toolpackPage = toolpackArgument === undefined ? undefined : decodeURIComponent(toolpackArgument.slice('--rainy-toolpack-page='.length))
if (process.isMainFrame && toolpackPage !== undefined && location.href === toolpackPage) {
  contextBridge.exposeInMainWorld('__RAINY_TOOLPACK__', {
    getProgress: (): Promise<ToolPackWindowProgress> => ipcRenderer.invoke('rainy:toolpack-status'),
    cancel: (): Promise<void> => ipcRenderer.invoke('rainy:toolpack-cancel'),
    onProgress(listener: (snapshot: ToolPackWindowProgress) => void): () => void {
      const receive = (_event: Electron.IpcRendererEvent, snapshot: ToolPackWindowProgress): void => { listener(snapshot) }
      ipcRenderer.on('rainy:toolpack-progress', receive)
      return () => { ipcRenderer.removeListener('rainy:toolpack-progress', receive) }
    },
  })
}

const setupArgument = process.argv.find(value => value.startsWith('--rainy-setup-page='))
const setupPage = setupArgument === undefined ? undefined : decodeURIComponent(setupArgument.slice('--rainy-setup-page='.length))
if (process.isMainFrame && setupPage !== undefined && location.href === setupPage) {
  contextBridge.exposeInMainWorld('__RAINY_ENVIRONMENT__', {
    inspect: (): Promise<EnvironmentSnapshot> => ipcRenderer.invoke('rainy:environment-inspect'),
    act: (action: EnvironmentAction): Promise<EnvironmentSnapshot> => ipcRenderer.invoke('rainy:environment-act', action),
    onProgress(listener: (snapshot: EnvironmentSnapshot) => void): () => void {
      const receive = (_event: Electron.IpcRendererEvent, snapshot: EnvironmentSnapshot): void => { listener(snapshot) }
      ipcRenderer.on('rainy:environment-progress', receive)
      return () => { ipcRenderer.removeListener('rainy:environment-progress', receive) }
    },
  })
}

const ideSetupArgument = process.argv.find(value => value.startsWith('--rainy-ide-environment-page='))
const ideSetupPage = ideSetupArgument === undefined ? undefined : decodeURIComponent(ideSetupArgument.slice('--rainy-ide-environment-page='.length))
if (process.isMainFrame && ideSetupPage !== undefined && location.href === ideSetupPage) {
  contextBridge.exposeInMainWorld('__RAINY_IDE_ENVIRONMENT__', {
    inspect: (): Promise<IdeEnvironmentSnapshot> => ipcRenderer.invoke('rainy:ide-environment-inspect'),
    act: (action: IdeEnvironmentAction): Promise<IdeEnvironmentSnapshot> => ipcRenderer.invoke('rainy:ide-environment-act', action),
    close: (): Promise<void> => ipcRenderer.invoke('rainy:ide-environment-close'),
    onProgress(listener: (snapshot: IdeEnvironmentSnapshot) => void): () => void {
      const receive = (_event: Electron.IpcRendererEvent, snapshot: IdeEnvironmentSnapshot): void => { listener(snapshot) }
      ipcRenderer.on('rainy:ide-environment-progress', receive)
      return () => { ipcRenderer.removeListener('rainy:ide-environment-progress', receive) }
    },
  })
}

if (process.isMainFrame && location.protocol === 'http:' && location.hostname === '127.0.0.1') {
  if (process.platform === 'win32') installWindowChrome()
  contextBridge.exposeInMainWorld('__DSH_HOST_PATHS__', {
    pathFor(file: File): string {
      const path = webUtils.getPathForFile(file)
      return path ? String(ipcRenderer.sendSync('rainy:path', path) ?? '') : ''
    },
  })
  contextBridge.exposeInMainWorld('__RAINY_IDE_NATIVE__', {
    selectDirectory: (): Promise<IdeNativeDirectory | null> => ipcRenderer.invoke('rainy:ide-directory'),
    prepareDevelopmentTools: (): Promise<void> => ipcRenderer.invoke('rainy:ide-prepare-development'),
  })
  contextBridge.exposeInMainWorld('__RAINY_STRATA_NATIVE__', {
    status: () => ipcRenderer.invoke('rainy:strata-status'),
    save: (settings: StrataSettings) => ipcRenderer.invoke('rainy:strata-save', settings),
    start: () => ipcRenderer.invoke('rainy:strata-start'),
    stop: () => ipcRenderer.invoke('rainy:strata-stop'),
    selectModel: (kind: StrataModelPicker) => ipcRenderer.invoke('rainy:strata-select-model', kind),
    connect: () => ipcRenderer.invoke('rainy:strata-connect'),
  } satisfies StrataNativeHost)
  contextBridge.exposeInMainWorld('__RAINY_RUNTIME_NATIVE__', {
    targets: () => ipcRenderer.invoke('rainy:runtime-targets'),
    switchTarget: (request: { targetId: string; workspaceId?: string }) => ipcRenderer.invoke('rainy:runtime-switch', request),
    prepare: (): Promise<void> => ipcRenderer.invoke('rainy:ide-prepare-development'),
    onProgress: (listener: (message: string) => void): (() => void) => {
      const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => {
        if (value !== null && typeof value === 'object' && 'message' in value && typeof value.message === 'string') listener(value.message)
      }
      ipcRenderer.on('rainy:component-progress', receive)
      return () => { ipcRenderer.removeListener('rainy:component-progress', receive) }
    },
  })
  contextBridge.exposeInMainWorld('__RAINY_TOOLS__', {
    listTools: (): Promise<NativeToolCatalog> => ipcRenderer.invoke('rainy:tools-list'),
    launchTool: (id: NativeToolId, variant?: 'x32'): Promise<NativeToolLaunchResult> => ipcRenderer.invoke('rainy:tools-launch', { id, ...variant === undefined ? {} : { variant } }),
    setFavorites: (ids: readonly NativeToolId[]): Promise<void> => ipcRenderer.invoke('rainy:tools-favorites', ids),
  })
  const saves = new Set<() => Promise<{ readonly ok: boolean; readonly error?: string }>>()
  contextBridge.exposeInMainWorld('__RAINY_WORKBENCH__', {
    onFlush(flush: () => Promise<{ readonly ok: boolean; readonly error?: string }>): () => void {
      saves.add(flush)
      return () => { saves.delete(flush) }
    },
  })
  const flush = async (_event: Electron.IpcRendererEvent, id: unknown): Promise<void> => {
    if (typeof id !== 'string') return
    try {
      const results = await Promise.all([...saves].map(save => save()))
      const failure = results.find(result => !result.ok)
      ipcRenderer.send('rainy:workbench-flushed', { id, ...(failure ?? { ok: true }) })
    } catch (error) {
      ipcRenderer.send('rainy:workbench-flushed', { id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const handleFlush = (event: Electron.IpcRendererEvent, id: unknown): void => { void flush(event, id) }
  ipcRenderer.on('rainy:flush-workbench', handleFlush)
  window.addEventListener('unload', () => { ipcRenderer.removeListener('rainy:flush-workbench', handleFlush); saves.clear() }, { once: true })
}
