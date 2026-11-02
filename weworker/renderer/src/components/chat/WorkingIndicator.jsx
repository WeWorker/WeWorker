import React from 'react'
import './working-indicator.css'

export default function WorkingIndicator() {
  return (
    <div className="working-indicator" role="status" aria-live="polite">
      <span className="working-indicator__label">working......</span>
    </div>
  )
}
