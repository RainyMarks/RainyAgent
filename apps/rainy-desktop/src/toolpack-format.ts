/** Validated metadata for the offline native-tool archive and installation units. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const bytesSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Reject filesystem aliases and platform-specific path escapes before touching disk.
 * @param path Slash-separated installation-relative path.
 * @returns Whether every component is an ordinary Windows filename.
 */
export function isToolPackPath(path: string): boolean {
  return path.length > 0 && !/[\\:\x00-\x1f\x7f<>"|?*]/.test(path) && path.split('/').every(part =>
    part.length > 0 && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))
}

const pathSchema = z.string().refine(isToolPackPath, 'Unsafe installation-relative path')
const fileSchema = z.object({ path: pathSchema, bytes: bytesSchema, sha256: hashSchema }).strict()
const unitSchema = z.object({ path: pathSchema, kind: z.enum(['directory', 'file']), preserve: z.array(pathSchema) }).strict()

/** Metadata ships inside the desktop installer; adjacent archive volumes are checked against it. */
export const toolPackMetadataSchema = z.object({
  version: z.literal(1),
  id: hashSchema,
  format: z.literal('tar.gz'),
  volumeSize: z.number().int().positive().max(2 * 1024 ** 3),
  unpackedBytes: bytesSchema,
  files: z.array(fileSchema).min(1),
  units: z.array(unitSchema).min(1),
  volumes: z.array(z.object({ file: pathSchema.refine(path => !path.includes('/')), bytes: bytesSchema.refine(bytes => bytes > 0), sha256: hashSchema }).strict()).min(1),
}).strict().superRefine((metadata, context) => {
  const reject = (message: string): void => { context.addIssue({ code: 'custom', message }) }
  const paths = new Set<string>()
  const aliases = new Map<string, string>()
  for (const file of metadata.files) {
    const key = file.path.toLowerCase()
    if (paths.has(key)) reject(`Duplicate file: ${file.path}`)
    paths.add(key)
    const parts = file.path.split('/')
    for (let index = 1; index <= parts.length; index++) {
      const original = parts.slice(0, index).join('/')
      const previous = aliases.get(original.toLowerCase())
      if (previous && previous !== original) reject(`Inconsistent Windows path spelling: ${original}`)
      aliases.set(original.toLowerCase(), original)
    }
    if (!metadata.units.some(unit => unit.kind === 'file' ? file.path === unit.path : file.path.startsWith(unit.path + '/'))) reject(`File outside install units: ${file.path}`)
  }
  if (metadata.files.reduce((sum, file) => sum + file.bytes, 0) !== metadata.unpackedBytes) reject('Unpacked byte count does not match file inventory')
  const units = new Set<string>()
  for (const unit of metadata.units) {
    if (units.has(unit.path.toLowerCase())) reject(`Duplicate install unit: ${unit.path}`)
    units.add(unit.path.toLowerCase())
    if (unit.kind === 'directory' && !/^(tools\/[^/]+|runtime\/windows\/[^/]+)$/.test(unit.path)) reject(`Invalid tool directory: ${unit.path}`)
    if (unit.kind === 'file' && !['tools/manifest.json', 'tools/verified.json'].includes(unit.path)) reject(`Invalid catalog file: ${unit.path}`)
    for (const path of unit.preserve) if (unit.kind !== 'directory' || !path.startsWith(unit.path + '/')) reject(`Preserved path outside tool directory: ${path}`)
    const preserved = unit.preserve.map(path => path.toLowerCase())
    const preservedPaths = new Set(preserved)
    if (preservedPaths.size !== preserved.length) reject(`Duplicate preserved paths in ${unit.path}`)
    for (const path of preserved) {
      const parts = path.split('/')
      for (let index = 1; index < parts.length; index++) {
        if (preservedPaths.has(parts.slice(0, index).join('/'))) reject(`Overlapping preserved paths: ${path}`)
      }
    }
    for (const path of unit.preserve) {
      const parts = path.split('/')
      for (let index = 1; index <= parts.length; index++) {
        const original = parts.slice(0, index).join('/')
        const existing = aliases.get(original.toLowerCase())
        if (existing && existing !== original) reject(`Inconsistent preserved path spelling: ${original}`)
      }
    }
    if (!metadata.files.some(file => unit.kind === 'file' ? file.path === unit.path : file.path.startsWith(unit.path + '/'))) reject(`Empty installation unit: ${unit.path}`)
  }
  if (!metadata.files.some(file => file.path === 'tools/manifest.json')) reject('Tool catalog is missing')
  const expectedId = createHash('sha256').update(JSON.stringify({ files: metadata.files, units: metadata.units })).digest('hex')
  if (expectedId !== metadata.id) reject('Pack ID does not match the file and installation-unit records')
  const volumeNames = new Set<string>()
  for (const [index, volume] of metadata.volumes.entries()) {
    const expectedName = `native-tools-${metadata.id.slice(0, 16)}.tar.gz.${String(index + 1).padStart(3, '0')}`
    if (volume.file !== expectedName || volumeNames.has(volume.file.toLowerCase())) reject(`Unexpected archive volume: ${volume.file}`)
    volumeNames.add(volume.file.toLowerCase())
    if (volume.bytes > metadata.volumeSize || index < metadata.volumes.length - 1 && volume.bytes !== metadata.volumeSize) reject(`Invalid volume size: ${volume.file}`)
  }
})

/** Trusted fields after metadata parsing succeeds. */
export type ToolPackMetadata = z.infer<typeof toolPackMetadataSchema>

/** One directory or catalog file replaced atomically during the installation transaction. */
export type ToolPackUnit = ToolPackMetadata['units'][number]

/** Installer progress suitable for the maintenance window or setup log. */
export interface ToolPackProgress {
  phase: 'checking-media' | 'checking-space' | 'extracting' | 'verifying' | 'preserving' | 'switching' | 'rolling-back' | 'complete'
  message: string
  completedBytes: number
  totalBytes: number
  currentPath?: string
}

/** Installation input. All paths are chosen by the main process, not renderer content. */
export interface InstallNativeToolPackOptions {
  installRoot: string
  mediaDirectory: string
  metadataPath: string
  onProgress?(progress: ToolPackProgress): void
  signal?: AbortSignal
}

/** Successful installation including retained recovery files. */
export interface NativeToolPackInstallResult {
  status: 'installed'
  packId: string
  installedFiles: number
  reusedFiles: number
  backupDirectory: string
}

/** Platform calls that own free-space observations, busy-process checks, and atomic renames. */
export interface ToolPackPlatform {
  availableBytes(path: string): Promise<number>
  assertNotBusy(installRoot: string, units: ToolPackUnit[]): Promise<void>
  move(source: string, destination: string): Promise<void>
}

/** Actionable installation failure; cancellation preserves verified staging files. */
export class ToolPackInstallError extends Error {
  readonly code: string
  constructor(code: string, message: string, options?: ErrorOptions) { super(message, options); this.name = 'ToolPackInstallError'; this.code = code }
}
