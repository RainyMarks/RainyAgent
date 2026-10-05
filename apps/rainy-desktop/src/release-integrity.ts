/** Authenticated inventory for Rainy-owned release resources; user data is never inventoried. */
import { createHash, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { ReleaseKeyring } from './release-trust.ts'

/** Domain separation restricts signatures to RainyAgent resource inventories. */
export const RELEASE_SIGNATURE_DOMAIN = 'RainyAgent/release-manifest/v1\0'
/** Paths are relative to the signed resource root and cannot escape it. */
export const releaseManifestSchema = z.object({ version: z.literal(1), product: z.literal('RainyAgent'),
  buildVersion: z.string().min(1).max(100), createdAt: z.iso.datetime(), keyId: z.string().regex(/^[a-f0-9]{32}$/),
  files: z.array(z.object({ path: z.string().min(1).max(4096).refine(value => !value.includes('\\') && !value.includes('\0')
    && !value.includes(':') && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..')),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() }).strict()).min(1).max(100000),
}).strict().refine(value => new Set(value.files.map(file => file.path.toLowerCase())).size === value.files.length, '资源清单包含重复路径')

/** Canonical payload signed by the build's release key. */
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>
/** Signed envelope whose decoded bytes remain unchanged during verification. */
export interface SignedReleaseManifest { readonly version: 1; readonly payload: string; readonly signature: string }

/**
 * Authenticate an inventory against keys embedded in the client executable bundle.
 * @param input - untrusted signed JSON read from release resources.
 * @param keys - release-owned public keys, independent of the manifest.
 * @returns the authenticated resource list.
 */
export function authenticateReleaseManifest(input: unknown, keys: ReleaseKeyring): ReleaseManifest {
  const signed = z.object({ version: z.literal(1), payload: z.string().max(32 * 1024 * 1024), signature: z.string().max(128) })
    .strict().parse(input)
  const bytes = Buffer.from(signed.payload, 'base64url')
  const signature = Buffer.from(signed.signature, 'base64url')
  if (bytes.toString('base64url') !== signed.payload || signature.toString('base64url') !== signed.signature || signature.length !== 64) throw new Error('发行清单编码无效')
  const manifest = releaseManifestSchema.parse(JSON.parse(bytes.toString('utf8')))
  const key = keys.keys[manifest.keyId]
  if (!key || !verify(null, Buffer.concat([Buffer.from(RELEASE_SIGNATURE_DOMAIN), bytes]), key, signature)) throw new Error('发行清单签名无效')
  return manifest
}

/**
 * Check signed resources before starting their processes; symbolic links and path escapes are refused.
 * @param root - release-owned resource directory.
 * @param signedPath - signed inventory path.
 * @param keys - public keys embedded in the carrier bundle.
 * @returns inventory metadata after every declared resource matches.
 */
export async function verifyReleaseResources(root: string, signedPath: string, keys: ReleaseKeyring): Promise<ReleaseManifest> {
  const manifest = authenticateReleaseManifest(JSON.parse(await readFile(signedPath, 'utf8')), keys)
  const canonicalRoot = await realpath(root)
  for (const expected of manifest.files) {
    const path = resolve(canonicalRoot, ...expected.path.split('/'))
    const local = relative(canonicalRoot, path)
    if (!local || isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) throw new Error('发行资源路径越界')
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.bytes) throw new Error(`发行资源损坏：${expected.path}`)
    if (await realpath(path) !== path) throw new Error(`发行资源路径被替换：${expected.path}`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) {
      if (!Buffer.isBuffer(chunk)) throw new Error('发行资源读取格式无效')
      hash.update(chunk)
    }
    if (hash.digest('hex') !== expected.sha256) throw new Error(`发行资源校验失败：${expected.path}`)
  }
  return manifest
}
