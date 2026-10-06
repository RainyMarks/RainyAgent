/** Project-owned directory mounts, independent of chat ownership and source files. */
import { Service, type Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, normalize } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId, IdeRootId, IdeWorkspaceRoot } from '@deepseek-ai/dsh-client-ui-rainy/ide-files-protocol'
import { z } from 'zod'
import { ideContains, IdeOperationError } from './ide-files-core.ts'

/** Stable primary-root identity within each project. */
export const primaryIdeRootId = brandString<IdeRootId>('primary')

const rootSchema = z.object({
  rootId: z.string().min(1).max(128).transform(value => brandString<IdeRootId>(value)),
  path: z.string().min(1), title: z.string(), primary: z.literal(false),
}).strict()
const recordSchema = z.object({ revision: z.number().int().nonnegative(), roots: z.array(rootSchema) }).strict()
type RootRecord = z.infer<typeof recordSchema>

/** Only attached directories are stored; the workspace registry owns the primary directory. */
export const projectRootsSpec = defineDomain({
  name: 'rainy_project_roots', version: 1, layout: 'per-record',
  tables: { projects: domainTable<WorkspaceId, RootRecord>(recordSchema) },
})

/** Limits apply per project and include its primary root. */
export interface Config { maxRoots: number }
/** Deployment-selected directory budget. */
export const Config: s<Config> = s.object({ maxRoots: s.number().min(1).max(128).step(1).default(16) })

declare module '@deepseek-ai/cordis' {
  interface Context { rainyProjectRoots: RainyProjectRoots }
  interface Events {
    /** Emitted after directory mount changes are durable.
     * @mode emit
     * @param workspaceId Project whose mounts changed.
     * @param roots Committed root list, including the primary directory.
     */
    'rainy-project/roots-changed'(workspaceId: WorkspaceId, roots: readonly IdeWorkspaceRoot[]): void
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? normalize(left).toLowerCase() === normalize(right).toLowerCase() : left === right
}

/** Durable directory mounts keep the project's primary cwd and conversation account unchanged. */
export default class RainyProjectRoots extends Service {
  static inject = ['workspaceRegistry', 'storageDomain']
  static Config = Config
  private domain?: Domain<typeof projectRootsSpec>
  private chain: Promise<void> = Promise.resolve()
  private closing = false

  /** @param ctx Workspace and durable storage owners. @param config Per-project root budget. */
  constructor(ctx: Context, private readonly config: Config) { super(ctx, 'rainyProjectRoots') }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(projectRootsSpec)
    this.domain = domain
    this.ctx.effect(() => async () => { this.closing = true; await this.chain; await domain.close() })
  }

  /** Read registered mounts without requiring the directories to be currently online.
   * @param workspaceId Project identity.
   * @returns Primary root followed by attached roots in insertion order.
   */
  get(workspaceId: WorkspaceId): readonly IdeWorkspaceRoot[] {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new IdeOperationError('workspace-not-found', 'The selected project is no longer registered.')
    return [{ rootId: primaryIdeRootId, path: workspace.path, title: workspace.title, primary: true },
      ...this.table().get(workspaceId)?.roots ?? []]
  }

  /** Resolve the project that owns a Session cwd without merging another project's mounts.
   * @param cwd Immutable Session working directory.
   * @returns Its roots, or an empty list for Sessions without a registered project.
   */
  forSessionCwd(cwd: string): readonly IdeWorkspaceRoot[] {
    const workspace = this.ctx.workspaceRegistry.list().find(item => samePath(item.path, cwd))
    return workspace === undefined ? [] : this.get(workspace.id)
  }

  /** Verify a mounted directory immediately before a file or process operation.
   * @param workspaceId Project identity.
   * @param rootId Mounted directory identity; omission explicitly selects the primary root.
   * @returns The unchanged mount with its current canonical directory verified.
   */
  async resolveRoot(workspaceId: WorkspaceId, rootId: IdeRootId = primaryIdeRootId): Promise<IdeWorkspaceRoot> {
    const root = this.get(workspaceId).find(item => item.rootId === rootId)
    if (root === undefined) throw new IdeOperationError('workspace-not-found', 'This directory is no longer attached to the project.')
    try {
      const canonical = await realpath(root.path)
      if (!samePath(canonical, root.path) || !(await stat(canonical)).isDirectory())
        throw new IdeOperationError('workspace-unavailable', 'The project directory is unavailable or now resolves to another location.')
      return root
    } catch (error) {
      if (error instanceof IdeOperationError) throw error
      throw new IdeOperationError('workspace-unavailable', 'The project directory is unavailable.')
    }
  }

  /** Attach an existing directory; a duplicate canonical path reuses its existing root.
   * @param workspaceId Project receiving the directory.
   * @param path Absolute directory chosen by the user.
   * @returns The committed root list.
   */
  attach(workspaceId: WorkspaceId, path: string): Promise<readonly IdeWorkspaceRoot[]> {
    return this.enqueue(() => this.attachDirectory(workspaceId, path))
  }

  /** Restore a trusted carrier mount when the user switches an existing project to another execution target.
   * @param workspaceId Target Host workspace identity.
   * @param root Carrier-mapped directory retaining its previous root identity.
   * @returns The committed target-side mounts.
   */
  importRoot(workspaceId: WorkspaceId, root: Pick<IdeWorkspaceRoot, 'rootId' | 'path' | 'title'>): Promise<readonly IdeWorkspaceRoot[]> {
    return this.enqueue(() => this.attachDirectory(workspaceId, root.path, root))
  }

  private async attachDirectory(workspaceId: WorkspaceId, path: string,
    imported?: Pick<IdeWorkspaceRoot, 'rootId' | 'title'>): Promise<readonly IdeWorkspaceRoot[]> {
    if (!isAbsolute(path) || path.includes('\0')) throw new IdeOperationError('invalid-path', 'Choose an absolute directory path.')
    let canonical: string
    try {
      canonical = await realpath(path)
      if (!(await stat(canonical)).isDirectory()) throw new IdeOperationError('not-directory', 'Choose an existing directory.')
    } catch (error) {
      if (error instanceof IdeOperationError) throw error
      throw new IdeOperationError('not-directory', 'Choose an existing directory.')
    }
    const roots = this.get(workspaceId)
    if (imported?.rootId === primaryIdeRootId) throw new IdeOperationError('invalid-request', 'The primary directory cannot be imported as an attachment.')
    if (imported !== undefined && roots.some(root => root.rootId === imported.rootId && !samePath(root.path, canonical)))
      throw new IdeOperationError('invalid-request', 'The imported root identity already names another directory.')
    const existing = roots.find(root => samePath(root.path, canonical))
    if (existing !== undefined) {
      if (imported !== undefined && imported.rootId !== existing.rootId)
        throw new IdeOperationError('invalid-request', 'The imported directory already has another root identity.')
      return roots
    }
    if (roots.some(root => ideContains(root.path, canonical) || ideContains(canonical, root.path)))
      throw new IdeOperationError('root-overlap', 'The directory overlaps an existing project folder.')
    if (roots.length >= this.config.maxRoots) throw new IdeOperationError('too-large', 'The project has reached its directory limit.')
    const previous = this.table().get(workspaceId)
    const next: RootRecord = { revision: (previous?.revision ?? 0) + 1,
      roots: [...previous?.roots ?? [], { rootId: imported?.rootId ?? brandString<IdeRootId>(randomUUID()), path: canonical,
        title: imported?.title ?? (basename(canonical) || canonical), primary: false }] }
    await this.table().put(workspaceId, next)
    const committed = this.get(workspaceId)
    this.ctx.emit('rainy-project/roots-changed', workspaceId, committed)
    return committed
  }

  /** Unmount a secondary directory without deleting files or conversations.
   * @param workspaceId Project receiving the change.
   * @param rootId Secondary root to remove.
   * @returns The committed root list.
   */
  remove(workspaceId: WorkspaceId, rootId: IdeRootId): Promise<readonly IdeWorkspaceRoot[]> {
    return this.enqueue(async () => {
      const roots = this.get(workspaceId)
      if (rootId === primaryIdeRootId) throw new IdeOperationError('invalid-request', 'The primary project directory cannot be removed.')
      const previous = this.table().get(workspaceId)
      if (previous === undefined || !roots.some(root => root.rootId === rootId)) return roots
      await this.table().put(workspaceId, { revision: previous.revision + 1,
        roots: previous.roots.filter(root => root.rootId !== rootId) })
      const committed = this.get(workspaceId)
      this.ctx.emit('rainy-project/roots-changed', workspaceId, committed)
      return committed
    })
  }

  private table() {
    if (this.domain === undefined) throw new Error('Project root storage has not initialized.')
    return this.domain.table('projects')
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new IdeOperationError('closed', 'Project root storage is closing.'))
    const result = this.chain.then(operation)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }
}
