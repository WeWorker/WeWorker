import React from 'react'

export function ClosePanelIcon({ size = 16 }) {
  return (
    <span style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  )
}

export function PlusIcon({ size = 18, strokeWidth = 2.2 }) {
  return (
    <span style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
      </svg>
    </span>
  )
}

export function EyeIcon({ size = 16 }) {
  return (
    <span style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
      </svg>
    </span>
  )
}

export function EyeOffIcon({ size = 16 }) {
  return (
    <span style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M3 3l18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M9.8 5.4A10.2 10.2 0 0 1 12 5c6.1 0 9.5 7 9.5 7a15.2 15.2 0 0 1-3 3.9M6.4 6.8C3.9 8.5 2.5 12 2.5 12s3.4 7 9.5 7c1.7 0 3.2-.5 4.4-1.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9.9 9.9A3 3 0 0 0 14.1 14.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  )
}

export function RobotIcon({ size = 18 }) {
  return (
    <span style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <rect x="5" y="7" width="14" height="11" rx="4" fill="var(--accent)" />
        <path d="M9 7V5.2A3 3 0 0 1 12 2.2a3 3 0 0 1 3 3V7" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="9.5" cy="12.3" r="1.4" fill="#fff" />
        <circle cx="14.5" cy="12.3" r="1.4" fill="#fff" />
        <path d="M9.2 15.1c1.7 1 3.9 1 5.6 0" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M5 11H3.5M20.5 11H19" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  )
}

export function TrialChatIcon({ size = 18 }) {
  return (
    <span style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M8.7 17.2H8a5 5 0 1 1 3.7-1.6l-3.8 1.8.8-.2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M14.4 8.2A5 5 0 0 1 19 15.8l.8 2.4-3.2-1.3a5 5 0 0 1-5.1-1.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

export function ToolPackageIcon({ size = 18 }) {
  return (
    <span style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M4 7.5 12 3l8 4.5-8 4.5-8-4.5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M4 12.5 12 17l8-4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4 17.5 12 22l8-4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

export function BackIcon({ size = 16 }) {
  return (
    <span style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M14.5 6.5 9 12l5.5 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9 12h10.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  )
}

export function PanelHideIcon({ size = 16 }) {
  return (
    <span style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M8 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M13 8.5 17.5 12 13 15.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

export function PanelExpandIcon({ size = 16 }) {
  return (
    <span style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M16 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M11 8.5 6.5 12 11 15.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}
