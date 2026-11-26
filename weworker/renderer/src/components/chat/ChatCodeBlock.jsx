import React, { useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Download, Eye, X } from 'lucide-react'
import { common, createLowlight } from 'lowlight'
import { isTabTableBlock } from '../../utils/code-block.js'
import './chat-code-block.css'

const highlighter = createLowlight(common)

const aliases = { py: 'python', js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript', ps1: 'powershell', pwsh: 'powershell', cs: 'csharp', rs: 'rust', rb: 'ruby', yml: 'yaml', sh: 'bash' }
const autoLanguages = ['python', 'javascript', 'java', 'cpp', 'csharp', 'go', 'rust', 'ruby', 'php', 'bash', 'sql', 'json', 'xml', 'css']
  .filter(language => highlighter.registered(language))

function highlightCode(text, language, filename) {
  const tag = language.toLowerCase()
  if (['text', 'plaintext', 'txt', 'tsv', 'csv', 'log'].includes(tag)) return { language: tag }
  const extension = filename.includes('.') ? filename.split('.').at(-1).toLowerCase() : ''
  const candidates = [tag, extension].map(value => Object.hasOwn(aliases, value) ? aliases[value] : value)
  const known = candidates.find(value => value && highlighter.registered(value))
  if (text.length > 100_000 || !text.trim()) return { language: known || tag }
  if (known) return { language: known, tree: highlighter.highlight(known, text) }
  if (text.length > 20_000) return { language: tag }
  const tree = highlighter.highlightAuto(text, { subset: autoLanguages })
  return tree.data?.relevance >= 3 ? { language: tree.data.language, tree } : {}
}

function highlightedLines(source, tree) {
  if (!tree) return source.split('\n')

  function split(node) {
    if (node.type === 'text') return node.value.split('\n')
    const lines = [[]]
    for (const child of node.children) {
      const [first, ...rest] = split(child)
      lines.at(-1).push(first)
      for (const line of rest) lines.push([line])
    }
    if (node.type === 'root') return lines.map(parts => React.Children.toArray(parts))
    return lines.map(parts => <span className={node.properties.className.join(' ')}>{React.Children.toArray(parts)}</span>)
  }

  return split(tree)
}

function NumberedCode({ lines }) {
  return (
    <pre className="chat-code-preview__body" tabIndex={0} aria-label="源代码" style={{ '--line-number-width': `${String(lines.length).length}ch` }}>
      <code>
        {lines.map((line, index) => (
          <span className="chat-code-preview__line" key={index}>
            <span className="chat-code-preview__number" aria-hidden="true">{index + 1}</span>
            <span className="chat-code-preview__source">{line}{index < lines.length - 1 ? '\n' : ''}</span>
          </span>
        ))}
      </code>
    </pre>
  )
}

function Action({ label, icon: Icon, onClick }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}>
      <Icon size={15} strokeWidth={1.7} aria-hidden="true" />
    </button>
  )
}

export default function ChatCodeBlock({ filename, text, language = '', preserveInline = false, children }) {
  const dialog = useRef(null)
  const titleId = useId()
  const [preview, setPreview] = useState(false)
  const [feedback, setFeedback] = useState('')

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setFeedback('已复制')
    } catch {
      setFeedback('复制失败')
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    try {
      link.click()
    } finally {
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    }
  }

  const highlighting = useMemo(() => isTabTableBlock(text) ? {} : highlightCode(text.replace(/\n$/, ''), language, filename), [text, language, filename])
  const lines = useMemo(() => highlightedLines(text.replace(/\n$/, ''), highlighting.tree), [text, highlighting.tree])
  const copyIcon = feedback === '已复制' ? Check : Copy
  return (
    <div className="chat-code-file">
      <div className="chat-code-file__bar">
        <span className="chat-code-file__name" title={filename}>{filename}</span>
        {highlighting.language && <span className="chat-code-preview__language">{highlighting.language}</span>}
        <span className="chat-code-file__status" role="status">{feedback}</span>
        <div className="chat-code-file__actions">
          <Action label="查看" icon={Eye} onClick={() => { setPreview(true); dialog.current.showModal() }} />
          <Action label="复制" icon={copyIcon} onClick={copy} />
          <Action label="下载" icon={Download} onClick={download} />
        </div>
      </div>
      {preserveInline ? children : <NumberedCode lines={lines} />}
      {createPortal(
        <dialog ref={dialog} className="chat-code-preview" aria-labelledby={titleId} onClose={() => setPreview(false)}>
          <div className="chat-code-file__bar">
            <strong id={titleId} className="chat-code-file__name" title={filename}>{filename}</strong>
            {highlighting.language && <span className="chat-code-preview__language">{highlighting.language}</span>}
            <span className="chat-code-file__status" role="status">{feedback}</span>
            <div className="chat-code-file__actions">
              <Action label="复制" icon={copyIcon} onClick={copy} />
              <Action label="下载" icon={Download} onClick={download} />
              <Action label="关闭" icon={X} onClick={() => dialog.current.close()} />
            </div>
          </div>
          {preview && <NumberedCode lines={lines} />}
        </dialog>,
        document.body,
      )}
    </div>
  )
}
