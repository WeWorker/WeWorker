/**
 * webcli-result-cache：大结果落盘 + TTL + 清扫 单测（用临时目录，不碰真实用户目录）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  offloadIfLarge,
  saveLargeResult,
  getLatestCacheFile,
  isCacheFresh,
  sweepWorkCache,
  readCacheResult,
  rehydratePointer,
  _resetWebcliResultCacheForTests,
  WEBCLI_RESULT_CACHE_TTL_MS,
} from '../webcli-result-cache.js'

const TMP = path.join(os.tmpdir(), `weworker-cache-test-${process.pid}-${Date.now()}`)

function largeJson(): string {
  return JSON.stringify({
    ok: true,
    mode: 'req',
    count: 2,
    items: [
      { id: 1, title: 'x'.repeat(9000), raw: { big: 'y'.repeat(9000) } },
      { id: 2, title: 'small' },
    ],
  })
}

function ageFile(file: string, msAgo: number): void {
  const t = Math.max(1, Math.floor((Date.now() - msAgo) / 1000))
  fs.utimesSync(file, t, t)
}

describe('webcli-result-cache', () => {
  beforeEach(() => {
    _resetWebcliResultCacheForTests()
    fs.mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true })
  })

  it('offloadIfLarge：小结果返回 null（不落盘）', () => {
    expect(offloadIfLarge('itsm.example.com.ls', '{"ok":true}', 'work-1', { rootDir: TMP })).toBeNull()
  })

  it('offloadIfLarge：大结果落盘并返回最小指针（不含条目数据）', () => {
    const output = largeJson()
    const pointerStr = offloadIfLarge('itsm.example.com.ls', output, 'work-1', { rootDir: TMP })
    expect(pointerStr).not.toBeNull()
    const pointer = JSON.parse(pointerStr!)
    expect(pointer.type).toBe('large_output')
    expect(pointer.tool).toBe('itsm.example.com.ls')
    expect(pointer.file).toContain(path.join('tool-results', 'work-1'))
    expect(pointer.count).toBe(2)
    expect(pointer.header).toContain('count=2')
    expect(pointer).not.toHaveProperty('summary') // A 方案：指针不内联数据
    expect(pointerStr!).not.toMatch(/big/) // 指针里不出现 raw 条目内容
    expect(fs.existsSync(pointer.file)).toBe(true)
    expect(fs.readFileSync(pointer.file, 'utf8')).toBe(output) // 完整原文落盘
  })

  it('workId 含路径分隔符会被规整，防穿越', () => {
    const pointerStr = offloadIfLarge('t.tool', largeJson(), '..\\evil', { rootDir: TMP })
    const pointer = JSON.parse(pointerStr!)
    const rel = path.relative(TMP, path.resolve(pointer.file))
    expect(rel.startsWith('..')).toBe(false)
  })

  it('getLatestCacheFile：命中最近一次；mtime 过期后判 miss 并清理内存表', () => {
    offloadIfLarge('itsm.example.com.ls', largeJson(), 'work-2', { rootDir: TMP })
    const latest = getLatestCacheFile('work-2', { rootDir: TMP })
    expect(latest).not.toBeNull()
    expect(fs.existsSync(latest!)).toBe(true)

    ageFile(latest!, WEBCLI_RESULT_CACHE_TTL_MS + 5000)
    expect(getLatestCacheFile('work-2', { rootDir: TMP })).toBeNull() // 过期 → miss
  })

  it('isCacheFresh：新鲜 true、过期 false、不存在 false', () => {
    const { filePath } = saveLargeResult('t.tool', largeJson(), 'work-3', { rootDir: TMP })
    expect(isCacheFresh(filePath)).toBe(true)
    ageFile(filePath, WEBCLI_RESULT_CACHE_TTL_MS + 5000)
    expect(isCacheFresh(filePath)).toBe(false)
    expect(isCacheFresh(path.join(TMP, 'nope.json'))).toBe(false)
  })

  it('sweepWorkCache：删除过期文件、保留新鲜文件', () => {
    const a = saveLargeResult('t.tool', largeJson(), 'work-4', { rootDir: TMP, now: 1000 })
    // 再写一个“现在”的文件
    const b = saveLargeResult('t.tool', largeJson(), 'work-4', { rootDir: TMP })
    ageFile(a.filePath, WEBCLI_RESULT_CACHE_TTL_MS + 5000)
    const removed = sweepWorkCache('work-4', { rootDir: TMP })
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(a.filePath)).toBe(false)
    expect(fs.existsSync(b.filePath)).toBe(true)
  })

  it('readCacheResult：JSON 正常解析；非 JSON 返回 _rawText', () => {
    const { filePath } = saveLargeResult('t.tool', largeJson(), 'work-5', { rootDir: TMP })
    const obj = readCacheResult(filePath) as any
    expect(obj.ok).toBe(true)
    expect(obj.count).toBe(2)

    const plain = path.join(TMP, 'plain.txt')
    fs.writeFileSync(plain, 'not json at all', 'utf8')
    const obj2 = readCacheResult(plain) as any
    expect(obj2._rawText).toContain('not json')
  })

  describe('rehydratePointer（fast-path 回读）', () => {
    it('新鲜指针 → 还原成落盘内容（含条目数据）', () => {
      const output = largeJson()
      const pointerStr = offloadIfLarge('t.tool', output, 'work-r1', { rootDir: TMP })!
      const restored = rehydratePointer(pointerStr, TMP)
      expect(restored).not.toBeNull()
      expect(JSON.parse(restored!)).toEqual(JSON.parse(output))
    })

    it('非指针文本 / 非 JSON → null（调用方退回指针文案）', () => {
      expect(rehydratePointer('{"ok":true}', TMP)).toBeNull()
      expect(rehydratePointer('not json', TMP)).toBeNull()
      expect(rehydratePointer(JSON.stringify({ type: 'large_output' }), TMP)).toBeNull() // 无 file
    })

    it('指针里的文件越出缓存根 → null（防穿越）', () => {
      const outside = path.join(TMP, '..', `weworker-outside-${process.pid}.json`)
      fs.writeFileSync(outside, '{"secret":1}', 'utf8')
      try {
        const pointer = JSON.stringify({ type: 'large_output', file: outside })
        expect(rehydratePointer(pointer, TMP)).toBeNull()
      } finally {
        fs.rmSync(outside, { force: true })
      }
    })

    it('文件已过期或不存在 → null', () => {
      const { filePath } = saveLargeResult('t.tool', largeJson(), 'work-r2', { rootDir: TMP })
      ageFile(filePath, WEBCLI_RESULT_CACHE_TTL_MS + 5000)
      expect(rehydratePointer(JSON.stringify({ type: 'large_output', file: filePath }), TMP)).toBeNull()

      const gone = path.join(TMP, 'tool-results', 'work-r3', 'gone.json')
      expect(rehydratePointer(JSON.stringify({ type: 'large_output', file: gone }), TMP)).toBeNull()
    })
  })
})
