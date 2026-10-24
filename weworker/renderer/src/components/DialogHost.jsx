import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStore } from '../store/dialog.js'

export default function DialogHost() {
  const current = useDialogStore((state) => state.queue[0])
  const resolve = useDialogStore((state) => state.resolve)
  const panelRef = useRef(null)

  useEffect(() => {
    if (!current) return
    panelRef.current?.querySelector('button, input')?.focus()
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        resolve(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [current, resolve])

  if (!current || typeof document === 'undefined') return null
  const isConfirm = current.kind === 'confirm'
  return createPortal(
    <div
      className="weworker-dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) resolve(false)
      }}
    >
      <section
        ref={panelRef}
        className="weworker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="weworker-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="weworker-dialog-title">{current.title}</h2>
        <p>{current.message}</p>
        <footer>
          {isConfirm && <button data-app-button="action" type="button" className="weworker-dialog__button" onClick={() => resolve(false)}>取消</button>}
          <button data-app-button="action" data-variant={isConfirm && current.danger ? 'danger' : undefined} type="button" className={`weworker-dialog__button${isConfirm ? ' is-primary' : ''}`} onClick={() => resolve(true)}>
            {isConfirm ? '确定' : '知道了'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
