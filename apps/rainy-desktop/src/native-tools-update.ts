/** Authenticate a tool-channel revision before accepting new launch entries and archive hashes. */
import { createHash, verify } from 'node:crypto'
import { z } from 'zod'
import type { ReleaseKeyring } from './release-trust.ts'
import { toolPackMetadataSchema } from './toolpack-format.ts'
import { parseNativeToolCatalog } from './native-tools.ts'

/** Tool-channel signatures cannot be reused as application resource signatures. */
export const TOOL_CHANNEL_SIGNATURE_DOMAIN = 'RainyAgent/tool-channel/v1\0'
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const keyId = z.string().regex(/^[a-f0-9]{32}$/)
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** Pinned archive URLs, transport hashes and tool-pack identity supplied by the publisher. */
export const toolDownloadSourceSchema = z.object({ version: z.literal(1), packId: hash,
  baseUrl: z.string().regex(/^https:\/\/github\.com\/RainyMarks\/RainyAgent\/releases\/download\/v\d+\.\d+\.\d+-resources\/$/),
  volumes: z.array(z.object({ path: z.string().regex(/^native-tools-[a-f0-9]{16}\.tar\.gz\.\d{3}$/),
    category: z.literal('offline'), bytes, sha256: hash,
    pieces: z.array(z.object({ file: z.string().regex(/^rainy-[a-f0-9]{20}\.\d{3}$/), bytes, sha256: hash }).strict()).min(1),
  }).strict()).min(1),
}).strict()
/** Validated downloadable archive selection. */
export type NativeToolsDownloadSource = z.infer<typeof toolDownloadSourceSchema>
const channelSchema = z.object({ version: z.literal(1), revision: z.number().int().positive(),
  releaseVersion: z.string().regex(/^\d+\.\d+\.\d+$/), keyId,
  source: toolDownloadSourceSchema, metadata: toolPackMetadataSchema, catalog: z.string().min(1),
}).strict()
/** Authenticated channel revision, including exact catalog bytes and installation metadata. */
export type NativeToolsChannel = z.infer<typeof channelSchema>

/** Check matching archive identities and volume hashes.
 * @param source - validated transport selection.
 * @param metadata - validated installation inventory.
 */
export function validateToolDownloadInputs(source: NativeToolsDownloadSource, metadata: z.infer<typeof toolPackMetadataSchema>): void {
  if (source.packId !== metadata.id || source.volumes.length !== metadata.volumes.length) throw new Error('工具下载清单与当前安装包不匹配')
  const names = new Set<string>()
  for (const [index, volume] of source.volumes.entries()) {
    const expected = metadata.volumes[index]
    if (volume.path !== expected.file || volume.bytes !== expected.bytes || volume.sha256 !== expected.sha256
      || volume.pieces.reduce((sum, piece) => sum + piece.bytes, 0) !== volume.bytes) throw new Error('工具下载分卷校验信息不匹配')
    for (const piece of volume.pieces) {
      if (names.has(piece.file)) throw new Error('工具下载分片重复')
      names.add(piece.file)
    }
  }
}

/** Verify a revision using only the carrier's trust anchors, then validate every installation input.
 * @param input - untrusted channel envelope.
 * @param keys - public keys embedded in the executable.
 * @returns authenticated tool channel; unsigned, modified or mismatched inputs reject.
 */
export function authenticateToolChannel(input: unknown, keys: ReleaseKeyring): NativeToolsChannel {
  const envelope = z.object({ version: z.literal(1), payload: z.string().max(14 * 1024 ** 2),
    signature: z.string().max(200) }).strict().parse(input)
  const payload = Buffer.from(envelope.payload, 'base64')
  const raw: unknown = JSON.parse(payload.toString('utf8'))
  const identity = z.object({ keyId }).parse(raw)
  const key = keys.keys[identity.keyId]
  if (!key || !verify(null, Buffer.concat([Buffer.from(TOOL_CHANNEL_SIGNATURE_DOMAIN), payload]), key, Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('工具更新签名无效，请重试或更新 RainyAgent')
  }
  const channel = channelSchema.parse(raw)
  validateToolDownloadInputs(channel.source, channel.metadata)
  const file = channel.metadata.files.find(entry => entry.path === 'tools/manifest.json')
  if (!file || Buffer.byteLength(channel.catalog) !== file.bytes || createHash('sha256').update(channel.catalog).digest('hex') !== file.sha256) throw new Error('工具更新目录摘要不匹配')
  parseNativeToolCatalog(channel.catalog)
  return channel
}
