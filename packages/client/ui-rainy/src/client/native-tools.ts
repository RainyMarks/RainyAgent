/** User-level tool directory state; native operations never enter the Session log. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { NativeToolCatalog, NativeToolId, NativeToolsBridge } from '../native-tools-protocol.ts'

/** Retained directory state and in-flight operations. */
export interface NativeToolsState extends NativeToolCatalog {
  readonly phase: 'desktop-only' | 'idle' | 'loading' | 'ready' | 'error'
  readonly error: string
  readonly pending: readonly NativeToolId[]
  readonly savingFavorites: boolean
}

/** Localized outcomes are supplied by the registered locale owner. */
export interface NativeToolsCopy {
  readonly opened: (name: string) => string
  readonly launchFailed: (name: string) => string
  readonly favoritesFailed: () => string
  readonly favoriteSaved: (selected: boolean) => string
}

/** Owns requests independently of a visible catalog panel. */
export class NativeToolsController {
  readonly state
  private disposed = false
  private loading: Promise<void> | undefined

  /**
   * @param bridge - desktop preload, absent in a browser-only deployment.
   * @param copy - locale-aware outcome text.
   * @param toast - retained shell feedback owner.
   */
  constructor(private readonly bridge: NativeToolsBridge | undefined, private readonly copy: NativeToolsCopy,
    private readonly toast: (message: string, kind: 'success' | 'error' | 'warning') => void) {
    this.state = createSnapshotStore<NativeToolsState>({ phase: bridge === undefined ? 'desktop-only' : 'idle',
      tools: [], preferences: { favorites: [], recent: [] }, error: '', pending: [], savingFavorites: false })
  }

  /** Read current availability without discarding a populated catalog. @returns settled load. */
  load(): Promise<void> {
    if (this.disposed || this.bridge === undefined) return Promise.resolve()
    if (this.loading !== undefined) return this.loading
    const current = this.state.getSnapshot()
    if (current.pending.length > 0 || current.savingFavorites) return Promise.resolve()
    this.state.set({ ...this.state.getSnapshot(), phase: 'loading', error: '' })
    this.loading = this.read(this.bridge).finally(() => { this.loading = undefined })
    return this.loading
  }

  /**
   * Open one tool; overlapping requests for that tool are ignored.
   * @param id - selected catalog identity.
   * @param variant - optional x32 entry.
   * @returns completion of the launch request.
   */
  async launch(id: NativeToolId, variant?: 'x32'): Promise<void> {
    const before = this.state.getSnapshot()
    const tool = before.tools.find(entry => entry.id === id)
    if (this.isDisposed() || this.bridge === undefined || tool === undefined || before.pending.includes(id) || before.phase === 'loading') return
    const availability = variant === undefined ? tool.status : tool.variants?.[0]?.status
    if (availability !== 'ready') return
    this.state.set({ ...before, pending: [...before.pending, id] })
    try {
      const result = await this.bridge.launchTool(id, variant)
      if (this.disposed) return
      if (result.ok) {
        const current = this.state.getSnapshot()
        this.state.set({ ...current, preferences: { ...current.preferences,
          recent: [id, ...current.preferences.recent.filter(entry => entry !== id)] } })
        this.toast(result.warning ?? this.copy.opened(tool.name), result.warning === undefined ? 'success' : 'warning')
      } else {
        this.toast(result.error ?? this.copy.launchFailed(tool.name), 'error')
      }
    } catch (error) {
      if (!this.disposed) this.toast(error instanceof Error ? error.message : this.copy.launchFailed(tool.name), 'error')
    } finally {
      if (!this.disposed) {
        const current = this.state.getSnapshot()
        this.state.set({ ...current, pending: current.pending.filter(entry => entry !== id) })
      }
    }
  }

  /** Toggle a favorite after its durable write completes. @param id - catalog identity. @returns saved completion. */
  async toggleFavorite(id: NativeToolId): Promise<void> {
    const before = this.state.getSnapshot()
    if (this.isDisposed() || this.bridge === undefined || before.savingFavorites || before.phase === 'loading' || !before.tools.some(tool => tool.id === id)) return
    const selected = !before.preferences.favorites.includes(id)
    const favorites = selected ? [...before.preferences.favorites, id] : before.preferences.favorites.filter(entry => entry !== id)
    this.state.set({ ...before, savingFavorites: true })
    try {
      await this.bridge.setFavorites(favorites)
      if (this.disposed) return
      const current = this.state.getSnapshot()
      this.state.set({ ...current, preferences: { ...current.preferences, favorites } })
      this.toast(this.copy.favoriteSaved(selected), 'success')
    } catch (error) {
      if (!this.disposed) this.toast(error instanceof Error ? error.message : this.copy.favoritesFailed(), 'error')
    } finally {
      if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), savingFavorites: false })
    }
  }

  /** Suppress late IPC responses and feedback after the plugin unloads. */
  dispose(): void { this.disposed = true }

  private isDisposed(): boolean { return this.disposed }

  private async read(bridge: NativeToolsBridge): Promise<void> {
    try {
      const catalog = await bridge.listTools()
      if (this.disposed) return
      const current = this.state.getSnapshot()
      this.state.set({ ...current, ...catalog, phase: 'ready', error: '' })
    } catch (error) {
      if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), phase: 'error', error: error instanceof Error ? error.message : '' })
    }
  }
}
