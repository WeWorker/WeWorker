/** Convert only reviewed ID paths, preserving numeric JSON lexemes before rounding. */
export function parseWriteJson(text, decimalPaths = []) {
  if(!decimalPaths.length)return JSON.parse(text);
  const lexemes=new WeakMap();
  const result=JSON.parse(text,function(key,value,context){
    if(typeof value==='number'){let fields=lexemes.get(this);if(!fields)lexemes.set(this,fields=new Map());fields.set(key,context?.source);}
    return value;
  });
  for(const path of decimalPaths){
    const keys=path.split('.'),last=keys.pop();let parent=result;
    for(const key of keys){if(!parent||typeof parent!=='object'||!Object.hasOwn(parent,key)){parent=null;break;}parent=parent[key];}
    if(parent&&Object.hasOwn(parent,last)&&typeof parent[last]==='number'){
      const raw=lexemes.get(parent)?.get(last);
      if(typeof raw!=='string'||!/^(?:0|-?[1-9][0-9]*)$/.test(raw)||raw.length>512)throw Object.assign(new Error('Exact integer JSON lexemes are required; rounded numbers cannot identify a resource.'),{code:'WRITE_RESULT_ID_INVALID'});
      parent[last]=raw;
    }
  }
  return result;
}
