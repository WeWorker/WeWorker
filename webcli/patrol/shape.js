/**
 * 返回值"形状"的提取与对比。
 *
 * 形状 = 字段路径 → 类型。数组只取首个非空元素的形状，元素路径用 `[]` 标记。
 * 形状里**不含任何业务值**——这是基线的核心约束（基线要能入仓）。
 *
 * 约定（由 patrol-shape.test.js 固化）：
 * - 根容器自身不记条目（它的类型恒为 object/array，不带信息）；
 *   嵌套对象/数组在各自路径上记 'object' / 'array'。
 * - 空数组在元素路径上记 'empty-array'（内容信号，不是结构）。
 * - diff 时，若当前形状把某数组标为 empty-array，则基线里该数组的所有
 *   叶子路径视为"变空"（内容退化），不算字段缺失（结构退化）。
 */

const MAX_DEPTH = 6

function walk(value, path, out, depth) {
  if (depth > MAX_DEPTH) return

  if (Array.isArray(value)) {
    if (path) out[path] = 'array'
    const elemPath = path ? `${path}[]` : '[]'
    const first = value.find((item) => item !== undefined && item !== null)
    if (first === undefined) {
      out[elemPath] = 'empty-array'
      return
    }
    walk(first, elemPath, out, depth + 1)
    return
  }

  const type = value === null ? 'null' : typeof value
  if (path) out[path] = type
  if (type === 'object') {
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key, out, depth + 1)
    }
  }
}

/** 把任意 JSON 值提取成 `{ 路径: 类型 }`。 */
export function extractShape(value) {
  const out = {}
  walk(value, '', out, 0)
  return out
}

/** `items[].id` / `items[]` → `items`（数组容器路径）。 */
function containerOf(path) {
  return path.split('[]')[0]
}

/**
 * 基线形状 vs 当前形状。
 * - missing / typeChanged → 结构退化
 * - added → 只是 drift 信号，不算退化
 * - emptied → 数组变空，属**内容**退化，单独给出
 */
export function diffShape(baselineShape, currentShape) {
  const missing = []
  const typeChanged = []
  const emptied = []

  const emptyMarkers = Object.entries(currentShape)
    .filter(([, type]) => type === 'empty-array')
    .map(([path]) => path)
  const coveredByEmpty = (path) =>
    emptyMarkers.some((marker) => path === marker || path.startsWith(`${marker}.`))

  for (const [path, baselineType] of Object.entries(baselineShape)) {
    if (coveredByEmpty(path)) {
      emptied.push(containerOf(path))
      continue
    }
    if (currentShape[path] === undefined) {
      missing.push({ path, baselineType })
    } else if (currentShape[path] !== baselineType) {
      if (currentShape[path] === 'empty-array') emptied.push(containerOf(path))
      else typeChanged.push({ path, baselineType, currentType: currentShape[path] })
    }
  }

  const added = Object.keys(currentShape).filter((path) => baselineShape[path] === undefined)

  return {
    missing,
    typeChanged,
    added,
    emptied: [...new Set(emptied)],
    degraded: missing.length > 0 || typeChanged.length > 0,
  }
}
