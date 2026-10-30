const cancelers = new Set()

export function registerModelSwitchCanceler(cancel) {
  cancelers.add(cancel)
  return () => cancelers.delete(cancel)
}

export async function cancelActiveQrForModelSwitch() {
  await Promise.all([...cancelers].map(cancel => cancel()))
}
