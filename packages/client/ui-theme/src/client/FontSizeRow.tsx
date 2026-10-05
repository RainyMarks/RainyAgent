/** Independent interface and code size controls backed by the theme settings. */
import {
  IconChevronDownOutlineRegular, IconChevronUpOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { DEFAULT_CODE_FONT_SIZE, DEFAULT_FONT_SIZE, FONT_SIZE_MAX, FONT_SIZE_MIN } from '../theme-settings.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createFontSizeRowStore } from './settings-store.ts'
import css from './FontSizeRow.module.css'

/** Injected business face: the preference write (t rides the standard locale seat). */
export interface FontSizeRowInjected {
  /** Change the interface font size (integer px within FONT_SIZE_MIN..FONT_SIZE_MAX). */
  setFontSize: (px: number) => void
  /** Change the independent code font size with the same integer bounds. */
  setCodeFontSize: (px: number) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type FontSizeRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createFontSizeRowStore>>
  & PropsLocale<'settings.theme'> & FontSizeRowInjected

/**
 * Render the font-size row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function FontSizeRow({ t, setFontSize, setCodeFontSize, useStore }: FontSizeRowComponentProps) {
  const fontSize = useStore(s => s.fontSize)
  const codeFontSize = useStore(s => s.codeFontSize)
  const rows = [
    { key: 'fontSize', value: fontSize, set: setFontSize },
    { key: 'codeFontSize', value: codeFontSize, set: setCodeFontSize },
  ] as const
  return (
    <div>
      {rows.map(({ key, value, set }) => <div className={css.row} key={key}>
        <div className={css.rowText}>
          <div className={css.title}>{t(`${key}.title`)}</div>
          <div className={css.desc}>{t(`${key}.description`)}</div>
        </div>
        <div className={css.control}>
          <div className={css.stepper}>
            <span className={css.value}>{value}</span>
            <span className={css.arrows}>
              <button
                type="button"
                className={css.arrow}
                aria-label={t(`${key}.increase`)}
                disabled={value >= FONT_SIZE_MAX}
                onClick={() => { set(value + 1) }}
              >
                <IconChevronUpOutlineRegular size={9} />
              </button>
              <button
                type="button"
                className={css.arrow}
                aria-label={t(`${key}.decrease`)}
                disabled={value <= FONT_SIZE_MIN}
                onClick={() => { set(value - 1) }}
              >
                <IconChevronDownOutlineRegular size={9} />
              </button>
            </span>
          </div>
          <span className={css.unit}>{t('fontSize.unit')}</span>
        </div>
      </div>)}
      <div className={css.resetRow}>
        <button type="button" className={css.reset}
          disabled={fontSize === DEFAULT_FONT_SIZE && codeFontSize === DEFAULT_CODE_FONT_SIZE}
          onClick={() => { setFontSize(DEFAULT_FONT_SIZE); setCodeFontSize(DEFAULT_CODE_FONT_SIZE) }}>
          {t('fontSize.reset')}
        </button>
      </div>
    </div>
  )
}
