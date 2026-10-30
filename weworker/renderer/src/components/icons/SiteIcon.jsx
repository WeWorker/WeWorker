import bilibiliIcon from '../../assets/site-icons/bilibili.ico'
import React, { useState } from 'react'
import { resolveSiteIcon } from '../../utils/site-icon-resolve.js'
import { getSiteIconColor, getSiteIconInitials, shouldGenerateSiteIcon } from '../../utils/site-icon-generated.js'

/** Minimal silhouette SVGs — single color via currentColor */
const ICONS = {
  globe: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.5 0 2.9.4 4.1 1.1-.6 1.5-1 3.2-1.1 5.1H8.9c-.1-1.9-.5-3.6-1.1-5.1A7.9 7.9 0 0 1 12 4zm-4.2 1.4c.5 1.3.8 2.8.9 4.4H5.2a8 8 0 0 1 2.6-4.4zM4 12c0-.9.2-1.8.5-2.6h3.5c0 1.8-.2 3.5-.6 5.1A8 8 0 0 1 4 12zm1.1 4.6h3.7c.1 1.6.4 3.1.9 4.4A8 8 0 0 1 5.1 16.6zm6.9 2.5c-.5-1.3-.8-2.8-.9-4.4h6.2c-.1 1.6-.4 3.1-.9 4.4a7.9 7.9 0 0 1-4.4 0zm7.2-2.5c.4-1.6.6-3.3.6-5.1h3.5c.3.8.5 1.7.5 2.6a8 8 0 0 1-2.6 5.1zm2.6-7.6h-3.7a16 16 0 0 0-.9-4.4 8 8 0 0 1 4.6 4.4z" />
    </svg>
  ),
  mail: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2 8 5 8-5v1.2l-8 5-8-5V7zm16 2.5-7.4 4.6a1 1 0 0 1-1.2 0L4 9.5V17h16V9.5z" />
    </svg>
  ),
  mailbox: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M5 8V6a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h1zm2-2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v2H7V6zm11 4H6v8h12v-8zM4 19h16v1H4v-1z" />
    </svg>
  ),
  cart: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 4h-2l-1 2v2h2l3.6 7.6-1.4 2.5a2 2 0 0 0 1.7 3h9.7v-2H11.2l.3-.5h6.5l2.9-5.3H8.1L7 4zm-1 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
    </svg>
  ),
  social: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 3h12a2 2 0 0 1 2 2v14l-4-2-4 2-4-2-4 2V5a2 2 0 0 1 2-2zm0 2v11.5l2-1 4 2 4-2 2 1V5H6z" />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 10V8a4 4 0 1 1 8 0v2h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1zm2 0h4V8a2 2 0 1 0-4 0v2zm-1 4v4h8v-4H9z" />
    </svg>
  ),
  doc: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 3h7l5 5v13a1 1 0 0 1-1 1H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm7 1.4V9h4.6L15 4.4zM8 5v14h11V10h-5V5H8zm2 4h6v2h-6V9zm0 4h6v2h-6v-2z" />
    </svg>
  ),
  ticket: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M4 8a2 2 0 0 1 0-4h1V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v1h1a2 2 0 0 1 0 4 2 2 0 0 1 0 4 2 2 0 0 1 0 4H5a2 2 0 0 1 0-4 2 2 0 0 1 0-4zm2 0v8h12V8H6zm3 2h2v4H9v-4zm4 0h2v4h-2v-4z" />
    </svg>
  ),
  pipeline: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M4 6h6v4H4V6zm10 0h6v4h-6V6zM4 14h6v4H4v-4zm10 0h6v4h-6v-4zM11 8h2v8h-2V8z" />
    </svg>
  ),
  wallet: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M5 5h14a2 2 0 0 1 2 2v3h-3a2 2 0 0 0 0 4h3v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v10h14v-2h-3a4 4 0 0 1 0-8h3V7H5zm12 4h2v2h-2v-2z" />
    </svg>
  ),
  product: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />
    </svg>
  ),
  version: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M4 4h6l2 2h8v14H4V4zm2 2v12h12v-10h-7.6L10 6H6zm3 4h6v2H9v-2zm0 4h8v2H9v-2z" />
    </svg>
  ),
  invoice: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 3h10a2 2 0 0 1 2 2v16l-3-2-3 2-3-2-3 2V5a2 2 0 0 1 2-2zm0 2v12.5l1-.7 3 2 3-2 3 2 1 .7V5H7zm2 3h6v2H9V8zm0 4h6v2H9v-2z" />
    </svg>
  ),
  budget: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2C7.6 2 4 5.1 4 9c0 2.2 1.2 4.2 3 5.4V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-5.6c1.8-1.2 3-3.2 3-5.4 0-3.9-3.6-7-8-7zm0 2c3.9 0 6 2.5 6 5s-2.1 5-6 5-6-2.5-6-5 2.1-5 6-5zm-1 9h2v5h-2v-5z" />
    </svg>
  ),
}

const wrapStyle = (size, style) => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: size,
  height: size,
  flexShrink: 0,
  ...style,
})

const COLOR_META = {
  globe: { fg: '#339CFF', bg: 'linear-gradient(135deg, #e6f4ff, #cce9ff)' },
  mail: { fg: '#ea4335', bg: 'linear-gradient(135deg, #fee2e2, #e6f4ff)' },
  mailbox: { fg: '#339CFF', bg: 'linear-gradient(135deg, #e6f4ff, #d9ecff)' },
  cart: { fg: '#d97706', bg: 'linear-gradient(135deg, #fef3c7, #fed7aa)' },
  social: { fg: '#dc2626', bg: 'linear-gradient(135deg, #ffe4e6, #fecdd3)' },
  lock: { fg: '#475569', bg: 'linear-gradient(135deg, #e2e8f0, #cbd5e1)' },
  doc: { fg: '#0f766e', bg: 'linear-gradient(135deg, #ccfbf1, #d1fae5)' },
  ticket: { fg: '#7c3aed', bg: 'linear-gradient(135deg, #ede9fe, #ddd6fe)' },
  pipeline: { fg: '#0891b2', bg: 'linear-gradient(135deg, #cffafe, #bae6fd)' },
  wallet: { fg: '#16a34a', bg: 'linear-gradient(135deg, #dcfce7, #bbf7d0)' },
  product: { fg: '#4f46e5', bg: 'linear-gradient(135deg, #e0e7ff, #c7d2fe)' },
  version: { fg: '#64748b', bg: 'linear-gradient(135deg, #f1f5f9, #e2e8f0)' },
  invoice: { fg: '#ea580c', bg: 'linear-gradient(135deg, #ffedd5, #fed7aa)' },
  budget: { fg: '#ca8a04', bg: 'linear-gradient(135deg, #fef9c3, #fde68a)' },
}

/**
 * @param {{ icon?: string, iconUrl?: string } | null} [site] — metadata from GET /sites
 * @param {number} [size]
 */
export default function SiteIcon({ site, size = 20, className, style }) {
  const resolved = resolveSiteIcon(site)
  const source = site?.id === 'bilibili.com' ? bilibiliIcon : site?.iconUrl
  const [failedSource, setFailedSource] = useState(null)

  if (shouldGenerateSiteIcon(site, source && failedSource !== source, resolved)) {
    return (
      <span
        className={className}
        aria-hidden
        style={{
          ...wrapStyle(size, style),
          color: '#fff',
          background: getSiteIconColor(site),
          borderRadius: Math.max(5, Math.round(size * 0.24)),
          fontSize: Math.max(9, Math.round(size * 0.42)),
          fontWeight: 700,
          letterSpacing: 0,
          lineHeight: 1,
          textTransform: 'uppercase',
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.28)',
        }}
      >
        {getSiteIconInitials(site)}
      </span>
    )
  }

  if (source && failedSource !== source) {
    return (
      <span className={className} aria-hidden style={{
        ...wrapStyle(size, style),
        background: '#fff',
        borderRadius: Math.max(4, Math.round(size * 0.2)),
      }}>
        <img
          src={source}
          alt=""
          draggable={false}
          width={size}
          height={size}
          onError={() => setFailedSource(source)}
          style={{ display: 'block', width: size, height: size, objectFit: 'contain', borderRadius: 'inherit' }}
        />
      </span>
    )
  }

  if (resolved.mode === 'literal') {
    return (
      <span
        className={className}
        aria-hidden
        style={{
          ...wrapStyle(size, style),
          fontSize: Math.round(size * 0.85),
          lineHeight: 1,
        }}
      >
        {resolved.text}
      </span>
    )
  }

  const glyph = ICONS[resolved.key] || ICONS.globe
  const meta = COLOR_META[resolved.key] || COLOR_META.globe
  const glyphSize = Math.max(10, Math.round(size * 0.68))
  return (
    <span
      className={className}
      style={{
        ...wrapStyle(size, style),
        color: meta.fg,
        background: meta.bg,
        borderRadius: Math.max(5, Math.round(size * 0.24)),
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.55)',
      }}
    >
      {React.cloneElement(glyph, { width: glyphSize, height: glyphSize })}
    </span>
  )
}
