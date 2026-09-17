import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// 在 React 渲染前同步挂主题 class，保证 CSS 变量与 antd 主题桥首帧即正确。
// App 内部 effect 会继续负责后续切换与 localStorage 持久化，此处幂等。
{
  const saved = localStorage.getItem('theme')
  const initial = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  document.documentElement.classList.add(initial)
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
