import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { initializeBackendConnection } from './api/http.js'
import './index.css'
import './workspace-refresh.css'

// 在 React 渲染前同步挂主题 class，保证 CSS 变量与 antd 主题桥首帧即正确。
// App 内部 effect 会继续负责后续切换与 localStorage 持久化，此处幂等。
{
  const saved = localStorage.getItem('theme')
  const initial = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  document.documentElement.classList.add(initial)
}

initializeBackendConnection().then(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(<App />)
}).catch(error => {
  console.error(error)
  document.getElementById('root').textContent = '无法连接本地服务，请重启 WeWorker。'
})
