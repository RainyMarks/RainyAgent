// @vitest-environment jsdom
/** Root workspaces arbitrate one column while Session layout remains independently owned. */
import { expect, it, vi } from 'vitest'
import { createSidebarRightApplications, type SidebarRightApplicationId } from '../src/client/applications.ts'

const ID = 'workbench' as SidebarRightApplicationId

it('reveals a registered body once without a Session and retains it on hide', () => {
  const report = vi.fn()
  const applications = createSidebarRightApplications(report)
  expect(() => { applications.controller.open(ID) }).toThrow('not registered')
  const release = applications.controller.register(ID)
  expect(() => applications.controller.register(ID)).toThrow('already registered')
  applications.controller.open(ID)
  applications.controller.open(ID)
  expect(applications.controller.state.getSnapshot()).toEqual({ activeId: ID, visited: [ID] })
  applications.reportApplication({ shown: true, track: true, fullscreen: false })
  applications.reportSession({ shown: false, track: false, fullscreen: false })
  expect(report).toHaveBeenCalledExactlyOnceWith({ shown: true, track: true, fullscreen: false })
  applications.controller.close()
  expect(applications.controller.state.getSnapshot()).toEqual({ activeId: undefined, visited: [ID] })
  expect(report).toHaveBeenLastCalledWith({ shown: false, track: false, fullscreen: false })
  applications.controller.open(ID)
  release()
  release()
  expect(applications.controller.state.getSnapshot()).toEqual({ activeId: undefined, visited: [] })
})

it('resolves only the visible workspace commands and rejects a captured operation after disposal', () => {
  const applications = createSidebarRightApplications(vi.fn())
  const refresh = vi.fn()
  const release = applications.controller.register(ID, { refresh })
  const element = document.createElement('div')
  element.setAttribute('data-sidebar-right-application', ID)
  expect(applications.resolveCommand('refresh', element)).toBeUndefined()
  applications.controller.open(ID)
  const captured = applications.resolveCommand('refresh', element)
  captured?.()
  expect(refresh).toHaveBeenCalledOnce()
  applications.resolveCommand('close', element)?.()
  expect(applications.controller.state.getSnapshot().activeId).toBeUndefined()
  applications.controller.open(ID)
  release()
  captured?.()
  expect(refresh).toHaveBeenCalledOnce()
})
