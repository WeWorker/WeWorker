import React from 'react'
import './working-indicator.css'

export default function WorkingIndicator({ label = '工作中......' }) {
  return (
    <div className="working-indicator" role="status" aria-live="polite">
      <span className="working-indicator__label">{label}</span>
    </div>
  )
}
