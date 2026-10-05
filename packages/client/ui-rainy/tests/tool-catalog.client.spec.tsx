// @vitest-environment jsdom
/** Directory discovery, launch availability and lazy retained IceSky navigation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { ToolCatalog } from '../src/client/ToolCatalog.tsx'
import { CtfWorkbench } from '../src/client/ctf.tsx'
import type { NativeToolsState } from '../src/client/native-tools.ts'
import { zh } from '../src/client/locales.ts'
import { globalProps } from './global-props.client.ts'

afterEach(cleanup)
const t = ((key: keyof typeof zh, values?: Record<string, string>) => zh[key].replace(/\{(\w+)\}/g,
  (match, name: string) => values?.[name] ?? match)) as TranslateNS<'rainy'>

const state: NativeToolsState = { phase: 'ready', error: '', pending: [], savingFavorites: false, tools: [
  { id: 'cyberchef', name: 'CyberChef', category: 'web', version: '10', launchKind: 'web', status: 'ready', verified: false, missing: [] },
  { id: 'x64dbg', name: 'x64dbg', category: 'reverse', version: '2026', launchKind: 'desktop', status: 'ready', verified: true,
    missing: [], variants: [{ id: 'x32', name: 'x32dbg', status: 'ready' }] },
  { id: '7zip', name: '7-Zip', category: 'misc', version: '25', launchKind: 'desktop', status: 'missing', verified: false, missing: ['7zFM.exe'] },
], preferences: { favorites: ['cyberchef'], recent: ['x64dbg', 'cyberchef'] } }

function fixture(next = state) {
  const actions = { loadTools: vi.fn(async () => {}), launchTool: vi.fn(async () => {}), toggleFavorite: vi.fn(async () => {}) }
  const view = render(<ToolCatalog t={t} state={next} {...actions} />)
  return { ...actions, ...view }
}

describe('common tool catalog', () => {
  it('filters by category, localized use, favorites and recent order', () => {
    const h = fixture()
    fireEvent.click(screen.getByRole('button', { name: 'Reverse' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'x64dbg' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '编码' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'CyberChef' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '取消收藏 CyberChef' }))
    expect(h.toggleFavorite).toHaveBeenCalledExactlyOnceWith('cyberchef')
    fireEvent.click(screen.getByRole('button', { name: '最近使用' }))
    expect(screen.getAllByRole('heading').map(row => row.textContent)).toEqual(['x64dbg', 'CyberChef'])
  })

  it('distinguishes unverified from missing and disables overlapping launches', () => {
    const h = fixture()
    const cyberchef = screen.getByRole('heading', { name: 'CyberChef' }).closest('li')!
    expect(within(cyberchef).getByText('待验证')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开 CyberChef' }))
    expect(h.launchTool).toHaveBeenLastCalledWith('cyberchef')
    fireEvent.click(screen.getByRole('button', { name: '打开 x32dbg' }))
    expect(h.launchTool).toHaveBeenLastCalledWith('x64dbg', 'x32')
    expect(screen.getByRole('button', { name: '打开 7-Zip' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('7zFM.exe')).toBeTruthy()
    h.rerender(<ToolCatalog t={t} state={{ ...state, pending: ['x64dbg'] }} {...h} />)
    expect(screen.getByRole('button', { name: '打开 x64dbg' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '打开 x32dbg' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '刷新工具状态' }).hasAttribute('disabled')).toBe(true)
  })

  it('retains rows and offers retry after a directory refresh fails', () => {
    const h = fixture({ ...state, phase: 'error', error: 'Directory unavailable' })
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByRole('alert').textContent).toContain('Directory unavailable')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(h.loadTools).toHaveBeenCalledOnce()
  })

  it('expands offline repair steps for a missing tool without starting an operation', () => {
    const h = fixture()
    const missing = screen.getByRole('heading', { name: '7-Zip' }).closest('li')!
    const repair = within(missing).getByRole('button', { name: '修复工具包' })
    expect(repair.getAttribute('aria-expanded')).toBe('false')
    expect(within(missing).queryByRole('list')).toBeNull()
    fireEvent.click(repair)
    expect(repair.getAttribute('aria-expanded')).toBe('true')
    expect(within(missing).getAllByRole('listitem').map(step => step.textContent)).toEqual([
      '保存工作，并退出 RainyAgent 和所有工具窗口',
      '将配套版本的安装 EXE 和全部工具包分卷放在同一文件夹，然后重新运行安装程序',
      '安装完成后重新打开 RainyAgent，点击“刷新工具状态”',
    ])
    expect(h.launchTool).not.toHaveBeenCalled()
    expect(h.loadTools).not.toHaveBeenCalled()
    expect(h.toggleFavorite).not.toHaveBeenCalled()
    fireEvent.keyDown(repair, { key: 'Enter' })
    expect(within(missing).queryByRole('list')).toBeNull()
  })

  it('offers the same repair guidance when the whole directory cannot load', () => {
    const h = fixture({ ...state, phase: 'error', tools: [], error: 'Directory unavailable' })
    const notice = screen.getByRole('alert')
    fireEvent.click(within(notice).getByRole('button', { name: '修复工具包' }))
    expect(within(notice).getAllByRole('listitem').map(step => step.textContent)).toEqual([
      '保存工作，并退出 RainyAgent 和所有工具窗口',
      '将配套版本的安装 EXE 和全部工具包分卷放在同一文件夹，然后重新运行安装程序',
      '安装完成后重新打开 RainyAgent，点击“刷新工具状态”',
    ])
    expect(h.launchTool).not.toHaveBeenCalled()
    expect(h.loadTools).not.toHaveBeenCalled()
    fireEvent.click(within(notice).getByRole('button', { name: '重试' }))
    expect(h.loadTools).toHaveBeenCalledOnce()
  })

  it('offers repair when only the alternate executable is missing', () => {
    fixture({ ...state, tools: [{ id: 'x64dbg', name: 'x64dbg', category: 'reverse', version: '2026',
      launchKind: 'desktop', status: 'ready', verified: false, missing: [],
      variants: [{ id: 'x32', name: 'x32dbg', status: 'missing' }] }] })
    expect(screen.getByRole('button', { name: '打开 x64dbg' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: '打开 x32dbg' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '修复工具包' })).toBeTruthy()
  })

  it('offers no native launch controls in a browser without the desktop bridge', () => {
    fixture({ ...state, phase: 'desktop-only' })
    expect(screen.getByText('在 RainyAgent 桌面应用中使用常用工具')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('CTF directory and IceSky tabs', () => {
  it('mounts one IceSky frame on first selection and preserves it across directory visits', () => {
    const attach = vi.fn()
    const loadTools = vi.fn(async () => {})
    function Harness() {
      const [view, selectView] = useState<'catalog' | 'icesky'>('catalog')
      const props: ComponentProps<typeof CtfWorkbench> = {
        ...globalProps,
        width: 550, close: vi.fn(), t,
        useWorkbench: selector => selector({ phase: 'ready', saving: 'idle', error: undefined, message: '' }),
        useTools: selector => selector(state), useView: selector => selector(view), selectView,
        attach, loadTools, launchTool: vi.fn(async () => {}), toggleFavorite: vi.fn(async () => {}),
        retry: vi.fn(async () => true), loadFailed: vi.fn(),
      }
      return <CtfWorkbench {...props} />
    }
    const h = render(<Harness />)
    expect(h.container.querySelector('iframe')).toBeNull()
    expect(loadTools).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('tab', { name: 'IceSky' }))
    const frame = h.container.querySelector('iframe')
    expect(frame).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '常用工具' }))
    expect(h.container.querySelector('iframe')).toBe(frame)
    expect(frame?.parentElement?.hidden).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'IceSky' }))
    expect(h.container.querySelectorAll('iframe')).toHaveLength(1)
    expect(frame?.parentElement?.hidden).toBe(false)
  })
})
