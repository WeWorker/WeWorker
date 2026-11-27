import { describe, expect, it } from 'vitest'
import { parsePatrolArgs } from '../patrol/index.js'

describe('parsePatrolArgs', () => {
  it('解析常用参数', () => {
    expect(parsePatrolArgs(['--concurrency', '8', '--only', 'a.com', '--json'])).toMatchObject({ concurrency: 8, only: 'a.com', json: true })
  })

  it('默认并发 4', () => {
    expect(parsePatrolArgs([]).concurrency).toBe(4)
  })

  it('识别 --update-baseline', () => {
    expect(parsePatrolArgs(['--update-baseline']).updateBaseline).toBe(true)
  })

  it('--timeout 以秒为单位换算', () => {
    expect(parsePatrolArgs(['--timeout', '30']).timeoutMs).toBe(30_000)
  })
})
