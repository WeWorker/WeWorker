// Strict bounded Atom parser. No DOM/network dependency in the background runner.
import { CommandExecutionError } from './errors.js';
const fail = message => { throw new CommandExecutionError(`Invalid arXiv Atom feed: ${message}`); };
const ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v[1-9]\d*)?$/;
function decode(text) {
  return text.replace(/&([^;]+);/g, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    if (!/^#(?:\d+|x[\da-fA-F]+)$/.test(entity)) fail('unknown entity');
    const n = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(n) || n > 0x10ffff || n >= 0xd800 && n <= 0xdfff || n < 32 && ![9,10,13].includes(n)) fail('invalid character');
    return String.fromCodePoint(n);
  });
}
function parse(xml) {
  if (typeof xml !== 'string' || xml.length > 4 * 1024 * 1024) fail('missing or oversized document');
  const roots = [], stack = [];
  let i = 0, count = 0;
  const text = (value, cdata = false) => {
    if (!stack.length) { if (value.trim()) fail('text outside root'); return; }
    stack.at(-1).text += cdata ? value : decode(value);
  };
  while (i < xml.length) {
    if (xml[i] !== '<') { const next = xml.indexOf('<', i); const end = next < 0 ? xml.length : next; text(xml.slice(i, end)); i = end; continue; }
    if (xml.startsWith('<!--', i) || xml.startsWith('<?', i) || xml.startsWith('<![CDATA[', i)) {
      const cdata = xml.startsWith('<![CDATA[', i), pi = xml.startsWith('<?', i);
      const prefix = cdata ? 9 : pi ? 2 : 4, close = cdata ? ']]>' : pi ? '?>' : '-->';
      const end = xml.indexOf(close, i + prefix); if (end < 0) fail('unterminated section');
      if (cdata) text(xml.slice(i + prefix, end), true);
      i = end + close.length; continue;
    }
    if (xml.startsWith('<!', i)) fail('declarations are not accepted');
    let quote = '', end = i + 1;
    for (; end < xml.length; end++) { const c = xml[end]; if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break; }
    if (end >= xml.length) fail('unclosed tag');
    const raw = xml.slice(i + 1, end); i = end + 1;
    if (raw.startsWith('/')) {
      const node = stack.pop(); if (!node || raw.slice(1).trim() !== node.name) fail('mismatched closing tag');
      continue;
    }
    const self = /\/\s*$/.test(raw), body = self ? raw.replace(/\/\s*$/, '') : raw;
    const match = body.match(/^([A-Za-z_][\w.:-]*)([\s\S]*)$/); if (!match) fail('invalid tag');
    const attrs = {}; let rest = match[2];
    while (rest.trim()) {
      const a = rest.match(/^\s+([A-Za-z_][\w.:-]*)\s*=\s*(["'])([\s\S]*?)\2/);
      if (!a || Object.hasOwn(attrs, a[1])) fail('invalid or duplicate attribute');
      attrs[a[1]] = decode(a[3]); rest = rest.slice(a[0].length);
    }
    if (++count > 50000 || stack.length > 40) fail('document complexity limit');
    const node = { name: match[1], attrs, children: [], text: '' };
    (stack.length ? stack.at(-1).children : roots).push(node);
    if (!self) stack.push(node);
  }
  if (stack.length || roots.length !== 1 || roots[0].name !== 'feed' || roots[0].attrs.xmlns !== 'http://www.w3.org/2005/Atom') fail('expected one complete Atom feed');
  return roots[0];
}
export function parseEntries(xml) {
  const root = parse(xml);
  const children = (node, name) => node.children.filter(c => c.name === name);
  const field = (node, name) => children(node, name)[0]?.text.trim().replace(/\s+/g, ' ') || '';
  return children(root, 'entry').map(entry => {
    const rawId = field(entry, 'id');
    const versioned = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, '');
    if (rawId === versioned || !ID.test(versioned)) fail('error entry or invalid paper identity');
    const id = versioned.replace(/v\d+$/, ''), title = field(entry, 'title');
    if (!title) fail('paper title is missing');
    const pdfLink = children(entry, 'link').find(c => c.attrs.type === 'application/pdf' || c.attrs.title === 'pdf');
    let pdf = `https://arxiv.org/pdf/${versioned}`;
    if (pdfLink) {
      let url; try { url = new URL(pdfLink.attrs.href); } catch { fail('invalid PDF URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'arxiv.org' || url.port || url.username || url.password || url.pathname !== `/pdf/${versioned}`) fail('untrusted PDF URL');
      url.protocol = 'https:'; pdf = url.href;
    }
    return { id, title, authors: children(entry, 'author').map(a => field(a, 'name')).filter(Boolean).join(', '),
      abstract: field(entry, 'summary'), published: field(entry, 'published').slice(0,10), updated: field(entry, 'updated').slice(0,10),
      primary_category: children(entry, 'arxiv:primary_category')[0]?.attrs.term || '',
      categories: children(entry, 'category').map(c => c.attrs.term).filter(Boolean).join(', '),
      comment: field(entry, 'arxiv:comment'), pdf, url: `https://arxiv.org/abs/${id}` };
  });
}
