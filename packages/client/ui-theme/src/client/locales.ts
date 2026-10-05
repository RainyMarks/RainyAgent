/** `settings.theme` namespace dictionaries (the Appearance and font-size rows' copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'appearance.title': '外观',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.system': '跟随系统',
  'fontSize.title': '界面字号',
  'fontSize.description': '调整界面和聊天正文的基础字号',
  'fontSize.unit': 'px',
  'fontSize.increase': '增大字号',
  'fontSize.decrease': '减小字号',
  'codeFontSize.title': '代码字号',
  'codeFontSize.description': '调整聊天、文件预览和差异视图中的代码字号',
  'codeFontSize.increase': '增大代码字号',
  'codeFontSize.decrease': '减小代码字号',
  'fontSize.reset': '重置字号',
} satisfies Record<string, string>

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'fontSize.title': 'Interface font size',
  'fontSize.description': 'Base size for the interface and conversation text',
  'fontSize.unit': 'px',
  'fontSize.increase': 'Increase font size',
  'fontSize.decrease': 'Decrease font size',
  'codeFontSize.title': 'Code font size',
  'codeFontSize.description': 'Code in conversations, file previews, and diffs',
  'codeFontSize.increase': 'Increase code font size',
  'codeFontSize.decrease': 'Decrease code font size',
  'fontSize.reset': 'Reset font sizes',
} satisfies Record<ThemeKey, string>
