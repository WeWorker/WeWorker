/**
 * 巡检探针 stderr 留存夹具:探针把 tool 名拼在 `call <tool>` 里(argv[3]),
 * 按 tool 名分三种行为——
 * - stderr-boom:写一行真实错误文本后非零退出(模拟 traceback 的最后一行)
 * - stderr-flood:HEAD 标记 + 大段填充 + TAIL 标记后非零退出,
 *   验证尾部环形留存「丢旧行、留新行」
 * - stderr-ok:静默零退出,验证成功行 stderrTail 为空
 */
const tool = process.argv[3] ?? ''
if (tool === 'stderr-ok') process.exit(0)
if (tool === 'stderr-flood') {
  process.stderr.write('HEAD_MARKER should be dropped\n')
  process.stderr.write(`${'x'.repeat(4000)}\n`)
  process.stderr.write('boom: TAIL_MARKER real cause\n')
  process.exit(1)
}
process.stderr.write('boom: real cause\n')
process.exit(1)
