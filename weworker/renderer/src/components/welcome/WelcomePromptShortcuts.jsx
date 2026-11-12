import React from 'react'
import './welcome-prompt-shortcuts.css'

export default function WelcomePromptShortcuts({ prompts = [], onSelect }) {
  const items = Array.isArray(prompts) ? prompts.filter(item => typeof item?.text === 'string' && item.text.trim()) : []
  if (!items.length) return null

  return <div className="welcome-prompt-shortcuts" aria-label="常用提示词" role="group">
    {items.map((item, index) => <button
      key={item.id || `${index}-${item.text}`}
      type="button"
      className="welcome-prompt-shortcut"
      aria-label={item.text}
      disabled={!onSelect}
      onClick={() => onSelect?.(item.text)}
    >
      <span className="welcome-prompt-shortcut__text">{item.text}</span>
      <svg className="welcome-prompt-shortcut__arrow" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 12 12 4M4 4h8v8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>)}
  </div>
}
