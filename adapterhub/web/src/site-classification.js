export const SOURCES = [['all', '全部'], ['external', '外网'], ['internal', '内网']]
export const CATEGORIES = ['全部', '研发效能', 'IT 运维', '协同办公', '企业管理', '互联网服务', '其他']

export function siteSource(site) {
  const domain = (site.domain || site.name || '').toLowerCase()
  if (/^10\./.test(domain) || /^192\.168\./.test(domain) || /^172\.(1[6-9]|2\d|3[01])\./.test(domain) || domain.endsWith('.local') || domain === 'localhost') return 'internal'
  const match = domain.match(/^172\.(\d+)\./)
  return match && Number(match[1]) >= 16 && Number(match[1]) <= 31 ? 'internal' : 'external'
}

export function siteCategory(site) {
  const text = `${site.domain || site.name} ${site.display || site.name} ${site.description}`.toLowerCase()
  const contains = (...words) => words.some((word) => text.includes(word))
  if (contains('京东', '小红书', 'juejin', '掘金')) return '互联网服务'
  if (contains('邮箱', 'mail.', 'wemail', '会议', '协作', '文档', '统一登录')) return '协同办公'
  if (contains('费控', '报销', '签报', '审批', '补贴', '发票')) return '企业管理'
  if (contains('发布计划', '代码托管', '接口设计', '测试平台', 'git', 'ci/cd', '流水线')) return '研发效能'
  if (contains('运维', '监控', '工单', '配置', '数据库', 'sql', '容器', '任务流', '抽数', '服务治理', '链路', '漏洞', 'ssh', 'cmdb')) return 'IT 运维'
  return '其他'
}
