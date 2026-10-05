/** Offline native-tool installation with verified staging and recoverable directory swaps. */
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { Parser } from 'tar'
import type { ReadEntry } from 'tar'
import { z } from 'zod'
import { ToolPackInstallError, isToolPackPath, toolPackMetadataSchema } from './toolpack-format.ts'
import type { InstallNativeToolPackOptions, NativeToolPackInstallResult, ToolPackMetadata, ToolPackPlatform, ToolPackProgress, ToolPackUnit } from './toolpack-format.ts'
import { assertToolPackPath, checkToolPackCancellation, copyToolPackUserData, readToolPackRecord, resetToolPackStagedUserData, toolPackChild, toolPackHash, toolPackStat, toolPackTree, writeToolPackRecord } from './toolpack-files.ts'
import { nativeToolPackPlatform } from './toolpack-platform.ts'
import { toolPackFileSystem } from './toolpack-fs.ts'

const { createReadStream } = toolPackFileSystem
const { mkdir, open, readFile, unlink } = toolPackFileSystem.promises

export { ToolPackInstallError } from './toolpack-format.ts'
export type { InstallNativeToolPackOptions, NativeToolPackInstallResult, ToolPackProgress } from './toolpack-format.ts'

const installedSchema = z.object({ version: z.literal(1), packId: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const journalSchema = z.object({
  version: z.literal(1),
  installRoot: z.string(),
  packId: z.string().regex(/^[a-f0-9]{64}$/),
  transactionId: z.uuid(),
  previousPackId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  phase: z.enum(['staging', 'prepared', 'switching', 'rolling-back', 'rolled-back', 'committed']),
  units: z.array(z.object({
    path: z.string().refine(isToolPackPath),
    kind: z.enum(['directory', 'file']),
    preserve: z.array(z.string().refine(isToolPackPath)),
    state: z.enum(['pending', 'moving-old', 'old-moved', 'moving-new', 'installed', 'rolled-back']),
    hadOriginal: z.boolean().optional(),
    // Absent or false means the unit receives a staged replacement.
    retired: z.boolean().optional(),
  }).strict()),
}).strict().superRefine((journal, context) => {
  const seen = new Set<string>()
  for (const unit of journal.units) {
    if (seen.has(unit.path.toLowerCase())
      || unit.kind === 'directory' && !/^(tools\/[^/]+|runtime\/windows\/[^/]+)$/.test(unit.path)
      || unit.kind === 'file' && !['tools/manifest.json', 'tools/verified.json'].includes(unit.path)
      || unit.preserve.some(path => unit.kind !== 'directory' || !path.startsWith(unit.path + '/'))
      || unit.retired && (unit.preserve.length > 0 || unit.state === 'moving-new')
      || !['pending', 'rolled-back'].includes(unit.state) && unit.hadOriginal === undefined) {
      context.addIssue({ code: 'custom', message: 'Invalid transaction unit' })
    }
    seen.add(unit.path.toLowerCase())
  }
})
type Journal = z.infer<typeof journalSchema>

function asInstallError(error: unknown): ToolPackInstallError {
  return error instanceof ToolPackInstallError ? error : new ToolPackInstallError('install-failed', error instanceof Error ? error.message : '工具安装失败，请重试。', { cause: error })
}

/** Hold one installation directory exclusively during normal application use or maintenance.
 * @param installRoot Installed RainyAgent directory.
 * @returns An asynchronous release function; process exit also releases the Windows pipe.
 */
export async function acquireToolPackLock(installRoot: string): Promise<() => Promise<void>> {
  const root = resolve(installRoot)
  await assertToolPackPath(root)
  if (!(await toolPackStat(root))?.isDirectory()) throw new ToolPackInstallError('invalid-target', 'RainyAgent 安装目录不存在。')
  const stateRoot = join(root, '.rainy-toolpack')
  await assertToolPackPath(stateRoot)
  await mkdir(stateRoot, { recursive: true })
  const id = createHash('sha256').update(root.toLowerCase()).digest('hex')
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\rainy-toolpack-${id}` : join(stateRoot, 'install.sock')
  const server = createServer(socket => socket.end())
  await new Promise<void>((accept, reject) => {
    server.once('error', (error) => {
      reject(new ToolPackInstallError('install-busy', '安装目录正被 RainyAgent 或安装进程使用，请关闭应用或等待安装完成。', { cause: error }))
    })
    server.listen(address, () => { accept() })
  })
  return async () => {
    await new Promise<void>((accept, reject) => {
      server.close((error) => { if (error) reject(error); else accept() })
    })
  }
}

function preserved(path: string, units: ToolPackUnit[]): boolean {
  const key = path.toLowerCase()
  return units.some(unit => unit.preserve.some(item => key === item.toLowerCase() || key.startsWith(item.toLowerCase() + '/')))
}

async function installedManifest(stateRoot: string, packId: string): Promise<ToolPackMetadata> {
  const path = join(stateRoot, 'manifests', `${packId}.json`)
  const parsed = toolPackMetadataSchema.safeParse(await readToolPackRecord(path))
  if (!parsed.success || parsed.data.id !== packId) {
    throw new ToolPackInstallError('invalid-record', `已安装工具文件清单缺失或损坏，无法安全区分程序文件和用户数据。已保留原目录，请恢复清单后重试：${path}`)
  }
  return parsed.data
}

async function userDataUnits(
  root: string, metadata: ToolPackMetadata, previous: ToolPackMetadata | undefined, signal?: AbortSignal,
): Promise<{ units: ToolPackUnit[]; preservedBytes: number }> {
  const managed = new Set(previous?.files.filter(file => !preserved(file.path, previous.units)).map(file => file.path.toLowerCase()))
  const incomingFiles = new Set(metadata.files.map(file => file.path.toLowerCase()))
  const incomingDirectories = new Set<string>()
  for (const file of incomingFiles) {
    const parts = file.split('/')
    for (let index = 1; index < parts.length; index++) incomingDirectories.add(parts.slice(0, index).join('/'))
  }
  const units = metadata.units.map(unit => ({ ...unit, preserve: [...unit.preserve] }))
  let preservedBytes = 0
  for (const unit of units) {
    for (const file of await toolPackTree(toolPackChild(root, unit.path), signal)) {
      const path = relative(root, file.path).split(sep).join('/')
      if (preserved(path, metadata.units)) { preservedBytes += file.bytes; continue }
      const key = path.toLowerCase()
      if (managed.has(key)) continue
      const parts = key.split('/')
      if (unit.kind === 'file' || incomingFiles.has(key) || incomingDirectories.has(key)
        || parts.some((_part, index) => incomingFiles.has(parts.slice(0, index).join('/')))) {
        throw new ToolPackInstallError('user-data-conflict', `用户文件与新版本工具路径冲突，已保留原目录。请将该文件移到工具目录外后重试：${path}`)
      }
      if (!isToolPackPath(path)) throw new ToolPackInstallError('unsafe-path', `用户文件路径不受支持，已保留原目录：${path}`)
      unit.preserve.push(path)
      preservedBytes += file.bytes
    }
  }
  return { units, preservedBytes }
}

async function verifyInstalled(root: string, metadata: ToolPackMetadata, signal?: AbortSignal): Promise<boolean> {
  for (const file of metadata.files) {
    checkToolPackCancellation(signal)
    if (preserved(file.path, metadata.units)) continue
    const path = toolPackChild(root, file.path)
    await assertToolPackPath(path)
    const existing = await toolPackStat(path)
    if (!existing?.isFile() || existing.size !== file.bytes || await toolPackHash(path, signal) !== file.sha256) return false
  }
  return true
}

async function extractArchive(
  metadata: ToolPackMetadata, mediaRoot: string, stageRoot: string, reusable: Set<string>,
  progress: (update: ToolPackProgress) => void, signal?: AbortSignal,
): Promise<void> {
  const expected = new Map(metadata.files.map(file => [file.path, file]))
  const seen = new Set<string>()
  const entries = new Set<ReadEntry>()
  let processing = Promise.resolve()
  let failure: ToolPackInstallError | undefined
  let completedBytes = 0
  const parser = new Parser({ strict: true, gzip: true, noResume: true, onReadEntry(entry) {
    entries.add(entry)
    entry.on('error', () => { /* The installer reports archive and cancellation failures through fail(). */ })
    processing = processing.then(async () => {
      if (failure) throw failure
      checkToolPackCancellation(signal)
      const file = expected.get(entry.path)
      if (!isToolPackPath(entry.path) || !file || seen.has(entry.path.toLowerCase()) || entry.type !== 'File' || entry.size !== file.bytes || entry.linkpath) {
        throw new ToolPackInstallError('unsafe-archive', `归档包含未登记、重复或不安全的文件：${entry.path}`)
      }
      seen.add(entry.path.toLowerCase())
      if (reusable.has(entry.path)) {
        for await (const chunk of entry) { checkToolPackCancellation(signal); void chunk }
      } else {
        const destination = toolPackChild(stageRoot, entry.path)
        await assertToolPackPath(destination)
        await mkdir(dirname(destination), { recursive: true })
        const temporary = join(dirname(destination), `.rainy-tmp-${randomUUID()}`)
        const output = await open(temporary, 'wx', 0o600)
        const hash = createHash('sha256')
        let bytes = 0
        try {
          for await (const chunk of entry) {
            checkToolPackCancellation(signal)
            bytes += chunk.length
            if (bytes > file.bytes) throw new ToolPackInstallError('file-integrity', `解包文件超过登记大小：${file.path}`)
            hash.update(chunk)
            await output.writeFile(chunk)
          }
          if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw new ToolPackInstallError('file-integrity', `工具文件校验失败：${file.path}`)
          await output.sync()
        } catch (error) {
          await output.close()
          await unlink(temporary)
          throw error
        }
        await output.close()
        await assertToolPackPath(destination)
        await nativeToolPackPlatform.move(temporary, destination)
      }
      entries.delete(entry)
      completedBytes += file.bytes
      progress({ phase: 'extracting', message: '正在解包并逐项校验工具…', completedBytes, totalBytes: metadata.unpackedBytes, currentPath: file.path })
      checkToolPackCancellation(signal)
    }).catch((error: unknown) => { fail(asInstallError(error)) })
  } })

  function fail(error: ToolPackInstallError): void {
    if (failure) return
    failure = error
    for (const entry of entries) entry.destroy(error)
    parser.abort(error)
    source.destroy(error)
  }

  async function* chunks(): AsyncGenerator<Buffer> {
    for (const volume of metadata.volumes) {
      const path = toolPackChild(mediaRoot, volume.file)
      await assertToolPackPath(path)
      for await (const chunk of createReadStream(path)) {
        checkToolPackCancellation(signal)
        if (!Buffer.isBuffer(chunk)) throw new ToolPackInstallError('volume-integrity', '工具包读取返回了非二进制数据。')
        yield chunk
      }
    }
  }

  const onAbort = (): void => { fail(new ToolPackInstallError('cancelled', '工具安装已取消。已校验的暂存文件会在重试时复用。')) }
  signal?.addEventListener('abort', onAbort, { once: true })
  const source = Readable.from(chunks())
  try {
    await pipeline(source, parser)
    await processing
    if (failure) throw failure
    if (seen.size !== metadata.files.length) throw new ToolPackInstallError('file-integrity', '归档未包含全部登记文件。')
  } catch (error) {
    fail(asInstallError(error))
    await processing
    throw failure ?? error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    source.destroy()
    try { await finished(source) } catch (error) { if (!failure) throw error }
  }
}

/** Create an installer that preserves user files and backs up tools removed from the next package.
 * Existing package records require their matching saved manifest; conflicting user paths stop before replacement.
 * @param platform Free-space, running-process, and move operations.
 * @returns An offline installer with the same public arguments as installNativeToolPack.
 */
export function createNativeToolPackInstaller(
  platform: ToolPackPlatform,
): (options: InstallNativeToolPackOptions) => Promise<NativeToolPackInstallResult> {
  return async (options) => {
    const installRoot = resolve(options.installRoot)
    const mediaRoot = resolve(options.mediaDirectory)
    await assertToolPackPath(installRoot)
    if (!(await toolPackStat(installRoot))?.isDirectory()) throw new ToolPackInstallError('invalid-target', '安装目标目录不存在。请从 RainyAgent 安装程序启动工具安装。')
    const stateRoot = join(installRoot, '.rainy-toolpack')
    const release = await acquireToolPackLock(installRoot)
    const journalPath = join(stateRoot, 'journal.json')
    const installedPath = join(stateRoot, 'installed.json')
    const progress = (update: ToolPackProgress): void => {
      try { options.onProgress?.(update) } catch (error) { console.error('Tool installation progress listener failed', error) }
    }

    async function move(sourcePath: string, destinationPath: string): Promise<void> {
      await assertToolPackPath(sourcePath)
      await assertToolPackPath(destinationPath)
      await mkdir(dirname(destinationPath), { recursive: true })
      await platform.move(sourcePath, destinationPath)
    }

    async function rollback(journal: Journal): Promise<void> {
      journal.phase = 'rolling-back'
      await writeToolPackRecord(journalPath, journal)
      const stageRoot = join(stateRoot, 'stage', journal.packId)
      const backupRoot = join(stateRoot, 'backups', journal.transactionId)
      for (const unit of [...journal.units].reverse()) {
        if (unit.state === 'pending' || unit.state === 'rolled-back') continue
        const destination = toolPackChild(installRoot, unit.path)
        const staged = toolPackChild(stageRoot, unit.path)
        const backup = toolPackChild(backupRoot, unit.path)
        progress({ phase: 'rolling-back', message: '正在恢复安装前的工具…', completedBytes: 0, totalBytes: 0, currentPath: unit.path })
        await assertToolPackPath(destination)
        await assertToolPackPath(staged)
        await assertToolPackPath(backup)
        const [destinationExists, stagedExists, backupExists] = await Promise.all([
          toolPackStat(destination), toolPackStat(staged), toolPackStat(backup),
        ])
        if (unit.retired) {
          if (destinationExists && backupExists) throw new ToolPackInstallError('rollback-required', `恢复路径出现冲突，已保留两个版本：${unit.path}`)
        } else if (!stagedExists && destinationExists) await move(destination, staged)
        else if (destinationExists && backupExists) throw new ToolPackInstallError('rollback-required', `恢复路径出现冲突，已保留两个版本：${unit.path}`)
        if (backupExists) await move(backup, destination)
        else if (unit.hadOriginal && !await toolPackStat(destination)) throw new ToolPackInstallError('rollback-required', `原工具备份暂时不可用，已保留恢复记录：${unit.path}`)
        unit.state = 'rolled-back'
        await writeToolPackRecord(journalPath, journal)
      }
      if (journal.previousPackId) await writeToolPackRecord(installedPath, { version: 1, packId: journal.previousPackId })
      else if (await toolPackStat(installedPath)) await unlink(installedPath)
      journal.phase = 'rolled-back'
      await writeToolPackRecord(journalPath, journal)
    }

    let journal: Journal | undefined
    let previousJournal: Journal | undefined
    try {
      const previous = await readToolPackRecord(journalPath)
      if (previous !== undefined) {
        const parsed = journalSchema.safeParse(previous)
        if (!parsed.success || parsed.data.installRoot !== installRoot) throw new ToolPackInstallError('invalid-record', '工具安装恢复记录损坏或属于其他目录，已保留原文件。')
        previousJournal = parsed.data
        if (['switching', 'rolling-back'].includes(parsed.data.phase)) {
          const retired = parsed.data.units.filter(unit => unit.retired)
          if (retired.length) {
            const owner = parsed.data.previousPackId ? await installedManifest(stateRoot, parsed.data.previousPackId) : undefined
            if (retired.some(unit => !owner?.units.some(previous => previous.path === unit.path && previous.kind === unit.kind))) throw new ToolPackInstallError('invalid-record', '退役工具目录不属于已安装工具清单，已保留原文件。')
          }
          await platform.assertNotBusy(installRoot, parsed.data.units)
          journal = parsed.data
          await rollback(journal)
        }
      }
      checkToolPackCancellation(options.signal)
      await assertToolPackPath(options.metadataPath)
      let metadata: ToolPackMetadata
      try { metadata = toolPackMetadataSchema.parse(JSON.parse(await readFile(options.metadataPath, 'utf8'))) } catch (error) {
        throw new ToolPackInstallError('invalid-metadata', '工具包清单损坏或版本不受支持，请重新获取完整安装包。', { cause: error })
      }
      let verifiedBytes = 0
      const totalCompressedBytes = metadata.volumes.reduce((sum, volume) => sum + volume.bytes, 0)
      for (const volume of metadata.volumes) {
        const path = toolPackChild(mediaRoot, volume.file)
        await assertToolPackPath(path)
        const file = await toolPackStat(path)
        if (!file?.isFile()) throw new ToolPackInstallError('missing-volume', `缺少工具包分卷：${volume.file}。请将所有分卷与安装程序放在同一目录。`)
        if (file.size !== volume.bytes || await toolPackHash(path, options.signal) !== volume.sha256) throw new ToolPackInstallError('volume-integrity', `工具包分卷校验失败：${volume.file}。请重新获取该分卷。`)
        verifiedBytes += volume.bytes
        progress({ phase: 'checking-media', message: '正在校验离线工具包…', completedBytes: verifiedBytes, totalBytes: totalCompressedBytes, currentPath: volume.file })
      }
      checkToolPackCancellation(options.signal)
      const installedRecord = await readToolPackRecord(installedPath)
      const installed = installedRecord === undefined ? undefined : installedSchema.safeParse(installedRecord)
      if (installed && !installed.success) throw new ToolPackInstallError('invalid-record', '工具安装版本记录损坏，已保留原文件。')
      const previousPackId = installed?.success ? installed.data.packId : null
      const previousMetadata = previousPackId ? await installedManifest(stateRoot, previousPackId) : undefined
      const incomingUnits = new Set(metadata.units.map(unit => unit.path.toLowerCase()))
      const retiredUnits = previousMetadata?.units
        .filter(unit => !incomingUnits.has(unit.path.toLowerCase()))
        .map(unit => ({ ...unit, preserve: [], retired: true })) ?? []
      await platform.assertNotBusy(installRoot, [...retiredUnits, ...metadata.units])
      for (const unit of retiredUnits) await toolPackTree(toolPackChild(installRoot, unit.path), options.signal)
      const { units, preservedBytes } = await userDataUnits(installRoot, metadata, previousMetadata, options.signal)
      const stageRoot = join(stateRoot, 'stage', metadata.id)
      await assertToolPackPath(stageRoot)
      await mkdir(stageRoot, { recursive: true })
      if (previousJournal?.packId === metadata.id) {
        for (const unit of previousJournal.units.filter(unit => !unit.retired)) {
          for (const path of unit.preserve) await resetToolPackStagedUserData(stageRoot, path)
        }
      }
      for (const unit of metadata.units) for (const path of unit.preserve) await resetToolPackStagedUserData(stageRoot, path)
      const fileIndex = new Map(metadata.files.map(file => [file.path, file]))
      const reusable = new Set<string>()
      let reusedBytes = 0
      for (const file of await toolPackTree(stageRoot, options.signal)) {
        const name = relative(stageRoot, file.path).split(sep).join('/')
        if (/^\.rainy-tmp-[a-f0-9-]{36}$/.test(name.split('/').at(-1) ?? '')) { await unlink(file.path); continue }
        const expected = fileIndex.get(name)
        if (!expected) throw new ToolPackInstallError('unexpected-staging-file', `暂存目录包含未登记文件，已保留：${name}`)
        if (file.bytes === expected.bytes && await toolPackHash(file.path, options.signal) === expected.sha256) {
          reusable.add(name)
          reusedBytes += file.bytes
        }
      }
      const requiredBytes = metadata.unpackedBytes - reusedBytes + preservedBytes + 64 * 1024 ** 2
      progress({ phase: 'checking-space', message: '正在检查目标磁盘空间…', completedBytes: 0, totalBytes: requiredBytes })
      if (await platform.availableBytes(installRoot) < requiredBytes) throw new ToolPackInstallError('insufficient-space', `目标磁盘空间不足。至少还需要 ${Math.ceil(requiredBytes / 1024 ** 2)} MiB 可用空间。`)
      journal = { version: 1, installRoot, packId: metadata.id, transactionId: randomUUID(), previousPackId, phase: 'staging', units: [...retiredUnits, ...units].map(unit => ({ ...unit, state: 'pending' })) }
      await writeToolPackRecord(journalPath, journal)
      await extractArchive(metadata, mediaRoot, stageRoot, reusable, progress, options.signal)
      progress({ phase: 'verifying', message: '全部工具文件已通过逐项校验。', completedBytes: metadata.unpackedBytes, totalBytes: metadata.unpackedBytes })
      checkToolPackCancellation(options.signal)
      for (const unit of units) {
        for (const path of unit.preserve) {
          progress({ phase: 'preserving', message: '正在保留已有工具设置和用户数据…', completedBytes: 0, totalBytes: preservedBytes, currentPath: path })
          await copyToolPackUserData(toolPackChild(installRoot, path), toolPackChild(stageRoot, path), options.signal)
        }
      }
      journal.phase = 'prepared'
      await writeToolPackRecord(journalPath, journal)
      checkToolPackCancellation(options.signal)
      await platform.assertNotBusy(installRoot, journal.units)
      journal.phase = 'switching'
      await writeToolPackRecord(journalPath, journal)
      const backupRoot = join(stateRoot, 'backups', journal.transactionId)
      await assertToolPackPath(backupRoot)
      await mkdir(backupRoot, { recursive: true })
      for (const unit of journal.units) {
        checkToolPackCancellation(options.signal)
        progress({ phase: 'switching', message: '正在切换到已校验的新工具版本…', completedBytes: 0, totalBytes: metadata.unpackedBytes, currentPath: unit.path })
        const destination = toolPackChild(installRoot, unit.path)
        const staged = toolPackChild(stageRoot, unit.path)
        const backup = toolPackChild(backupRoot, unit.path)
        unit.hadOriginal = !!await toolPackStat(destination)
        unit.state = 'moving-old'
        await writeToolPackRecord(journalPath, journal)
        if (unit.hadOriginal) await move(destination, backup)
        unit.state = 'old-moved'
        await writeToolPackRecord(journalPath, journal)
        if (unit.retired) continue
        unit.state = 'moving-new'
        await writeToolPackRecord(journalPath, journal)
        await move(staged, destination)
        unit.state = 'installed'
        await writeToolPackRecord(journalPath, journal)
      }
      if (!await verifyInstalled(installRoot, metadata, options.signal)) throw new ToolPackInstallError('file-integrity', '工具切换后的文件校验失败，正在恢复旧版本。')
      const manifestPath = join(stateRoot, 'manifests', `${metadata.id}.json`)
      if (await toolPackStat(manifestPath)) await installedManifest(stateRoot, metadata.id)
      else await writeToolPackRecord(manifestPath, metadata)
      await writeToolPackRecord(installedPath, { version: 1, packId: metadata.id })
      await writeToolPackRecord(journalPath, { ...journal, phase: 'committed' })
      journal.phase = 'committed'
      progress({ phase: 'complete', message: '离线工具安装完成。', completedBytes: metadata.unpackedBytes, totalBytes: metadata.unpackedBytes })
      return { status: 'installed', packId: metadata.id, installedFiles: metadata.files.length, reusedFiles: reusable.size, backupDirectory: backupRoot }
    } catch (error) {
      if (journal?.phase === 'switching') {
        try { await rollback(journal) } catch (rollbackError) { throw new ToolPackInstallError('rollback-required', `工具安装未完成，恢复旧版本时遇到占用或文件错误。请关闭相关工具后重新运行安装程序。恢复记录：${journalPath}`, { cause: rollbackError }) }
      }
      if (journal?.phase === 'rolling-back') throw new ToolPackInstallError('rollback-required', `工具旧版本尚未恢复完成。请关闭相关工具后重试。恢复记录：${journalPath}`, { cause: error })
      throw asInstallError(error)
    } finally { await release() }
  }
}

/** Install adjacent offline volumes, retaining user files and a durable inventory for future upgrades.
 * @param options Trusted installation paths, progress callback, and optional cancellation.
 * @returns Installed pack identity and retained rollback directory.
 * Path conflicts or missing prior inventories reject without replacing tools.
 */
export async function installNativeToolPack(options: InstallNativeToolPackOptions): Promise<NativeToolPackInstallResult> {
  return createNativeToolPackInstaller(nativeToolPackPlatform)(options)
}
