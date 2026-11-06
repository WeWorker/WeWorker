import { useEffect, useState } from 'react'
import {
  DOWNLOADS,
  APP_VERSION,
  DOWNLOAD_SUMMARY_URL,
} from '../lib/downloadConfig.js'
import { CHANGELOG } from '../lib/changelog.js'
import { reportDownload, triggerFileDownload } from '../lib/downloadActions.js'
import { GITHUB_FAQ } from '../lib/siteConfig.js'
import disclaimer from '../../../weworker/disclaimer.json'

const URL_RE = /(https?:\/\/[^\s）)]+)/

function renderTextWithLinks(text) {
  const parts = text.split(URL_RE)
  if (parts.length === 1) return text
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <span key={i}>
        <a
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          地址
        </a>
      </span>
    ) : (
      part
    )
  )
}

function PlatformIcon({ name }) {
  if (name === 'windows') {
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M3 5.548l7.055-1.02v6.835H3V5.548zm0 7.255h7.055v6.853L3 18.637v-5.834zm8.098 6.853l9.902 1.443V12.5h-9.902v6.156zm0-13.707L21 1.5v6.156h-9.902V5.949z" />
      </svg>
    )
  }
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  )
}

export default function Download() {
  const [summary, setSummary] = useState(null)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryError, setSummaryError] = useState(false)

  const fetchSummary = async ({ silent = false, cancelledRef } = {}) => {
    const cancelled = () => cancelledRef?.current === true
    if (!DOWNLOAD_SUMMARY_URL) {
      setSummaryLoading(false)
      setSummaryError(false)
      return
    }
    if (!silent) {
      setSummaryLoading(true)
    }
    setSummaryError(false)
    try {
      const r = await fetch(DOWNLOAD_SUMMARY_URL)
      if (!r.ok) throw new Error('bad status')
      const data = await r.json()
      if (cancelled()) return
      const grand_total = typeof data?.grand_total === 'number' ? data.grand_total : 0
      const platformTotals = Object.fromEntries(
        (Array.isArray(data?.platforms) ? data.platforms : [])
          .map((item) => {
            const key = typeof item?.platform === 'string' ? item.platform : null
            const total = typeof item?.total_count === 'number'
              ? item.total_count
              : (typeof item?.total === 'number' ? item.total : 0)
            return key ? [key, total] : null
          })
          .filter(Boolean)
      )
      setSummary({ grand_total, platformTotals })
    } catch {
      if (!cancelled()) setSummaryError(true)
    } finally {
      if (!cancelled()) setSummaryLoading(false)
    }
  }

  useEffect(() => {
    const cancelledRef = { current: false }
    fetchSummary({ cancelledRef })
    return () => {
      cancelledRef.current = true
    }
  }, [])

  const handleDownloadClick = async (href, platform) => {
    triggerFileDownload(href)
    await reportDownload(platform)
    await fetchSummary({ silent: true })
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-28 pb-20">
      <header className="text-center mb-14">
        <h1 className="text-3xl sm:text-4xl font-bold text-[rgb(var(--color-text))] mb-4">下载 WeWorker</h1>
        <div className="max-w-2xl mx-auto space-y-4 text-muted text-sm sm:text-base leading-relaxed">
          <p>
            当前最新版本{' '}
            <span className="font-semibold tabular-nums text-[rgb(var(--color-text))]">v{APP_VERSION}</span>
            <span className="text-muted"> — 欢迎体验</span>
          </p>
          <p>
            安装或首次使用遇到问题？查看{' '}
            <a
              href={GITHUB_FAQ}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-accent hover:underline"
            >
              安装与首次使用 FAQ
            </a>
          </p>
        </div>
      </header>

      <section aria-label="安装包下载" className="mb-20">
        <div className="grid sm:grid-cols-3 gap-5">
          {DOWNLOADS.map((d) => (
            <a
              key={d.id}
              href={d.href}
              download
              className="group flex flex-col rounded-xl border border-border bg-surface p-6 text-left min-h-[240px] transition-colors hover:border-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              onClick={(e) => {
                e.preventDefault()
                handleDownloadClick(d.href, d.platform)
              }}
            >
              {(() => {
                const downloadCount = summary?.platformTotals?.[d.platform] ?? 0
                return (
                  <>
              <div className="w-10 h-10 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center text-accent mb-4">
                <PlatformIcon name={d.icon} />
              </div>
              <h2 className="text-[rgb(var(--color-text))] font-semibold text-lg mb-2">{d.title}</h2>
              <p className="text-muted text-sm leading-relaxed">{d.subtitle}</p>
              <p className="mt-2 text-xs text-muted">{d.sizeHint}</p>
              {d.notice && (
                <p className="mt-3 rounded-md border border-amber-500/35 bg-amber-500/10 px-2.5 py-2 text-[12px] leading-relaxed text-amber-300">
                  {d.notice} 安装后请在终端运行 <code className="font-mono">xattr -cr /Applications/WeWorker.app</code>，再打开应用。
                </p>
              )}
              <p className="text-[11px] text-muted font-mono truncate mt-auto pt-4 mb-5" title={d.filename}>
                {d.filename}
              </p>
              <span className="mt-auto flex items-center justify-center gap-2 w-full rounded-lg border border-accent/35 bg-accent/[0.08] py-2.5 px-3 text-sm font-semibold text-accent transition-colors group-hover:border-accent/55 group-hover:bg-accent group-hover:text-white">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>下载</span>
                {downloadCount > 0 && (
                  <span className="text-[11px] font-medium tabular-nums opacity-85">
                    （已累计下载{downloadCount.toLocaleString()}次）
                  </span>
                )}
              </span>
                  </>
                )
              })()}
            </a>
          ))}
        </div>
      </section>

      {/* Disclaimer */}
      <section aria-label="使用须知" className="mb-20 rounded-xl border border-border bg-surface/40 p-5 sm:p-6">
        <h2 className="text-lg font-bold text-[rgb(var(--color-text))] mb-4">{disclaimer.title}</h2>
        <div className="space-y-4 text-sm text-muted leading-relaxed">
          {disclaimer.sections.map((sec, i) => (
            <div key={i}>
              <h3 className="font-semibold text-[rgb(var(--color-text))] mb-1">{sec.heading}</h3>
              <p>{sec.content}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-muted">下载即表示您已阅读并同意上述内容。</p>
      </section>

      <section aria-label="更新日志" className="border-t border-border pt-14">
        <h2 className="text-2xl font-bold text-[rgb(var(--color-text))] mb-10">更新日志</h2>
        <ol className="space-y-10">
          {CHANGELOG.map((entry, idx) => (
            <li key={entry.version} className="relative pl-6 sm:pl-8 border-l border-border">
              <div className="absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full bg-accent ring-4 ring-bg" />
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
                <span className="text-lg font-semibold text-[rgb(var(--color-text))]">v{entry.version}</span>
                <time className="text-xs text-muted tabular-nums">{entry.date}</time>
                {(entry.commit || (idx === 0 && __RELEASE_COMMIT__)) && <span className="text-xs text-muted font-mono opacity-70">({entry.commit || __RELEASE_COMMIT__})</span>}
              </div>
              <ul className="list-disc list-inside space-y-2 text-sm text-muted leading-relaxed marker:text-accent/60">
                {entry.items.map((line, i) => (
                  <li key={i}>{renderTextWithLinks(line)}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
