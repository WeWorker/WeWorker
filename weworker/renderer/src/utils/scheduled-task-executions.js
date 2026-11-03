const EXECUTIONS_PER_PAGE = 10

export function getExecutionPage(executions, requestedPage = 1) {
  const total = executions.length
  const pageCount = Math.max(1, Math.ceil(total / EXECUTIONS_PER_PAGE))
  const page = Math.min(pageCount, Math.max(1, requestedPage))
  const offset = (page - 1) * EXECUTIONS_PER_PAGE
  return {
    items: executions.slice(offset, offset + EXECUTIONS_PER_PAGE),
    page,
    pageCount,
    total,
    start: total ? offset + 1 : 0,
    end: Math.min(offset + EXECUTIONS_PER_PAGE, total),
  }
}
