import React, { useCallback, useState } from 'react'
import { useSettingsStore } from '../../store/settings.js'
import WecomQrConnect from './WecomQrConnect.jsx'

export default function AppBotQrSetup({ channel, profileId, disabled, onBusyChange, onSaved }) {
  const { appBotQrPending, appBotQrSaving, saveAppBotQr } = useSettingsStore()
  const [error, setError] = useState('')
  const profilePending = useSettingsStore(state => state.channelProfileQrPending[profileId])
  const profileSaving = useSettingsStore(state => state.channelProfileQrSaving[profileId])
  const pending = profileId ? profilePending : appBotQrPending[channel]
  const saving = profileId ? profileSaving : appBotQrSaving[channel]
  const changeBusy = useCallback(busy => onBusyChange(channel, busy), [channel, onBusyChange])
  const save = async credentials => {
    setError('')
    try { await (profileId ? useSettingsStore.getState().saveChannelProfileQr(profileId, credentials) : saveAppBotQr(channel, credentials)); onSaved() }
    catch (error) { setError(error.message); throw error }
  }
  return <>
    {pending && <div role="status" className="channel-settings-feedback">
      {saving ? '正在保存机器人配置…' : error || '扫码已完成，配置尚未保存。请重试保存，无需重新扫码。'}
      {!saving && <button data-app-button="action" type="button" className="settings-btn settings-btn-secondary" onClick={() => { void save().catch(() => {}) }}>重试保存</button>}
    </div>}
    <WecomQrConnect channel={channel} onImport={save} onBusyChange={changeBusy} disabled={disabled || !!pending} />
  </>
}
