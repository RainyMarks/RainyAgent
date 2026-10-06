/** Resolve the installed human tool catalog and retain per-user catalog preferences. */
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { nativeToolIds } from '@deepseek-ai/dsh-client-ui-rainy/native-tools-protocol'
import type { NativeToolCatalog, NativeToolId, NativeToolLaunchResult } from '@deepseek-ai/dsh-client-ui-rainy/native-tools-protocol'
import { toolPackFileSystem } from './toolpack-fs.ts'

const { readFile, writeFile, rename, mkdir, realpath, stat, rm } = toolPackFileSystem.promises

const ids = nativeToolIds
const toolIdSchema = z.enum(ids)
const storedToolIdSchema = z.enum([...ids, 'burp-community'])
const relativePath = z.string().min(1).refine(value => !value.includes('\0') && !value.includes('\\')
  && !isAbsolute(value) && !win32.isAbsolute(value) && !value.split('/').some(part => part === '..' || part === '.' || part === '')
  && !value.includes(':'), 'Expected an installation-relative path')
const entrySchema = z.object({
  kind: z.enum(['gui', 'console', 'java', 'web']), path: relativePath, cwd: relativePath,
  args: z.array(z.string().refine(value => !value.includes('\0'))).default([]), runtime: relativePath.optional(),
  dotnetRoot: relativePath.optional(),
  pythonRoot: relativePath.optional(),
  requiredFiles: z.array(relativePath).optional(),
})
const toolSchema = z.object({
  id: storedToolIdSchema, category: z.enum(['web', 'misc', 'reverse']), name: z.string().min(1),
  version: z.string(), entry: entrySchema, roots: z.array(relativePath).min(1),
  variants: z.array(z.object({ id: z.literal('x32'), name: z.string(), entry: entrySchema })).optional(),
  preserve: z.array(relativePath).optional(),
})
const catalogSchema = z.object({ version: z.literal(1), tools: z.array(toolSchema) }).superRefine((catalog, ctx) => {
  const seen = new Set<string>()
  for (const tool of catalog.tools) {
    if (seen.has(tool.id)) ctx.addIssue({ code: 'custom', message: `Duplicate tool: ${tool.id}` })
    seen.add(tool.id)
    if (tool.variants?.length && tool.id !== 'x64dbg') ctx.addIssue({ code: 'custom', message: 'Only x64dbg declares an x32 variant' })
    if (tool.variants && tool.variants.length > 1) ctx.addIssue({ code: 'custom', message: 'Duplicate x32 variant' })
    for (const entry of [tool.entry, ...(tool.variants?.map(variant => variant.entry) ?? [])]) {
      if (!entry.path.startsWith(`tools/${tool.id}/`) || !(entry.cwd === `tools/${tool.id}` || entry.cwd.startsWith(`tools/${tool.id}/`))
        || entry.kind === 'java' && entry.runtime === undefined || entry.runtime && !entry.runtime.startsWith('runtime/windows/')) {
        ctx.addIssue({ code: 'custom', message: `Invalid installed entry for ${tool.id}` })
      }
      if (entry.dotnetRoot && (!entry.dotnetRoot.startsWith('runtime/windows/') || !tool.roots.includes(entry.dotnetRoot))) {
        ctx.addIssue({ code: 'custom', message: `Invalid private .NET runtime for ${tool.id}` })
      }
      if (entry.pythonRoot && !entry.pythonRoot.startsWith(`tools/${tool.id}/`)) {
        ctx.addIssue({ code: 'custom', message: `Invalid private Python runtime for ${tool.id}` })
      }
      for (const file of entry.requiredFiles ?? []) if (!tool.roots.some(root => file.startsWith(root + '/'))) {
        ctx.addIssue({ code: 'custom', message: `Required file is outside the installed roots for ${tool.id}` })
      }
    }
    for (const root of tool.roots) if (root !== `tools/${tool.id}` && !root.startsWith(`tools/${tool.id}/`) && !root.startsWith('runtime/windows/')) {
      ctx.addIssue({ code: 'custom', message: `Invalid dependency root for ${tool.id}` })
    }
  }
})
const preferencesSchema = z.object({ version: z.literal(1),
  favorites: z.array(storedToolIdSchema).max(ids.length + 1), recent: z.array(storedToolIdSchema).max(ids.length + 1) })
const verificationSchema = z.object({ version: z.literal(1),
  catalogSha256: z.string().regex(/^[a-f0-9]{64}$/), tools: z.array(storedToolIdSchema) })

/** Catalog entry loaded from the installed tool pack. */
export type InstalledNativeTool = Omit<z.infer<typeof toolSchema>, 'id'> & { id: NativeToolId }

type CurrentPreferences = { version: 1; favorites: NativeToolId[]; recent: NativeToolId[] }

/** A checked, absolute invocation; only the main process constructs it. */
export interface NativeInvocation {
  readonly id: NativeToolId
  readonly name: string
  readonly kind: InstalledNativeTool['entry']['kind']
  readonly target: string
  readonly executable: string
  readonly cwd: string
  readonly args: readonly string[]
  readonly roots: readonly string[]
  /** Private directory for the selected tool's user configuration. */
  readonly userData: string
  readonly dotnetRoot?: string
  readonly pythonRoot?: string
}

/** Main-process dependencies for the installed catalog. */
export interface NativeToolsOptions {
  readonly installRoot: string
  readonly userData: string
  /** Starts the checked invocation and resolves when the operating system accepts it. */
  readonly start: (invocation: NativeInvocation) => Promise<void>
}

/**
 * Parse a launch request at the renderer IPC boundary.
 * @param value - renderer-supplied request.
 * @returns the fixed tool and optional x32 selection.
 */
export function parseNativeLaunch(value: unknown): { readonly id: NativeToolId; readonly variant?: 'x32' } {
  return z.object({ id: toolIdSchema, variant: z.literal('x32').optional() }).strict().refine(value => value.variant === undefined || value.id === 'x64dbg').parse(value)
}

/**
 * Parse a favorite list at the renderer IPC boundary.
 * @param value - renderer-supplied tool identities.
 * @returns deduplicated catalog identities.
 */
export function parseNativeFavorites(value: unknown): NativeToolId[] {
  return [...new Set(z.array(toolIdSchema).max(ids.length).parse(value))]
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
}

/**
 * Resolve an existing file or directory without following links outside the installation.
 * @param root - installed application directory.
 * @param child - validated relative entry.
 * @returns the actual contained path.
 */
export async function resolveNativePath(root: string, child: string): Promise<string> {
  relativePath.parse(child)
  const actualRoot = await realpath(root)
  const actual = await realpath(resolve(root, child))
  if (!inside(actualRoot, actual)) throw new Error(`工具路径超出安装目录：${child}`)
  return actual
}

async function optionalJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** The user's catalog preferences and installed launch entries. */
export class NativeToolsLibrary {
  private mutation: Promise<void> = Promise.resolve()
  private readonly pending = new Map<string, Promise<NativeToolLaunchResult>>()
  private readonly preferencesPath: string

  /** @param options - installation paths and native launch owner. */
  constructor(private readonly options: NativeToolsOptions) {
    this.preferencesPath = resolve(options.userData, 'native-tools.json')
  }

  private async catalog(): Promise<{ readonly tools: InstalledNativeTool[]; readonly verified: ReadonlySet<string> }> {
    const file = resolve(this.options.installRoot, 'tools/manifest.json')
    const text = await readFile(file, 'utf8')
    const catalog = catalogSchema.parse(JSON.parse(text))
    const record = await optionalJson(resolve(this.options.installRoot, 'tools/verified.json'))
    const verified = new Set<string>()
    if (record !== undefined) {
      const parsed = verificationSchema.parse(record)
      if (parsed.catalogSha256 === createHash('sha256').update(text).digest('hex')) for (const id of parsed.tools) verified.add(id)
    }
    const tools = catalog.tools.flatMap((tool) => {
      const { id } = tool
      return id === 'burp-community' ? [] : [{ ...tool, id }]
    })
    return { tools, verified }
  }

  private async preferences(): Promise<CurrentPreferences> {
    const value = await optionalJson(this.preferencesPath)
    if (value === undefined) return { version: 1, favorites: [], recent: [] }
    const stored = preferencesSchema.parse(value)
    return { version: 1,
      favorites: [...new Set(stored.favorites.map(id => id === 'burp-community' ? 'yakit' : id))],
      recent: [...new Set(stored.recent.filter(id => id !== 'burp-community'))],
    }
  }

  private async missing(tool: InstalledNativeTool, entry = tool.entry): Promise<string[]> {
    const missing: string[] = []
    for (const path of new Set([entry.path, entry.cwd, ...tool.roots, ...entry.runtime ? [entry.runtime] : [],
      ...entry.dotnetRoot ? [entry.dotnetRoot] : [], ...entry.pythonRoot ? [entry.pythonRoot] : [], ...entry.requiredFiles ?? []])) {
      try {
        const resolved = await resolveNativePath(this.options.installRoot, path)
        const info = await stat(resolved)
        const fileRequired = path === entry.path || path === entry.runtime || entry.requiredFiles?.includes(path)
        const directoryRequired = path === entry.cwd || path === entry.dotnetRoot || path === entry.pythonRoot || tool.roots.includes(path)
        if (fileRequired && !info.isFile() || directoryRequired && !info.isDirectory()) missing.push(path)
      } catch (error) {
        if (error instanceof Error) missing.push(path)
        else throw error
      }
    }
    return missing
  }

  /**
   * Read current tool availability and durable preferences.
   * @returns tool summaries; availability does not imply a completed functional acceptance run.
   */
  async listTools(): Promise<NativeToolCatalog> {
    const [{ tools, verified }, preferences] = await Promise.all([this.catalog(), this.preferences()])
    return {
      tools: await Promise.all(tools.map(async (tool) => {
        const missing = await this.missing(tool)
        return {
          id: tool.id, name: tool.name, category: tool.category, version: tool.version,
          launchKind: tool.entry.kind === 'console' ? 'terminal' as const : tool.entry.kind === 'web' ? 'web' as const : 'desktop' as const,
          status: missing.length ? 'missing' as const : 'ready' as const, missing, verified: verified.has(tool.id),
          ...tool.variants ? { variants: await Promise.all(tool.variants.map(async variant => ({ id: variant.id, name: variant.name,
            status: (await this.missing(tool, variant.entry)).length ? 'missing' as const : 'ready' as const }))) } : {},
        }
      })), preferences: { favorites: preferences.favorites, recent: preferences.recent },
    }
  }

  private change(update: (current: CurrentPreferences) => void): Promise<void> {
    const operation = this.mutation.then(async () => {
      const current = await this.preferences()
      update(current)
      await mkdir(dirname(this.preferencesPath), { recursive: true })
      const temporary = `${this.preferencesPath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx' })
        await rename(temporary, this.preferencesPath)
      } finally { await rm(temporary, { force: true }) }
    })
    this.mutation = operation.catch(() => { /* Each caller receives its own write error; later edits remain possible. */ })
    return operation
  }

  /**
   * Save the user's ordered favorites without losing concurrent recent launches.
   * @param favorites - validated tool identities.
   */
  setFavorites(favorites: readonly NativeToolId[]): Promise<void> {
    return this.change((current) => { current.favorites = [...new Set(favorites)] })
  }

  /**
   * Finish accepted launches and preference writes before the owning carrier exits.
   * @returns completion after the current operation queue has settled.
   */
  async waitForIdle(): Promise<void> {
    await Promise.all([...this.pending.values()])
    await this.mutation
  }

  /**
   * Start one installed tool; overlapping requests share the same launch operation.
   * @param id - catalog tool identity.
   * @param variant - x32dbg selection for the debugger entry.
   * @returns whether the native launcher accepted the request, or a user-readable failure.
   */
  launchTool(id: NativeToolId, variant?: 'x32'): Promise<NativeToolLaunchResult> {
    const key = `${id}:${variant ?? ''}`
    const existing = this.pending.get(key)
    if (existing) return existing
    const operation = this.launch(id, variant)
      .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { this.pending.delete(key) })
    this.pending.set(key, operation)
    return operation
  }

  private async launch(id: NativeToolId, variant?: 'x32'): Promise<NativeToolLaunchResult> {
    const { tools } = await this.catalog()
    const tool = tools.find(value => value.id === id)
    if (tool === undefined) throw new Error('工具不在已安装目录中')
    const entry = variant === undefined ? tool.entry : tool.variants?.at(0)?.entry
    if (entry === undefined) throw new Error('工具启动选项不可用')
    const missing = await this.missing(tool, entry)
    if (missing.length) throw new Error(`工具文件缺失，请修复工具包：${missing.join('、')}`)
    const target = await resolveNativePath(this.options.installRoot, entry.path)
    const executable = entry.runtime === undefined ? target : await resolveNativePath(this.options.installRoot, entry.runtime)
    await this.options.start({ id, name: tool.name, kind: entry.kind, target, executable,
      userData: resolve(this.options.userData, 'native-tools', id),
      cwd: await resolveNativePath(this.options.installRoot, entry.cwd),
      args: entry.kind === 'java' ? ['-jar', target, ...entry.args] : entry.args,
      roots: await Promise.all(tool.roots.map(path => resolveNativePath(this.options.installRoot, path))),
      ...entry.dotnetRoot ? { dotnetRoot: await resolveNativePath(this.options.installRoot, entry.dotnetRoot) } : {},
      ...entry.pythonRoot ? { pythonRoot: await resolveNativePath(this.options.installRoot, entry.pythonRoot) } : {},
    })
    try { await this.change((current) => { current.recent = [id, ...current.recent.filter(value => value !== id)].slice(0, ids.length) }) }
    catch (error) {
      return { ok: true, warning: `工具已打开，但最近使用记录未保存：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true }
  }
}
