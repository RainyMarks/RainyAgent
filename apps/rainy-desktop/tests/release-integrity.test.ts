/** Resource authenticity uses real build signatures and filesystem mutation evidence. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { authenticateReleaseManifest, RELEASE_SIGNATURE_DOMAIN, verifyReleaseResources } from '../src/release-integrity.ts'
import { embeddedReleaseKeys, parseReleaseKeyring, releasePublicKeyId } from '../src/release-trust.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 5 }))) })

it.each([
  { name: 'host.js', contents: 'published host bytes' },
  { name: 'app-update.yml', contents: 'provider: github\nowner: RainyMarks\nrepo: RainyAgent\n' },
])('authenticates $name and refuses both changed bytes and forged inventory', async ({ name, contents }) => {
  const directory = await mkdtemp(join(tmpdir(), 'rainy-integrity-'))
  directories.push(directory)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keyId = releasePublicKeyId(pem)
  const keys = parseReleaseKeyring({ version: 1, keys: { [keyId]: pem } })
  const bytes = Buffer.from(contents)
  await writeFile(join(directory, name), bytes)
  const input = { version: 1, product: 'RainyAgent', buildVersion: 'test', createdAt: new Date().toISOString(), keyId,
    files: [{ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }
  const envelope = (value: object) => {
    const payload = Buffer.from(JSON.stringify(value))
    return { version: 1, payload: payload.toString('base64url'),
      signature: sign(null, Buffer.concat([Buffer.from(RELEASE_SIGNATURE_DOMAIN), payload]), privateKey).toString('base64url') }
  }
  const signed = envelope(input)
  const path = join(directory, 'release-manifest.signed.json')
  await writeFile(path, JSON.stringify(signed))
  expect((await verifyReleaseResources(directory, path, keys)).buildVersion).toBe('test')
  const forged = { ...signed, payload: Buffer.from(JSON.stringify({ ...input, buildVersion: 'forged' })).toString('base64url') }
  expect(() => authenticateReleaseManifest(forged, keys)).toThrow('签名')
  const changed = Buffer.from(bytes)
  changed.writeUInt8(changed.readUInt8(0) ^ 1, 0)
  await writeFile(join(directory, name), changed)
  await expect(verifyReleaseResources(directory, path, keys)).rejects.toThrow('资源')
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(signed)
  expect(() => authenticateReleaseManifest(envelope({ ...input, files: [{ ...input.files[0], path: '../outside.js' }] }), keys)).toThrow()
})

it('rejects empty, private, non-Ed25519, and mismatched public trust data', () => {
  expect(() => parseReleaseKeyring({ version: 1, keys: {} })).toThrow('缺少')
  expect(() => parseReleaseKeyring({ version: 1, keys: { ['a'.repeat(32)]: '-----BEGIN PRIVATE KEY-----\nfixture' } })).toThrow('只能包含发行公钥')
  const { publicKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  expect(() => parseReleaseKeyring({ version: 1, keys: { ['a'.repeat(32)]: pem } })).toThrow('标识')
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
  expect(() => releasePublicKeyId(rsa)).toThrow('Ed25519')
  expect(embeddedReleaseKeys()).toBeUndefined()
})
