export function needsAdapterApplyReview(review) {
  return Boolean(review.addedPermissions.length || review.sourceChange || review.downgrade || review.overwritesNewerBase || review.changedTools?.length > 1)
}

export function adapterApplyFeedback(result) {
  if (!result.refreshed) return 'Adapter 已安装，能力同步待完成。请点击应用重试同步。'
  if (!result.acknowledged) return 'Adapter 已安装，开发区状态同步待完成。请点击应用重试同步。'
  return 'Adapter 已应用到 WeWorker。请在对话中调试；如当前对话未识别新能力，请新建对话。'
}
