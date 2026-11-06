import { Link } from 'react-router-dom'
import DemoSection from '../components/DemoSection.jsx'
import HeroCommandBar from '../components/HeroCommandBar.jsx'
import ProductPathsSection from '../components/ProductPathsSection.jsx'
import ScrollReveal from '../components/ScrollReveal.jsx'
import MagneticButton from '../components/MagneticButton.jsx'
import sitesData from '../lib/sites.json'
import { GITHUB_REPO } from '../lib/siteConfig.js'

const ALL_SITE_NAMES = sitesData.groups
  .flatMap((g) => g.sites)
  .map((s) => s.name)
  .join('、')

const FEATURES = [
  {
    bento: 'bento-span-2x2',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    ),
    title: '浏览器自动化',
    desc: '通过 Chrome 扩展，AI 可以直接操作任意网页——点击、填表、搜索、下单，无需网站提供 API。',
  },
  {
    bento: 'bento-span-1x1',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
    title: '定时任务',
    desc: '设置定时任务，让 AI 在指定时间自动执行任务，并通过微信、QQ、企业微信推送执行结果。',
  },
  {
    bento: 'bento-span-1x1',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    title: '多通道通知',
    desc: '支持微信、QQ、企业微信机器人通道，任务完成后主动推送消息。',
  },
  {
    bento: 'bento-span-2x1',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    ),
    title: '可扩展 Adapter',
    desc: `通过 Adapter 机制支持任意网站。社区已适配 ${ALL_SITE_NAMES} 等示例，也可以自己编写。`,
  },
  {
    bento: 'bento-span-2x1',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    title: '数据说明',
    desc: '您的对话内容和任务指令会发送至所配置的 AI 模型服务商（如 Anthropic）进行处理。WeWorker 本身不收集、存储或上传您的个人数据至开发者服务器。',
  },
  {
    bento: 'bento-span-1x1',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
    title: '多模型支持',
    desc: '支持 Anthropic Claude、GLM、DeepSeek 及自定义 API 端点。',
  },
]

const STEPS = [
  {
    num: '01',
    title: '下载 WeWorker',
    desc: '从 Releases 下载 macOS 或 Windows 安装包，安装后打开应用。',
    action: '前往下载',
    href: '/download',
  },
  {
    num: '02',
    title: '安装 Chrome 扩展',
    desc: '安装 WebMCP Adapter 扩展，让 AI 获得操作浏览器的能力。',
    action: '查看说明',
    href: '/docs/quick-start',
  },
  {
    num: '03',
    title: '配置 API Key',
    desc: '在设置中填入 Claude 或其他模型的 API Key，即可开始对话。',
    action: '查看文档',
    href: '/docs/quick-start',
  },
]

export default function Landing() {
  return (
    <div className="pb-4">
      {/* Hero — 对齐截图 / officialWeb */}
      <section className="hero-section pt-12 pb-16 sm:pt-16 sm:pb-20 px-4 sm:px-6">
        <div className="relative max-w-4xl mx-auto text-center">
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-[rgb(var(--color-text))] leading-tight mb-6">
            WeWorker, 你的{' '}
            <span className="hero-title-gradient">AI 网页助理</span>
          </h1>
          <p className="text-lg text-muted max-w-2xl mx-auto leading-relaxed mb-8">
            通过为每个网站编写专属 Adapter，AI 精准操作浏览器，替你完成查邮件、提工单、填表单等日常网页工作。
          </p>
        </div>

        <div className="relative max-w-6xl mx-auto text-center">
          <HeroCommandBar />

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link to="/download" className="hero-cta-primary">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              免费下载
            </Link>
            <Link to="/docs/quick-start" className="hero-cta-secondary">
              快速开始
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </Link>
            <a
              href={GITHUB_REPO}
              target="_blank"
              rel="noreferrer"
              className="hero-cta-secondary"
            >
              GitHub Star
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="m12 2.5 2.86 5.8 6.4.93-4.63 4.51 1.09 6.38L12 17.1l-5.72 3.02 1.09-6.38-4.63-4.51 6.4-.93L12 2.5Z" />
              </svg>
            </a>
          </div>
        </div>
      </section>

      <ProductPathsSection />

      {/* 效果示例 */}
      <section id="demo" className="py-8 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-10 max-w-3xl mx-auto">
            <h2 className="text-3xl font-bold text-[rgb(var(--color-text))] mb-4">效果示例</h2>
            <p className="text-muted text-base sm:text-lg leading-relaxed">
              跨站查攻略、比价格，总是<span className="text-[rgb(var(--color-text))] font-medium">来回切换、重复粘贴</span>。
            </p>
            <p className="text-accent text-base sm:text-lg leading-relaxed mt-2 font-medium">
              现在，一条链路一句话。
            </p>
            <div className="mt-4 demo-prompt-chip">
              <span className="text-accent/70 mr-1.5">›</span>
              小红书搜杭州周末攻略 → 携程查机票/跟团 → 12306 查高铁，帮我汇总对比
            </div>
          </div>
          <ScrollReveal delay={80}>
            <DemoSection />
          </ScrollReveal>
        </div>
      </section>

      <section id="features" className="section-pad py-20 sm:py-28 border-y border-border bg-surface/30">
        <div className="max-w-page mx-auto">
          <ScrollReveal className="text-center mb-12">
            <h2 className="text-3xl font-bold text-[rgb(var(--color-text))] mb-4">核心功能</h2>
            <p className="text-muted text-lg max-w-2xl mx-auto">
              不只是聊天，而是真正帮你干活的 AI 助手
            </p>
          </ScrollReveal>

          <div className="bento-grid">
            {FEATURES.map((f, i) => (
              <ScrollReveal key={f.title} delay={[0, 80, 80, 160, 240, 240][i]} className={f.bento}>
                <article className="glass glow-border bento-card rounded-2xl p-5 sm:p-6 card-lift h-full">
                  <div className={`mb-3 flex items-center gap-3 ${f.bento.includes('2x2') ? 'flex-col items-start' : ''}`}>
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/15">
                      {f.icon}
                    </div>
                    <h3 className="font-semibold text-[rgb(var(--color-text))]">{f.title}</h3>
                  </div>
                  <p className="text-sm text-muted leading-relaxed">{f.desc}</p>
                </article>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <section id="steps" className="section-pad py-20 sm:py-28">
        <div className="max-w-page mx-auto">
          <ScrollReveal className="text-center mb-12">
            <h2 className="text-3xl font-bold text-[rgb(var(--color-text))] mb-2">快速开始</h2>
            <p className="text-muted">三步完成安装，5 分钟上手</p>
          </ScrollReveal>

          <div className="grid md:grid-cols-3 gap-4 mb-12">
            {STEPS.map((step, i) => (
              <ScrollReveal key={step.num} delay={i * 80}>
                <div className="glass glow-border rounded-2xl p-6 flex flex-col card-lift h-full border border-border bg-surface">
                  <div className="text-3xl font-bold text-accent/30 font-mono mb-4">{step.num}</div>
                  <h3 className="font-semibold text-lg mb-2">{step.title}</h3>
                  <p className="text-sm text-muted leading-relaxed flex-1 mb-4">{step.desc}</p>
                  <Link
                    to={step.href}
                    className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:text-accent-hover transition-colors"
                  >
                    {step.action}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                  </Link>
                </div>
              </ScrollReveal>
            ))}
          </div>

          <ScrollReveal>
            <div className="relative overflow-hidden glass glow-border rounded-2xl p-8 text-center card-lift border border-border">
              <h3 className="text-2xl font-bold mb-3">准备好了吗？</h3>
              <p className="text-muted mb-6">让 AI 替你操作浏览器，一句话完成网页上的繁琐工作</p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <MagneticButton as={Link} to="/download" className="hero-cta-primary">
                  下载 WeWorker
                </MagneticButton>
                <MagneticButton as={Link} to="/docs/quick-start" className="hero-cta-secondary">
                  查看文档
                </MagneticButton>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      <section id="opensource" className="section-pad pb-24 sm:pb-28">
        <div className="max-w-page mx-auto text-center">
          <a
            href={GITHUB_REPO}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-muted hover:text-accent transition-colors"
          >
            在 GitHub 查看源码、参与贡献并 Star →
          </a>
        </div>
      </section>
    </div>
  )
}
