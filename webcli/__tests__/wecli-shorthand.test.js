import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEBCLI_DIR = resolve(__dirname, '..')

it('recognizes bare follow only for browser console/network without coercing business arguments', () => {
  for (const command of ['console', 'network']) expect(runIndexHelper(`m.resolveCliInvocation(['call', 'browser.${command}', '--session=example', '--follow'])`)).toMatchObject({type:'call',toolName:`browser.${command}`,flagArgs:{session:'example',follow:true}})
  expect(runIndexHelper(`m.resolveCliInvocation(['call', 'example.query', '--follow=true'])`).flagArgs.follow).toBe(true)
})

function runIndexHelper(expression) {
  const script = `
    import('./index.js')
      .then((m) => {
        const result = ${expression};
        console.log(JSON.stringify(result));
      })
      .catch((error) => {
        console.error(error.stack || error.message);
        process.exit(1);
      });
  `
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: WEBCLI_DIR,
    encoding: 'utf8',
  }))
}

function captureIndexHelperError(expression) {
  const script = `
    import('./index.js')
      .then((m) => {
        try {
          ${expression};
        } catch (error) {
          console.error(error.message);
          process.exit(42);
        }
        process.exit(0);
      })
      .catch((error) => {
        console.error(error.stack || error.message);
        process.exit(1);
      });
  `
  try {
    execFileSync(process.execPath, ['-e', script], {
      cwd: WEBCLI_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stderr: '' }
  } catch (error) {
    return { status: error.status, stderr: error.stderr.toString() }
  }
}

describe('WeCLI-style shorthand invocation', () => {
  it('advertises shorthand usage in CLI help', () => {
    const help = execFileSync(process.execPath, ['index.js', '--help'], {
      cwd: WEBCLI_DIR,
      encoding: 'utf8',
    })
    expect(help).toContain('webcli <site> <command...> [--key=value')
  })

  it('resolves a simple site command with --key=value flags', () => {
    expect(runIndexHelper(`m.resolveCliInvocation(['itsm', 'ls', '--status=open'])`)).toMatchObject({
      type: 'shorthand',
      toolName: 'itsm.ls',
      flagArgs: { status: 'open' },
    })
  })

  it('resolves a simple site command with --args (backward compat)', () => {
    expect(runIndexHelper(`m.resolveCliInvocation(['itsm', 'ls', '--args', '{"status":"open"}'])`)).toMatchObject({
      type: 'shorthand',
      toolName: 'itsm.ls',
      argsJson: '{"status":"open"}',
      flagArgs: { status: 'open' },
    })
  })

  it('resolves a multi-token command by joining command tokens with spaces', () => {
    expect(runIndexHelper(`m.resolveCliInvocation(['gitee', 'pr', 'create', '--repo=demo'])`)).toMatchObject({
      type: 'shorthand',
      toolName: 'gitee.pr create',
      flagArgs: { repo: 'demo' },
    })
  })

  it('preserves alias-compatible site.command names for downstream catalog resolution', () => {
    expect(runIndexHelper(`m.resolveCliInvocation(['pace-pipeline', 'params'])`)).toMatchObject({
      type: 'shorthand',
      toolName: 'pace-pipeline.params',
    })
  })

  it('keeps built-in commands out of shorthand parsing', () => {
    expect(runIndexHelper(`m.resolveCliInvocation(['service', 'status'])`)).toEqual({ type: 'builtin', command: 'service' })
    expect(runIndexHelper(`m.resolveCliInvocation(['adapter', 'list'])`)).toEqual({ type: 'builtin', command: 'adapter' })
    expect(runIndexHelper(`m.resolveCliInvocation(['call', 'itsm.ls', '--args', '{}'])`)).toEqual({
      type: 'call',
      toolName: 'itsm.ls',
      flagArgs: {},
    })
    expect(runIndexHelper(`m.resolveCliInvocation(['install', '--skills'])`)).toEqual({ type: 'builtin', command: 'install' })
    expect(runIndexHelper(`m.resolveCliInvocation(['trace', 'abc123'])`)).toEqual({ type: 'builtin', command: 'trace' })
  })

  it('passes structured call arguments once and keeps their priority over flags', () => {
    for (const args of [
      ['--page=9', '--args', '{"page":2,"id":"007"}'],
      ['--args', '{"page":2,"id":"007"}', '--page=9'],
      ['--args={"page":2,"id":"007"}', '--page=9'],
    ]) {
      expect(runIndexHelper(`m.resolveCliInvocation(${JSON.stringify(['call', 'example.com.list', ...args])})`)).toEqual({
        type: 'call',
        toolName: 'example.com.list',
        flagArgs: { page: 2, id: '007' },
      })
    }
  })

  it('treats npm global junction paths as direct CLI execution', () => {
    expect(runIndexHelper(`m.isDirectCliExecution('E:/npm-global/node_modules/@example/webcli/index.js', 'D:/git/WeWorker/webcli/index.js', (filePath) => {
      if (filePath.startsWith('E:/npm-global/node_modules/@example/webcli')) {
        return filePath.replace('E:/npm-global/node_modules/@example/webcli', 'D:/git/WeWorker/webcli')
      }
      return filePath
    })`)).toBe(true)
  })

  it('parses valid JSON args and rejects invalid JSON with a stable error', () => {
    expect(runIndexHelper(`m.parseArgsJson('{"dry-run":true}')`)).toEqual({ 'dry-run': true })
    const error = captureIndexHelperError(`m.parseArgsJson('{bad json')`)
    expect(error.status).toBe(42)
    expect(error.stderr).toContain('--args 必须是有效的 JSON')
  })

  it('extracts --key=value flags from argv', () => {
    expect(runIndexHelper(`m.extractFlagArgs(['--url=http://jd.com', '--limit=5'], 0)`)).toEqual({
      args: { url: 'http://jd.com', limit: '5' },
      rest: [],
    })
  })

  it('extractFlagArgs merges --args JSON with --key=value flags', () => {
    expect(runIndexHelper(`m.extractFlagArgs(['--key1=val1', '--args', '{"key2":"val2"}'], 0)`)).toEqual({
      args: { key1: 'val1', key2: 'val2' },
      rest: [],
    })
  })

  it('extractFlagArgs parses JSON array literal value (方案 A)', () => {
    expect(runIndexHelper(`m.extractFlagArgs(['--approvers=["a","b"]'], 0)`)).toEqual({
      args: { approvers: ['a', 'b'] },
      rest: [],
    })
  })

  it('extractFlagArgs parses JSON object literal value (方案 A)', () => {
    expect(runIndexHelper(`m.extractFlagArgs(['--fields={"k":"v"}'], 0)`)).toEqual({
      args: { fields: { k: 'v' } },
      rest: [],
    })
  })

  it('extractFlagArgs aggregates repeated flags into array (方案 C)', () => {
    expect(runIndexHelper(`m.extractFlagArgs(['--tags=x', '--tags=y'], 0)`)).toEqual({
      args: { tags: ['x', 'y'] },
      rest: [],
    })
  })
})
