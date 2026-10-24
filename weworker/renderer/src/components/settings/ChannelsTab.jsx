import React, { useRef, useState } from 'react'
import { AppstoreAddOutlined, CheckCircleOutlined, DeleteOutlined, DownOutlined, EditOutlined, MessageOutlined, QqOutlined, SendOutlined, WechatOutlined, WechatWorkOutlined } from '@ant-design/icons'
import { useSettingsStore } from '../../store/settings.js'
import { showConfirm } from '../../store/dialog.js'
import { showNotification } from '../../store/notifications.js'
import { CHANNEL_TYPES } from '../../utils/channel-configurations.js'
import { DropdownMenuPortal, useDropdownDismiss } from '../common/DropdownMenuPortal.jsx'
import ChannelConfigurationEditor from './ChannelConfigurationEditor.jsx'
import './channel-profiles.css'

function ChannelIcon({ id }) {
  const Icon = { qq: QqOutlined, feishu: SendOutlined, wecom: WechatWorkOutlined, weixin: WechatOutlined }[id]
  return <Icon aria-hidden="true" />
}

export default function ChannelsTab() {
  const { channels, channelProfileAction } = useSettingsStore()
  const profiles = Object.values(channels.configurations || {})
  const [type, setType] = useState(() => profiles[0]?.type || 'qq')
  const [selected, setSelected] = useState({})
  const [busy, setBusy] = useState(false)
  const [editorBusy, setEditorBusy] = useState(false)
  const [rename, setRename] = useState(null)
  const renameRef = useRef(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const profileRef = useRef(null)
  const profileMenuRef = useRef(null)
  const closeProfiles = () => { setProfileOpen(false); setRename(null) }
  useDropdownDismiss(profileOpen, closeProfiles, profileRef, profileMenuRef)
  const [addOpen, setAddOpen] = useState(false)
  const addRef = useRef(null)
  const menuRef = useRef(null)
  useDropdownDismiss(addOpen, () => setAddOpen(false), addRef, menuRef)
  const entries = profiles.filter(item => item.type === type)
  const current = entries.find(item => item.id === selected[type]) || entries.find(item => item.id === channels.active_ids?.[type]) || entries[0]
  const locked = busy || editorBusy
  const channel = CHANNEL_TYPES.find(item => item.id === type)
  const act = async (action, id, input, target = type) => {
    if (locked) return
    setBusy(true)
    try {
      const result = await channelProfileAction(target, action, id, input)
      if (action === 'add') { setType(target); setSelected(prev => ({ ...prev, [target]: result })); setAddOpen(false); closeProfiles() }
      if (action === 'rename') setRename(null)
    } catch (error) { showNotification(error.message || '操作失败，请重试', { type: 'error' }) }
    finally { setBusy(false) }
  }
  const remove = async entry => {
    closeProfiles()
    const active = channels.active_ids?.[type] === entry.id && entry.config.enabled
    if (await showConfirm(`删除“${entry.name}”的本地配置？${active ? '该机器人会停止使用。' : ''}平台上的机器人不会被删除。`, '删除机器人', { danger: true })) {
      await act('delete', entry.id)
    }
  }
  const finishRename = () => {
    if (!rename || busy) return
    if (!rename.name.trim()) { showNotification('机器人名称不能为空', { type: 'error' }); return }
    if (rename.name.trim() === entries.find(item => item.id === rename.id)?.name) { setRename(null); return }
    void act('rename', rename.id, { name: rename.name })
  }
  const profileSelector = <>
    <button ref={profileRef} type="button" className="channel-profile-select" aria-label="选择机器人" aria-haspopup="dialog" aria-expanded={profileOpen} disabled={locked}
      onKeyDown={event => { if (event.key === 'Escape') closeProfiles() }}
      onClick={() => { setProfileOpen(value => !value); setRename(null) }}>
      <span>{current?.name || '选择机器人'}</span><DownOutlined aria-hidden="true" />
    </button>
    <DropdownMenuPortal ref={profileMenuRef} open={profileOpen} anchorRef={profileRef} minWidth={300} className="channel-profile-menu">
      <div role="dialog" aria-label="机器人选择与管理" onKeyDown={event => { if (event.key === 'Escape') { closeProfiles(); profileRef.current?.focus() } }}>
        <div className="channel-profile-menu__list">
            {entries.map(entry => {
              const active = entry.id === channels.active_ids?.[type] && entry.config.enabled
              return <div key={entry.id} className={`channel-profile-row${current?.id === entry.id ? ' is-selected' : ''}`}>
                {rename?.id === entry.id ? <input ref={renameRef} autoFocus className="channel-profile-rename" aria-label="机器人名称" title="Enter 保存，Esc 取消" maxLength={60} disabled={busy} value={rename.name}
                  onFocus={event => event.target.select()} onChange={event => setRename({ id: entry.id, name: event.target.value })}
                   onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); finishRename() } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRename(null) } }} />
                  : <button type="button" className="channel-profile-name" disabled={locked} title={entry.name} aria-current={current?.id === entry.id ? 'true' : undefined} onClick={() => { setSelected(prev => ({ ...prev, [type]: entry.id })); closeProfiles() }}>{entry.name}</button>}
                <div className="channel-profile-actions">
                  <button type="button" disabled={locked || active} className={active ? 'is-active' : ''} title={active ? '使用中' : '使用'} aria-label={`${active ? '使用中' : '使用'} ${entry.name}`} onClick={() => act('activate', entry.id)}><CheckCircleOutlined /></button>
                  <button type="button" disabled={locked} title="重命名" aria-label={`重命名 ${entry.name}`} onClick={() => rename?.id === entry.id ? finishRename() : setRename({ id: entry.id, name: entry.name })}><EditOutlined /></button>
                  <button type="button" disabled={locked} className="is-delete" title="删除" aria-label={`删除 ${entry.name}`} onClick={() => remove(entry)}><DeleteOutlined /></button>
                </div>
              </div>
            })}
            {!entries.length && <p className="channel-profile-empty">暂无机器人</p>}
          </div>

        <button type="button" className="app-dropdown-menu-item" disabled={locked} aria-label={`添加${channel.name}机器人`} onClick={() => act('add')}>
          <AppstoreAddOutlined /><span>添加{channel.name}机器人</span>
        </button>
        <p className="channel-profile-hint">同类型同时只能使用一个</p>
      </div>
    </DropdownMenuPortal>
  </>
  return <div className="model-settings-layout channel-settings-layout channel-profiles-layout">
    <aside className="model-settings-sidebar channel-types" aria-label="机器人类型">
      <div className="model-settings-sidebar__header">
        <div><div className="model-settings-sidebar__title">机器人</div><div className="model-settings-sidebar__count">{profiles.length} 个配置</div></div>
        <button ref={addRef} type="button" className="settings-btn model-settings-add" aria-label="添加机器人" title="添加机器人" aria-haspopup="menu" aria-expanded={addOpen} disabled={locked}
          onClick={() => setAddOpen(value => !value)}><AppstoreAddOutlined /></button>
      </div>
      <div className="model-settings-provider-list">
        {CHANNEL_TYPES.map(item => <button type="button" key={item.id} disabled={locked} className={`channel-settings-item${type === item.id ? ' is-selected' : ''}`}
          aria-pressed={type === item.id} onClick={() => { setType(item.id); closeProfiles() }}>
          <ChannelIcon id={item.id} /><span>{item.name}</span>
          <span className={`channel-settings-status${channels[item.id]?.enabled ? ' is-enabled' : ''}`}>{profiles.filter(profile => profile.type === item.id).length}</span>
        </button>)}
      </div>
      <DropdownMenuPortal ref={menuRef} open={addOpen} anchorRef={addRef} align="end" minWidth={170}>
        <div role="menu" aria-label="选择机器人类型">{CHANNEL_TYPES.map(item => <button key={item.id} type="button" role="menuitem" disabled={locked} className="app-dropdown-menu-item" onClick={() => act('add', undefined, {}, item.id)}>
          <ChannelIcon id={item.id} /><span className="app-dropdown-menu-item__label">{item.name}</span>
        </button>)}</div>
      </DropdownMenuPortal>
    </aside>
    <section className="channel-profiles-workspace" aria-label={`${channel.name}机器人管理`}>
      <div className="channel-profiles-content">
        {current ? <ChannelConfigurationEditor key={current.id} type={type} profileId={current.id} onBusyChange={setEditorBusy} profileSelector={profileSelector} />
          : <section className="channel-settings-detail"><header className="channel-settings-toolbar">{profileSelector}</header><div className="channel-settings-empty"><MessageOutlined /><h4>添加{channel.name}机器人</h4><p>从顶部下拉框添加机器人配置</p></div></section>}
      </div>
    </section>
  </div>
}
