import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import InputBar from '../../components/chat/InputBar.jsx'
import { useChatDraft } from '../../store/chat-drafts.js'
import { useSettingsStore } from '../../store/settings.js'
import { FormattedBody } from '../../utils/formatted-body.js'
import '../../index.css'
import '../../workspace-refresh.css'
document.documentElement.classList.add('light')
// Match app startup: the composer is enabled after default model settings load.
useSettingsStore.setState({ loaded: true, activeProvider: 'anthropic', model: 'example-model', contextLimit: 200000 })
window.saveCount = 0
window.electronAPI = {
  saveFormattedBody: async body => {
    window.saveCount++
    window.savedBody = body
    if (window.failSave) throw new Error('fixture save failure')
    if (window.delaySave) await new Promise(resolve => { window.finishSave = resolve })
    return { path: `/fixtures/body-args-${window.saveCount}.json`, name: `body-args-${window.saveCount}.json` }
  }, focusWindow: () => {}, selectFiles: async () => ['/fixtures/note.txt'],
}
function Fixture() {
  const [target, setTarget] = useState('a')
  const { inputText: text, setInputText: setText, attachments, setAttachments } = useChatDraft(target)
  const [sent, setSent] = useState('')
  window.switchDraft = value => setTarget(value)
  window.fixtureState = { text, attachments, target }
  return <main style={{ width: 800, margin: '40px auto', fontFamily: 'sans-serif' }}>
    <h2>正文输入</h2>
    <InputBar key={target} attachmentTarget={target} text={text} onTextChange={setText} attachments={attachments} onAttachmentsChange={setAttachments}
      onSend={(value, files) => { setSent(value); window.lastSent = { text: value, files } }} onShellCommand={command => { window.lastShell = command }} />
    <div data-sent className="formatted-body"><FormattedBody markdown={sent} /></div>
  </main>
}
createRoot(document.getElementById('root')).render(<Fixture />)
