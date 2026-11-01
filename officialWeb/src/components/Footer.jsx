import { ADAPTER_REPO, GITHUB_FAQ, GITHUB_ISSUES, GITHUB_REPO, LICENSE } from '../lib/siteConfig.js'

export default function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="section-pad border-t border-[rgb(var(--border)/0.06)] mt-8">
      <div className="max-w-page mx-auto py-14 flex flex-col md:flex-row md:justify-between gap-10">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <img src="/logo.png" alt="" className="h-7 w-7 rounded-md opacity-90" />
            <span className="text-sm font-semibold">WeWorker</span>
          </div>
          <p className="text-sm text-muted max-w-xs leading-relaxed">
            开源 AI 浏览器助理 · Adapter 驱动 · 本地运行
          </p>
        </div>

        <div className="flex flex-wrap gap-x-16 gap-y-6 text-sm">
          <ul className="space-y-2.5">
            <FooterLink href={GITHUB_REPO}>主仓库</FooterLink>
            <FooterLink href={ADAPTER_REPO}>Chrome 扩展</FooterLink>
            <FooterLink href="/download">下载</FooterLink>
            <FooterLink href="/docs/quick-start">使用说明</FooterLink>
          </ul>
          <ul className="space-y-2.5">
            <FooterLink href={GITHUB_FAQ}>安装 FAQ</FooterLink>
            <FooterLink href={GITHUB_ISSUES}>问题反馈</FooterLink>
            <FooterLink href={`${GITHUB_REPO}/discussions`}>社区讨论</FooterLink>
          </ul>
          <div className="text-muted">
            <p>{LICENSE} License</p>
            <p className="text-xs mt-2">© {year} Contributors</p>
          </div>
        </div>
      </div>
    </footer>
  )
}

function FooterLink({ href, children }) {
  const external = href.startsWith('http')
  return (
    <li>
      <a
        href={href}
        {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
        className="text-muted hover:text-accent transition-colors"
      >
        {children}
      </a>
    </li>
  )
}
