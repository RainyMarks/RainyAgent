/** Download the carrier's fixed tool pack into per-user storage, with verified resumable media. */
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { NativeToolsDownloadState, NativeToolsUpdateState } from '@deepseek-ai/dsh-client-ui-rainy/native-tools-protocol'
import type { ReleaseKeyring } from './release-trust.ts'
import { installNativeToolPack } from './toolpack.ts'
import type { InstallNativeToolPackOptions, NativeToolPackInstallResult } from './toolpack.ts'
import { toolPackMetadataSchema, ToolPackInstallError } from './toolpack-format.ts'
import { assertToolPackPath, checkToolPackCancellation, toolPackHash, toolPackStat } from './toolpack-files.ts'
import { authenticateToolChannel, toolDownloadSourceSchema, validateToolDownloadInputs } from './native-tools-update.ts'
import type { NativeToolsChannel, NativeToolsDownloadSource } from './native-tools-update.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
type Source = NativeToolsDownloadSource

/** Main-process paths and optional transport dependencies; renderer content cannot choose a URL or destination. */
export interface NativeToolsDownloadOptions {
  readonly installRoot: string
  readonly previousInstallRoot?: string
  readonly cacheRoot: string
  readonly metadataPath: string
  readonly sourcePath: string
  readonly catalogPath?: string
  readonly updateKeys?: ReleaseKeyring
  readonly publish: (state: NativeToolsDownloadState) => void
  readonly fetch?: typeof globalThis.fetch
  readonly install?: (options: InstallNativeToolPackOptions) => Promise<NativeToolPackInstallResult>
}

async function matches(path: string, expected: { bytes: number; sha256: string }, signal?: AbortSignal): Promise<boolean> {
  await assertToolPackPath(path)
  const info = await toolPackStat(path)
  return info?.isFile() === true && info.size === expected.bytes && await toolPackHash(path, signal) === expected.sha256
}

/** Own one resumable download and atomic installation; closing waits for cancellation and rollback. */
export class NativeToolsDownloader {
  private state: NativeToolsDownloadState = { phase: 'idle', completedBytes: 0, totalBytes: 0, error: '' }
  private running: Promise<void> | undefined
  private abort: AbortController | undefined
  private source: Promise<Source> | undefined
  private closed = false
  private lastPublished = 0
  private metadataPath: string
  private catalogPath: string | undefined
  private channel: NativeToolsChannel | undefined
  private checking: Promise<NativeToolsUpdateState> | undefined
  private checkAbort: AbortController | undefined

  /** @param options - trusted carrier paths, transport and retained progress owner. */
  constructor(private readonly options: NativeToolsDownloadOptions) {
    this.metadataPath = options.metadataPath
    this.catalogPath = options.catalogPath
  }

  private async inputs(): Promise<Source> {
    this.source ??= (async () => {
      const source = toolDownloadSourceSchema.parse(JSON.parse(await readFile(this.options.sourcePath, 'utf8')))
      const metadata = toolPackMetadataSchema.parse(JSON.parse(await readFile(this.options.metadataPath, 'utf8')))
      validateToolDownloadInputs(source, metadata)
      const path = join(this.options.cacheRoot, 'channel.signed.json')
      await assertToolPackPath(path)
      if (this.options.updateKeys && await toolPackStat(path)) {
        const channel = authenticateToolChannel(JSON.parse(await readFile(path, 'utf8')), this.options.updateKeys)
        await this.accept(channel)
        return channel.source
      }
      return source
    })()
    return this.source
  }

  /** Read the committed local pack identity without accessing the network. @returns whether online tools were installed. */
  private async installedPack(root = this.options.installRoot): Promise<string | undefined> {
    const record = join(root, '.rainy-toolpack/installed.json')
    await assertToolPackPath(record)
    if (!(await toolPackStat(record))) return undefined
    const parsed = z.object({ version: z.literal(1), packId: hash }).strict().parse(JSON.parse(await readFile(record, 'utf8')))
    const journal = join(root, '.rainy-toolpack/journal.json')
    await assertToolPackPath(journal)
    if (await toolPackStat(journal)) {
      const value: unknown = JSON.parse(await readFile(journal, 'utf8'))
      if (!z.object({ phase: z.enum(['committed', 'rolled-back']) }).safeParse(value).success) return undefined
    }
    return parsed.packId
  }

  /** Read whether a committed per-user tool pack exists, including an older usable version. @returns local availability. */
  async hasInstalledTools(): Promise<boolean> { return await this.installedPack() !== undefined }

  /** Compare the committed local pack to the selected signed revision. @returns whether that revision is installed. */
  async installed(): Promise<boolean> {
    const id = (await this.inputs()).packId
    if (await this.installedPack() === id) return true
    return this.options.previousInstallRoot !== undefined && await this.installedPack(this.options.previousInstallRoot) === id
  }

  /** Return the authenticated fallback catalog for a core-only installation. @returns local catalog path. */
  async availableCatalog(): Promise<string> {
    await this.inputs()
    if (!this.catalogPath) throw new Error('发行包缺少工具目录')
    return this.catalogPath
  }

  private async save(path: string, text: string): Promise<void> {
    await assertToolPackPath(path)
    await mkdir(this.options.cacheRoot, { recursive: true })
    const temporary = path + `.${randomUUID()}.pending`
    try { await writeFile(temporary, text, { flag: 'wx' }); await rename(temporary, path) }
    finally { await rm(temporary, { force: true }) }
  }

  private async accept(channel: NativeToolsChannel): Promise<void> {
    const metadataPath = join(this.options.cacheRoot, `metadata-${channel.source.packId}.json`)
    const catalogPath = join(this.options.cacheRoot, `catalog-${channel.source.packId}.json`)
    await this.save(metadataPath, JSON.stringify(channel.metadata))
    await this.save(catalogPath, channel.catalog)
    this.metadataPath = metadataPath
    this.catalogPath = catalogPath
    this.channel = channel
  }

  /** Check the fixed publisher channel; a failed check retains installed tools and the last accepted revision.
   * @returns authenticated update availability, or a recoverable check error.
   */
  checkUpdates(): Promise<NativeToolsUpdateState> {
    if (this.checking) return this.checking
    const keys = this.options.updateKeys
    if (this.closed || this.running || !keys) return Promise.resolve({ phase: 'unchecked', version: '', error: '' })
    this.checkAbort = new AbortController()
    const signal = AbortSignal.any([this.checkAbort.signal, AbortSignal.timeout(30_000)])
    this.checking = (async (): Promise<NativeToolsUpdateState> => {
      try {
        await this.inputs()
        const response = await (this.options.fetch ?? globalThis.fetch)(
          'https://raw.githubusercontent.com/RainyMarks/RainyAgent/main/apps/rainy-desktop/toolpacks/native-tools-channel.signed.json', { signal, credentials: 'omit', cache: 'no-cache' })
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`检查工具更新失败（HTTP ${response.status}）`) }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of response.body) {
          size += chunk.byteLength
          if (size > 10 * 1024 ** 2) throw new Error('工具更新目录超过大小限制')
          chunks.push(Buffer.from(chunk))
        }
        const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const channel = authenticateToolChannel(envelope, keys)
        if (this.channel && (channel.revision < this.channel.revision
          || channel.revision === this.channel.revision && channel.source.packId !== this.channel.source.packId)) throw new Error('工具更新版本倒退或清单冲突')
        await this.save(join(this.options.cacheRoot, 'channel.signed.json'), JSON.stringify(envelope))
        await this.accept(channel)
        this.source = Promise.resolve(channel.source)
        return { phase: await this.installed() ? 'current' : 'available', version: channel.releaseVersion, error: '' }
      } catch (error) {
        if (this.checkAbort?.signal.aborted) return { phase: 'unchecked', version: this.channel?.releaseVersion ?? '', error: '' }
        return { phase: 'error', version: this.channel?.releaseVersion ?? '', error: error instanceof Error ? error.message : '无法检查工具更新，请检查网络后重试' }
      }
    })().finally(() => { this.checking = undefined; this.checkAbort = undefined })
    return this.checking
  }

  /** Return progress and the compressed pack size without downloading. @returns current local state. */
  async status(): Promise<NativeToolsDownloadState> {
    const source = await this.inputs()
    if (this.running) return this.state
    const complete = this.state.phase === 'idle' && await this.installed()
    return { ...this.state, totalBytes: source.volumes.reduce((sum, volume) => sum + volume.bytes, 0),
      ...complete ? { phase: 'complete' as const } : {} }
  }

  private publish(state: NativeToolsDownloadState): void {
    const changed = state.phase !== this.state.phase
    this.state = state
    const now = Date.now()
    if (!changed && (state.phase === 'downloading' || state.phase === 'installing') && now - this.lastPublished < 100) return
    this.lastPublished = now
    this.options.publish(state)
  }

  /** Coalesce repeated requests; a committed installation makes no network request.
   * @param repair - verify and repair missing installed files using cached media.
   * @returns settled installation.
   */
  start(repair = false): Promise<void> {
    if (this.closed) return Promise.reject(new Error('RainyAgent 正在关闭'))
    if (this.running) return this.running
    this.abort = new AbortController()
    this.running = this.run(this.abort.signal, repair).finally(() => { this.running = undefined; this.abort = undefined })
    return this.running
  }

  /** Abort safely, retaining partial downloads and verified staging. @returns completion after rollback. */
  async cancel(): Promise<void> {
    this.checkAbort?.abort()
    if (!this.running) this.publish({ ...this.state, phase: 'cancelled', error: '' })
    this.abort?.abort()
    await this.running
  }

  /** Reject new downloads and finish cancellation before carrier exit. @returns complete cleanup. */
  async close(): Promise<void> { this.closed = true; this.checkAbort?.abort(); await this.cancel(); await this.checking }

  private async download(piece: Source['volumes'][number]['pieces'][number], source: Source, signal: AbortSignal,
    progress: (bytes: number) => void): Promise<string> {
    const target = join(this.options.cacheRoot, piece.file)
    if (await matches(target, piece, signal)) { progress(piece.bytes); return target }
    const partial = target + '.partial'
    await assertToolPackPath(partial)
    const info = await toolPackStat(partial)
    if (info && (!info.isFile() || info.size > piece.bytes)) throw new Error('工具下载缓存无效，请清理下载缓存后重试')
    let offset = info?.size ?? 0
    if (offset === piece.bytes) {
      if (await matches(partial, piece, signal)) { await rename(partial, target); progress(piece.bytes); return target }
      await rm(partial)
      offset = 0
    }
    const response = await (this.options.fetch ?? globalThis.fetch)(source.baseUrl + piece.file,
      { signal, headers: offset ? { Range: `bytes=${offset}-` } : {}, credentials: 'omit' })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`工具下载失败（HTTP ${response.status}），请检查网络后重试`)
    }
    if (response.status === 206) {
      if (response.headers.get('content-range') !== `bytes ${offset}-${piece.bytes - 1}/${piece.bytes}`) {
        await response.body.cancel()
        throw new Error('工具下载续传响应无效')
      }
    } else if (response.status === 200) offset = 0
    else { await response.body.cancel(); throw new Error('工具下载响应无效') }
    const output = await open(partial, offset ? 'a' : 'w')
    let received = offset
    progress(received)
    try {
      for await (const value of response.body) {
        checkToolPackCancellation(signal)
        received += value.byteLength
        if (received > piece.bytes) throw new Error('工具下载超出清单大小')
        await output.writeFile(value)
        progress(received)
      }
    } finally { await output.close() }
    if (!await matches(partial, piece, signal)) {
      await rm(partial)
      throw new Error('工具下载校验失败，请重试')
    }
    await rename(partial, target)
    return target
  }

  private async run(signal: AbortSignal, repair: boolean): Promise<void> {
    try {
      await this.checking
      checkToolPackCancellation(signal)
      const source = await this.inputs()
      if (!repair && await this.installed()) {
        const totalBytes = source.volumes.reduce((sum, volume) => sum + volume.bytes, 0)
        this.publish({ phase: 'complete', completedBytes: totalBytes, totalBytes, error: '' })
        return
      }
      await assertToolPackPath(this.options.cacheRoot)
      await assertToolPackPath(this.options.installRoot)
      await mkdir(this.options.cacheRoot, { recursive: true })
      await mkdir(this.options.installRoot, { recursive: true })
      const totalBytes = source.volumes.reduce((sum, volume) => sum + volume.bytes, 0)
      let completed = 0
      this.publish({ phase: 'downloading', completedBytes: 0, totalBytes, error: '' })
      for (const volume of source.volumes) {
        checkToolPackCancellation(signal)
        const target = join(this.options.cacheRoot, volume.path)
        if (!await matches(target, volume, signal)) {
          let pieceOffset = completed
          const paths: string[] = []
          for (const piece of volume.pieces) {
            const baseline = pieceOffset
            paths.push(await this.download(piece, source, signal, (value) => {
              this.publish({ phase: 'downloading', completedBytes: baseline + value, totalBytes, error: '' })
            }))
            pieceOffset += piece.bytes
          }
          const partial = target + '.partial'
          await assertToolPackPath(partial)
          const output = await open(partial, 'w')
          try {
            for (const path of paths) for await (const chunk of createReadStream(path)) {
              checkToolPackCancellation(signal)
              if (!Buffer.isBuffer(chunk)) throw new Error('工具分卷读取格式无效')
              await output.writeFile(chunk)
            }
          } finally { await output.close() }
          if (!await matches(partial, volume, signal)) throw new Error('工具分卷校验失败，请重试')
          await rename(partial, target)
          for (const path of paths) await rm(path)
        }
        completed += volume.bytes
        this.publish({ phase: 'downloading', completedBytes: completed, totalBytes, error: '' })
      }
      checkToolPackCancellation(signal)
      this.publish({ phase: 'installing', completedBytes: 0, totalBytes: 0, error: '' })
      await (this.options.install ?? installNativeToolPack)({ installRoot: this.options.installRoot,
        mediaDirectory: this.options.cacheRoot, metadataPath: this.metadataPath, signal,
        onProgress: (update) => { this.publish({ phase: 'installing', completedBytes: update.completedBytes, totalBytes: update.totalBytes, error: '' }) },
      })
      this.publish({ phase: 'complete', completedBytes: totalBytes, totalBytes, error: '' })
    } catch (error) {
      const recoveryFailed = error instanceof ToolPackInstallError && error.code === 'rollback-required'
      const cancelled = !recoveryFailed && (signal.aborted || error instanceof ToolPackInstallError && error.code === 'cancelled')
      this.publish({ ...this.state, phase: cancelled ? 'cancelled' : 'error', error: cancelled ? '' : error instanceof Error ? error.message : '工具下载失败，请重试' })
      if (!cancelled) throw error
    }
  }
}
