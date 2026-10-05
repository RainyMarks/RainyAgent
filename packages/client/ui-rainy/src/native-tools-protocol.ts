/** Fixed catalog and narrow desktop operations exposed to Rainy's trusted main window. */

/** Fixed identities accepted by the human catalog and its desktop operations. */
export const nativeToolIds = ['yakit', 'cyberchef', '7zip', 'exiftool', 'wireshark',
  'binwalk', 'ffmpeg', 'audacity', 'stegsolve', 'pngcheck', 'qrazybox', 'image-lsb-viewer',
  'imagemagick', 'ida', 'x64dbg', 'die', 'imhex', 'jadx', 'dnspy', 'pyinstxtractor-ng',
  'winmerge', 'qalculate', 'sonic-visualiser', 'tesseract-ocr', 'sox', 'tweakpng',
  'multimon-ng', 'gnu-strings', 'gimp', 'curl', 'jq', 'yq', 'sqlite', 'sqlite-browser',
  'qpdf', 'ripgrep', 'bruno', 'pcapfix'] as const

/** Stable identities of the bundled human-operated tools. */
export type NativeToolId = typeof nativeToolIds[number]

/** File availability is separate from completed tool acceptance. */
export interface NativeToolSummary {
  readonly id: NativeToolId
  readonly name: string
  readonly category: 'web' | 'misc' | 'reverse'
  readonly version: string
  readonly launchKind: 'desktop' | 'terminal' | 'web'
  readonly status: 'ready' | 'missing'
  readonly verified: boolean
  readonly missing: readonly string[]
  readonly variants?: readonly { readonly id: 'x32'; readonly name: string; readonly status: 'ready' | 'missing' }[]
}

/** Per-user preferences are shared by all conversations. */
export interface NativeToolPreferences {
  readonly favorites: readonly NativeToolId[]
  readonly recent: readonly NativeToolId[]
}

/** Current filesystem availability and saved user preferences. */
export interface NativeToolCatalog {
  readonly tools: readonly NativeToolSummary[]
  readonly preferences: NativeToolPreferences
}

/** Reports platform acceptance of a launch request; interface readiness and tool acceptance require separate observations. */
export interface NativeToolLaunchResult { readonly ok: boolean; readonly error?: string; readonly warning?: string }

/** Preload operations available only to the trusted main window. */
export interface NativeToolsBridge {
  /** Read current availability and user preferences. @returns the installed catalog. */
  listTools(): Promise<NativeToolCatalog>
  /**
   * Request startup of a fixed catalog entry; arbitrary paths and arguments are unsupported.
   * @param id - installed tool identity.
   * @param variant - the optional x32 debugger entry.
   * @returns whether the platform accepted the launch request, with a user-readable failure if rejected.
   */
  launchTool(id: NativeToolId, variant?: 'x32'): Promise<NativeToolLaunchResult>
  /** Save the complete favorites list. @param ids - selected tools. @returns durable completion. */
  setFavorites(ids: readonly NativeToolId[]): Promise<void>
}
