/** Agent-neutral browser commands. Session names bind independent CLI processes. */
const target = ['selector?', 'ref?', 'role?', 'name?', 'text?', 'frameId?', 'documentId?', 'shadow?'];
export const browserCommands = {
  help: { description: 'Describe browser commands and their arguments.', params: [] },
  doctor: { description: 'Check Bridge version, extension capabilities and a live tab query.', params: [] },
  sessions: { description: 'List persisted browser session bindings.', params: [] },
  tabs: { description: 'List HTTP(S) browser tabs.', params: [] },
  bind: { description: 'Bind an existing tab to a named session without navigating it.', params: ['session', 'tabId'] },
  unbind: { description: 'Release a session without closing the tab.', params: ['session'] },
  open: { description: 'Open or navigate a session-owned tab. Bound user tabs cannot be navigated by this command.', params: ['session', 'url', 'background?'] },
  close: { description: 'Close an owned tab, or release a user-bound tab without closing it.', params: ['session'] },
  back: { description: 'Navigate back in an owned tab.', params: ['session'] },
  reload: { description: 'Reload the selected page.', params: ['session'] },
  state: { description: 'Read DOM state with date/select/file compound metadata (compound=false omits it), or Chrome ax. shadow=true includes open shadow controls; compareSources reports DOM/AX metrics without replacing refs.', params: ['session', 'frameId?', 'documentId?', 'limit?', 'source?', 'compareSources?', 'shadow?', 'compound?'] },
  find: { description: 'Find elements by CSS, role/name, text or reference, with date/select/file compound metadata. shadow=true queries each open root; CSS combinators stay inside each tree. Ambiguity never chooses the first match.', params: ['session', ...target, 'limit?', 'compound?'] },
  get: { description: 'Read text, value, html, attribute or compound. html with as=json returns a bounded structured tree; depth/childrenMax/textMax/maxNodes control its limits. Passwords are redacted, scripts omitted. Compound includes date format/constraints, select options/current selection and file metadata.', params: ['session', ...target, 'property?', 'attribute?', 'as?', 'depth?', 'childrenMax?', 'textMax?', 'maxNodes?', 'compound?'] },
  extract: { description: 'Read visible page or element text.', params: ['session', ...target, 'maxChars?'] },
  click: { description: 'Click one unambiguous element.', params: ['session', ...target] },
  dblclick: { description: 'Double-click one element.', params: ['session', ...target] },
  fill: { description: 'Replace an editable field and dispatch input/change events.', params: ['session', ...target, 'value'] },
  type: { description: 'Append text to an editable field.', params: ['session', ...target, 'value'] },
  select: { description: 'Select native options by auto (value or label), value, or label. Ambiguous or disabled options fail before changing selection; the final selection is verified.', params: ['session', ...target, 'value', 'by?'] },
  check: { description: 'Ensure a checkbox or radio is checked.', params: ['session', ...target] },
  uncheck: { description: 'Ensure a checkbox is unchecked.', params: ['session', ...target] },
  focus: { description: 'Focus an element.', params: ['session', ...target] },
  hover: { description: 'Move the pointer over an element.', params: ['session', ...target] },
  drag: { description: 'Drag between two unambiguous CSS targets in the selected frame using a native pointer.', params: ['session', 'selector', 'toSelector', 'frameId?', 'documentId?', 'shadow?'] },
  upload: { description: 'Set files on one retained native input, including hidden, shadow and frame targets. Supports selector/semantic/ref targets and AX references. paths are absolute local files; file names/sizes are verified after selection. Use directory=true with one directory; chooser=true targets the button opening a native file chooser. Selection verifies metadata, not server receipt.', params: ['session', ...target, 'paths', 'directory?', 'chooser?'] },
  scroll: { description: 'Scroll the page or element in a direction.', params: ['session', ...target, 'direction?', 'amount?'] },
  keys: { description: 'Send a keyboard key or modifier combination to the focused page.', params: ['session', 'key'] },
  frames: { description: 'List accessible page frames, including cross-origin frames, with Chrome frameId and documentId for navigation-safe selection.', params: ['session'] },
  eval: { description: 'Evaluate JavaScript in MAIN world; optional frameId/documentId selects a specific frame, including nested cross-origin frames.', params: ['session', 'expression', 'frameId?', 'documentId?'] },
  screenshot: { description: 'Capture PNG with optional numbered DOM references and temporary CSS viewport width/height. fullPage ignores height. Optional absolute path saves a new local file without overwriting. Returns dimensions, annotation refs and restoration status.', params: ['session', 'fullPage?', 'annotate?', 'width?', 'height?', 'path?'] },
  console: { description: 'Read bounded console messages; CLI follow=true emits JSON Lines from main and child frames.', params: ['session', 'after?', 'level?', 'limit?', 'since?', 'until?', 'match?', 'follow?', 'cursor?', 'durationMs?', 'maxEvents?', 'intervalMs?'] },
  dialog: { description: 'Inspect or accept/dismiss a JavaScript dialog.', params: ['session', 'action?', 'text?'] },
  network: { description: 'Read captured network traffic or inspect a key; CLI follow=true emits new completed/failed/redirected requests as JSON Lines.', params: ['session', 'detail?', 'all?', 'failed?', 'since?', 'until?', 'limit?', 'match?', 'follow?', 'cursor?', 'durationMs?', 'maxEvents?', 'intervalMs?'] },
  events: { description: 'Poll a bounded console/network event batch without locking page actions. Cursor belongs to this tab, channel and observation; expired history fails explicitly.', params: ['session', 'channel', 'cursor?', 'level?', 'all?', 'failed?', 'since?', 'until?', 'limit?', 'match?'] },
  downloads: { description: 'Read downloads observed in this tab and a cursor to mark the next action. Only metadata is returned; no browser history or file contents are read.', params: ['session', 'after?', 'downloadId?', 'match?', 'limit?'] },
  wait: { description: 'Wait for selector/text/xhr/time or a tab download. shadow=true is supported for selector waits. Download waits accept a filename/URL substring and an optional prior cursor or downloadId.', params: ['session', 'kind', 'value?', 'timeoutMs?', 'frameId?', 'documentId?', 'after?', 'downloadId?', 'shadow?'] },
};

export const isBrowserObserver = (command, args) => ['dialog', 'downloads', 'events'].includes(command) || (command === 'wait' && args.kind === 'download');

export function browserHelp() {
  return { namespace: 'browser', schemaVersion: 1, usage: 'webcli call browser.<command> --session=work --key=value',
    desktopRequired: false, model: 'calling-agent', target: 'Use selector, role/name, text, or the exact ref from the latest state/find result. Ambiguous matches fail.',
    commands: Object.entries(browserCommands).map(([name, value]) => ({ name: `browser.${name}`, ...value })) };
}
