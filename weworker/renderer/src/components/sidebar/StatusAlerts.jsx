import React, { useEffect, useRef, useState } from 'react'
import { Modal, Popover } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'
import './status-alerts.css'

export default function StatusAlerts({ alerts, onOpenGuide }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(null)
  const trigger = useRef(null)
  useEffect(() => { if (!alerts.length) setOpen(false) }, [alerts.length])

  return <span className="status-alert-slot">
    <Popover open={open && alerts.length > 0} onOpenChange={setOpen} trigger="click" placement="topLeft"
      classNames={{ root: 'status-alert-popover' }} content={
        <div className="status-alert-list" role="dialog" aria-label="告警列表" onKeyDown={event => {
          if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() }
        }}>
          <div className="status-alert-list-title">告警列表 · {alerts.length}</div>
          {alerts.map(alert => <button type="button" key={alert.id} onClick={() => { setOpen(false); setSelected(alert) }}>
            <ExclamationCircleOutlined aria-hidden="true" /><span>{alert.title}</span>
          </button>)}
        </div>
      }>
      <button ref={trigger} type="button" className="status-alert-trigger" style={{ visibility: alerts.length ? 'visible' : 'hidden' }}
        aria-label={`查看 ${alerts.length} 条告警`} aria-expanded={open && alerts.length > 0}
        aria-haspopup="dialog" tabIndex={alerts.length ? 0 : -1} onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}>
        <ExclamationCircleOutlined aria-hidden="true" />
      </button>
    </Popover>
    <Modal open={Boolean(selected)} title={selected?.title} onCancel={() => setSelected(null)}
      footer={null} width={480} centered className="status-alert-details" afterClose={() => trigger.current?.focus()}>
      <p className="status-alert-description">{selected?.detail}</p>
      {selected?.command && <pre className="status-alert-command">{selected.command}</pre>}
      <div className="status-alert-detail-actions">
        {selected?.guide && <button data-app-button="action" type="button" onClick={() => { setSelected(null); onOpenGuide() }}>查看扩展连接指引</button>}
        <button data-app-button="action" type="button" onClick={() => setSelected(null)}>关闭</button>
      </div>
    </Modal>
  </span>
}
