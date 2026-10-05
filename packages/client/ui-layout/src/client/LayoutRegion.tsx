/** Stable factory occurrences for the navigation, conversation, and auxiliary shell regions. */
import type { FactoryComponentPropsOf, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './index.ts'

function MainRegion({ usePanelInfo, renderSlot }: Pick<PropsRuntime<'root'>, 'usePanelInfo'> & PropsRenderSlots<'main'>) {
  const selected = usePanelInfo(state => state.activePanelId)
  return renderSlot('main', {}, { entryKey: selected ?? 'conversation' })
}

/** Render one existing shell region within its factory-owned child declarations.
 * @param props Measured geometry, region identity, and framework render capabilities.
 * @returns The selected existing region.
 */
export function LayoutRegion({ region, width, viewportWidth, collapsed, canShow, renderSlot, usePanelInfo }:
FactoryComponentPropsOf<'layout.region'>) {
  const render = {
    navigation: () => renderSlot('sidebar', { collapsed, width }),
    conversation: () => <MainRegion usePanelInfo={usePanelInfo} renderSlot={renderSlot} />,
    auxiliary: () => renderSlot('rightbar', { width, viewportWidth, canShow }),
  }
  return render[region]()
}
