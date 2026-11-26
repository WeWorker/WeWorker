/**
 * 围栏代码块展示策略。
 *
 * 制表符分隔的表格型代码块（如 WeWorker Bot 输出的问题清单）单行远宽于可视区。
 * 历史上曾按容器宽度换行展示（避免横向滚动下拖选扩选），但换行后一行数据折成
 * 多行、无法整行复制，2026-11 按用户要求改回横向滚动，另用伪元素在列间画竖线
 * 分隔（伪元素不进选区，选中复制的仍是真实 Tab）。
 */

/** 该代码块是否为 Tab 分隔的表格型代码块（存在 ≥4 列即 3 个 Tab 的行）。 */
export function isTabTableBlock(text) {
  if (typeof text !== 'string' || !text.includes('\t')) return false
  return text.split('\n').some((line) => (line.match(/\t/g) || []).length >= 3)
}

/** 尽力取出 react-markdown <pre> 子节点（<code> 元素）的纯文本，供表格型判断。 */
export function preChildText(children) {
  const first = Array.isArray(children) ? children[0] : children
  if (typeof first === 'string') return first
  const inner = first && typeof first === 'object' ? first.props?.children : ''
  return typeof inner === 'string' ? inner : ''
}

function codeBlockFilename(name) {
  if (!name || /[<>:"/\\|?*\u0000-\u001f]|[. ]$/u.test(name) ||
      /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])\s*(?:\.|$)/i.test(name)) return 'code'
  return name
}

// Keep the filename in Markdown metadata, outside the text copied or saved.
export function remarkCodeFilenames() {
  return tree => {
    function annotate(node) {
      if (node.type === 'code') {
        const match = node.meta?.match(/(?:^|\s)filename=(?:"([^"]+)"|'([^']+)'|([^\s]+))(?:\s|$)/)
        node.data ??= {}
        node.data.hProperties = {
          ...node.data.hProperties,
          'data-code-filename': codeBlockFilename(match?.[1] ?? match?.[2] ?? match?.[3]),
        }
      }
      node.children?.forEach(annotate)
    }
    annotate(tree)
  }
}
