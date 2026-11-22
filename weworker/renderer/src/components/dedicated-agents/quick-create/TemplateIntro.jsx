import React from 'react'
import { Button } from 'antd'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { handleChatLinkClick } from '../../../utils/chat-links.js'

/**
 * 模板 Bot 的介绍页：渲染蓝图包里的 intro.md（markdown，经安全渲染管线，
 * 原始 HTML 不执行），CTA 由引擎统一渲染在下方。
 */
export default function TemplateIntro({ introMarkdown, name, cta, onStart }) {
  if (!introMarkdown) return null
  return (
    <div className="tintro">
      <div className="tintro__md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleChatLinkClick}
                onAuxClick={handleChatLinkClick}
              >{children}</a>
            ),
          }}
        >{introMarkdown}</ReactMarkdown>
      </div>
      <div className="tintro__cta">
        <Button data-app-button="action" type="primary" size="large" className="tintro__cta-btn" onClick={onStart}>
          {cta || `开始创建${name ? ` ${name}` : ''}`}
        </Button>
      </div>
    </div>
  )
}
