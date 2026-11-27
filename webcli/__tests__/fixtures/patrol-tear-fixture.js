/**
 * 巡检探针多字节撕裂夹具：输出 banner + 含中文的 JSON，
 * 并刻意在多字节字符（"超"）的字节序列中间把 stdout 切成两半分两次写——
 * 模拟管道按块读取时的撕裂。宿主若未对 child.stdout setEncoding('utf8')，
 * 第一块会以 U+FFFD 收尾，拼接结果无法 JSON.parse。
 */
const json = JSON.stringify({ ok: true, items: ['京东超市搜索结果第一页', '自营旗舰店'] })
const payload = Buffer.from(`Bridge not running, starting...\n${json}\n`, 'utf8')
const cut = payload.indexOf('超', 'utf8') + 1

process.stdout.write(payload.subarray(0, cut))
setTimeout(() => {
  process.stdout.write(payload.subarray(cut))
  process.exit(0)
}, 30)
