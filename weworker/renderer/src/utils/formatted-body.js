import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

export function safeBodyUrl(value) {
  const url = String(value || '').trim()
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : ''
}

// Preview and export deliberately share the same renderer. Raw HTML and remote
// images are not mounted; pasted HTML is first converted to editable Markdown.
export function FormattedBody({ markdown, onLinkClick }) {
  return React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkBreaks], urlTransform: safeBodyUrl,
    components: {
      img: ({ alt }) => React.createElement('span', null, alt ? `[图片：${alt}]` : '[图片]'),
      a: ({ href, children }) => href
        ? React.createElement('a', { href, target: '_blank', rel: 'noopener noreferrer', onClick: onLinkClick, onAuxClick: onLinkClick }, children)
        : React.createElement('span', null, children),
    },
    children: markdown || '',
  })
}

export function createFormattedBody(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) throw new Error('正文不能为空')
  return { content: renderToStaticMarkup(React.createElement(FormattedBody, { markdown })), 'markdown-content': markdown }
}

export function clipboardMarkdown({ html = '', text = '' }, Parser = globalThis.DOMParser) {
  // Code editors usually supply HTML only for syntax colouring. Preserve their
  // plain source, including indentation and blank lines.
  if (!html || !Parser) return text
  const doc = new Parser().parseFromString(html, 'text/html')
  if (doc.querySelector('pre') && !doc.querySelector('p,li,table,h1,h2,h3,blockquote')) return text || doc.body.textContent
  if (!doc.querySelector('p,div,br,li,table,h1,h2,h3,h4,h5,h6,blockquote,strong,b,em,i,a,del,span[style]')) return text
  doc.querySelectorAll('script,style,iframe,object,embed,svg,math,form,button,input,select,textarea,template,meta,link').forEach(node => node.remove())
  // Browser/office copy often expresses emphasis with inline CSS instead of
  // semantic tags. Keep emphasis, but never export arbitrary CSS or attributes.
  doc.querySelectorAll('span[style]').forEach(node => {
    const style = node.getAttribute('style') || ''
    for (const [pattern, tag] of [[/font-weight\s*:\s*(bold|[6-9]00)/i, 'strong'], [/font-style\s*:\s*italic/i, 'em'], [/text-decoration[^:]*\s*:[^;]*line-through/i, 'del']]) {
      if (!pattern.test(style)) continue
      const wrapper = doc.createElement(tag)
      while (node.firstChild) wrapper.appendChild(node.firstChild)
      node.appendChild(wrapper)
    }
  })
  doc.querySelectorAll('a').forEach(node => {
    const href = safeBodyUrl(node.getAttribute('href'))
    if (href) node.setAttribute('href', href)
    else node.removeAttribute('href')
  })
  // GFM requires a header. An empty header preserves ordinary copied tables
  // without mislabelling their first data row as column names.
  doc.querySelectorAll('table').forEach(table => {
    const first = table.querySelector('tr')
    if (!first || first.querySelector('th') || first.parentElement?.tagName === 'THEAD') return
    const header = doc.createElement('thead')
    const row = doc.createElement('tr')
    for (const _cell of first.children) row.appendChild(doc.createElement('th'))
    header.appendChild(row)
    table.insertBefore(header, table.firstChild)
  })
  const converter = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' })
  converter.use(gfm)
  converter.addRule('image-label', { filter: 'img', replacement: (_content, node) => node.getAttribute('alt') || '' })
  return converter.turndown(doc.body) || text
}
