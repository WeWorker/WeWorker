import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// 行内 wnpm registry 地址。dev 分支的 package-lock.json 可能包含指向该地址的
// resolved 条目（行内发布链路需要），但公开 CI 与外部贡献者无法访问行内网络，
// 安装依赖前需要把地址改写为公网镜像。仅在 CI 运行目录内改写，不回写仓库。
const INTRANET_REGISTRY = 'http://wnpm.weoa.com:8001'
const PUBLIC_MIRROR = 'https://registry.npmmirror.com'

export function normalizeLockfileRegistry(files) {
  const changed = []
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    const normalized = source.split(INTRANET_REGISTRY).join(PUBLIC_MIRROR)
    if (normalized !== source) {
      fs.writeFileSync(file, normalized)
      changed.push(file)
    }
  }
  return changed
}

function main(argv) {
  const changed = normalizeLockfileRegistry(argv)
  for (const file of changed) console.log(`normalized: ${file}`)
  console.log(`normalized ${changed.length} lockfile(s)`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
