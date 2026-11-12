/**
 * 写完 stdout 再退出。
 *
 * `process.exit()` 不会等 stdout 冲刷：当 stdout 是**管道**（桌面端 `execFile` 抓输出、
 * shell 管道、CI 抓取）时，Node 的写是异步的，一次写入超过管道缓冲区（macOS/Linux 常见
 * 16~64KB）会被切段，剩下的段还压在 libuv 队列里，进程一退就永久丢失，调用方拿到的是
 * **半截 JSON**。Windows 的管道写是同步的，所以同一处 bug 只在 macOS/Linux 上暴露成
 * 「返回内容被截断」——同一份代码在两台机器上表现不同。
 *
 * 因此凡是「写完 stdout 立刻退出」的地方都走 `writeStdoutThenExit()`：先等这次写入的回调
 * （数据真正进了管道），再退出。纯 stderr 的打印不受影响，stderr 不承载结果。
 */

/**
 * 把文本写到 stdout 并等它写完（自动补一个换行，与 `console.log` 行为一致）。
 * `stream.write(chunk, callback)` 的回调在**整段数据写完**后才触发，中途经历背压重试也一样。
 * @param {string} text
 * @param {import('node:stream').Writable} [stream]
 * @returns {Promise<void>}
 */
export function writeStdout(text, stream = process.stdout) {
  if (text === undefined || text === null || text === '') return Promise.resolve()
  const chunk = `${text}\n`
  return new Promise((resolve, reject) => {
    try {
      stream.write(chunk, (error) => (error ? reject(error) : resolve()))
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * 冲刷 stdout 后用 `exit(code)` 退出。
 *
 * 写失败（对端提前关闭管道等）也必须退出：退出码比输出完整性更重要。另外留一个兜底时限：
 * 对端不读、写入永远不回调时也要退出，绝不为了「冲刷」把进程挂住。
 * `stream` / `exit` / `flushTimeoutMs` 可注入，便于单测断言「退出发生在写完之后」。
 * @param {string} text
 * @param {number} [code]
 * @param {{ stream?: import('node:stream').Writable, exit?: (code: number) => void, onError?: (error: unknown) => void, flushTimeoutMs?: number }} [options]
 * @returns {Promise<void>}
 */
export function writeStdoutThenExit(text, code = 0, options = {}) {
  const { stream = process.stdout, exit = (value) => process.exit(value), onError, flushTimeoutMs = 5000 } = options
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      exit(code)
      resolve()
    }
    const timer = flushTimeoutMs > 0 ? setTimeout(finish, flushTimeoutMs) : null
    writeStdout(text, stream).then(finish, (error) => {
      onError?.(error)
      finish()
    })
  })
}
