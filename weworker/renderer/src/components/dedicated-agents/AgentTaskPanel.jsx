import React, { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Popconfirm, Space, Tag } from 'antd'
import AppSwitch from '../common/AppSwitch.jsx'
import { backendFetch } from '../../api/http.js'
import { hintStyle, sectionStyle, sectionTitleStyle } from './styles.js'

function formatTime(value) {
  if (!value) return '—'
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN') : value
}

function targetLabel(target) {
  return target.chat_type === 2 ? `群聊 · ${target.id}` : `单聊 · ${target.id}`
}

/** Tasks are created through the owner’s conversation; this panel is for visibility and safe management. */
export default function AgentTaskPanel({ agent }) {
  const [tasks, setTasks] = useState([])
  const [targets, setTargets] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [taskRes, targetRes] = await Promise.all([
        backendFetch(`/dedicated-agents/${agent.id}/tasks`),
        backendFetch(`/dedicated-agents/${agent.id}/notification-targets`),
      ])
      if (!taskRes.ok || !targetRes.ok) throw new Error('加载定时任务失败')
      const [taskData, targetData] = await Promise.all([taskRes.json(), targetRes.json()])
      setTasks(Array.isArray(taskData.tasks) ? taskData.tasks : [])
      setTargets(Array.isArray(targetData.targets) ? targetData.targets : [])
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [agent.id])

  useEffect(() => { load() }, [load])

  const patch = async (taskId, body) => {
    setBusyId(taskId)
    try {
      const res = await backendFetch(`/dedicated-agents/${agent.id}/tasks/${taskId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || '保存失败')
      setTasks((current) => current.map((task) => task.id === taskId ? data.task : task))
    } catch (err) {
      setError(err.message || '保存失败')
    } finally {
      setBusyId('')
    }
  }

  const remove = async (taskId) => {
    setBusyId(taskId)
    try {
      const res = await backendFetch(`/dedicated-agents/${agent.id}/tasks/${taskId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('删除失败')
      setTasks((current) => current.filter((task) => task.id !== taskId))
    } catch (err) {
      setError(err.message || '删除失败')
    } finally {
      setBusyId('')
    }
  }

  if (loading) return <div style={{ ...hintStyle, padding: 20 }}>正在加载定时任务…</div>
  return (
    <div style={{ padding: '16px 24px 24px', overflowY: 'auto' }}>
      <div style={{ maxWidth: 860 }}>
        <div style={sectionStyle}>
          <h3 style={sectionTitleStyle}>通过对话创建任务</h3>
          <div style={hintStyle}>仅主人可在与此 Agent 的对话中确认并创建任务。任务运行时由 Agent 自行决定是否调用主动消息工具；未调用就不会推送。</div>
          {agent.channel !== 'wecom' && <Alert type="info" showIcon style={{ marginTop: 12 }} message="微信机器人当前不支持企业微信主动通知目标。" />}
          {agent.channel === 'wecom' && <div style={{ ...hintStyle, marginTop: 10 }}>可用通知目标来自曾与该机器人对话过的单聊或群聊。群聊不会被自动选择，必须由主人授权给具体任务。</div>}
        </div>
        {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
        {tasks.length === 0 ? <div style={{ ...hintStyle, padding: 20 }}>还没有定时任务。可在对话中告诉 Agent 你要定期执行什么，并明确确认频率和通知对象。</div> : tasks.map((task) => {
          const selected = task.notification_targets || []
          return <div key={task.id} style={{ ...sectionStyle, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <h3 style={{ ...sectionTitleStyle, marginBottom: 4 }}>{task.title}</h3>
                <div style={hintStyle}>Cron：{task.cron_expression} · 创建于 {formatTime(task.created_at)}</div>
              </div>
              <Space>
                <AppSwitch checked={task.enabled} disabled={busyId === task.id} onChange={(event) => patch(task.id, { enabled: event.target.checked })} aria-label={`启用 ${task.title}`} />
                <Popconfirm title="删除这个定时任务？" description="执行记录和持续上下文会一并删除。" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => remove(task.id)}>
                  <Button data-app-button="action" danger disabled={busyId === task.id}>删除</Button>
                </Popconfirm>
              </Space>
            </div>
            <div style={{ marginTop: 10, whiteSpace: 'pre-wrap', fontSize: 13, color: 'var(--text-primary)' }}>{task.prompt_template}</div>
            {agent.channel === 'wecom' && <div style={{ marginTop: 12 }}>
              <div style={{ ...hintStyle, marginBottom: 6 }}>授权通知目标</div>
              {targets.length === 0 ? <div style={hintStyle}>暂无已观察到的企业微信会话。请先在目标单聊或群聊中让机器人收到一条消息。</div> : targets.map((target) => {
                const checked = selected.some((item) => item.id === target.id && item.chat_type === target.chat_type)
                return <label key={`${target.chat_type}:${target.id}`} style={{ display: 'block', margin: '5px 0', fontSize: 13 }}>
                  <Checkbox checked={checked} onChange={(event) => {
                    const next = event.target.checked
                      ? [...selected, target]
                      : selected.filter((item) => !(item.id === target.id && item.chat_type === target.chat_type))
                    patch(task.id, { notification_targets: next })
                  }} disabled={busyId === task.id} />
                  <Tag style={{ marginLeft: 7 }}>{targetLabel(target)}</Tag>
                </label>
              })}
            </div>}
          </div>
        })}
      </div>
    </div>
  )
}
