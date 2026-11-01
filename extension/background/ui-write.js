const fail = () => { throw Object.assign(new Error('Invalid native UI write contract.'), { code: 'INVALID_UI_WRITE' }); };
export function uiWriteRequest(command, args) {
  const spec = command.uiWrite;
  if (!spec || ![1, 2].includes(spec.version) || spec.method !== 'POST' || !(spec.version === 2 ? ['native-setter-no-events', 'native-input-change'] : ['native-setter-no-events']).includes(spec.inputMode)
    || command.runtime !== 'extension' || command.safety !== 'write' || command.requires_confirmation === false || command.pageWrite || command.pageWorkflow || command.execution
    || !Array.isArray(spec.inputs) || !spec.inputs.length || spec.inputs.length > 10) fail();
  if (args?.__confirmed !== true) throw Object.assign(new Error('Explicit confirmation is required.'), { code: 'CONFIRMATION_REQUIRED' });
  const names = spec.inputs.map(v => v.parameter);
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => k !== '__confirmed' && !names.includes(k))
    || names.some(k => typeof args[k] !== 'string' || args[k].length > 10000 || /[\r\n\0]/.test(args[k])) || !args[spec.confirmation?.parameter]?.trim()) fail();
  if (spec.inputs.some(v => v.kind === 'checkbox' && !['true', 'false'].includes(args[v.parameter]))) fail();
  return { url: spec.url, method: 'POST', body: Object.fromEntries(spec.inputs.map(v => [v.name, args[v.parameter]])) };
}

/** Runs in the retained isolated document. Events are opt-in and may write. */
export async function pageUiSubmit(input) {
  let submitted = false, eventsDispatched = 0;
  const error = code => { throw Object.assign(new Error(code), { code }); };
  const current = () => {
    if (Date.now() >= input.deadline) error('UI_WRITE_TIMEOUT');
    if (location.href !== input.documentUrl || globalThis.__weworkerWriteDocumentToken !== input.documentToken) error('PAGE_WRITE_DOCUMENT_CHANGED');
  };
  const unique = (root, selector) => {
    const nodes = root.querySelectorAll(selector);
    if (nodes.length !== 1) error('UI_WRITE_TARGET_AMBIGUOUS');
    return nodes[0];
  };
  const visible = node => {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return node.isConnected && rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) > 0 && !node.closest('[inert],[hidden]');
  };
  try {
    current();
    const spec = input.ui;
    const enhanced = spec?.version === 2;
    if (!spec || ![1, 2].includes(spec.version) || spec.method !== 'POST' || !(enhanced ? ['native-setter-no-events', 'native-input-change'] : ['native-setter-no-events']).includes(spec.inputMode)
      || spec.url !== input.request.url || input.request.method !== 'POST' || !Array.isArray(spec.inputs) || !spec.inputs.length || spec.inputs.length > 10) error('INVALID_UI_WRITE');
    if (spec.result !== undefined && (!spec.result || Object.keys(spec.result).sort().join(',') !== 'attribute,idType,publicId'
      || spec.result.publicId !== true || !(enhanced?['string','integer','signed-integer','decimal']:['string', 'integer']).includes(spec.result.idType)
      || !/^data-[a-z][a-z0-9-]{0,63}$/.test(spec.result.attribute)
      || /token|cookie|auth|password|secret|session|credential|api.?key|csrf|ticket|prototype|constructor/i.test(spec.result.attribute)
      || spec.result.attribute === spec.confirmation.attribute)) error('INVALID_UI_WRITE');
    if (!enhanced && (spec.shadowRoots || spec.hiddenFields || spec.submit?.mode || spec.inputs.some(v => v.kind))) error('INVALID_UI_WRITE');
    const autosave = spec.submit?.mode === 'none';
    if (spec.submit?.mode && !['none', 'requestSubmit', 'click', 'enter'].includes(spec.submit.mode) || autosave && spec.inputMode !== 'native-input-change') error('INVALID_UI_WRITE');
    const enter = spec.submit?.mode === 'enter';
    let root = document;
    const roots = [];
    for (const selector of spec.shadowRoots || []) {
      const host = unique(root, selector);
      if (!host.shadowRoot || roots.length >= 8) error('UI_WRITE_SHADOW_UNAVAILABLE');
      roots.push({ root, selector, host, shadow: host.shadowRoot }); root = host.shadowRoot;
    }
    const form = unique(root, spec.form), submit = autosave ? null : unique(form, spec.submit.selector), receipt = unique(root, spec.confirmation.selector);
    const previousId = spec.result ? receipt.getAttribute(spec.result.attribute) : null;
    const entries = spec.inputs.map(binding => ({ binding, node: unique(form, binding.selector) }));
    const hidden = (spec.hiddenFields || []).map(binding => ({ binding, node: unique(form, binding.selector) }));
    const correlate = entries.find(v => v.binding.parameter === spec.confirmation.parameter);
    if (!correlate || Object.keys(input.request.body).length !== entries.length || entries.some(({ binding }) => typeof input.request.body[binding.name] !== 'string')) error('INVALID_UI_WRITE');
    const wanted = input.request.body[correlate.binding.name];
    const valueOf = ({ binding, node }) => binding.kind === 'choice' ? node.getAttribute('data-value') : binding.kind === 'checkbox' ? String(node.checked) : binding.kind === 'contenteditable' ? node.textContent : node.value;
    const inspect = (allowReceipt = false) => {
      current();
      if (roots.some(v => unique(v.root, v.selector) !== v.host || !v.host.isConnected || v.host.shadowRoot !== v.shadow)) error('UI_WRITE_TARGET_CHANGED');
      if (!(form instanceof HTMLFormElement) || form.action !== spec.url || form.method !== 'post' || form.target && form.target !== '_self'
        || form.enctype !== 'application/x-www-form-urlencoded' || form.noValidate || !visible(form)
        || unique(root, spec.form) !== form || unique(root, spec.confirmation.selector) !== receipt) error('UI_WRITE_TARGET_CHANGED');
      if (!autosave && (unique(form, spec.submit.selector) !== submit || (enter ? !entries.some(v => v.node === submit) || !(submit instanceof HTMLInputElement) || submit.getAttribute('aria-label') !== spec.submit.text
        : !(submit instanceof HTMLButtonElement) || submit.type !== 'submit' || submit.name || submit.textContent.trim() !== spec.submit.text) || submit.form !== form || submit.matches(':disabled') || !visible(submit)
        || ['formaction', 'formmethod', 'formenctype', 'formtarget', 'formnovalidate'].some(k => submit.hasAttribute(k))
        )) error('UI_WRITE_TARGET_CHANGED');
      for (const { binding, node } of entries) {
        const kind = binding.kind || 'text';
        const supported = kind === 'text' ? node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement && ['text', 'search'].includes(node.type)
          : kind === 'date' ? node instanceof HTMLInputElement && node.type === 'date'
          : kind === 'choice' ? node instanceof HTMLButtonElement && node.form === form && node.type === 'button' && node.getAttribute('role') === 'combobox' && node.getAttribute('data-field') === binding.name && !node.name
          : kind === 'select' ? node instanceof HTMLSelectElement && !node.multiple
          : kind === 'checkbox' ? node instanceof HTMLInputElement && node.type === 'checkbox'
          : kind === 'contenteditable' && node.isContentEditable && node.getAttribute('role') === 'textbox' && node.getAttribute('data-field') === binding.name;
        if (unique(form, binding.selector) !== node || !visible(node) || (!['contenteditable','choice'].includes(kind) && (node.form !== form || node.name !== binding.name)) || node.matches(':disabled') || node.readOnly
          || node.getAttribute('aria-disabled') === 'true' || !supported) error('UI_WRITE_INPUT_UNSUPPORTED');
        if (kind === 'select') {
          const options = [...node.options].filter(v => v.value === input.request.body[binding.name]);
          if (options.length !== 1 || options[0].disabled || options[0].parentElement?.disabled) error('UI_WRITE_INPUT_UNSUPPORTED');
        }
        if (kind === 'checkbox' && !['true', 'false'].includes(input.request.body[binding.name])) error('INVALID_UI_WRITE');
      }
      for (const { binding, node } of hidden) {
        if (binding.source !== 'page' || unique(form, binding.selector) !== node || !(node instanceof HTMLInputElement) || node.type !== 'hidden' || !node.isConnected
          || node.form !== form || node.name !== binding.name || node.matches(':disabled')) error('UI_WRITE_HIDDEN_CHANGED');
      }
      // Page-owned hidden values never cross the isolated document boundary.
      const declared = [...entries, ...hidden];
      if (new Set(declared.map(v => v.node)).size !== declared.length || [...form.elements].some(node => node.name && !node.matches(':disabled') && !declared.some(v => v.node === node))) error('UI_WRITE_EXTRA_FIELDS');
      if (!visible(receipt) || !/^data-[a-z][a-z0-9-]*$/.test(spec.confirmation.attribute) || !wanted?.trim() || !allowReceipt && receipt.getAttribute(spec.confirmation.attribute) === wanted) error('UI_WRITE_STALE_CONFIRMATION');
      if (!allowReceipt && spec.result && receipt.getAttribute(spec.result.attribute) !== previousId) error('UI_WRITE_TARGET_CHANGED');
    };
    inspect();
    for (const { binding, node } of entries) {
      if (binding.kind === 'choice') continue;
      if (binding.kind === 'contenteditable') node.textContent = input.request.body[binding.name];
      else {
        const prototype = binding.kind === 'select' ? HTMLSelectElement.prototype : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, binding.kind === 'checkbox' ? 'checked' : 'value').set.call(node, binding.kind === 'checkbox' ? input.request.body[binding.name] === 'true' : input.request.body[binding.name]);
      }
    }
    inspect();
    if (entries.some(entry => entry.binding.kind !== 'choice' && valueOf(entry) !== input.request.body[entry.binding.name])
      || [...form.elements].some(node => node.willValidate && !node.validity.valid)) error('UI_WRITE_INPUT_REJECTED');
    // Popup choices are explicit page actions, not arbitrary widget scripts.
    // All other values are prepared first; each click can itself have effects.
    for (const entry of entries.filter(v => v.binding.kind === 'choice')) {
      const {binding,node}=entry, wantedValue=input.request.body[binding.name];
      inspect();
      if(node.getAttribute('data-value')===wantedValue)continue;
      eventsDispatched++; HTMLElement.prototype.click.call(node); await Promise.resolve();
      inspect();
      const popup=unique(root,binding.popup);
      if(!visible(popup)||!popup.id||node.getAttribute('aria-controls')!==popup.id||node.getAttribute('aria-expanded')!=='true'
        || !['listbox','grid'].includes(popup.getAttribute('role')))error('UI_WRITE_CHOICE_UNAVAILABLE');
      const options=[...popup.querySelectorAll(binding.option)];
      if(options.length>500)error('UI_WRITE_CHOICE_UNAVAILABLE');
      const matches=options.filter(v=>v.getAttribute('data-value')===wantedValue);
      if(matches.length!==1)error('UI_WRITE_CHOICE_AMBIGUOUS');
      const option=matches[0];
      if(!visible(option)||!['option','gridcell'].includes(option.getAttribute('role'))||option.matches(':disabled')||option.getAttribute('aria-disabled')==='true')error('UI_WRITE_CHOICE_UNAVAILABLE');
      inspect();
      if(unique(root,binding.popup)!==popup||!option.isConnected||!popup.contains(option))error('UI_WRITE_TARGET_CHANGED');
      eventsDispatched++;HTMLElement.prototype.click.call(option);await Promise.resolve();
      inspect(autosave);
      if(valueOf(entry)!==wantedValue)error('UI_WRITE_INPUT_REJECTED');
    }
    const valuesMatch = () => entries.every(entry => valueOf(entry) === input.request.body[entry.binding.name]);
    if (!valuesMatch() || [...form.elements].some(node => node.willValidate && !node.validity.valid)) error('UI_WRITE_INPUT_REJECTED');
    if (spec.inputMode === 'native-input-change') {
      for (const { node } of entries.filter(v => v.binding.kind !== 'choice')) for (const type of ['input', 'change']) {
        inspect(autosave); if (!valuesMatch()) error('UI_WRITE_INPUT_REJECTED');
        eventsDispatched++;
        node.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
        // Let controlled renderers commit before rechecking the retained nodes.
        await Promise.resolve();
      }
    }
    inspect(autosave);
    if (!valuesMatch()) error('UI_WRITE_INPUT_REJECTED');
    const dispatch = () => {
      inspect(autosave); if (!valuesMatch()) error('UI_WRITE_INPUT_REJECTED');
      if (submitted) error('UI_WRITE_ALREADY_DISPATCHED');
      if (!autosave) {
        submitted = true;
        if (enter) { submit.focus(); return; }
        if (spec.submit.mode === 'click') HTMLElement.prototype.click.call(submit);
        else HTMLFormElement.prototype.requestSubmit.call(form, submit);
      }
    };
    const waitReceipt = async () => {
    while (true) {
      current();
      if (roots.some(v => unique(v.root, v.selector) !== v.host || !v.host.isConnected || v.host.shadowRoot !== v.shadow)
        || !form.isConnected || unique(root, spec.form) !== form || !receipt.isConnected || unique(root, spec.confirmation.selector) !== receipt) error('UI_WRITE_TARGET_CHANGED');
      if (receipt.getAttribute(spec.confirmation.attribute) === wanted && visible(receipt)) {
        let resultId;
        if (spec.result) {
          const raw = receipt.getAttribute(spec.result.attribute);
          if (raw === previousId) error('UI_WRITE_STALE_RESULT_ID');
          // DOM attributes are text. Explicit integer mode parses only canonical
          // non-negative decimal; string mode preserves leading zeros/Unicode.
          const valid = typeof raw === 'string' && (spec.result.idType === 'integer'
            ? /^(0|[1-9][0-9]{0,15})$/.test(raw) && Number.isSafeInteger(Number(raw))
            : spec.result.idType === 'signed-integer' ? /^(?:0|-?[1-9][0-9]{0,15})$/.test(raw) && Number.isSafeInteger(Number(raw))
            : spec.result.idType === 'decimal' ? raw.length<=512 && /^(?:0|-?[1-9][0-9]*)$/.test(raw)
            : raw.length > 0 && raw.length <= 512 && raw !== '.' && raw !== '..' && /^[\p{L}\p{N}_.-]+$/u.test(raw));
          if (!valid) error('UI_WRITE_RESULT_ID_INVALID');
          resultId = ['integer','signed-integer'].includes(spec.result.idType) ? Number(raw) : raw;
        }
        return { ok: true, value: { ok: true, submitted: true, confirmationMatched: true, effectVerified: false, ...(enhanced ? { submitDispatched: submitted, eventsDispatched } : {}), ...(spec.result ? { resultId } : {}) }, submitted, eventsDispatched };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    };
    if (input.actionToken) {
      globalThis[input.actionToken] = { dispatch, waitReceipt, node:submit, check:() => {inspect(autosave);return valuesMatch();} };
      return {ok:true,prepared:true,previousId,eventsDispatched};
    }
    if (enter) error('UI_WRITE_NATIVE_ENTER_REQUIRED');
    dispatch();
    return await waitReceipt();
  } catch (cause) { return { ok: false, error: { code: cause.code || 'UI_WRITE_FAILED' }, submitted, eventsDispatched }; }
}

/** Read a receipt in an explicitly declared new document, never run form actions. */
export function pageUiNavigationReceipt(input) {
  const fail = code => ({ok:false,error:{code}});
  if (Date.now() >= input.deadline || location.href !== input.documentUrl) return fail('UI_WRITE_NAVIGATION_CHANGED');
  let root=document;
  for(const selector of input.ui.shadowRoots || []) {const nodes=root.querySelectorAll(selector);if(nodes.length!==1||!nodes[0].shadowRoot)return fail('UI_WRITE_SHADOW_UNAVAILABLE');root=nodes[0].shadowRoot;}
  const nodes=root.querySelectorAll(input.ui.confirmation.selector);
  if(nodes.length!==1)return fail('UI_WRITE_TARGET_AMBIGUOUS');
  const node=nodes[0],rect=node.getBoundingClientRect(),style=getComputedStyle(node);
  if(!node.isConnected||!rect.width||!rect.height||style.visibility!=='visible'||style.display==='none'||node.closest('[hidden],[inert]'))return fail('UI_WRITE_CONFIRMATION_FAILED');
  const name=input.ui.inputs.find(v=>v.parameter===input.ui.confirmation.parameter)?.name;
  if(node.getAttribute(input.ui.confirmation.attribute)!==input.request.body[name])return fail('UI_WRITE_CONFIRMATION_FAILED');
  let resultId;
  if(input.ui.result) {
    const raw=node.getAttribute(input.ui.result.attribute),type=input.ui.result.idType;
    if(raw===input.previousId)return fail('UI_WRITE_STALE_RESULT_ID');
    if(typeof raw!=='string'||!(type==='integer'?/^(0|[1-9][0-9]{0,15})$/.test(raw)&&Number.isSafeInteger(Number(raw)):type==='signed-integer'?/^(?:0|-?[1-9][0-9]{0,15})$/.test(raw)&&Number.isSafeInteger(Number(raw)):type==='decimal'?raw.length<=512&&/^(?:0|-?[1-9][0-9]*)$/.test(raw):raw.length>0&&raw.length<=512&&raw!=='.'&&raw!=='..'&&/^[\p{L}\p{N}_.-]+$/u.test(raw)))return fail('UI_WRITE_RESULT_ID_INVALID');
    resultId=['integer','signed-integer'].includes(type)?Number(raw):raw;
  }
  return {ok:true,value:{ok:true,submitted:true,confirmationMatched:true,effectVerified:false,...(input.ui.result?{resultId}:{})}};
}
