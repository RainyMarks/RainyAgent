---
description: "RainyAgent workspace editor, retained AI conversation, execution panels, and human tool workbench."
kind: "package-reference"
---
# Rainy workspace UI

English | [中文](README.zh.md)

## Summary

This browser plugin supplies RainyAgent's workspace editor, file tree, retained AI conversation, run/debug panels, and central CTF tool workbench. Editor state belongs to each workspace independently of chats. The Host retains the selected workspace across restarts and browser-origin changes. The Rainy desktop profile includes it by default; unloading it restores the shared shell and brand fallbacks.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The folder you open becomes the project's primary directory. Add folder attaches another independent directory without changing the chat's working directory. A pending native folder choice disables folder actions; overlapping requests share the first choice and its open-or-attach action until the workspace adopts the directory. Cancellation or failure permits another choice. File tabs, recovery buffers, breakpoints, and run configurations retain their root identity even when filenames match. Duplicate paths reuse their existing root; nested or overlapping roots are rejected. Removing an attached folder never deletes its files and requires its modified buffers to be saved or closed first.

Opening a folder and choosing New chat do not create a Session. The first text or attachment submission creates one in the selected project. Project restoration selects its recent chat only when the working directory matches; otherwise it opens a fresh draft. Selecting another project's chat from history restores that project's editor and keeps the selected chat. The file tree becomes interactive after project and chat restoration succeeds; a failed recovery save preserves the current project and buffers.

Settings uses one dialog for models, extensions, appearance, runtime environments and project memory. Adding a model clears the previous endpoint and credentials, starts local context at 100,000 tokens or API context at 1,000,000 tokens, and leaves output allocation automatic. Model discovery needs connection fields, while saving and probing require the complete configuration. The profile's `localModelContextWindow` and `apiModelContextWindow` fields control these initial values; saved or manually edited windows remain unchanged when switching model location. Memory has independent read and automatic-generation switches, editable entries, and deletion controls for the selected project. Runtime selection detects existing interpreters without installing them. Component preparation shows progress or a waiting notice and refreshes execution targets when the native flow completes or is cancelled. Menus follow the dialog's light or dark theme. Settings has no device-code, activation or renewal controls. This package uses the [RainyAgent source-available license](LICENSE); upstream components retain their own licenses.

The Strata card manages the bundled engine and Python through the desktop bridge in `./strata-protocol`. Users select supported Qwen3.8 Flash Next GGUF files, a model directory, or a Strata profile, plus matching MTP weights as a GGUF or prepared directory. An empty MTP path requests automatic detection, not disabling MTP. Selecting or saving files never starts the model. Explicit startup can prepare local runtime files and can be cancelled; the integration does not download model weights. Existing external servers can be connected but cannot be stopped by this card.

Connect and use by default waits for the selected Windows or WSL Host to verify the loaded endpoint, then displays its saved model identifier and actual context window in the existing model form. Reasoning and per-request output limits remain in that form. A Host that cannot reach Strata reports the connection error instead of selecting a cloud endpoint. Refresh retains unsaved card edits and never treats an older poll as the result of a completed configuration change.

New workspaces show the file tree and main editor; AI and execution panels open from the top toolbar when needed. Existing workspaces retain their saved panel visibility and widths. View → Focus editor hides the AI and bottom panels while retaining their state. The file pane has one row of actions; editor actions share the file-tab row, which is absent when no file or tool tab is open. File offers the Windows folder picker and a browser for the current execution target. Quick Open searches relative filenames without reading source contents and reports truncated results. The file pane defaults to 240 px and AI to 400 px; both resize. When space is tight, files can open over the editor. Model, context, Skills, MCP, Appearance, and preferences remain accessible through the single settings entry; see the [desktop guide](../../../apps/rainy-desktop/README.md).

The top toolbar centers the project switcher and Search files, which shows the Quick Open shortcut. Run and debug appear on the right while a file is being edited, followed by the file, bottom-panel and AI toggles, CTF tools and settings. Without a project, the editor area offers Open folder when the desktop folder picker is available, Browse folders on current host, and recent projects; with a project but no open file, it offers Search files, Create a new file and Open AI assistant. A window-wide status bar shows the execution environment, saving, run and debug activity, caret line and column, selection length, language, line endings and encoding.

Monaco reads complete UTF-8 source and retains undo history, selections, cursor positions, and scroll while tabs change. Binary, unsupported-encoding, and oversized files expose metadata and a bounded readonly text or hex preview; truncation is labeled and never enables saving a partial file. Explicit saves compare the last observed disk version. A changed disk file retains the local buffer and offers a diff; accepting a conflict uses only the version shown in that comparison. Dirty buffers are saved separately as recovery data before workspace changes and application exit. A concurrent recovery writer blocks further recovery writes while dirty data remains; source files can still be saved explicitly.

Settled AI reply code can open a readonly temporary editor tab, including before a workspace is selected, or compare with the active source buffer. Viewing the comparison preserves unsaved source edits. Apply to file buffer is explicit and does not save the file; if the target changed while the comparison was open, the comparison refreshes for another review. Temporary AI previews are excluded from durable workspace file recovery.

Python, JavaScript, TypeScript, C, and C++ connect to the Host language services for diagnostics and navigation. Symbol rename retains previously unopened edited files as background tabs with dirty recovery and explicit version-checked saves. Formatting changes the editor buffer; it does not save the source automatically. Run and Debug first save every dirty file, then use the selected workspace configuration. Named configurations retain program/module, arguments, environment, interpreter/compiler, and single-file or CMake build choices, including optional configure/build presets. Advanced options collapse without clearing their values; the configuration dialog scrolls within the window while keeping Save accessible. Interactive terminals, run output, breakpoints, stack frames, variables, and watches stay owned by their workspace when editor tabs change. The C/C++ debug console evaluates expressions in the selected frame; other language adapters receive REPL requests. Debugging launches a configured program; attaching to unrelated processes is not supported.

The Host embeds validated configuration in the page. `readyTimeoutMs` and `flushTimeoutMs` control the tool frame's startup and durable-save acknowledgements. `editorPollMs` observes open files, idle execution, and visible model settings including Strata; `executionPollMs` observes active execution. `editorStateDebounceMs` schedules recovery writes. `editorMaxOutputCharacters`, `editorMaxRetainedWorkspaces`, `editorTerminalCols`, and `editorTerminalRows` bound retained output and initialize terminals. Configuration changes take effect on the next page load.

The CTF tools toolbar button opens a central tab without a chat. Its default Common tools list searches names and localized uses, filters Web, Misc and Reverse, and displays favorites and recent launches. Preferences belong to the desktop user and remain shared across conversations. Desktop programs open separate windows, command-line tools open prepared terminals, and offline pages open isolated tool windows. Missing files disable launch; available but unverified tools remain marked Not verified. Launch feedback confirms that the platform accepted the request; interface readiness and functional acceptance require separate checks. The x64dbg entry also exposes x32dbg.

The desktop preload supplies the fixed-ID `NativeToolsBridge` from `./native-tools-protocol`; the client sends no paths or command arguments. Failed launches preserve the directory and report a shell toast; favorite controls wait for durable completion. An accepted launch request with a recent-history write failure reports a warning. A browser without this bridge offers IceSky and identifies native tools as desktop-only.

Missing-tool cards and directory-read errors offer Repair tool pack, which expands offline instructions without starting the installer. Save your work and exit RainyAgent and all tool windows, place the matching setup EXE and every tool-pack volume in the same directory, and run the installer again. After installation, reopen RainyAgent and refresh the tool status.

The IceSky tab loads one frame on its first visit and retains it while hidden. Changing conversations switches the frame's logical draft context even while the directory is selected; an unselected conversation or blank New Session page uses the independent context. Model and extension actions open the desktop profile's authenticated settings dialog, with the current session selected for extensions.

CTF follows the host's resolved semantic CSS colors and interface/code sizes. Workbench navigation and status controls follow the host language; bundled tool prose retains its original language. A failed load keeps the frame and offers Retry; a failed save keeps the current document and reports its unsaved state. Desktop waits for a durable save acknowledgement before stopping its Host, and preserves the window when that save fails. Restored legacy CTF tabs reveal the workspace without creating another iframe.

File and diff text follows the independent code-size setting; toolbar labels follow the interface scale. See the [theme settings](../ui-theme/README.md#use-this-package).

<a id="understand-the-implementation"></a>
## Understand the implementation

The desktop catalog downloads the complete tool pack into per-user storage with progress, cancellation and retry. Partial downloads and verified media are reused; installed tools remain available offline across restarts and application updates. The catalog checks the signed publisher channel on its first visit and exposes Check tool updates. Added or updated tools require an explicit download; unchanged packs remain local. Newly published tool IDs use the authenticated catalog without requiring a hardcoded client entry.

<details>
<summary>Implementation details</summary>

The `shell.workspace` contribution composes one occurrence of each `layout.region` factory: existing navigation, conversation, and auxiliary resource routing. Hiding a pane changes visibility without replacing its conversation owner. The workspace declares `rainy.ide.tools` for the retained tool workbench. Monaco, language clients, and xterm load from the application's own offline ESM bundle; ordinary browser contributions keep the shared Client module format. The Host owns file versions, workspace recovery revisions, execution lifetimes, and language-server processes. The browser validates responses and retains view state; it has no independent runtime invariant.

</details>

<a id="model-experience"></a>
## Model Experience

### Browser branding

#### What the model sees

The `slots` registrations render browser components only. Send selected code to AI explicitly submits the selected source, absolute mounted path, and line range through the existing logged user-message path. Ordinary editing and human execution do not inject file content into a chat. Settings delegates model, extension, and memory changes to the [desktop Host](../../../apps/rainy-desktop/README.md).

#### Token effect

The package registers no model tools or automatic prompt sections. An explicit selected-code message contributes its normal user-message tokens.

#### KV Cache effect

The package does not change provider request prefixes; an explicit selected-code message follows ordinary conversation caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Electron carrier owns the native window title and development-tool installer. Office documents have no structured preview. Language services, run/debug adapters, and file size limits belong to the desktop Host configuration.

<a id="dev-note"></a>
### Dev Note

No deferred design decisions.
