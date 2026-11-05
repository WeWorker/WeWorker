// Inline style objects shared by the WeWorker Bot page (follows TaskConfigView conventions).

export const pageStyle = { display: 'flex', height: '100%', overflow: 'hidden', background: 'var(--bg-primary)' }
export const listColumnStyle = {
  width: 248,
  minWidth: 248,
  borderRight: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg-secondary)',
}
export const contentStyle = { flex: 1, minWidth: 0, overflowY: 'auto', padding: '24px 32px' }
export const sectionStyle = { background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 16 }
export const sectionTitleStyle = { margin: '0 0 12px 0', fontSize: 'var(--font-size-subtitle)', fontWeight: 600, color: 'var(--text-primary)' }
export const titleStyle = { margin: 0, fontSize: 'var(--font-size-title)', fontWeight: 600, color: 'var(--text-primary)' }
export const labelStyle = { display: 'block', fontSize: 'var(--font-size-label)', color: 'var(--text-secondary)', marginBottom: 5, fontWeight: 600 }
export const hintStyle = { fontSize: 'var(--font-size-caption)', color: 'var(--text-muted)', lineHeight: 1.6 }
export const fieldStyle = { marginBottom: 14 }
export const monoStyle = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 }
export const markdownEditorStyle = {
  width: '100%',
  minHeight: 320,
  resize: 'vertical',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  lineHeight: 1.6,
}
export const qrBoxStyle = {
  display: 'inline-flex',
  padding: 12,
  background: '#fff',
  borderRadius: 10,
  border: '1px solid var(--border)',
}
export const codeBadgeStyle = {
  display: 'inline-block',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 22,
  fontWeight: 700,
  letterSpacing: 2,
  padding: '8px 16px',
  borderRadius: 8,
  background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
  color: 'var(--text-primary)',
}
