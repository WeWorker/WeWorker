/**
 * JSONC 支持：让路由配置文件可以写注释（`//` 与 `/* *\/`）。
 *
 * 为什么需要：路由配置的维护者是 adapter 作者与运维，改一条配置必须能就地看到
 * 「这条是干什么的、成功示例长什么样、常见错误是什么」。纯 JSON 做不到，注释只能
 * 堆在 README 里，改一条配置要在两个文件间来回跳——这是配置被写错的主要来源。
 *
 * 语义约束（与 JSON 的差异只有两点，其余逐字等价）：
 *   1. 允许 `//` 行注释与 `/* *\/` 块注释；
 *   2. 允许尾逗号（`[1, 2,]` / `{"a": 1,}`），因为按注释分节时尾逗号很自然。
 *
 * **字符串内一律不动**：`"https://example.com"` 里的 `//`、工具名里的斜杠、
 * `"a\\"b"` 这类转义都必须原样保留。这是本模块唯一的技术风险点，有专门的单测钉住。
 *
 * 剥除后**保留换行**，使 JSON.parse 报错时的行列位置仍能对上原文件，便于定位。
 */

/** 剥除注释并去掉尾逗号，返回可被 `JSON.parse` 直接消费的文本。 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text))
}

/** 只做「剥注释 + 去尾逗号」，不解析；导出便于单测与调试。 */
export function stripJsonComments(text: string): string {
  return stripTrailingCommas(stripCommentsOnly(String(text ?? '')))
}

function stripCommentsOnly(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  let inString = false

  while (i < n) {
    const ch = src[i]

    if (inString) {
      out += ch
      // 反斜杠转义：把下一个字符一并原样带出，避免把 `\"` 误判为字符串结束。
      if (ch === '\\') {
        if (i + 1 < n) {
          out += src[i + 1]
          i += 2
          continue
        }
        i += 1
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }

    // 行注释：吃到行尾，换行本身留给下一轮（保住行号）。
    if (ch === '/' && src[i + 1] === '/') {
      i += 2
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i += 1
      continue
    }

    // 块注释：吃到 `*/`，内部换行原样保留。
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'
        i += 1
      }
      i = Math.min(i + 2, n) // 跳过 `*/`
      continue
    }

    out += ch
    i += 1
  }

  return out
}

/** 去掉 `,` 紧跟 `}` 或 `]` 的尾逗号（跳过空白后再判断）。 */
function stripTrailingCommas(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  let inString = false

  while (i < n) {
    const ch = src[i]

    if (inString) {
      out += ch
      if (ch === '\\') {
        if (i + 1 < n) {
          out += src[i + 1]
          i += 2
          continue
        }
        i += 1
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }

    if (ch === ',') {
      let j = i + 1
      while (j < n && /\s/.test(src[j])) j += 1
      if (j < n && (src[j] === '}' || src[j] === ']')) {
        i += 1 // 丢弃这个尾逗号
        continue
      }
    }

    out += ch
    i += 1
  }

  return out
}
