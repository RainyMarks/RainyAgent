/** Online media checks, resumable requests and durable native-tool installation. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { c } from 'tar'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeToolsDownloader } from '../src/native-tools-download.ts'
import { createNativeToolPackInstaller } from '../src/toolpack.ts'
import { releasePublicKeyId } from '../src/release-trust.ts'
import { TOOL_CHANNEL_SIGNATURE_DOMAIN } from '../src/native-tools-update.ts'
import { NativeToolsLibrary } from '../src/native-tools.ts'

const roots: string[] = []
const owners: NativeToolsDownloader[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(owners.splice(0).map(owner => owner.close()))
  for (const root of roots.splice(0)) {
    if (relative(tmpdir(), root).startsWith('..')) throw new Error('Test directory escaped temporary storage')
    await rm(root, { recursive: true, force: true })
  }
})
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

async function fixture(tool = 'alpha') {
  const root = await mkdtemp(join(tmpdir(), 'rainy-online-tools-'))
  roots.push(root)
  const input = join(root, 'input')
  const catalog = JSON.stringify({ version: 1, tools: tool === 'alpha' ? [] : [{ id: tool, category: 'misc', name: tool, version: '1',
    roots: [`tools/${tool}`], entry: { kind: 'gui', path: `tools/${tool}/app.exe`, cwd: `tools/${tool}`, args: [] } }] })
  const content = { [`tools/${tool}/app.exe`]: 'fixture executable', 'tools/manifest.json': catalog }
  for (const [path, value] of Object.entries(content)) {
    await mkdir(dirname(join(input, path)), { recursive: true })
    await writeFile(join(input, path), value)
  }
  const files = Object.entries(content).map(([path, value]) => ({ path, bytes: Buffer.byteLength(value), sha256: hash(value) }))
  const units = [{ path: `tools/${tool}`, kind: 'directory', preserve: [] }, { path: 'tools/manifest.json', kind: 'file', preserve: [] }]
  const id = hash(JSON.stringify({ files, units }))
  const chunks: Buffer[] = []
  for await (const chunk of c({ cwd: input, gzip: true, portable: true }, Object.keys(content))) chunks.push(Buffer.from(chunk))
  const archive = Buffer.concat(chunks)
  const data = [archive.subarray(0, Math.floor(archive.length / 2)), archive.subarray(Math.floor(archive.length / 2))]
  const pieces = data.map((value, index) => ({ file: `rainy-${hash(id).slice(0, 20)}.${String(index + 1).padStart(3, '0')}`,
    bytes: value.length, sha256: hash(value) }))
  const volume = { file: `native-tools-${id.slice(0, 16)}.tar.gz.001`, bytes: archive.length, sha256: hash(archive) }
  const source = { version: 1, packId: id, baseUrl: 'https://github.com/RainyMarks/RainyAgent/releases/download/v1.0.0-resources/',
    volumes: [{ path: volume.file, category: 'offline', bytes: volume.bytes, sha256: volume.sha256, pieces }] }
  const metadataPath = join(root, 'metadata.json')
  const sourcePath = join(root, 'source.json')
  await writeFile(metadataPath, JSON.stringify({ version: 1, id, format: 'tar.gz', volumeSize: archive.length,
    unpackedBytes: files.reduce((sum, file) => sum + file.bytes, 0), files, units, volumes: [volume] }))
  await writeFile(sourcePath, JSON.stringify(source))
  const transport = vi.fn<typeof fetch>(async (url, options) => {
    const index = pieces.findIndex(piece => url === source.baseUrl + piece.file)
    if (index < 0) throw new Error('Unexpected download URL')
    const value = data[index]
    const range = new Headers(options?.headers).get('range')
    if (range) {
      const offset = Number(range.slice(6, -1))
      return new Response(value.subarray(offset), { status: 206, headers: { 'content-range': `bytes ${offset}-${value.length - 1}/${value.length}` } })
    }
    return new Response(value)
  })
  const publish = vi.fn()
  const install = createNativeToolPackInstaller({ availableBytes: async () => 1024 ** 4, assertNotBusy: async () => {}, move: rename })
  const options = { installRoot: join(root, 'installed'), cacheRoot: join(root, 'cache'), metadataPath, sourcePath, publish, fetch: transport, install }
  const owner = new NativeToolsDownloader(options)
  owners.push(owner)
  return { owner, options, source, pieces, data, transport, publish, catalog }
}

function channelSigner() {
  const key = generateKeyPairSync('ed25519')
  const pem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keyId = releasePublicKeyId(pem)
  const keys = { version: 1 as const, keys: { [keyId]: pem } }
  const envelope = async (f: Awaited<ReturnType<typeof fixture>>, revision: number, releaseVersion: string) => {
    const metadata: unknown = JSON.parse(await readFile(f.options.metadataPath, 'utf8'))
    const payload = Buffer.from(JSON.stringify({ version: 1, revision, releaseVersion, keyId,
      source: f.source, metadata, catalog: f.catalog }))
    return { version: 1, payload: payload.toString('base64'), signature: sign(null, Buffer.concat([Buffer.from(TOOL_CHANNEL_SIGNATURE_DOMAIN), payload]), key.privateKey).toString('base64') }
  }
  return { keys, envelope }
}

it('installs verified media, coalesces clicks and survives a restart without downloading again', async () => {
  const h = await fixture()
  expect(await h.owner.status()).toMatchObject({ phase: 'idle', totalBytes: h.data.reduce((sum, data) => sum + data.length, 0) })
  expect(h.transport).not.toHaveBeenCalled()
  const first = h.owner.start()
  expect(h.owner.start()).toBe(first)
  await first
  expect(await readFile(join(h.options.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('fixture executable')
  expect(h.transport).toHaveBeenCalledTimes(2)
  const restarted = new NativeToolsDownloader(h.options)
  owners.push(restarted)
  expect(await restarted.status()).toMatchObject({ phase: 'complete' })
  await restarted.start()
  expect(h.transport).toHaveBeenCalledTimes(2)
  await restarted.start(true)
  expect(h.transport).toHaveBeenCalledTimes(2)
})

it('recognizes the matching pack from an earlier adjacent-volume installation', async () => {
  const h = await fixture()
  const legacy = join(dirname(h.options.installRoot), 'legacy-install')
  await mkdir(join(legacy, '.rainy-toolpack'), { recursive: true })
  await writeFile(join(legacy, '.rainy-toolpack/installed.json'), JSON.stringify({ version: 1, packId: h.source.packId }))
  await writeFile(join(legacy, '.rainy-toolpack/journal.json'), JSON.stringify({ phase: 'committed' }))
  const owner = new NativeToolsDownloader({ ...h.options, previousInstallRoot: legacy })
  owners.push(owner)
  expect(await owner.status()).toMatchObject({ phase: 'complete' })
  await owner.start()
  expect(h.transport).not.toHaveBeenCalled()
})

it('continues a partial piece using Range and verifies its complete bytes before installation', async () => {
  const h = await fixture()
  await mkdir(h.options.cacheRoot)
  await writeFile(join(h.options.cacheRoot, h.pieces[0].file + '.partial'), h.data[0].subarray(0, 8))
  await h.owner.start()
  expect(new Headers(h.transport.mock.calls[0][1]?.headers).get('range')).toBe('bytes=8-')
  expect(await h.owner.installed()).toBe(true)
})

it('restarts a partial piece when the server ignores Range', async () => {
  const h = await fixture()
  await mkdir(h.options.cacheRoot)
  await writeFile(join(h.options.cacheRoot, h.pieces[0].file + '.partial'), h.data[0].subarray(0, 8))
  h.transport.mockImplementationOnce(async () => new Response(h.data[0]))
  await h.owner.start()
  expect(await h.owner.installed()).toBe(true)
})

it('rejects changed data and mismatched carrier metadata before publishing an installed pack', async () => {
  const h = await fixture()
  h.transport.mockImplementationOnce(async () => new Response(Buffer.alloc(h.data[0].length, 1)))
  await expect(h.owner.start()).rejects.toThrow('校验失败')
  expect(await h.owner.installed()).toBe(false)
  expect(await h.owner.status()).toMatchObject({ phase: 'error' })
  await h.owner.start()
  expect(await h.owner.installed()).toBe(true)
  await writeFile(h.options.sourcePath, JSON.stringify({ ...h.source, packId: 'b'.repeat(64) }))
  const invalid = new NativeToolsDownloader(h.options)
  owners.push(invalid)
  h.transport.mockClear()
  await expect(invalid.start()).rejects.toThrow('不匹配')
  expect(h.transport).not.toHaveBeenCalled()
})

it('cancels a blocked request, waits for cleanup and resumes using the same local cache', async () => {
  const h = await fixture()
  const entered = Promise.withResolvers<undefined>()
  h.transport.mockImplementationOnce((_url, options) => new Promise<Response>((_resolve, reject) => {
    entered.resolve(undefined)
    options?.signal?.addEventListener('abort', () => { reject(new DOMException('Cancelled', 'AbortError')) }, { once: true })
  }))
  const running = h.owner.start()
  await entered.promise
  await h.owner.cancel()
  await running
  expect(await h.owner.status()).toMatchObject({ phase: 'cancelled' })
  await h.owner.start()
  expect(await h.owner.installed()).toBe(true)
  await h.owner.close()
  await expect(h.owner.start()).rejects.toThrow('关闭')
})

it('keeps installed tools available after a repair is cancelled before directories switch', async () => {
  const h = await fixture('beta-tool')
  await h.owner.start()
  const cancelling: NativeToolsDownloader = new NativeToolsDownloader({ ...h.options, install: options => h.options.install({ ...options,
    onProgress: (update) => { if (update.phase === 'extracting') void cancelling.cancel() } }) })
  owners.push(cancelling)
  await cancelling.start(true)
  expect(await cancelling.status()).toMatchObject({ phase: 'cancelled' })
  expect(JSON.parse(await readFile(join(h.options.installRoot, '.rainy-toolpack/journal.json'), 'utf8'))).toMatchObject({ phase: 'staging' })
  expect(await cancelling.hasInstalledTools()).toBe(true)
  expect(await cancelling.installed()).toBe(true)
  const library = new NativeToolsLibrary({ installRoot: h.options.installRoot, userData: dirname(h.options.installRoot), start: vi.fn() })
  expect((await library.listTools()).tools).toMatchObject([{ id: 'beta-tool', status: 'ready' }])
})

it('reads carrier inputs again after a failed read', async () => {
  const h = await fixture()
  const moved = h.options.sourcePath + '.moved'
  await rename(h.options.sourcePath, moved)
  await expect(h.owner.status()).rejects.toMatchObject({ code: 'ENOENT' })
  await rename(moved, h.options.sourcePath)
  expect(await h.owner.status()).toMatchObject({ phase: 'idle' })
})

it('replaces an unreadable cached channel instead of blocking status and update checks', async () => {
  const h = await fixture()
  const { keys, envelope } = channelSigner()
  const channel = await envelope(h, 1, '1.0.0')
  await mkdir(h.options.cacheRoot)
  await writeFile(join(h.options.cacheRoot, 'channel.signed.json'), '')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const owner = new NativeToolsDownloader({ ...h.options, updateKeys: keys, fetch: async () => new Response(JSON.stringify(channel)) })
  owners.push(owner)
  expect(await owner.status()).toMatchObject({ phase: 'idle' })
  expect(error).toHaveBeenCalledOnce()
  expect(await owner.checkUpdates()).toMatchObject({ phase: 'available', version: '1.0.0' })
  expect(JSON.parse(await readFile(join(h.options.cacheRoot, 'channel.signed.json'), 'utf8'))).toEqual(channel)
})

it('removes a joined volume that fails verification and keeps its verified pieces', async () => {
  const h = await fixture()
  const sha256 = 'f'.repeat(64)
  const metadata = JSON.parse(await readFile(h.options.metadataPath, 'utf8')) as { volumes: Array<{ sha256: string }> }
  metadata.volumes[0].sha256 = sha256
  await writeFile(h.options.metadataPath, JSON.stringify(metadata))
  await writeFile(h.options.sourcePath, JSON.stringify({ ...h.source, volumes: [{ ...h.source.volumes[0], sha256 }] }))
  await expect(h.owner.start()).rejects.toThrow('工具分卷校验失败')
  expect((await readdir(h.options.cacheRoot)).sort()).toEqual(h.pieces.map(piece => piece.file).sort())
})

it('rejects an invalid resumable response without installing or accepting its bytes', async () => {
  const h = await fixture()
  h.transport.mockImplementationOnce(async () => new Response(h.data[0], { status: 206, headers: { 'content-range': 'bytes 1-2/3' } }))
  await expect(h.owner.start()).rejects.toThrow('续传响应无效')
  expect(await h.owner.installed()).toBe(false)
})

it('detects a signed added tool, keeps the installed pack during checks and rejects replay or tampering', async () => {
  const h = await fixture()
  const future = await fixture('future-tool')
  const { keys, envelope } = channelSigner()
  const current = await envelope(h, 1, '1.0.0')
  const next = await envelope(future, 2, '1.0.1')
  let channel = current
  let media = h.transport
  const fetchChannel = vi.fn<typeof fetch>(async (url, init) => (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).includes('raw.githubusercontent.com') ? new Response(JSON.stringify(channel)) : media(url, init))
  const owner = new NativeToolsDownloader({ ...h.options, updateKeys: keys, fetch: fetchChannel })
  owners.push(owner)
  expect(await owner.checkUpdates()).toMatchObject({ phase: 'available', version: '1.0.0' })
  await owner.start()
  expect(await owner.checkUpdates()).toMatchObject({ phase: 'current' })
  channel = next
  media = future.transport
  expect(await owner.checkUpdates()).toMatchObject({ phase: 'available', version: '1.0.1' })
  expect(await owner.hasInstalledTools()).toBe(true)
  expect(await owner.installed()).toBe(false)
  await owner.start(true)
  const library = new NativeToolsLibrary({ installRoot: h.options.installRoot, userData: dirname(h.options.installRoot), start: vi.fn() })
  expect((await library.listTools()).tools[0]).toMatchObject({ id: 'future-tool', status: 'ready' })
  channel = current
  expect(await owner.checkUpdates()).toMatchObject({ phase: 'error', error: '工具更新版本倒退或清单冲突' })
  channel = { ...next, signature: 'invalid' }
  expect(await owner.checkUpdates()).toMatchObject({ phase: 'error' })
  expect((await library.listTools()).tools[0]).toMatchObject({ id: 'future-tool', status: 'ready' })
  const restarted = new NativeToolsDownloader({ ...h.options, updateKeys: keys, fetch: fetchChannel })
  owners.push(restarted)
  expect(await restarted.installed()).toBe(true)
  fetchChannel.mockClear()
  await restarted.start()
  expect(fetchChannel).not.toHaveBeenCalled()
})
