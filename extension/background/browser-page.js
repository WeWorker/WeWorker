/** Injected as a function into an isolated world. Keep all helpers inside. */
export async function runBrowserPageCommand(command, args = {}) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  try {
    if (args.shadow !== undefined && ![true, false, 'true', 'false'].includes(args.shadow)) fail('INVALID_ARGUMENT', 'shadow must be true or false.');
    if (args.compound !== undefined && ![true, false, 'true', 'false'].includes(args.compound)) fail('INVALID_ARGUMENT', 'compound must be true or false.');
    const shadow = args.shadow === true || args.shadow === 'true';
    const limit = Math.max(1, Math.min(Number(args.limit) || 100, 200));
    const visible = node => !!(node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    const role = node => node.getAttribute('role') || ({ BUTTON: 'button', A: 'link', TEXTAREA: 'textbox', SELECT: 'combobox' }[node.tagName])
      || (node.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', search: 'searchbox', submit: 'button', button: 'button', file: 'button' }[node.type] || 'textbox') : '');
    const label = node => (node.getAttribute('aria-label') || (node.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => node.getRootNode().getElementById?.(id)?.textContent || '').join(' ').trim()
      || [...(node.labels || [])].map(item => item.textContent).join(' ') || node.getAttribute('placeholder') || node.textContent || '').trim().slice(0, 500);
    const shadowHosts = node => {
      const hosts=[]; let root=node.getRootNode();
      while(root instanceof ShadowRoot){hosts.unshift({tag:root.host.tagName.toLowerCase(),...(root.host.id?{id:root.host.id}:{})});root=root.host.getRootNode();}
      return hosts;
    };
    const disabled = node => Boolean(node.disabled || node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true');
    let inspectionRemaining=100000;
    const compound = node => {
      const clipped={};
      const text=(value,key,max=500)=>{const s=String(value??'');if(s.length>max)clipped[key]=true;return s.slice(0,max);};
      const formats={date:'YYYY-MM-DD',time:'HH:mm[:ss[.SSS]]','datetime-local':'YYYY-MM-DDTHH:mm[:ss[.SSS]]',month:'YYYY-MM',week:'YYYY-Www'};
      let result;
      if(node.tagName==='INPUT'&&Object.hasOwn(formats,node.type)){
        result={control:node.type,format:formats[node.type],current:text(node.value,'current'),required:!!node.required,readOnly:!!node.readOnly};
        for(const key of ['min','max','step'])if(node.getAttribute(key)!==null)result[key]=text(node.getAttribute(key),key);
        if(node.validity)result.validity=Object.fromEntries(['valid','valueMissing','badInput','rangeUnderflow','rangeOverflow','stepMismatch','typeMismatch','customError'].map(key=>[key,!!node.validity[key]]));
      }else if(node.tagName==='INPUT'&&node.type==='file'){
        const files=node.files||[];
        result={control:'file',multiple:!!node.multiple,accept:text(node.accept,'accept'),required:!!node.required,current:Array.from({length:Math.min(files.length,100)},(_,i)=>text(files[i].name,'names',200)),filesTotal:files.length};
        if(files.length>100)clipped.current=true;
      }else if(node.tagName==='SELECT'){
        const options=node.options;
        if(options.length>20000)return{control:'select',options_total:options.length,omitted:'option_scan_limit'};
        const labelOf=option=>String(option.label||option.textContent||'').trim();
        const selected=[];for(let i=0;i<options.length;i++)if(options[i].selected)selected.push(options[i]);
        const current=selected.slice(0,1000).map(option=>text(labelOf(option),'current',200)),values=selected.slice(0,1000).map(option=>text(option.value,'currentValues'));
        result={control:'select',multiple:!!node.multiple,required:!!node.required,current:node.multiple?current:(current[0]??''),currentValues:node.multiple?values:(values[0]??''),selectedTotal:selected.length,
          options:Array.from(options).slice(0,50).map((option,index)=>({index,label:text(labelOf(option),'labels',200),value:text(option.value,'values'),selected:!!option.selected,disabled:disabled(option),...(option.parentElement?.tagName==='OPTGROUP'?{group:text(option.parentElement.label,'groups',200)}:{})})),options_total:options.length};
        if(options.length>50)clipped.options=true;if(selected.length>1000){clipped.current=true;clipped.currentValues=true;}
      }else return null;
      if(Object.keys(clipped).length)result.truncated=clipped;
      const length=JSON.stringify(result).length;
      if(length>inspectionRemaining)return{control:result.control,omitted:'response_budget'};
      inspectionRemaining-=length;return result;
    };
    const rich = node => {
      if(args.compound===false||args.compound==='false')return{};
      const info=compound(node);return info?{compound:info}:{};
    };
    const describe = (node, ref) => ({ ref, tag: node.tagName.toLowerCase(), role: role(node), name: label(node),
      ...(node.id ? { id: node.id } : {}), ...(node.getAttribute('type') ? { type: node.getAttribute('type') } : {}),
      ...(node.getRootNode() instanceof ShadowRoot ? {shadowHosts:shadowHosts(node)} : {}),
      disabled: disabled(node), ...(node.type === 'checkbox' || node.type === 'radio' ? { checked: node.checked } : {}),...rich(node) });
    // Explicit opt-in preserves normal CSS scope. Each open shadow root is a
    // separate CSS tree: combinators never silently jump across a host boundary.
    let roots;
    const queryAll = selector => {
      try {
        if(!shadow)return [...document.querySelectorAll(selector)];
        if(!roots){
          roots=[document];const depths=[0];let scanned=0;
          for(let i=0;i<roots.length;i++){
            const walker=document.createTreeWalker(roots[i],NodeFilter.SHOW_ELEMENT);
            let node;while((node=walker.nextNode())){
              if(++scanned>20000)fail('SHADOW_QUERY_LIMIT','Open-shadow lookup exceeds 20000 elements. Select a smaller frame or use an AX reference.');
              if(node.shadowRoot){
                if(roots.length>=101||depths[i]>=32)fail('SHADOW_QUERY_LIMIT','Open-shadow lookup exceeds 100 roots or 32 nested boundaries. Use an AX reference.');
                roots.push(node.shadowRoot);depths.push(depths[i]+1);
              }
            }
          }
        }
        return roots.flatMap(root=>[...root.querySelectorAll(selector)]);
      }catch(error){if(error.code==='SHADOW_QUERY_LIMIT')throw error;fail('INVALID_SELECTOR','Invalid CSS selector.');}
    };
    const query = () => {
      if (args.ref) {
        const snapshot = globalThis.__weworkerBrowserSnapshot;
        const found = snapshot?.refs.get(String(args.ref));
        if (!found || !found.node.isConnected || found.node.ownerDocument !== document || snapshot.url !== location.href || (!found.ax && (found.label !== label(found.node) || (found.role !== undefined && found.role !== role(found.node))))) fail('STALE_REF', 'Reference expired. Read browser.state/find again or use a selector.');
        return [found.node];
      }
      let nodes = queryAll(args.selector || '*');
      if (args.role) nodes = nodes.filter(node => role(node) === args.role);
      if (args.name !== undefined) nodes = nodes.filter(node => label(node) === String(args.name));
      if (args.text !== undefined) nodes = nodes.filter(node => node.textContent.trim() === String(args.text) && ![...node.children].some(child => child.textContent.trim() === String(args.text)));
      return nodes.filter(node=>visible(node)||command==='upload-target'||(command==='get'&&args.property==='compound'));
    };
    const one = () => {
      if (!args.selector && !args.ref && !args.role && args.text === undefined) fail('INVALID_ARGUMENT', 'Provide selector, ref, role/name or text.');
      const nodes = query();
      if (!nodes.length) fail('ELEMENT_NOT_FOUND', 'No visible element matches the target.');
      if (nodes.length > 1) fail('AMBIGUOUS_TARGET', `${nodes.length} elements match. Use a more specific target.`);
      return nodes[0];
    };
    if (command === 'state' || command === 'find') {
      const nodes = command === 'find' ? query() : queryAll('a[href],button,input,textarea,select,[role],[contenteditable="true"],[tabindex]').filter(visible);
      if (args.metricsOnly) return {ok:true,data:{url:location.href,title:document.title,metrics:{source:'dom',interactiveNodes:nodes.length,
        namedInteractiveNodes:nodes.filter(node=>label(node)).length,textChars:Math.min(document.body?.innerText.length||0,12000),
        roles:Object.fromEntries([...new Set(nodes.map(role))].map(value=>[value,nodes.filter(node=>role(node)===value).length])),truncated:nodes.length>limit||(document.body?.innerText.length||0)>12000}}};
      // randomUUID is unavailable on HTTP documents. getRandomValues is also
      // available in insecure contexts; keep identifiers unique across reloads.
      const snapshotId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      const refs = new Map();
      const elements = nodes.slice(0, limit).map((node, index) => { const ref = `${shadow||node.getRootNode() instanceof ShadowRoot?'shadow:':''}${snapshotId}:${index + 1}`; refs.set(ref, { node, label: label(node), role: role(node) }); return describe(node, ref); });
      globalThis.__weworkerBrowserSnapshot = { refs, url: location.href, snapshotId, source: 'dom' };
      return { ok: true, data: { url: location.href, title: document.title, snapshotId, matches: nodes.length, elements,
        ...(shadow?{scope:'open_shadow_roots',shadowRoots:(roots?.length||1)-1,closedShadowIncluded:false,truncated:nodes.length>limit,textScope:'light_dom'}:{}),
        ...(command === 'state' ? { text: document.body?.innerText.slice(0, 12000) || '' } : {}) } };
    }
    if (command === 'extract') {
      if(shadow&&!args.selector&&!args.ref&&!args.role&&args.text===undefined)fail('INVALID_ARGUMENT','Shadow extraction requires an explicit element target.');
      const node = args.selector || args.ref || args.role || args.text !== undefined ? one() : document.body;
      const text = node?.innerText || node?.textContent || '';
      const max = Math.max(1, Math.min(Number(args.maxChars) || 20000, 200000));
      return { ok: true, data: { text: text.slice(0, max), truncated: text.length > max, url: location.href } };
    }
    if (command === 'scroll') {
      const node = args.selector || args.ref || args.role ? one() : window;
      const amount = Math.max(1, Math.min(Number(args.amount) || 600, 10000));
      const direction = args.direction || 'down';
      if (!['up', 'down', 'left', 'right', 'top', 'bottom'].includes(direction)) fail('INVALID_ARGUMENT', 'Unknown scroll direction.');
      if (direction === 'top' || direction === 'bottom') node.scrollTo({ top: direction === 'top' ? 0 : (node === window ? document.documentElement.scrollHeight : node.scrollHeight), behavior: 'instant' });
      else node.scrollBy({ top: direction === 'up' ? -amount : direction === 'down' ? amount : 0, left: direction === 'left' ? -amount : direction === 'right' ? amount : 0, behavior: 'instant' });
      return { ok: true, data: { scrolled: true, direction } };
    }
    const node = command==='get'&&args.property==='html'&&!args.selector&&!args.ref&&!args.role&&args.text===undefined?document.documentElement:one();
    if(!node)fail('ELEMENT_NOT_FOUND','The document root is unavailable.');
    if (command === 'get') {
      if (node.type === 'password') fail('SENSITIVE_FIELD', 'Password field contents are not returned.');
      const property = args.property || 'text';
      if(['as','depth','childrenMax','textMax','maxNodes'].some(key=>args[key]!==undefined)&&property!=='html')fail('INVALID_ARGUMENT','Tree formatting options require property=html.');
      if(property==='compound')return{ok:true,data:{value:compound(node),element:{tag:node.tagName.toLowerCase(),role:role(node),name:label(node)}}};
      if(property==='html'&&args.as!==undefined&&!['html','json'].includes(args.as))fail('INVALID_ARGUMENT','as must be html or json.');
      if(property==='html'&&args.as==='json'){
        const number=(key,fallback,max,min=0)=>{const raw=args[key]??fallback;const n=(typeof raw==='number'||typeof raw==='string'&&/^\d+$/.test(raw))?Number(raw):NaN;if(!Number.isInteger(n)||n<min||n>max)fail('INVALID_ARGUMENT',`${key} must be ${min}–${max}.`);return n;};
        const depth=number('depth',3,20),childrenMax=number('childrenMax',50,200),textMax=number('textMax',200,2000),maxNodes=number('maxNodes',500,2000,1);
        let count=0,chars=100000;const truncated={};
        const bounded=(value,key,max)=>{const s=String(value??'');const cap=Math.min(max,chars);if(s.length>cap)truncated[key]=true;const out=s.slice(0,cap);chars-=out.length;return out;};
        const attrsAllowed=new Set(['id','class','role','name','type','value','href','src','alt','title','placeholder','for','disabled','readonly','required','checked','selected','multiple','accept','min','max','step']);
        const tree=(element,level)=>{
          if(chars<=0){truncated.characters=true;return null;}
          if(count>=maxNodes){truncated.nodes=true;return null;}count++;
          const attrs={};let attrCount=0;
          for(const attr of element.attributes){if(element.type==='password'&&attr.name==='value')continue;if(!attrsAllowed.has(attr.name)&&!attr.name.startsWith('aria-')&&!attr.name.startsWith('data-'))continue;if(attr.name.length>128){truncated.attributes=true;continue;}if(attrCount++>=50||chars<attr.name.length){truncated.attributes=true;break;}chars-=attr.name.length;attrs[attr.name]=bounded(attr.value,'attributes',500);}
          const output={tag:bounded(element.tagName.toLowerCase(),'tags',200),attrs};
          if(element.type==='password'){output.redacted=true;return output;}
          if(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(element.tagName)){output.omitted=true;truncated.omittedContent=true;return output;}
          let ownText='';for(const child of element.childNodes)if(child.nodeType===3){ownText+=child.textContent.slice(0,textMax+1);if(ownText.length>textMax){truncated.text=true;break;}}
          if(ownText.trim())output.text=bounded(ownText.trim(),'text',textMax);
          if(args.compound!==false&&args.compound!=='false'){const info=compound(element);if(info){output.compound=info;if(info.omitted)truncated.compounds=true;}}
          const children=[];let eligible=0;
          for(const child of element.children){
            if(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(child.tagName)){truncated.omittedContent=true;continue;}
            eligible++;if(level>=depth){truncated.depth=true;break;}if(eligible>childrenMax){truncated.children=true;break;}
            const captured=tree(child,level+1);if(captured)children.push(captured);else break;
          }
          if(children.length)output.children=children;
          if(element.shadowRoot)output.shadowRoot={mode:'open',included:false};
          return output;
        };
        return{ok:true,data:{value:tree(node,0),format:'json',nodes:count,truncated,url:location.href}};
      }
      if(['depth','childrenMax','textMax','maxNodes'].some(key=>args[key]!==undefined))fail('INVALID_ARGUMENT','Tree limits require as=json.');
      const readers = { text: () => node.innerText || node.textContent, value: () => node.value, html: () => node.outerHTML, attribute: () => node.getAttribute(String(args.attribute || '')) };
      if (!readers[property]) fail('INVALID_ARGUMENT', 'property must be text, value, html, attribute or compound.');
      return { ok: true, data: { value: String(readers[property]() ?? '').slice(0, 100000), element: describe(node) } };
    }
    if (disabled(node)) fail('ELEMENT_DISABLED', 'The target element is disabled.');
    if(command==='upload-target'){
      if(Date.now()>=args.uploadDeadline)fail('UPLOAD_INTERRUPTED','Upload preparation exceeded its deadline.');
      if(node.tagName!=='INPUT'||node.type!=='file')fail('INVALID_ARGUMENT','Target must be a native file input.');
      if(!!node.webkitdirectory!==!!args.directory)fail('DIRECTORY_INPUT_UNSUPPORTED','Directory input and directory selection must match.');
      if(args.fileCount>1&&!node.multiple&&!args.directory)fail('INVALID_ARGUMENT','The file input accepts only one file.');
      const captured={node,url:location.href,name:label(node),role:role(node),multiple:node.multiple,directory:!!node.webkitdirectory};
      captured.validate=(phase)=>{
        if(!node.isConnected||node.ownerDocument!==document||location.href!==captured.url)fail('UPLOAD_TARGET_CHANGED','The selected file input or document changed.');
        if(phase==='before'){
          if(Date.now()>=args.uploadDeadline)fail('UPLOAD_INTERRUPTED','The upload target preparation expired.');
          if(node.tagName!=='INPUT'||node.type!=='file'||node.multiple!==captured.multiple||!!node.webkitdirectory!==captured.directory||label(node)!==captured.name||role(node)!==captured.role)fail('UPLOAD_TARGET_CHANGED','The file input contract changed before upload.');
          if(disabled(node))fail('ELEMENT_DISABLED','The file input became disabled.');
        }
      };
      globalThis[args.uploadToken]=captured;
      return{ok:true,data:{multiple:!!node.multiple,accept:String(node.accept||'').slice(0,500)}};
    }
    if (args.scrollIntoView !== false) node.scrollIntoView({ block: 'center', inline: 'center' });
    if (command === 'bounds') {
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) fail('ELEMENT_OFFSCREEN', 'The target is outside the viewport. Scroll it into view first.');
      const x = Math.max(0, rect.left) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) / 2;
      const y = Math.max(0, rect.top) + (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) / 2;
      const hitMatches = () => {
        let target = node, root = target.getRootNode();
        while (root instanceof ShadowRoot) {
          const hit = root.elementFromPoint(x,y);
          if (!hit || (hit !== target && !target.contains(hit))) return false;
          target = root.host; root = target.getRootNode();
        }
        const hit = document.elementFromPoint(x,y);
        return !!hit && (hit === target || target.contains(hit));
      };
      // Native frame pointers verify the actual content quad and every ancestor.
      // A rotated element's bounding-box center need not be inside the element.
      if (!args.pointerToken && !hitMatches()) fail('ELEMENT_OBSCURED', 'Another element covers this target. Inspect the current page.');
      // Internal native-pointer handoff stays in the extension's isolated world.
      if (typeof args.pointerToken === 'string') globalThis[args.pointerToken] = node;
      return { ok: true, data: { x, y } };
    }
    if (command === 'click' || command === 'dblclick') {
      node.click(); if (command === 'dblclick') { node.click(); node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); }
    } else if (command === 'focus') node.focus();
    else if (command === 'hover') {
      node.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); node.dispatchEvent(new MouseEvent('mouseenter'));
    } else if (command === 'fill' || command === 'type') {
      if (node.readOnly) fail('ELEMENT_READONLY', 'The field is read-only.');
      if (node.type === 'file') fail('INVALID_ARGUMENT', 'Use browser.upload for file inputs.');
      if (!['INPUT', 'TEXTAREA'].includes(node.tagName) && !node.isContentEditable) fail('NOT_EDITABLE', 'Target is not an editable field.');
      node.focus();
      const value = (command === 'type' ? (node.isContentEditable ? node.textContent : node.value) : '') + String(args.value ?? '');
      if (node.isContentEditable) node.textContent = value;
      else Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(node, value);
      node.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: String(args.value ?? '') })); node.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      if ((node.isContentEditable ? node.textContent : node.value) !== value) fail('INPUT_REJECTED', 'The page did not retain the supplied input.');
    } else if (command === 'select') {
      if (node.tagName !== 'SELECT') fail('INVALID_ARGUMENT', 'Target is not a native select.');
      const values = (Array.isArray(args.value) ? args.value : [args.value]).map(String);
      if(values.length>1000||node.options.length>20000)fail('SELECTION_LIMIT','Selection exceeds 1000 requested options or 20000 live options.');
      if (!node.multiple && values.length !== 1) fail('INVALID_ARGUMENT', 'This select accepts one option.');
      const by=args.by??'auto';if(!['auto','value','label'].includes(by))fail('INVALID_ARGUMENT','by must be auto, value or label.');
      const options = values.map(value => {
        const matches=[...node.options].filter(option=>(by!=='label'&&option.value===value)||(by!=='value'&&String(option.label||option.textContent).trim()===value));
        if(matches.length>1)fail('AMBIGUOUS_OPTION','Multiple options match. Use an unambiguous value with by=value or label with by=label.');
        return matches[0];
      });
      if (options.some(option => !option || disabled(option))) fail('OPTION_NOT_FOUND', 'An option is missing or disabled.');
      const expected=new Set(options);
      for (const option of node.options) option.selected = expected.has(option);
      node.dispatchEvent(new Event('input', { bubbles: true, composed: true })); node.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      const currentOptions=new Set(node.options);
      if(!node.isConnected||[...currentOptions].some(option=>option.selected!==expected.has(option))||options.some(option=>!currentOptions.has(option)))fail('SELECTION_REJECTED','The page did not retain the requested selection. Inspect the current control before retrying.');
    } else if (command === 'check' || command === 'uncheck') {
      const desired = command === 'check';
      const current = () => ['checkbox', 'radio'].includes(node.type) ? node.checked : node.getAttribute('aria-checked') === 'true';
      if (!['checkbox', 'radio'].includes(node.type) && !node.hasAttribute('aria-checked')) fail('INVALID_ARGUMENT', 'Target is not checkable.');
      if (current() !== desired) node.click();
      if (current() !== desired) fail('CHECK_FAILED', 'The page did not reach the requested checked state.');
    } else fail('UNKNOWN_COMMAND', 'Unsupported page command.');
    return { ok: true, data: { action: command, completed: true, element: describe(node) } };
  } catch (error) { return { ok: false, error: { code: error.code || 'PAGE_OPERATION_FAILED', message: error.message } }; }
}
