/**
 * 第4层毕业计数单测（第16行）。
 *
 * 只提示、不自动生成：计数落盘与提示阈值是这层的全部行为，所以「恰好在第 N 次提示一次」
 * 与「坏文件不炸」两面都要钉住——计数文件在用户机器上随时可能被手改或写坏。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  graduationHint,
  graduationThreshold,
  recordTier4HostUsage,
  shouldSuggestGraduation,
} from '../tier4-graduation.js'

const tempDirs: string[] = []

function tempStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-tier4-graduation-'))
  tempDirs.push(dir)
  return path.join(dir, 'tier4-usage.json')
}

beforeEach(() => {
  delete process.env.WEWORKER_TIER4_GRADUATE_AFTER
})

afterEach(() => {
  delete process.env.WEWORKER_TIER4_GRADUATE_AFTER
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言
    }
  }
})

describe('graduationThreshold', () => {
  it('未设置 → 默认 3', () => {
    expect(graduationThreshold()).toBe(3)
  })

  it('空串/纯空白 → 默认 3', () => {
    process.env.WEWORKER_TIER4_GRADUATE_AFTER = '   '
    expect(graduationThreshold()).toBe(3)
  })

  it('0 → 关闭提示（计数仍记录）', () => {
    process.env.WEWORKER_TIER4_GRADUATE_AFTER = '0'
    expect(graduationThreshold()).toBe(0)
    expect(shouldSuggestGraduation(0)).toBe(false)
    expect(shouldSuggestGraduation(5)).toBe(false)
  })

  it('负数/非法值 → 回默认 3（不是「当成 0 关掉」）', () => {
    process.env.WEWORKER_TIER4_GRADUATE_AFTER = '-1'
    expect(graduationThreshold()).toBe(3)
    process.env.WEWORKER_TIER4_GRADUATE_AFTER = 'abc'
    expect(graduationThreshold()).toBe(3)
  })

  it('小数向下取整', () => {
    process.env.WEWORKER_TIER4_GRADUATE_AFTER = '4.9'
    expect(graduationThreshold()).toBe(4)
  })
})

describe('shouldSuggestGraduation', () => {
  it('恰好在第 N 次提示一次，前后都不提示', () => {
    process.env.WEWORKER_TIER4_GRADUATE_AFTER = '3'
    expect([1, 2, 3, 4, 5].map(shouldSuggestGraduation)).toEqual([false, false, true, false, false])
  })

  it('默认阈值同样是「恰好第 3 次」', () => {
    expect([2, 3, 4].map(shouldSuggestGraduation)).toEqual([false, true, false])
  })
})

describe('recordTier4HostUsage', () => {
  it('同一 host 逐次累加并返回新计数', () => {
    const storePath = tempStore()
    expect(recordTier4HostUsage('shop.example.org', { storePath })).toBe(1)
    expect(recordTier4HostUsage('shop.example.org', { storePath })).toBe(2)
    expect(recordTier4HostUsage('shop.example.org', { storePath })).toBe(3)
  })

  it('host 归一化为小写去空白（大小写不同不该算两个站点）', () => {
    const storePath = tempStore()
    recordTier4HostUsage('  Shop.Example.ORG ', { storePath })
    expect(recordTier4HostUsage('shop.example.org', { storePath })).toBe(2)
  })

  it('不同 host 各自独立计数', () => {
    const storePath = tempStore()
    recordTier4HostUsage('a.example.org', { storePath })
    expect(recordTier4HostUsage('b.example.org', { storePath })).toBe(1)
    expect(recordTier4HostUsage('a.example.org', { storePath })).toBe(2)
  })

  it('空 host → 0，且不写文件', () => {
    const storePath = tempStore()
    expect(recordTier4HostUsage('   ', { storePath })).toBe(0)
    expect(fs.existsSync(storePath)).toBe(false)
  })

  it('落盘内容含计数与 ISO 时间戳，且不残留 .tmp', () => {
    const storePath = tempStore()
    const at = new Date('2026-01-02T03:04:05.000Z')
    recordTier4HostUsage('shop.example.org', { storePath, now: () => at })

    const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as {
      version: number
      hosts: Record<string, { count: number; lastAt: string }>
    }
    expect(raw.version).toBe(1)
    expect(raw.hosts['shop.example.org']).toEqual({ count: 1, lastAt: '2026-01-02T03:04:05.000Z' })
    expect(fs.existsSync(`${storePath}.tmp`)).toBe(false)
  })

  it('文件缺失/坏 JSON/结构不对 → 从空档重来，不抛异常', () => {
    const storePath = tempStore()
    expect(recordTier4HostUsage('a.example.org', { storePath })).toBe(1)

    fs.writeFileSync(storePath, '{ not json', 'utf-8')
    expect(recordTier4HostUsage('a.example.org', { storePath })).toBe(1)

    fs.writeFileSync(storePath, JSON.stringify({ version: 1, hosts: 'nope' }), 'utf-8')
    expect(recordTier4HostUsage('a.example.org', { storePath })).toBe(1)
  })

  it('逐次累加跨进程可读回（持久化真的生效）', () => {
    const storePath = tempStore()
    recordTier4HostUsage('a.example.org', { storePath })
    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as { hosts: Record<string, { count: number }> }
    expect(persisted.hosts['a.example.org'].count).toBe(1)
    expect(recordTier4HostUsage('a.example.org', { storePath })).toBe(2)
  })
})

describe('graduationHint', () => {
  it('写明站点名、次数与固化入口，且不提内部组件名', () => {
    const hint = graduationHint('shop.example.org', 3)
    expect(hint).toContain('shop.example.org')
    expect(hint).toContain('第 3 次')
    expect(hint).toContain('网站探索agent')
    expect(hint).toContain('http://127.0.0.1:8766/ui')
    expect(hint.toLowerCase()).not.toContain('webwright')
  })
})
