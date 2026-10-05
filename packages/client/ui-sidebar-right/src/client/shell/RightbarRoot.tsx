/** Root-scoped controller for the right Sidebar's Session content. */
import { useLayoutEffect } from 'react'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SidebarSessionViewSnapshot } from '../session-views.ts'
import type { SidebarRightApplicationState } from '../applications.ts'
import type { SidebarRightPresentation } from './SidebarRight.tsx'
import type {} from '../contract/slots.ts'
import css from './SidebarRight.module.css'

/** Root-only retained Session targets and their committed mount lifetimes. */
export interface RightbarRootInjected {
  readonly hooks: {
    readonly views: HostObservable<readonly SidebarSessionViewSnapshot[]>
    readonly applications: HostObservable<SidebarRightApplicationState>
  }
  readonly mountView: (reference: SessionReference) => () => void
  readonly closeApplication: () => void
  readonly reportApplication: (presentation: SidebarRightPresentation) => void
}

type RootProps = PropsRuntime<'rightbar'> & PropsRenderSlots<'rightbar.session' | 'rightbar.application'> & InjectFace<RightbarRootInjected>

function SessionView({ view, visible, covered, SessionProvider, renderSlot, mountView, width, viewportWidth, canShow }:
  Pick<RootProps, 'SessionProvider' | 'renderSlot' | 'mountView' | 'width' | 'viewportWidth' | 'canShow'>
  & { readonly view: SidebarSessionViewSnapshot; readonly visible: boolean; readonly covered: boolean }) {
  useLayoutEffect(() => mountView(view.reference), [mountView, view.reference])
  const navigationActive = visible && view.selected
  const active = navigationActive && !covered
  return <div className={css.session} hidden={!active} data-sidebar-right-session={view.sessionId}>
    <SessionProvider session={view.reference}>
      {renderSlot('rightbar.session', { width, viewportWidth, canShow, active, navigationActive, retainTab: view.retainTab })}
    </SessionProvider>
  </div>
}

/**
 * Keep independent Session subtrees and hide those outside the selected Conversation.
 * @param props - frame geometry, view targets and the authorized Session renderer.
 * @returns the foreground and retained background Sidebars.
 */
export function RightbarRoot({
  usePanelInfo, useViews, useApplications, closeApplication, reportApplication, ...props
}: RootProps) {
  const visible = usePanelInfo(info => info.activePanelId === null)
  const views = useViews(value => value)
  const applications = useApplications(value => value)
  const selected = applications.activeId !== undefined
  const fullscreen = !props.canShow
  useLayoutEffect(() => {
    if (selected) reportApplication({ shown: true, track: !fullscreen, fullscreen })
  }, [selected, fullscreen, reportApplication])
  return <>
    {views.map(view => <SessionView key={view.sessionId} {...props} view={view} visible={visible} covered={selected} />)}
    {applications.visited.map(id => <div key={id} className={css.session}
      hidden={applications.activeId !== id} data-sidebar-right-application={id}>
      {props.renderSlot('rightbar.application', { width: props.width, viewportWidth: props.viewportWidth,
        canShow: props.canShow, visible: applications.activeId === id, fullscreen, close: closeApplication }, { entryKey: id })}
    </div>)}
  </>
}
