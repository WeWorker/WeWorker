// Preloaded only by the desktop-owned Node child. Standalone WebCLI services
// intentionally detach from their launcher and must not install this guard.
if (!process.connected) throw new Error('Desktop Bridge requires its parent IPC channel.')
process.once('disconnect', () => {
  const deadline = setTimeout(() => process.exit(0), 9000)
  deadline.unref()
  // Reuse the Bridge's normal browser cleanup, including a disconnect during
  // startup before its signal handler has been registered.
  if (process.listenerCount('SIGTERM')) process.emit('SIGTERM')
  else process.exit(0)
})
