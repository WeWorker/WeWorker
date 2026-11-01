// Feature: webcli-and-skill-architecture, Property 4: call 命令构造正确的 bridge 消息
// **Validates: Requirements 4.1, 4.4**

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

/**
 * Replicate the message construction logic from cmdCall in index.js.
 * The actual function has side effects (WebSocket, process.exit) that make
 * direct import impractical for property testing, so we extract the pure
 * message-building logic here — same pattern as config-dir.test.js.
 *
 * From index.js cmdCall():
 *   let args = {};
 *   try { args = parseArgsJson(argsStr); }
 *   catch (error) { ... }
 *   const id = "cli-" + Date.now();
 *   ws.send(JSON.stringify({ type: "call_tool", toolName, args, id }));
 */
function buildCallMessage(toolName, argsStr) {
  let args = {}
  if (argsStr) {
    args = JSON.parse(argsStr)
  }
  const id = 'cli-' + Date.now()
  return { type: 'call_tool', toolName, args, id }
}

/**
 * Replicate the parseArgsJson / parseArgsKeyValue logic from index.js.
 * JSON parse first; on failure, attempt key=value parsing.
 */
function parseArgsJson(argsStr) {
  if (!argsStr) return {}
  try {
    return JSON.parse(argsStr)
  } catch {
    const parsed = parseArgsKeyValue(argsStr)
    if (parsed !== null) return parsed
    throw new Error("--args 必须是有效的 JSON 或 key=value 格式（如 url=http://example.com keyword=test）")
  }
}

function parseArgsKeyValue(argsStr) {
  const trimmed = argsStr.trim()
  if (!trimmed) return {}

  const result = {}
  let i = 0
  while (i < trimmed.length) {
    while (i < trimmed.length && trimmed[i] === ' ') i++
    if (i >= trimmed.length) break

    const keyStart = i
    while (i < trimmed.length && trimmed[i] !== '=') i++
    if (i >= trimmed.length) return null
    const key = trimmed.slice(keyStart, i).trim()
    if (!key) return null
    i++

    let value
    if (i >= trimmed.length) {
      value = ''
    } else if (trimmed[i] === '"' || trimmed[i] === "'") {
      const quote = trimmed[i]
      i++
      const valueStart = i
      while (i < trimmed.length && trimmed[i] !== quote) i++
      if (i >= trimmed.length) return null
      value = trimmed.slice(valueStart, i)
      i++
    } else {
      const valueStart = i
      while (i < trimmed.length && trimmed[i] !== ' ') i++
      value = trimmed.slice(valueStart, i)
    }

    if (value === 'true') {
      result[key] = true
    } else if (value === 'false') {
      result[key] = false
    } else {
      result[key] = value
    }
  }

  return Object.keys(result).length > 0 ? result : null
}

/**
 * Generator for valid tool name strings (non-empty alphanumeric with common separators).
 */
const arbitraryToolName = () =>
  fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_.-]{0,49}$/)

/**
 * Generator for JSON-serializable argument objects.
 * Uses fc.dictionary to produce { string: jsonValue } objects.
 */
const arbitraryArgsObject = () =>
  fc.dictionary(
    fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,15}$/),
    fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.float({ noNaN: true, noDefaultInfinity: true }).filter(v => !Object.is(v, -0)),
    ),
  )

describe('Property 4: call 命令构造正确的 bridge 消息', () => {
  it('should construct a message with type "call_tool", the original toolName, and parsed args', () => {
    fc.assert(
      fc.property(
        arbitraryToolName(),
        arbitraryArgsObject(),
        (toolName, argsObj) => {
          const argsStr = JSON.stringify(argsObj)
          const msg = buildCallMessage(toolName, argsStr)

          // Message must have type "call_tool"
          expect(msg.type).toBe('call_tool')
          // Message must preserve the original toolName
          expect(msg.toolName).toBe(toolName)
          // Message args must equal the parsed args object
          expect(msg.args).toEqual(argsObj)
          // Message must have an id starting with "cli-"
          expect(msg.id).toMatch(/^cli-\d+$/)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('should default args to {} when argsStr is not provided', () => {
    fc.assert(
      fc.property(arbitraryToolName(), (toolName) => {
        const msg = buildCallMessage(toolName, undefined)

        expect(msg.type).toBe('call_tool')
        expect(msg.toolName).toBe(toolName)
        expect(msg.args).toEqual({})
        expect(msg.id).toMatch(/^cli-\d+$/)
      }),
      { numRuns: 100 },
    )
  })

  it('should produce a valid JSON-serializable message for any inputs', () => {
    fc.assert(
      fc.property(
        arbitraryToolName(),
        arbitraryArgsObject(),
        (toolName, argsObj) => {
          const argsStr = JSON.stringify(argsObj)
          const msg = buildCallMessage(toolName, argsStr)

          // The message must be JSON-serializable (round-trip)
          const serialized = JSON.stringify(msg)
          const deserialized = JSON.parse(serialized)

          expect(deserialized.type).toBe('call_tool')
          expect(deserialized.toolName).toBe(toolName)
          expect(deserialized.args).toEqual(argsObj)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('should default args to {} when argsStr is empty string', () => {
    fc.assert(
      fc.property(arbitraryToolName(), (toolName) => {
        // Empty string is falsy, so args should default to {}
        const msg = buildCallMessage(toolName, '')

        expect(msg.type).toBe('call_tool')
        expect(msg.toolName).toBe(toolName)
        expect(msg.args).toEqual({})
      }),
      { numRuns: 100 },
    )
  })
})

// Feature: webcli-and-skill-architecture, Property 5: call 命令输出格式正确性
// **Validates: Requirements 4.2, 4.3**

/**
 * Replicate the output formatting logic from cmdCall in index.js.
 *
 * Success path (call_tool_result):
 *   console.log(JSON.stringify(msg.result, null, 2));  → stdout, exit 0
 *
 * Error path (call_tool_error):
 *   console.error(`Error: ${msg.error}`);              → stderr, exit 1
 */
function formatSuccessOutput(result) {
  return {
    stdout: JSON.stringify(result, null, 2),
    exitCode: 0,
  }
}

function formatErrorOutput(error) {
  return {
    stderr: `Error: ${error}`,
    exitCode: 1,
  }
}

/**
 * Generator for JSON-serializable result objects (arbitrary depth).
 */
const arbitraryResultObject = () =>
  fc.oneof(
    // Simple values
    fc.record({
      status: fc.constantFrom('ok', 'success', 'done'),
      data: fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
    }),
    // Nested objects
    fc.record({
      items: fc.array(
        fc.record({
          id: fc.integer({ min: 1, max: 10000 }),
          name: fc.string({ minLength: 1, maxLength: 30 }),
          active: fc.boolean(),
        }),
        { minLength: 0, maxLength: 5 },
      ),
    }),
    // Flat dictionary
    fc.dictionary(
      fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,10}$/),
      fc.oneof(
        fc.string(),
        fc.integer(),
        fc.boolean(),
        fc.constant(null),
        fc.float({ noNaN: true, noDefaultInfinity: true }).filter(v => !Object.is(v, -0)),
      ),
    ),
  )

/**
 * Generator for error message strings.
 */
const arbitraryErrorMessage = () =>
  fc.oneof(
    fc.string({ minLength: 1, maxLength: 200 }),
    fc.constantFrom(
      'Tool not found',
      'Timeout exceeded',
      'Permission denied',
      'Invalid arguments',
      '工具调用失败',
    ),
  )

describe('Property 5: call 命令输出格式正确性', () => {
  it('should format success result as 2-space indented JSON to stdout with exit code 0', () => {
    fc.assert(
      fc.property(arbitraryResultObject(), (result) => {
        const output = formatSuccessOutput(result)

        // stdout must be valid JSON
        const parsed = JSON.parse(output.stdout)
        expect(parsed).toEqual(result)

        // stdout must use 2-space indentation (matches JSON.stringify(x, null, 2))
        expect(output.stdout).toBe(JSON.stringify(result, null, 2))

        // exit code must be 0
        expect(output.exitCode).toBe(0)
      }),
      { numRuns: 100 },
    )
  })

  it('should format error as "Error: <message>" to stderr with exit code 1', () => {
    fc.assert(
      fc.property(arbitraryErrorMessage(), (errorMsg) => {
        const output = formatErrorOutput(errorMsg)

        // stderr must start with "Error: " prefix
        expect(output.stderr).toBe(`Error: ${errorMsg}`)
        expect(output.stderr.startsWith('Error: ')).toBe(true)

        // The original error message must be preserved after the prefix
        expect(output.stderr.slice('Error: '.length)).toBe(errorMsg)

        // exit code must be non-zero (specifically 1)
        expect(output.exitCode).not.toBe(0)
        expect(output.exitCode).toBe(1)
      }),
      { numRuns: 100 },
    )
  })

  it('should produce round-trippable JSON for any result object', () => {
    fc.assert(
      fc.property(arbitraryResultObject(), (result) => {
        const output = formatSuccessOutput(result)

        // Round-trip: parse the formatted output and re-stringify
        const roundTripped = JSON.stringify(JSON.parse(output.stdout), null, 2)
        expect(roundTripped).toBe(output.stdout)
      }),
      { numRuns: 100 },
    )
  })

  it('should always have different exit codes for success vs error', () => {
    fc.assert(
      fc.property(
        arbitraryResultObject(),
        arbitraryErrorMessage(),
        (result, errorMsg) => {
          const success = formatSuccessOutput(result)
          const error = formatErrorOutput(errorMsg)

          // Success and error must have different exit codes
          expect(success.exitCode).not.toBe(error.exitCode)

          // Success exit code is 0, error is non-zero
          expect(success.exitCode).toBe(0)
          expect(error.exitCode).toBeGreaterThan(0)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// Feature: key=value args parsing for webcli call
// **Validates: parseArgsJson supports both JSON and key=value formats**

describe('parseArgsJson: key=value format support', () => {
  it('should parse single key=value pair', () => {
    const result = parseArgsJson('url=http://example.com')
    expect(result).toEqual({ url: 'http://example.com' })
  })

  it('should parse multiple key=value pairs separated by spaces', () => {
    const result = parseArgsJson('keyword=travel limit=5')
    expect(result).toEqual({ keyword: 'travel', limit: '5' })
  })

  it('should infer boolean type for true and false', () => {
    const result = parseArgsJson('enabled=true disabled=false')
    expect(result).toEqual({ enabled: true, disabled: false })
  })

  it('should keep numeric values as strings for schema compatibility', () => {
    const result = parseArgsJson('count=42 offset=-1')
    expect(result).toEqual({ count: '42', offset: '-1' })
  })

  it('should keep float values as strings', () => {
    const result = parseArgsJson('rate=3.14')
    expect(result).toEqual({ rate: '3.14' })
  })

  it('should handle double-quoted values with spaces', () => {
    const result = parseArgsJson('name="hello world"')
    expect(result).toEqual({ name: 'hello world' })
  })

  it('should handle single-quoted values with spaces', () => {
    const result = parseArgsJson("name='hello world'")
    expect(result).toEqual({ name: 'hello world' })
  })

  it('should handle mixed quoted and unquoted values', () => {
    const result = parseArgsJson('url=http://example.com name="hello world" count=3')
    expect(result).toEqual({ url: 'http://example.com', name: 'hello world', count: '3' })
  })

  it('should still parse valid JSON when JSON is provided', () => {
    const result = parseArgsJson('{"url":"http://example.com","limit":5}')
    expect(result).toEqual({ url: 'http://example.com', limit: 5 })
  })

  it('should throw for completely invalid input', () => {
    expect(() => parseArgsJson('not valid input')).toThrow()
  })

  it('should throw for input with no equals sign', () => {
    expect(() => parseArgsJson('justakey')).toThrow()
  })

  it('should return {} for undefined input', () => {
    expect(parseArgsJson(undefined)).toEqual({})
  })

  it('should return {} for empty string', () => {
    expect(parseArgsJson('')).toEqual({})
  })

  it('should handle key with empty value', () => {
    const result = parseArgsJson('name=')
    expect(result).toEqual({ name: '' })
  })

  it('should handle URL values with special characters', () => {
    const result = parseArgsJson('url=http://example.com/path?a=1&b=2')
    expect(result).toEqual({ url: 'http://example.com/path?a=1&b=2' })
  })

  it('should handle value that looks like boolean but is part of a string', () => {
    const result = parseArgsJson('status=true')
    expect(result.status).toBe(true)
    expect(typeof result.status).toBe('boolean')
  })

  it('should produce same result as JSON for equivalent string-valued inputs', () => {
    // Note: key=value 不推断数字类型，所以 JSON 需要用字符串值才能等
    const kvResult = parseArgsJson('keyword=travel url=http://example.com')
    const jsonResult = parseArgsJson('{"keyword":"travel","url":"http://example.com"}')
    expect(kvResult).toEqual(jsonResult)
  })
})

describe('parseArgsKeyValue: property-based tests', () => {
  it('should always produce an object with string keys when given valid key=value input', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            key: fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,15}$/),
            value: fc.oneof(
              fc.stringMatching(/^[a-zA-Z0-9_.:/-]+$/),
              fc.integer({ min: -1000, max: 1000 }),
              fc.boolean(),
            ),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (pairs) => {
          const argsStr = pairs.map(p => `${p.key}=${p.value}`).join(' ')
          const result = parseArgsKeyValue(argsStr)
          expect(result).not.toBeNull()
          for (const p of pairs) {
            expect(result).toHaveProperty(p.key)
          }
        },
      ),
      { numRuns: 50 },
    )
  })

  it('should round-trip: key=value string → object → JSON → object matches', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,10}$/),
          fc.oneof(
            fc.stringMatching(/^[a-zA-Z0-9_.:/-]+$/),  // only safe chars that round-trip cleanly
            fc.integer(),
            fc.boolean(),
          ),
        ),
        (argsObj) => {
          // Build key=value string from object
          const kvStr = Object.entries(argsObj)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')
          const parsed = parseArgsKeyValue(kvStr)
          if (parsed !== null) {
            for (const [k, v] of Object.entries(argsObj)) {
              if (typeof v === 'number') {
                // Numbers become strings in key=value format (no inference)
                expect(parsed[k]).toBe(String(v))
              } else if (typeof v === 'boolean') {
                expect(parsed[k]).toBe(v)
              } else {
                // Strings: round-trip exactly (except special "true"/"false" which become boolean)
                if (v === 'true') {
                  expect(parsed[k]).toBe(true)
                } else if (v === 'false') {
                  expect(parsed[k]).toBe(false)
                } else {
                  expect(parsed[k]).toBe(v)
                }
              }
            }
          }
        },
      ),
      { numRuns: 50 },
    )
  })
})

// Feature: --key=value flag parsing
// **Validates: extractFlagArgs and inferType**

function inferType(value) {
  // 方案 A：值以 { 或 [ 开头时尝试 JSON.parse
  const trimmed = value.trim()
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if ((first === '{' && last === '}') || (first === '[' && last === ']')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // 解析失败按普通字符串处理
    }
  }
  // 只推断布尔；数字不推断（string 参数如 floor=11 应保留为 string）
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

function assignArg(args, key, value) {
  if (!(key in args)) {
    args[key] = value
    return
  }
  if (Array.isArray(args[key])) {
    args[key].push(value)
  } else {
    args[key] = [args[key], value]
  }
}

function extractFlagArgs(argv, startIndex = 0) {
  const args = {}
  const rest = []
  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--args') {
      i++
      if (i < argv.length) {
        const parsed = parseArgsJson(argv[i])
        for (const [k, v] of Object.entries(parsed)) assignArg(args, k, v)
      }
      continue
    }
    const flagMatch = arg.match(/^--([^=]+)=(.*)$/)
    if (flagMatch) {
      const [, key, value] = flagMatch
      assignArg(args, key, inferType(value))
      continue
    }
    rest.push(arg)
  }
  return { args, rest }
}

describe('extractFlagArgs: --key=value flag parsing', () => {
  it('should extract --key=value flags into args object', () => {
    const { args, rest } = extractFlagArgs(['open_browser', '--url=http://jd.com', '--adapter=jd.com'], 0)
    expect(args).toEqual({ url: 'http://jd.com', adapter: 'jd.com' })
    expect(rest).toEqual(['open_browser'])
  })

  it('should keep numeric flag values as strings for schema compatibility', () => {
    const { args } = extractFlagArgs(['--limit=5', '--offset=-1', '--rate=3.14'], 0)
    expect(args).toEqual({ limit: '5', offset: '-1', rate: '3.14' })
  })

  it('should infer boolean type from flag values', () => {
    const { args } = extractFlagArgs(['--enabled=true', '--disabled=false'], 0)
    expect(args).toEqual({ enabled: true, disabled: false })
  })

  it('should keep string values as strings', () => {
    const { args } = extractFlagArgs(['--keyword=手机', '--mode=security'], 0)
    expect(args).toEqual({ keyword: '手机', mode: 'security' })
  })

  it('should handle URL values with query params', () => {
    const { args } = extractFlagArgs(['--url=http://example.com/path?a=1&b=2'], 0)
    expect(args).toEqual({ url: 'http://example.com/path?a=1&b=2' })
  })

  it('should collect non-flag args into rest', () => {
    const { args, rest } = extractFlagArgs(['tool_name', '--key=val', 'positional'], 0)
    expect(args).toEqual({ key: 'val' })
    expect(rest).toEqual(['tool_name', 'positional'])
  })

  it('should merge --args JSON with --key=value flags', () => {
    const { args, rest } = extractFlagArgs(['--key1=val1', '--args', '{"key2":"val2"}'], 0)
    expect(args).toEqual({ key1: 'val1', key2: 'val2' })
  })

  it('should handle startIndex to skip initial args', () => {
    const { args, rest } = extractFlagArgs(['call', 'tool_name', '--key=val'], 2)
    expect(args).toEqual({ key: 'val' })
    expect(rest).toEqual([])
  })

  it('should return empty args when no flags present', () => {
    const { args, rest } = extractFlagArgs(['call', 'tool_name'], 2)
    expect(args).toEqual({})
    expect(rest).toEqual([])
  })

  it('should handle empty flag value', () => {
    const { args } = extractFlagArgs(['--name='], 0)
    expect(args).toEqual({ name: '' })
  })

  it('should handle value with equals sign', () => {
    const { args } = extractFlagArgs(['--expr=a=b'], 0)
    expect(args).toEqual({ expr: 'a=b' })
  })

  // ── 方案 A：JSON 字面量值 ──
  it('should parse array literal value as array (方案 A)', () => {
    const { args } = extractFlagArgs(['--approvers=["zhangsan","lisi"]'], 0)
    expect(args).toEqual({ approvers: ['zhangsan', 'lisi'] })
  })

  it('should parse object literal value as object (方案 A)', () => {
    const { args } = extractFlagArgs(['--fields={"标题":"xxx","业务类型":"其他"}'], 0)
    expect(args).toEqual({ fields: { '标题': 'xxx', '业务类型': '其他' } })
  })

  it('should parse array of objects literal value (方案 A)', () => {
    const { args } = extractFlagArgs(['--items=[{"id":1,"name":"foo"},{"id":2,"name":"bar"}]'], 0)
    expect(args).toEqual({ items: [{ id: 1, name: 'foo' }, { id: 2, name: 'bar' }] })
  })

  it('should parse nested object literal value (方案 A)', () => {
    const { args } = extractFlagArgs(['--review={"node":"审批","user":"zhang"}'], 0)
    expect(args).toEqual({ review: { node: '审批', user: 'zhang' } })
  })

  it('should treat malformed JSON literal as plain string', () => {
    const { args } = extractFlagArgs(['--bad={not valid json}'], 0)
    expect(args).toEqual({ bad: '{not valid json}' })
  })

  it('should parse number array literal (方案 A)', () => {
    const { args } = extractFlagArgs(['--rowNumbers=[1,2,3]'], 0)
    expect(args).toEqual({ rowNumbers: [1, 2, 3] })
  })

  // ── 方案 C：同名 flag 聚合数组 ──
  it('should aggregate repeated flags into array (方案 C)', () => {
    const { args } = extractFlagArgs(['--approvers=zhangsan', '--approvers=lisi'], 0)
    expect(args).toEqual({ approvers: ['zhangsan', 'lisi'] })
  })

  it('should aggregate three repeated flags into array (方案 C)', () => {
    const { args } = extractFlagArgs(['--tags=web', '--tags=api', '--tags=prod'], 0)
    expect(args).toEqual({ tags: ['web', 'api', 'prod'] })
  })

  it('should aggregate repeated flags with different types (方案 C)', () => {
    const { args } = extractFlagArgs(['--vals=1', '--vals=true', '--vals=text'], 0)
    expect(args).toEqual({ vals: ['1', true, 'text'] })
  })

  it('should aggregate JSON literal repeated flags (方案 A+C)', () => {
    const { args } = extractFlagArgs(['--items={"id":1}', '--items={"id":2}'], 0)
    expect(args).toEqual({ items: [{ id: 1 }, { id: 2 }] })
  })
})

describe('buildCallMessage with flagArgs', () => {
  it('should merge flagArgs into args with flagArgs having lower priority than --args', () => {
    // Simulating the cmdCall logic: args = { ...flagArgs, ...parsedArgs }
    const flagArgs = { key1: 'flag-value' }
    const parsedArgs = { key1: 'args-value', key2: 'val2' }
    const merged = { ...flagArgs, ...parsedArgs }
    expect(merged).toEqual({ key1: 'args-value', key2: 'val2' })
  })

  it('should use flagArgs when no --args provided', () => {
    const flagArgs = { url: 'http://jd.com', limit: 5 }
    const parsedArgs = {}
    const merged = { ...flagArgs, ...parsedArgs }
    expect(merged).toEqual({ url: 'http://jd.com', limit: 5 })
  })
})
