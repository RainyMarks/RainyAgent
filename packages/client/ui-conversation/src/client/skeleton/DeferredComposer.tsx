/** The existing draft editor and composer styling for a browser-only first message. */
import { useEffect, useRef, useState } from 'react'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconPlusOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { DraftEditor } from '../input/editor/DraftEditor.tsx'
import { DraftEditorRuntime } from '../input/editor/runtime.ts'
import { registerComposerKeymap } from '../input/editor/keymap.ts'
import css from './InputBar.module.css'

/**
 * Render a draft without creating a Session or uploading its files.
 * @param props - consumer-owned draft and lifecycle callbacks.
 * @returns the shared composer surface.
 */
export function DeferredComposer(props: FactoryComponentPropsOf<'conversation.deferredComposer'>) {
  const current = useRef(props)
  current.current = props
  const scroll = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [runtime, setRuntime] = useState<DraftEditorRuntime | undefined>()
  const locked = props.disabled || props.busy
  useEffect(() => {
    const draft = new DraftEditorRuntime({
      onUpdate: () => { draft.refreshProjection(); current.current.onChange(draft.projection.clipboardText) },
      openReference: () => false, activeClaimToken: () => null,
      lexicon: () => new Map(), resolveLexicon: () => undefined,
    })
    const unregister = draft.register()
    const unbind = registerComposerKeymap(draft.editor, {
      arbitrate: () => 'pass', space: () => false, dismissPopup: () => {},
      canSubmit: () => !current.current.disabled && !current.current.busy
        && (draft.projection.clipboardText.trim() !== '' || current.current.files.length > 0),
      submit: () => { current.current.onSubmit() },
      intakeFiles: (files) => { if (!current.current.disabled && !current.current.busy) current.current.onAddFiles(files) },
      pasteText: (text) => { if (!current.current.disabled && !current.current.busy) draft.paste(text) },
    })
    draft.setDraft(current.current.text)
    setRuntime(draft)
    return () => { unbind(); unregister() }
  }, [])
  useEffect(() => { runtime?.setDraft(props.text) }, [runtime, props.text])
  const placeholder = props.disabled ? props.t('placeholder.workspace') : props.t('placeholder.hero')
  return <div className={`${css.root} ${css.hero}`} data-deferred-composer>
    {props.error !== '' && <div className={css.notice} role="alert">{props.error}</div>}
    <div className={css.card} data-composer-card
      onDragOver={(event) => { if (!locked) event.preventDefault() }}
      onDrop={(event) => {
        if (locked) return
        event.preventDefault()
        props.onAddFiles(Array.from(event.dataTransfer.files))
      }}>
      {props.workspace !== '' && <div className={css.accessory}>{props.workspace}</div>}
      {props.files.length > 0 && <div className={css.accessory}>
        {props.files.map((file, index) => <Button key={`${index}:${file.name}`} size="sm" variant="outline" disabled={locked}
          aria-label={props.t('file.remove', { name: file.name })} onClick={() => { props.onRemoveFile(index) }}>{file.name} ×</Button>)}
      </div>}
      <DraftEditor classNames={css} editor={runtime?.editor ?? null} scrollRef={scroll}
        editable={!locked} editorDisabled={locked} phase={props.busy ? 'submitting' : 'plain'}
        placeholderText={placeholder} ariaLabel={placeholder} workspaceTrigger={false} workspacePickerOpen={false}
        onWorkspaceKeyDown={() => {}} hint={null} showPlaceholder={props.text === ''} />
      <div className={css.row}>
        <div className={css.tools}>
          <button type="button" className={css.add} aria-label={props.t('input.file')} disabled={locked}
            onClick={() => { fileInput.current?.click() }}><IconPlusOutlineMedium size={14} /></button>
          <input ref={fileInput} type="file" multiple hidden disabled={locked} onChange={(event) => {
            props.onAddFiles(Array.from(event.target.files ?? [])); event.target.value = ''
          }} />
        </div>
        <div className={css.trailing}>
          <button type="button" className={css.primary} aria-label={props.t('input.send')}
            disabled={locked || props.text.trim() === '' && props.files.length === 0} onClick={props.onSubmit}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M8 2 2 8h4v6h4V8h4z" fill="currentColor" /></svg>
          </button>
        </div>
      </div>
    </div>
  </div>
}
