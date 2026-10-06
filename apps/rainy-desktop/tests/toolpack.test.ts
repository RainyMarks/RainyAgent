/** Offline installation failures, cancellation, user-data preservation, and rollback. */
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { c } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { createNativeToolPackInstaller, ToolPackInstallError } from '../src/toolpack.ts'
import { toolPackMetadataSchema } from '../src/toolpack-format.ts'
import type { ToolPackMetadata, ToolPackPlatform } from '../src/toolpack-format.ts'
import { findBusyToolPackProcess } from '../src/toolpack-platform.ts'
import { renameToolPackPath, writeToolPackRecord } from '../src/toolpack-files.ts'
import { nativeConsoleCommand } from '../src/native-tool-process.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')

async function put(root: string, path: string, value: string | Buffer): Promise<void> {
  const destination = join(root, ...path.split('/'))
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, value)
}

async function fixture(preserve: string[] = [], changes: Record<string, string> = {}, omittedUnits: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'rainy-toolpack-'))
  roots.push(root)
  const source = join(root, 'source')
  const installRoot = join(root, 'installed')
  const mediaDirectory = join(root, 'media')
  const metadataPath = join(root, 'metadata.json')
  await Promise.all([source, installRoot, mediaDirectory].map(path => mkdir(path)))
  const content: Record<string, string> = Object.fromEntries(Object.entries({
    'tools/alpha/app.exe': 'new alpha executable',
    'tools/alpha/config/settings.json': '{"theme":"default"}',
    'tools/beta/app.exe': 'new beta executable',
    'tools/manifest.json': '{"version":1,"tools":[]}',
    ...changes,
  }).filter(([path]) => !omittedUnits.some(unit => path === unit || path.startsWith(unit + '/'))))
  for (const [path, value] of Object.entries(content)) await put(source, path, value)
  const files = Object.entries(content)
    .map(([path, value]) => ({ path, bytes: Buffer.byteLength(value), sha256: hash(value) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const units: ToolPackMetadata['units'] = ([
    { path: 'tools/alpha', kind: 'directory', preserve },
    { path: 'tools/beta', kind: 'directory', preserve: [] },
    { path: 'tools/manifest.json', kind: 'file', preserve: [] },
  ] satisfies ToolPackMetadata['units']).filter(unit => !omittedUnits.includes(unit.path))
  const id = hash(JSON.stringify({ files, units }))
  const metadata: ToolPackMetadata = { version: 1, id, format: 'tar.gz', volumeSize: 128, unpackedBytes: files.reduce((sum, file) => sum + file.bytes, 0), files, units, volumes: [] }
  async function archive(paths = files.map(file => file.path)): Promise<void> {
    const packed: Buffer[] = []
    for await (const chunk of c({ cwd: source, gzip: true, portable: true, noDirRecurse: true, mtime: new Date(0) }, paths)) {
      packed.push(Buffer.from(chunk))
    }
    const bytes = Buffer.concat(packed)
    metadata.volumes = []
    for (let offset = 0, index = 1; offset < bytes.length; offset += metadata.volumeSize, index++) {
      const data = bytes.subarray(offset, offset + metadata.volumeSize)
      const file = `native-tools-${id.slice(0, 16)}.tar.gz.${String(index).padStart(3, '0')}`
      await writeFile(join(mediaDirectory, file), data)
      metadata.volumes.push({ file, bytes: data.length, sha256: hash(data) })
    }
    await writeFile(metadataPath, JSON.stringify(metadata))
  }
  await archive()
  const platform: ToolPackPlatform = { availableBytes: async () => 1024 ** 4, assertNotBusy: async () => {}, move: rename }
  const options = { installRoot, mediaDirectory, metadataPath }
  return { root, source, installRoot, mediaDirectory, metadataPath, metadata, content, platform, options, archive }
}

async function upgradeFixture(
  preserve: string[] = [], oldFiles: Record<string, string> = {}, newFiles: Record<string, string> = {}, omittedUnits: string[] = [],
) {
  const previous = await fixture(preserve, {
    'tools/alpha/app.exe': 'old alpha',
    'tools/beta/app.exe': 'old beta',
    ...oldFiles,
  })
  await createNativeToolPackInstaller(previous.platform)(previous.options)
  const next = await fixture(preserve, newFiles, omittedUnits)
  return { ...next, installRoot: previous.installRoot, options: { ...next.options, installRoot: previous.installRoot }, previous }
}

describe('native tool pack installation', () => {
  it('streams verified split volumes into an installation and retains a transaction receipt', async () => {
    const test = await fixture()
    expect(test.metadata.volumes.length).toBeGreaterThan(1)
    const result = await createNativeToolPackInstaller(test.platform)(test.options)
    expect(result).toMatchObject({ status: 'installed', installedFiles: 4, reusedFiles: 0, packId: test.metadata.id })
    for (const [path, content] of Object.entries(test.content)) expect(await readFile(join(test.installRoot, path), 'utf8')).toBe(content)
    expect(JSON.parse(await readFile(join(test.installRoot, '.rainy-toolpack/journal.json'), 'utf8'))).toMatchObject({ phase: 'committed' })
  })

  it('reports a missing volume before replacing any existing tool', async () => {
    const test = await upgradeFixture()
    await unlink(join(test.mediaDirectory, test.metadata.volumes.at(-1)!.file))
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'missing-volume' })
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
  })

  it('rejects a same-size corrupt volume before staging', async () => {
    const test = await fixture()
    const volume = test.metadata.volumes[0]
    const bytes = await readFile(join(test.mediaDirectory, volume.file))
    bytes[bytes.length - 1] ^= 1
    await writeFile(join(test.mediaDirectory, volume.file), bytes)
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'volume-integrity' })
    await expect(readFile(join(test.installRoot, 'tools/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects insufficient free space without touching the old installation', async () => {
    const test = await upgradeFixture()
    test.platform.availableBytes = async () => 0
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'insufficient-space' })
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
  })

  it('cancels after a verified file and reuses that file on retry', async () => {
    const test = await fixture()
    const cancellation = new AbortController()
    await expect(createNativeToolPackInstaller(test.platform)({ ...test.options, signal: cancellation.signal, onProgress(update) { if (update.phase === 'extracting') cancellation.abort() } })).rejects.toMatchObject({ code: 'cancelled' })
    await expect(readFile(join(test.installRoot, 'tools/alpha/app.exe'))).rejects.toMatchObject({ code: 'ENOENT' })
    const result = await createNativeToolPackInstaller(test.platform)(test.options)
    expect(result.reusedFiles).toBeGreaterThanOrEqual(1)
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('new alpha executable')
  })

  it('preserves declared user settings and data while replacing program files', async () => {
    const test = await upgradeFixture(['tools/alpha/config'])
    await put(test.installRoot, 'tools/alpha/config/settings.json', '{"theme":"personal"}')
    await put(test.installRoot, 'tools/alpha/config/history/one.json', 'personal history')
    const result = await createNativeToolPackInstaller(test.platform)(test.options)
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('new alpha executable')
    expect(await readFile(join(test.installRoot, 'tools/alpha/config/settings.json'), 'utf8')).toBe('{"theme":"personal"}')
    expect(await readFile(join(test.installRoot, 'tools/alpha/config/history/one.json'), 'utf8')).toBe('personal history')
    expect(await readFile(join(result.backupDirectory, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
  })

  it.each([
    { installation: 'first installation', upgrade: false },
    { installation: 'version upgrade', upgrade: true },
  ])('retains disjoint user output in place during a $installation', async ({ upgrade }) => {
    const test = upgrade
      ? await upgradeFixture([], { 'tools/alpha/obsolete.dll': 'old program component' })
      : await fixture()
    await put(test.installRoot, 'tools/alpha/output/report.txt', 'personal output')
    await createNativeToolPackInstaller(test.platform)(test.options)
    expect(await readFile(join(test.installRoot, 'tools/alpha/output/report.txt'), 'utf8')).toBe('personal output')
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('new alpha executable')
    await expect(readFile(join(test.installRoot, 'tools/alpha/obsolete.dll'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(test.installRoot, `.rainy-toolpack/manifests/${test.metadata.id}.json`), 'utf8'))).toEqual(test.metadata)
  })

  it.each([
    { upgrade: true, userPath: 'tools/alpha/OUTPUT.txt', incomingPath: 'tools/alpha/output.txt' },
    { upgrade: true, userPath: 'tools/alpha/OUTPUT', incomingPath: 'tools/alpha/output/report.txt' },
    { upgrade: true, userPath: 'tools/alpha/OUTPUT/report.txt', incomingPath: 'tools/alpha/output' },
    { upgrade: false, userPath: 'tools/alpha/output/report.txt', incomingPath: 'tools/alpha/output/report.txt' },
  ])('rejects user path $userPath conflicting with $incomingPath before any move (upgrade: $upgrade)', async ({ upgrade, userPath, incomingPath }) => {
    const incomingFiles = { [incomingPath]: 'new program component' }
    const test = upgrade ? await upgradeFixture([], {}, incomingFiles) : await fixture([], incomingFiles)
    await put(test.installRoot, userPath, 'personal output')
    let moves = 0
    test.platform.move = async (source, destination) => { moves++; await rename(source, destination) }
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'user-data-conflict' })
    expect(moves).toBe(0)
    expect(await readFile(join(test.installRoot, userPath), 'utf8')).toBe('personal output')
    if (upgrade) expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
    else await expect(readFile(join(test.installRoot, 'tools/alpha/app.exe'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refreshes dynamically preserved output after cancellation and does not revive a deleted file on retry', async () => {
    const test = await upgradeFixture()
    await put(test.installRoot, 'tools/alpha/output/deleted.txt', 'temporary output')
    await put(test.installRoot, 'tools/alpha/output/retained.txt', 'original output')
    const cancellation = new AbortController()
    let checks = 0
    test.platform.assertNotBusy = async () => { if (++checks === 2) cancellation.abort() }
    await expect(createNativeToolPackInstaller(test.platform)({ ...test.options, signal: cancellation.signal })).rejects.toMatchObject({ code: 'cancelled' })
    expect(await readFile(join(test.installRoot, '.rainy-toolpack/stage', test.metadata.id, 'tools/alpha/output/deleted.txt'), 'utf8')).toBe('temporary output')
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
    await unlink(join(test.installRoot, 'tools/alpha/output/deleted.txt'))
    await put(test.installRoot, 'tools/alpha/output/retained.txt', 'updated output')
    test.platform.assertNotBusy = async () => {}
    await createNativeToolPackInstaller(test.platform)(test.options)
    await expect(readFile(join(test.installRoot, 'tools/alpha/output/deleted.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(test.installRoot, 'tools/alpha/output/retained.txt'), 'utf8')).toBe('updated output')
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('new alpha executable')
  })

  it('rejects an installed record whose previous manifest is missing before replacing tools', async () => {
    const test = await upgradeFixture()
    await put(test.installRoot, 'tools/alpha/output/report.txt', 'personal output')
    await unlink(join(test.installRoot, `.rainy-toolpack/manifests/${test.previous.metadata.id}.json`))
    let moves = 0
    test.platform.move = async (source, destination) => { moves++; await rename(source, destination) }
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'invalid-record' })
    expect(moves).toBe(0)
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
    expect(await readFile(join(test.installRoot, 'tools/alpha/output/report.txt'), 'utf8')).toBe('personal output')
    expect(JSON.parse(await readFile(join(test.installRoot, '.rainy-toolpack/installed.json'), 'utf8'))).toMatchObject({ packId: test.previous.metadata.id })
  })

  it('refreshes copied user data after cancellation instead of restoring a file the user removed before retry', async () => {
    const test = await fixture(['tools/alpha/config', 'tools/alpha/data'])
    await put(test.installRoot, 'tools/alpha/config/personal.json', 'temporary personal data')
    const cancellation = new AbortController()
    await expect(createNativeToolPackInstaller(test.platform)({ ...test.options, signal: cancellation.signal, onProgress(update) {
      if (update.phase === 'preserving' && update.currentPath === 'tools/alpha/data') cancellation.abort()
    } })).rejects.toMatchObject({ code: 'cancelled' })
    await unlink(join(test.installRoot, 'tools/alpha/config/personal.json'))
    await createNativeToolPackInstaller(test.platform)(test.options)
    await expect(readFile(join(test.installRoot, 'tools/alpha/config/personal.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back earlier directory switches when a later tool is locked', async () => {
    const test = await upgradeFixture()
    await put(test.installRoot, 'tools/alpha/output/report.txt', 'personal output')
    let blocked = false
    test.platform.move = async (source, destination) => {
      if (!blocked && source.includes(join('.rainy-toolpack', 'stage')) && destination === join(test.installRoot, 'tools/beta')) { blocked = true; throw Object.assign(new Error('Tool is in use'), { code: 'EBUSY' }) }
      await rename(source, destination)
    }
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'install-failed' })
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
    expect(await readFile(join(test.installRoot, 'tools/beta/app.exe'), 'utf8')).toBe('old beta')
    expect(await readFile(join(test.installRoot, 'tools/alpha/output/report.txt'), 'utf8')).toBe('personal output')
    expect(JSON.parse(await readFile(join(test.installRoot, '.rainy-toolpack/installed.json'), 'utf8'))).toMatchObject({ packId: test.previous.metadata.id })
    expect(JSON.parse(await readFile(join(test.installRoot, '.rainy-toolpack/journal.json'), 'utf8'))).toMatchObject({ phase: 'rolled-back' })
    await createNativeToolPackInstaller(test.platform)(test.options)
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('new alpha executable')
    expect(await readFile(join(test.installRoot, 'tools/beta/app.exe'), 'utf8')).toBe('new beta executable')
    expect(await readFile(join(test.installRoot, 'tools/alpha/output/report.txt'), 'utf8')).toBe('personal output')
  })

  it('moves retired tools and their user files to the upgrade backup while retaining prior package records', async () => {
    const test = await upgradeFixture(['tools/alpha/config'], {}, {}, ['tools/alpha'])
    const previousManifestPath = join(test.installRoot, `.rainy-toolpack/manifests/${test.previous.metadata.id}.json`)
    const previousManifest = await readFile(previousManifestPath, 'utf8')
    await put(test.installRoot, 'tools/alpha/output/report.txt', 'personal output')
    await put(test.installRoot, 'tools/unregistered/note.txt', 'unregistered user tool')
    const result = await createNativeToolPackInstaller(test.platform)(test.options)
    await expect(readFile(join(test.installRoot, 'tools/alpha/app.exe'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(result.backupDirectory, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
    expect(await readFile(join(result.backupDirectory, 'tools/alpha/output/report.txt'), 'utf8')).toBe('personal output')
    expect(await readFile(join(result.backupDirectory, 'tools/alpha/config/settings.json'), 'utf8')).toBe('{"theme":"default"}')
    expect(await readFile(join(test.installRoot, 'tools/beta/app.exe'), 'utf8')).toBe('new beta executable')
    expect(await readFile(join(test.installRoot, 'tools/unregistered/note.txt'), 'utf8')).toBe('unregistered user tool')
    expect(await readFile(previousManifestPath, 'utf8')).toBe(previousManifest)
    expect(JSON.parse(await readFile(join(test.installRoot, `.rainy-toolpack/manifests/${test.metadata.id}.json`), 'utf8'))).toEqual(test.metadata)
    expect(JSON.parse(await readFile(join(test.installRoot, '.rainy-toolpack/journal.json'), 'utf8'))).toMatchObject({
      phase: 'committed', units: [
        { path: 'tools/alpha', kind: 'directory', preserve: [], retired: true, hadOriginal: true, state: 'old-moved' },
        { path: 'tools/beta' },
        { path: 'tools/manifest.json' },
      ],
    })
  })

  it('restores a retired tool after a later replacement fails without putting old user files in new staging', async () => {
    const test = await upgradeFixture([], {}, {}, ['tools/alpha'])
    await put(test.installRoot, 'tools/alpha/output/report.txt', 'personal output')
    let failed = false
    test.platform.move = async (source, destination) => {
      if (!failed && source.includes(join('.rainy-toolpack', 'stage')) && destination === join(test.installRoot, 'tools/beta')) { failed = true; throw new Error('Replacement interrupted') }
      await rename(source, destination)
    }
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'install-failed' })
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
    expect(await readFile(join(test.installRoot, 'tools/alpha/output/report.txt'), 'utf8')).toBe('personal output')
    expect(await readFile(join(test.installRoot, 'tools/beta/app.exe'), 'utf8')).toBe('old beta')
    await expect(readdir(join(test.installRoot, '.rainy-toolpack/stage', test.metadata.id, 'tools/alpha'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(test.installRoot, '.rainy-toolpack/installed.json'), 'utf8'))).toMatchObject({ packId: test.previous.metadata.id })
    const result = await createNativeToolPackInstaller(test.platform)(test.options)
    expect(await readFile(join(result.backupDirectory, 'tools/alpha/output/report.txt'), 'utf8')).toBe('personal output')
    await expect(readdir(join(test.installRoot, 'tools/alpha'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('checks retired tool processes before staging or moving any installation unit', async () => {
    const test = await upgradeFixture([], {}, {}, ['tools/alpha'])
    let moves = 0
    test.platform.move = async (source, destination) => { moves++; await rename(source, destination) }
    test.platform.assertNotBusy = async (_root, units) => {
      expect(units.map(unit => unit.path)).toContain('tools/beta')
      if (units.some(unit => unit.path === 'tools/alpha')) throw new ToolPackInstallError('tools-busy', 'Retired tool is running')
    }
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'tools-busy' })
    expect(moves).toBe(0)
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
    await expect(readdir(join(test.installRoot, '.rainy-toolpack/stage', test.metadata.id))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back retirement on cancellation and keeps retry staging limited to the incoming package', async () => {
    const test = await upgradeFixture([], {}, {}, ['tools/alpha'])
    const cancellation = new AbortController()
    await expect(createNativeToolPackInstaller(test.platform)({ ...test.options, signal: cancellation.signal, onProgress(update) {
      if (update.phase === 'switching' && update.currentPath === 'tools/alpha') cancellation.abort()
    } })).rejects.toMatchObject({ code: 'cancelled' })
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
    await expect(readdir(join(test.installRoot, '.rainy-toolpack/stage', test.metadata.id, 'tools/alpha'))).rejects.toMatchObject({ code: 'ENOENT' })
    await createNativeToolPackInstaller(test.platform)(test.options)
    await expect(readdir(join(test.installRoot, 'tools/alpha'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    { state: 'moving-old', moved: false },
    { state: 'moving-old', moved: true },
    { state: 'old-moved', moved: true },
  ])('recovers a retired directory after restart at $state with old directory moved: $moved', async ({ state, moved }) => {
    const test = await upgradeFixture([], {}, {}, ['tools/alpha'])
    const transactionId = randomUUID()
    await put(test.installRoot, 'tools/alpha/personal.txt', 'retained across restart')
    if (moved) {
      const backup = join(test.installRoot, '.rainy-toolpack/backups', transactionId, 'tools/alpha')
      await mkdir(dirname(backup), { recursive: true })
      await rename(join(test.installRoot, 'tools/alpha'), backup)
    }
    await put(test.installRoot, '.rainy-toolpack/journal.json', JSON.stringify({
      version: 1, installRoot: test.installRoot, packId: test.metadata.id, transactionId, previousPackId: test.previous.metadata.id, phase: 'switching',
      units: [{ path: 'tools/alpha', kind: 'directory', preserve: [], state, retired: true, hadOriginal: true }],
    }))
    await unlink(test.metadataPath)
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'invalid-metadata' })
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
    expect(await readFile(join(test.installRoot, 'tools/alpha/personal.txt'), 'utf8')).toBe('retained across restart')
    await expect(readdir(join(test.installRoot, '.rainy-toolpack/stage', test.metadata.id, 'tools/alpha'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(test.installRoot, '.rainy-toolpack/installed.json'), 'utf8'))).toMatchObject({ packId: test.previous.metadata.id })
  })

  it('leaves an original tool in place when recovery finds its replacement staging already removed', async () => {
    const test = await upgradeFixture()
    await put(test.installRoot, '.rainy-toolpack/journal.json', JSON.stringify({
      version: 1, installRoot: test.installRoot, packId: test.metadata.id, transactionId: randomUUID(), previousPackId: test.previous.metadata.id, phase: 'switching',
      units: [{ path: 'tools/alpha', kind: 'directory', preserve: [], state: 'moving-old', hadOriginal: true }],
    }))
    await unlink(test.metadataPath)
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'invalid-metadata' })
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
    await expect(readdir(join(test.installRoot, '.rainy-toolpack/stage', test.metadata.id, 'tools/alpha'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(test.installRoot, '.rainy-toolpack/journal.json'), 'utf8'))).toMatchObject({ phase: 'rolled-back' })
  })

  it('rejects a retirement journal for a directory absent from its previous package manifest', async () => {
    const test = await upgradeFixture([], {}, {}, ['tools/alpha'])
    await put(test.installRoot, 'tools/unregistered/personal.txt', 'unregistered user tool')
    await put(test.installRoot, '.rainy-toolpack/journal.json', JSON.stringify({
      version: 1, installRoot: test.installRoot, packId: test.metadata.id, transactionId: randomUUID(), previousPackId: test.previous.metadata.id, phase: 'switching',
      units: [{ path: 'tools/unregistered', kind: 'directory', preserve: [], state: 'moving-old', retired: true, hadOriginal: true }],
    }))
    let moves = 0
    test.platform.move = async (source, destination) => { moves++; await rename(source, destination) }
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'invalid-record' })
    expect(moves).toBe(0)
    expect(await readFile(join(test.installRoot, 'tools/unregistered/personal.txt'), 'utf8')).toBe('unregistered user tool')
  })

  it('rejects links within retired tool directories before moving them', async () => {
    const test = await upgradeFixture([], {}, {}, ['tools/alpha'])
    const outside = join(test.root, 'outside')
    const link = join(test.installRoot, 'tools/alpha/linked')
    await mkdir(outside)
    await put(outside, 'personal.txt', 'external user data')
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'link-not-allowed' })
      expect(await readFile(join(outside, 'personal.txt'), 'utf8')).toBe('external user data')
      expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
    } finally { await unlink(link) }
  })

  it('finishes an interrupted rollback before checking the next installation media', async () => {
    const test = await upgradeFixture()
    test.platform.move = async (source, destination) => {
      if (source.includes(join('.rainy-toolpack', 'stage')) && destination === join(test.installRoot, 'tools/beta')) throw new Error('Switch interrupted')
      if (source.includes(join('.rainy-toolpack', 'backups')) && destination === join(test.installRoot, 'tools/beta')) throw new Error('Rollback interrupted')
      await rename(source, destination)
    }
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'rollback-required' })
    await unlink(join(test.mediaDirectory, test.metadata.volumes[0].file))
    test.platform.move = rename
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'missing-volume' })
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
    expect(await readFile(join(test.installRoot, 'tools/beta/app.exe'), 'utf8')).toBe('old beta')
  })

  it('rejects target junctions without reading or replacing their external content', async () => {
    const test = await fixture()
    const outside = join(test.root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'app.exe'), 'external original')
    await mkdir(join(test.installRoot, 'tools'))
    await symlink(outside, join(test.installRoot, 'tools/alpha'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'link-not-allowed' })
    expect(await readFile(join(outside, 'app.exe'), 'utf8')).toBe('external original')
  })

  it('rejects an archive hardlink even when its outer volumes have valid hashes', async () => {
    const test = await fixture()
    await unlink(join(test.source, 'tools/beta/app.exe'))
    await link(join(test.source, 'tools/alpha/app.exe'), join(test.source, 'tools/beta/app.exe'))
    await test.archive()
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'unsafe-archive' })
    await expect(readFile(join(test.installRoot, 'tools/alpha/app.exe'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects unsafe metadata paths before any tool directory is created', async () => {
    const test = await fixture()
    test.metadata.files[0].path = '../escape.exe'
    test.metadata.id = hash(JSON.stringify({ files: test.metadata.files, units: test.metadata.units }))
    await writeFile(test.metadataPath, JSON.stringify(test.metadata))
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'invalid-metadata' })
    expect(await readdir(test.installRoot)).toEqual(['.rainy-toolpack'])
  })

  it('keeps old tools when the process inventory reports that they are running', async () => {
    const test = await upgradeFixture()
    test.platform.assertNotBusy = async () => { throw new ToolPackInstallError('tools-busy', 'Please close the tool') }
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'tools-busy' })
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
  })

  it('serializes independent installers for the same target directory with an OS lock', async () => {
    const test = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const continueInstall = Promise.withResolvers<undefined>()
    test.platform.assertNotBusy = async () => { entered.resolve(undefined); await continueInstall.promise }
    const installer = createNativeToolPackInstaller(test.platform)
    const first = installer(test.options)
    await entered.promise
    try { await expect(installer(test.options)).rejects.toMatchObject({ code: 'install-busy' }) } finally { continueInstall.resolve(undefined) }
    expect(await first).toMatchObject({ status: 'installed' })
  })

  it('rejects duplicate Windows paths and mismatched package identity', async () => {
    const test = await fixture()
    expect(toolPackMetadataSchema.safeParse({ ...test.metadata, id: '0'.repeat(64) }).success).toBe(false)
    const duplicate = { ...test.metadata.files[0], path: test.metadata.files[0].path.toUpperCase() }
    const files = [...test.metadata.files, duplicate]
    const metadata = {
      ...test.metadata, files, unpackedBytes: test.metadata.unpackedBytes + duplicate.bytes,
      id: hash(JSON.stringify({ files, units: test.metadata.units })),
    }
    expect(toolPackMetadataSchema.safeParse(metadata).success).toBe(false)
  })

  it.each(['missing', 'corrupt'])('restores an interrupted switch even when the current metadata is %s', async (kind) => {
    const test = await upgradeFixture()
    test.platform.move = async (source, destination) => {
      if (destination === join(test.installRoot, 'tools/beta')) throw new Error('Interrupted move')
      await rename(source, destination)
    }
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'rollback-required' })
    if (kind === 'missing') await unlink(test.metadataPath)
    else await writeFile(test.metadataPath, '{broken')
    test.platform.move = rename
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'invalid-metadata' })
    expect(await readFile(join(test.installRoot, 'tools/alpha/app.exe'), 'utf8')).toBe('old alpha')
    expect(await readFile(join(test.installRoot, 'tools/beta/app.exe'), 'utf8')).toBe('old beta')
  })

  it('does not move any recovery paths while an old tool is running', async () => {
    const test = await upgradeFixture()
    test.platform.move = async (source, destination) => {
      if (destination === join(test.installRoot, 'tools/beta')) throw new Error('Interrupted move')
      await rename(source, destination)
    }
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'rollback-required' })
    const originalJournal = await readFile(join(test.installRoot, '.rainy-toolpack/journal.json'), 'utf8')
    test.platform.assertNotBusy = async () => { throw new ToolPackInstallError('tools-busy', 'Tool is running') }
    let moves = 0
    test.platform.move = async (source, destination) => { moves++; await rename(source, destination) }
    await expect(createNativeToolPackInstaller(test.platform)(test.options)).rejects.toMatchObject({ code: 'tools-busy' })
    expect(moves).toBe(0)
    expect(await readFile(join(test.installRoot, '.rainy-toolpack/journal.json'), 'utf8')).toBe(originalJournal)
  })

  it('detects a retained encoded PowerShell console and an older RainyAgent main process', async () => {
    const test = await fixture()
    const script = `Set-Location -LiteralPath '${join(test.installRoot, 'tools/alpha')}'\n& '${join(test.installRoot, 'tools/alpha/app.exe')}'`
    const consoleProcess = { pid: 100, executable: 'C:\\Windows\\powershell.exe', commandLine: `powershell.exe -NoExit -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}` }
    expect(findBusyToolPackProcess([consoleProcess], test.installRoot, test.metadata.units, 200)?.pid).toBe(100)
    const application = { pid: 300, executable: join(test.installRoot, 'RainyAgent.exe'), commandLine: 'RainyAgent.exe' }
    expect(findBusyToolPackProcess([application], test.installRoot, test.metadata.units, 200)?.pid).toBe(300)
    expect(findBusyToolPackProcess([application], test.installRoot, test.metadata.units, 300)).toBeUndefined()
  })

  it('detects a retained console whose tool path contains typographic single quotes', () => {
    const installRoot = join(tmpdir(), 'O’Brien‘s RainyAgent')
    const units: ToolPackMetadata['units'] = [{ path: 'tools/alpha', kind: 'directory', preserve: [] }]
    const cwd = join(installRoot, 'tools/alpha')
    const command = nativeConsoleCommand({ id: '7zip', name: '7-Zip', kind: 'console', target: join(cwd, 'app.exe'), executable: join(cwd, 'app.exe'),
      cwd, args: [], roots: [cwd], userData: join(tmpdir(), 'user-data') })
    const consoleProcess = { pid: 100, executable: 'powershell.exe', commandLine: `powershell.exe -NoExit -EncodedCommand ${command}` }
    expect(findBusyToolPackProcess([consoleProcess], installRoot, units, 200)?.pid).toBe(100)
  })

  it.runIf(process.platform === 'win32')('waits for a concurrent reader to release a record before replacing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainy-toolpack-rename-'))
    roots.push(root)
    const record = join(root, 'installed.json')
    await writeFile(record, '{}')
    const reader = await open(record, 'r')
    const released = new Promise<void>((resolve, reject) => { setTimeout(() => { reader.close().then(resolve, reject) }, 150) })
    await writeToolPackRecord(record, { version: 1 })
    await released
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({ version: 1 })
    expect(await readdir(root)).toEqual(['installed.json'])
  })

  it('removes its temporary file when a record cannot replace the destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rainy-toolpack-record-'))
    roots.push(root)
    await mkdir(join(root, 'installed.json', 'occupied'), { recursive: true })
    await expect(writeToolPackRecord(join(root, 'installed.json'), { version: 1 })).rejects.toThrow()
    expect(await readdir(root)).toEqual(['installed.json'])
    await expect(renameToolPackPath(join(root, 'absent'), join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects nonadjacent preservation ancestors and inconsistent directory spelling', async () => {
    const test = await fixture(['tools/alpha/config', 'tools/alpha/config-other', 'tools/alpha/config/child'])
    expect(toolPackMetadataSchema.safeParse(test.metadata).success).toBe(false)
    const normal = await fixture()
    normal.metadata.files[1].path = 'tools/Alpha/config/settings.json'
    normal.metadata.id = hash(JSON.stringify({ files: normal.metadata.files, units: normal.metadata.units }))
    expect(toolPackMetadataSchema.safeParse(normal.metadata).success).toBe(false)
  })

  it('limits NSIS cleanup to declared application files and preserves all runtime and tool trees', async () => {
    const script = await readFile(new URL('../resources/native-tools-installer.nsh', import.meta.url), 'utf8')
    expect(script).toContain('!macro customRemoveFiles')
    expect(script).not.toMatch(/RMDir\s+\/r/i)
    expect(script).not.toMatch(/(?:Delete|rainyDeleteApplicationFile|RMDir)\s+"\$INSTDIR\\(?:runtime|tools|\.rainy-toolpack)/i)
    expect(script).toContain('SetErrorLevel $0')
    expect(script).toContain('!insertmacro rainyRejectReparse "$INSTDIR\\resources"')
    expect(script).toContain('!macro customCheckAppRunning')
    expect(script).not.toMatch(/Stop-Process|taskkill|KILL_PROCESS/i)
    expect(script).toContain('$$row.ProcessId -eq $$PID -or $$row.ProcessId -eq $$InstallerPid')
    expect(script).toContain('--rainy-tools-silent')
  })
})
