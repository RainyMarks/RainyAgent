/** Host bootstrap options for Session restoration in workspace navigation. */

/** Explicit startup behavior; other navigation methods retain their documented effects. */
export interface WorkspaceNavigationConfig {
  /** Create or reuse a blank on startup, or restore only a remembered existing Session. */
  readonly startupSession: 'create' | 'restore-only'
}

/**
 * Validate Host-provided navigation options before constructing the provider.
 * @param value - `__DSH_WORKSPACE_NAVIGATION_CONFIG__`, absent in the default composition.
 * @returns complete startup options.
 */
export function resolveWorkspaceNavigationConfig(value?: unknown): WorkspaceNavigationConfig {
  if (value === undefined) return { startupSession: 'create' }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || !('startupSession' in value)
    || value.startupSession !== 'create' && value.startupSession !== 'restore-only') {
    throw new Error('Workspace navigation configuration must specify startupSession as create or restore-only.')
  }
  return { startupSession: value.startupSession }
}
