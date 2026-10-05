/** Atomic, serialized local records encrypted by the desktop operating-system vault. */
import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'

/** Operating-system protection supplied by Electron safeStorage in desktop processes. */
export interface LocalSecretProtection {
  /** Encrypt UTF-8 JSON with the current operating-system account. @param value - plaintext. @returns protected bytes. */
  encrypt(value: string): Buffer
  /** Decrypt protected JSON. @param value - protected bytes. @returns plaintext; throws for corrupt or foreign-account data. */
  decrypt(value: Buffer): string
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * Atomically replace a record without following an existing symbolic link.
 * @param path - application-owned record path.
 * @param bytes - complete serialized record.
 * @returns after the flushed replacement has been published.
 */
export async function writePrivateRecord(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('本地记录路径不是普通文件')
  } catch (error) { if (!missing(error)) throw error }
  const temporary = join(dirname(path), `.rainy-${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  let published = false
  try {
    try { await file.writeFile(bytes); await file.sync() }
    finally { await file.close() }
    await rename(temporary, path)
    published = true
  } finally {
    if (!published) {
      try { await unlink(temporary) }
      catch (error) { if (!missing(error)) throw error }
    }
  }
}

/** Instance-owned transaction queue for an encrypted JSON database. */
export class ProtectedJsonStore<T> {
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly options: {
    readonly path: string
    readonly protection: LocalSecretProtection
    readonly parse: (value: unknown) => T
    readonly create: () => T
    readonly maxBytes: number
  }) {}

  private async load(): Promise<T> {
    let bytes: Buffer
    try {
      const info = await lstat(this.options.path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > this.options.maxBytes) throw new Error('本地记录文件无效或过大')
      bytes = await readFile(this.options.path)
    } catch (error) { if (missing(error)) return this.options.create(); throw error }
    if (bytes.byteLength > this.options.maxBytes) throw new Error('本地记录文件过大')
    return this.options.parse(JSON.parse(this.options.protection.decrypt(bytes)))
  }

  /**
   * Read after preceding transactions finish; malformed records are never reset silently.
   * @returns a detached validated database value.
   */
  async read(): Promise<T> {
    await this.queue
    return this.load()
  }

  /**
   * Serialize one transaction and publish only a validated, successfully protected replacement.
   * @param change - synchronous mutation of this transaction's detached record.
   * @returns the mutation's result after its database write commits.
   */
  update<R>(change: (record: T) => R): Promise<R> {
    const operation = this.queue.then(async () => {
      const record = await this.load()
      const result = change(record)
      const validated = this.options.parse(record)
      const bytes = this.options.protection.encrypt(JSON.stringify(validated))
      if (bytes.byteLength > this.options.maxBytes) throw new Error('本地记录超过容量限制，请先导出归档')
      await writePrivateRecord(this.options.path, bytes)
      return result
    })
    this.queue = operation.then(() => {}, () => {})
    return operation
  }

  /**
   * Replace only an unreadable database after preserving its original protected bytes.
   * @param replacement - backup content already authenticated by the record owner.
   * @returns the preserved corrupt-record path after atomic replacement.
   */
  recover(replacement: T): Promise<string> {
    const operation = this.queue.then(async () => {
      let unreadable = false
      try { await this.load() }
      catch (_invalidRecord) { unreadable = true }
      if (!unreadable) throw new Error('本地数据库可以正常读取，请使用合并恢复')
      const info = await lstat(this.options.path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('无法恢复非普通文件的数据库路径')
      const value = this.options.parse(replacement)
      const bytes = this.options.protection.encrypt(JSON.stringify(value))
      if (bytes.byteLength > this.options.maxBytes) throw new Error('备份内容超过数据库容量限制')
      const preservedPath = this.options.path + `.corrupt-${randomUUID()}`
      await copyFile(this.options.path, preservedPath, constants.COPYFILE_EXCL)
      await writePrivateRecord(this.options.path, bytes)
      return preservedPath
    })
    this.queue = operation.then(() => {}, () => {})
    return operation
  }
}
