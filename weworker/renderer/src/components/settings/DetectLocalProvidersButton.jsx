import React, { useId, useState } from 'react'
import { Info, LoaderCircle, ScanSearch } from 'lucide-react'
import { useSettingsStore } from '../../store/settings.js'
import { showAlert } from '../../store/dialog.js'

const help = '读取本机其他 AI 工具的模型配置，将校验通过的新连接加入左侧列表，无需重启。同一接口和 API Key 的多个模型会合并，已有配置与当前选择会保留；已删除的配置可通过列表旁的识别入口重新导入。'

export default function DetectLocalProvidersButton() {
  const scan = useSettingsStore(state => state.detectAndImportProviders)
  const busy = useSettingsStore(state => state.detectingLocalProviders)
  const [helpOpen, setHelpOpen] = useState(false)
  const helpId = useId()
  const detect = async () => {
    try {
      const result = await scan()
      if (!result) return
      const lines = [result.imported > 0
        ? `已导入 ${result.imported} 个新连接：${(result.names || []).join('、')}。可在左侧列表查看，并在右侧选择模型。`
        : '未发现新的可导入连接。已有配置与当前模型选择已保留。']
      if (result.updated) lines.push(`已更新 ${result.updated} 个连接的本地模型列表。`)
      if (result.merged) lines.push(`已合并 ${result.merged} 项重复配置，原有模型仍可在下拉框中选择。`)
      if (result.skipped) lines.push(`${result.skipped} 个连接未通过校验，未自动导入。可通过列表旁的识别入口查看原因。`)
      if (result.issues?.length) lines.push(`部分工具的配置无法读取：${result.issues.join('、')}。`)
      void showAlert(lines.join('\n\n'), result.imported ? '已发现并导入新配置' : '检测完成')
    } catch (error) {
      void showAlert(error.message || '检测未完成，请稍后重试。', '检测未完成')
    }
  }
  return <div className="model-discovery-action">
    <button type="button" className="settings-btn" disabled={busy} onClick={() => { void detect() }}>
      {busy ? <LoaderCircle size={16} className="local-model-discovery__spin" aria-hidden="true" /> : <ScanSearch size={16} aria-hidden="true" />}
      {busy ? '正在检测…' : '检测本地配置'}
    </button>
    <span className="model-discovery-help" onMouseEnter={() => setHelpOpen(true)} onMouseLeave={() => setHelpOpen(false)}>
      <button type="button" className="model-discovery-help__button" aria-label="关于检测本地配置"
        aria-describedby={helpOpen ? helpId : undefined} aria-expanded={helpOpen}
        onFocus={() => setHelpOpen(true)} onBlur={() => setHelpOpen(false)}
        onClick={() => setHelpOpen(true)} onKeyDown={event => { if (event.key === 'Escape') setHelpOpen(false) }}>
        <Info size={17} aria-hidden="true" />
      </button>
      {helpOpen && <span id={helpId} role="tooltip" className="model-discovery-help__text">{help}</span>}
    </span>
  </div>
}
