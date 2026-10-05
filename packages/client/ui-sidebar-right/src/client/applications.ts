/** Root-scoped human workspaces share the existing right column with Session panes. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SidebarRightPresentation } from './shell/SidebarRight.tsx'

/** A registered application workspace, independent of Session tab identities. */
export type SidebarRightApplicationId = Branded<'SidebarRightApplicationId'>

/** Application selection and bodies visited during this Client lifetime. */
export interface SidebarRightApplicationState {
  readonly activeId: SidebarRightApplicationId | undefined
  readonly visited: readonly SidebarRightApplicationId[]
}

/** Optional refresh operation owned by the workspace's document lifetime. */
export interface SidebarRightApplicationCommands { readonly refresh?: () => void }

/** Navigation for root-scoped workspaces; provider bodies register in `rightbar.application`. */
export interface ISidebarRightApplications {
  readonly state: ObservableSnapshot<SidebarRightApplicationState>
  /**
   * Register a workspace for the caller's effect lifetime; duplicate identities throw.
   * @param id - workspace identity.
   * @param commands - document operations.
   * @returns disposer that closes and removes the workspace.
   */
  register(this: void, id: SidebarRightApplicationId, commands?: SidebarRightApplicationCommands): () => void
  /**
   * Reveal a registered workspace without creating a Session; unknown identities throw.
   * @param id - workspace identity.
   */
  open(this: void, id: SidebarRightApplicationId): void
  /** Hide the workspace and return the column to the selected Session. */
  close(this: void): void
}

/**
 * Create navigation and the owning root's two presentation reporters.
 * @param report - commits the selected occupant's geometry to the frame.
 * @returns navigation and provider-only presentation callbacks.
 */
export function createSidebarRightApplications(report: (presentation: SidebarRightPresentation) => void): {
  controller: ISidebarRightApplications
  reportSession: (presentation: SidebarRightPresentation) => void
  reportApplication: (presentation: SidebarRightPresentation) => void
  resolveCommand: (kind: 'close' | 'refresh', element: Element | null) => (() => void) | undefined
} {
  const state = createSnapshotStore<SidebarRightApplicationState>({ activeId: undefined, visited: [] })
  const registered = new Map<SidebarRightApplicationId, SidebarRightApplicationCommands>()
  let session: SidebarRightPresentation = { shown: false, track: false, fullscreen: false }
  const close = (): void => {
    if (state.getSnapshot().activeId === undefined) return
    state.set({ ...state.getSnapshot(), activeId: undefined })
    report(session)
  }
  return {
    controller: {
      state,
      register(id, commands = {}) {
        if (registered.has(id)) throw new Error(`sidebarRight: application "${id}" already registered`)
        registered.set(id, commands)
        return () => {
          if (!registered.delete(id)) return
          if (state.getSnapshot().activeId === id) close()
          state.set({ ...state.getSnapshot(), visited: state.getSnapshot().visited.filter(value => value !== id) })
        }
      },
      open(id) {
        if (!registered.has(id)) throw new Error(`sidebarRight: application "${id}" is not registered`)
        const current = state.getSnapshot()
        if (current.activeId === id) return
        state.set({ activeId: id, visited: current.visited.includes(id) ? current.visited : [...current.visited, id] })
      },
      close,
    },
    reportSession(presentation) {
      session = presentation
      if (state.getSnapshot().activeId === undefined) report(presentation)
    },
    reportApplication(presentation) {
      if (state.getSnapshot().activeId !== undefined) report(presentation)
    },
    resolveCommand(kind, element) {
      const id = state.getSnapshot().activeId
      if (id === undefined || element?.closest('[data-sidebar-right-application]')?.getAttribute('data-sidebar-right-application') !== id) return undefined
      const commands = registered.get(id)
      const run = kind === 'close' ? close : commands?.refresh
      if (run === undefined) return undefined
      return () => { if (state.getSnapshot().activeId === id && registered.get(id) === commands) run() }
    },
  }
}
