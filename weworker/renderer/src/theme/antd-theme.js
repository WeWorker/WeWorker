import { useEffect, useMemo, useState } from 'react'
import { theme as antdTheme } from 'antd'

// 把现有 CSS 变量设计语言桥接到 antd v5 token。
// 只桥接表层语义色：主色、文本层级、容器底色与边框，
// 其余派生色交给 antd algorithm（light/dark）计算，保证组件内部状态色可用。
const CSS_VAR_TOKENS = {
  colorPrimary: '--accent',
  colorInfo: '--accent',
  colorLink: '--accent',
  colorText: '--text-primary',
  colorTextSecondary: '--text-secondary',
  colorTextTertiary: '--text-muted',
  colorTextQuaternary: '--text-muted',
  colorBgContainer: '--bg-primary',
  colorBgElevated: '--bg-primary',
  colorBorder: '--border',
  colorBorderSecondary: '--border',
}

function resolveCssVarTokens() {
  const styles = window.getComputedStyle(document.documentElement)
  const tokens = {}
  for (const [token, cssVar] of Object.entries(CSS_VAR_TOKENS)) {
    const value = String(styles.getPropertyValue(cssVar) || '').trim()
    if (value) tokens[token] = value
  }
  return tokens
}

/**
 * 解析当前主题下的 CSS 变量为 antd theme config。
 * 依赖 main.jsx 在 React 渲染前同步挂好 .light/.dark class；
 * theme 切换后 class 先应用（App 内 effect），本 hook 的 effect
 * 在其后重新解析变量并触发一次补渲染，避免 token 停留在旧主题。
 */
export function useAntdThemeConfig(theme) {
  const isDark = theme === 'dark'
  const [cssVarTokens, setCssVarTokens] = useState(resolveCssVarTokens)

  useEffect(() => {
    setCssVarTokens(resolveCssVarTokens())
  }, [theme])

  return useMemo(() => ({
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      ...cssVarTokens,
      borderRadius: 8,
      fontFamily: 'inherit',
    },
  }), [isDark, cssVarTokens])
}
