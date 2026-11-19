export async function runModelSaveChecks(action, checks, update) {
  update(checks.map(check => ({ ...check, status: 'running', message: '' })))
  const finish = (results, error) => {
    let failureShown = results?.some(check => check.status === 'failure')
    update(checks.map(check => {
      const result = results?.find(result => result.target === check.target)
      if (result) return { ...check, ...result }
      if (error && !failureShown) {
        failureShown = true
        return { ...check, status: 'failure', message: error.message || '检测失败' }
      }
      return { ...check, status: 'skipped', message: '未完成检查' }
    }))
  }
  try {
    const result = await action()
    finish(result?.model_checks)
    return result
  } catch (error) {
    finish(error.modelChecks, error)
    throw error
  }
}
