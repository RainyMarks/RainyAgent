/** Human tool discovery and native launch controls in the retained CTF workspace. */
import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, DisclosureRow, Input, Pill, Tag, Tooltip, IconSearchOutlineRegular, IconRefreshOutlineRegular,
  IconPinOutlineRegular, IconPinFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { nativeToolIds } from '../native-tools-protocol.ts'
import type { NativeToolId, NativeToolSummary } from '../native-tools-protocol.ts'
import type { NativeToolsState } from './native-tools.ts'
import type { zh } from './locales.ts'
import css from './ToolCatalog.module.css'

const purpose: Record<typeof nativeToolIds[number], keyof typeof zh> = {
  yakit: 'toolYakit', cyberchef: 'toolCyberChef', '7zip': 'tool7zip', exiftool: 'toolExiftool',
  wireshark: 'toolWireshark', binwalk: 'toolBinwalk', ffmpeg: 'toolFfmpeg', audacity: 'toolAudacity',
  stegsolve: 'toolStegsolve', pngcheck: 'toolPngcheck', qrazybox: 'toolQrazybox', 'image-lsb-viewer': 'toolImageLsb',
  imagemagick: 'toolImagemagick', ida: 'toolIda', x64dbg: 'toolX64dbg', die: 'toolDie', imhex: 'toolImhex',
  jadx: 'toolJadx', dnspy: 'toolDnspy', 'pyinstxtractor-ng': 'toolPyinstxtractor',
  winmerge: 'toolWinMerge', qalculate: 'toolQalculate', 'sonic-visualiser': 'toolSonicVisualiser',
  'tesseract-ocr': 'toolTesseract', sox: 'toolSox', tweakpng: 'toolTweakPng', 'multimon-ng': 'toolMultimon',
  'gnu-strings': 'toolStrings', gimp: 'toolGimp', curl: 'toolCurl', jq: 'toolJq', yq: 'toolYq',
  sqlite: 'toolSqlite', 'sqlite-browser': 'toolSqliteBrowser', qpdf: 'toolQpdf', ripgrep: 'toolRipgrep',
  bruno: 'toolBruno', pcapfix: 'toolPcapfix',
}
const categoryCopy = { web: 'toolsWeb', misc: 'toolsMisc', reverse: 'toolsReverse' } as const
const kindCopy = { desktop: 'toolsDesktop', terminal: 'toolsTerminal', web: 'toolsOfflineWeb' } as const
type Filter = 'all' | 'favorites' | 'recent' | NativeToolSummary['category']
const filters: readonly { readonly id: Filter; readonly copyKey: keyof typeof zh }[] = [
  { id: 'all', copyKey: 'toolsAll' }, { id: 'favorites', copyKey: 'toolsFavorites' }, { id: 'recent', copyKey: 'toolsRecent' },
  { id: 'web', copyKey: 'toolsWeb' }, { id: 'misc', copyKey: 'toolsMisc' }, { id: 'reverse', copyKey: 'toolsReverse' },
]

function ToolPackRepair({ t }: PropsLocale<'rainy'>) {
  const [open, setOpen] = useState(false)
  return <DisclosureRow title={t('toolsRepair')} icon={<IconRefreshOutlineRegular />} open={open}
    expandable expandOnRowClick className={css.repair} onToggle={() => { setOpen(value => !value) }}>
    <ol className={css.repairSteps}>
      <li>{t('toolsRepairClose')}</li>
      <li>{t('toolsRepairInstall')}</li>
      <li>{t('toolsRepairRefresh')}</li>
    </ol>
  </DisclosureRow>
}

/** Actions supplied by the directory's retained owner. */
export interface ToolCatalogActions {
  readonly checkToolUpdates: () => Promise<void>
  readonly downloadTools: () => Promise<void>
  readonly cancelDownload: () => Promise<void>
  readonly loadTools: () => Promise<void>
  readonly launchTool: (id: NativeToolId, variant?: 'x32') => Promise<void>
  readonly toggleFavorite: (id: NativeToolId) => Promise<void>
}

/**
 * Filter the installed directory without changing its user-level preferences.
 * @param props - localized copy, authoritative availability, and native operations.
 * @returns the catalog, or the desktop availability notice in a browser.
 */
export function ToolCatalog({ t, state, loadTools, launchTool, toggleFavorite, downloadTools, cancelDownload, checkToolUpdates }:
  PropsLocale<'rainy'> & ToolCatalogActions & { readonly state: NativeToolsState }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const downloading = state.download.phase === 'downloading' || state.download.phase === 'installing'
  const complete = state.update.phase !== 'available' && state.tools.length > 0 && state.tools.every(tool => tool.status === 'ready'
    && (tool.variants?.every(variant => variant.status === 'ready') ?? true))
  const percentage = state.download.totalBytes > 0
    ? Math.min(100, Math.floor(state.download.completedBytes * 100 / state.download.totalBytes)) : 0
  const description = (id: NativeToolId): string => {
    const known = nativeToolIds.find(value => value === id)
    return t(known === undefined ? 'toolExtra' : purpose[known])
  }
  const search = query.trim().toLocaleLowerCase()
  const favoriteIds = state.preferences.favorites
  const recentIds = state.preferences.recent
  const tools = state.tools.filter((tool) => {
    if (filter === 'favorites' && !favoriteIds.includes(tool.id)) return false
    if (filter === 'recent' && !recentIds.includes(tool.id)) return false
    if (filter !== 'all' && filter !== 'favorites' && filter !== 'recent' && tool.category !== filter) return false
    return search === '' || `${tool.name} ${tool.id} ${description(tool.id)}`.toLocaleLowerCase().includes(search)
  })
  if (filter === 'recent') tools.sort((a, b) => recentIds.indexOf(a.id) - recentIds.indexOf(b.id))
  if (state.phase === 'desktop-only') return <div className={css.empty} data-rainy-tool-catalog>
    <p>{t('toolsDesktopOnly')}</p><p className={css.secondary}>{t('toolsDesktopHint')}</p>
  </div>
  const busy = state.phase === 'loading' || state.savingFavorites || state.pending.length > 0
  return <div className={css.catalog} data-rainy-tool-catalog>
    <div className={css.toolbar}>
      <div className={css.search}><Input icon={<IconSearchOutlineRegular />} aria-label={t('toolsSearch')}
        placeholder={t('toolsSearch')} value={query} onChange={(event) => { setQuery(event.target.value) }} /></div>
      <Tooltip label={t('toolsRefresh')} portal>
        <Button size="sm" aria-label={t('toolsRefresh')} icon={<IconRefreshOutlineRegular />} disabled={busy}
          onClick={() => { void loadTools() }} />
      </Tooltip>
    </div>
    <div className={css.notice}>
      <div><span>{t(complete ? 'toolsDownloadInstalled' : 'toolsDownloadDescription')}</span>
        {state.download.totalBytes > 0 && state.download.phase !== 'installing' && <small>
          {t('toolsDownloadSize', { size: (state.download.totalBytes / 1024 ** 3).toFixed(2) })}
        </small>}
        {downloading && <span role="status">{t(state.download.phase === 'installing' ? 'toolsDownloadInstalling' : 'toolsDownloadProgress', { progress: String(percentage) })}</span>}
        {state.download.phase === 'cancelled' && <small>{t('toolsDownloadCancelled')}</small>}
        {state.download.phase === 'error' && <small role="alert">{state.download.error}</small>}
        {state.update.phase === 'available' && <small>{t('toolsUpdateAvailable', { version: state.update.version })}</small>}
        {state.update.phase === 'current' && <small>{t('toolsUpdateCurrent')}</small>}
        {state.update.phase === 'error' && <small role="alert">{state.update.error}</small>}
      </div>
      <div className={css.actions}>
        {downloading ? <Button size="sm" variant="outline" onClick={() => { void cancelDownload() }}>{t('toolsDownloadCancel')}</Button>
          : <Button size="sm" variant="outline" disabled={complete || state.phase === 'loading' || state.savingFavorites || state.pending.length > 0}
            onClick={() => { void downloadTools() }}>
            {t(complete ? 'toolsDownloadInstalled' : state.download.phase === 'error' || state.download.phase === 'cancelled' ? 'toolsDownloadRetry'
              : state.update.phase === 'available' ? 'toolsUpdateDownload' : 'toolsDownloadAll')}
          </Button>}
        <Button size="sm" variant="outline" disabled={downloading || state.update.phase === 'checking'}
          onClick={() => { void checkToolUpdates() }}>{t(state.update.phase === 'checking' ? 'toolsUpdateChecking' : 'toolsUpdateCheck')}</Button>
      </div>
      {downloading && <progress className={css.downloadProgress} aria-label={t('toolsDownloadAll')} value={percentage} max={100} />}
    </div>
    <div className={css.filters} role="group" aria-label={t('toolsCategories')}>
      {filters.map(item => <Pill key={item.id} active={filter === item.id} aria-pressed={filter === item.id}
        onClick={() => { setFilter(item.id) }}>{t(item.copyKey)}</Pill>)}
    </div>
    {state.phase === 'error' && <div className={css.notice} role="alert">
      <span>{t('toolsLoadFailed')}{state.error && <small>{state.error}</small>}</span>
      <Button size="sm" onClick={() => { void loadTools() }}>{t('ctfRetry')}</Button>
      <ToolPackRepair t={t} />
    </div>}
    {state.phase === 'loading' && state.tools.length === 0 ? <div className={css.skeletons} role="status" aria-label={t('toolsLoading')}>
      {[0, 1, 2, 3].map(id => <div key={id} className={css.skeleton} aria-hidden="true"><span /><span /></div>)}
    </div> : <>
      <p className={css.count} role="status">{t('toolsCount', { count: String(tools.length) })}</p>
      {tools.length === 0 ? <div className={css.empty}><p>{t(search !== '' ? 'toolsEmpty'
        : filter === 'favorites' ? 'toolsEmptyFavorites' : filter === 'recent' ? 'toolsEmptyRecent' : 'toolsEmpty')}</p></div>
        : <ul className={css.list} aria-label={t('toolsCatalog')}>
          {tools.map((tool) => {
            const favorite = favoriteIds.includes(tool.id)
            const pending = state.pending.includes(tool.id)
            const favoriteLabel = t(favorite ? 'toolsRemoveFavorite' : 'toolsAddFavorite', { name: tool.name })
            return <li key={tool.id} className={css.card} data-tool-id={tool.id}>
              <div className={css.details}>
                <div className={css.nameRow}><h3>{tool.name}</h3><Tag>{t(categoryCopy[tool.category])}</Tag></div>
                <p className={css.purpose}>{description(tool.id)}</p>
                <div className={css.metadata}>
                  <span>{tool.version || t('toolsVersionUnknown')}</span><span>{t(kindCopy[tool.launchKind])}</span>
                  <Tag tone={tool.status === 'missing' ? 'warning' : tool.verified ? 'success' : 'neutral'}>
                    {t(tool.status === 'missing' ? 'toolsMissing' : tool.verified ? 'toolsReady' : 'toolsUnverified')}
                  </Tag>
                </div>
                {tool.missing.length > 0 && <p className={css.missing}>{tool.missing.join(' · ')}</p>}
                {(tool.status === 'missing' || tool.variants?.some(variant => variant.status === 'missing')) && <ToolPackRepair t={t} />}
              </div>
              <div className={css.actions}>
                <Tooltip label={favoriteLabel} portal>
                  <Button size="sm" aria-label={favoriteLabel} aria-pressed={favorite} disabled={state.savingFavorites || state.phase === 'loading' || downloading}
                    icon={favorite ? <IconPinFillRegular /> : <IconPinOutlineRegular />} onClick={() => { void toggleFavorite(tool.id) }} />
                </Tooltip>
                <Button size="sm" variant="outline" aria-label={t('toolsOpenName', { name: tool.name })}
                  disabled={tool.status === 'missing' || pending || state.phase === 'loading' || downloading} aria-busy={pending}
                  onClick={() => { void launchTool(tool.id) }}>
                  {t(pending ? 'toolsOpening' : tool.launchKind === 'terminal' ? 'toolsOpenTerminal' : 'toolsOpen')}
                </Button>
                {tool.variants?.map(variant => <Button key={variant.id} size="sm" variant="outline"
                  aria-label={t('toolsOpenName', { name: variant.name })} disabled={variant.status === 'missing' || pending || state.phase === 'loading' || downloading}
                  onClick={() => { void launchTool(tool.id, variant.id) }}>{variant.name}</Button>)}
              </div>
            </li>
          })}
        </ul>}
    </>}
  </div>
}
