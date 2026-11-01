import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateV2Manifest, validateV2AdapterDir } from '../adapter-package-validation.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function manifest(auth, extra = {}) {
  return {
    schema_version: 2, name: 'fixture.example.com', version: '1.0.0', description: 'Fixture',
    match: ['www.example.com'], runtime_allowed_hosts: ['api.example.com'],
    commands: [
      { id: 'whoami', runtime: 'extension', module: 'extension/commands/whoami.js', description: 'Who', safety: 'read', schema: { type: 'object' } },
      { id: 'post', runtime: 'extension', module: 'extension/commands/post.js', description: 'Post', safety: 'write', schema: { type: 'object' }, auth: 'required' },
    ],
    ...(auth === undefined ? {} : { auth }),
    ...extra,
  }
}

describe('manifest auth declaration', () => {
  it('accepts login pages, SSO hosts, cookie and command checks, and auto-login selectors', () => {
    expect(() => validateV2Manifest(manifest({
      login_url: 'https://sso.example.com/login', login_hosts: ['sso.example.com', '*.passport.example.com'], display_name: '示例',
      check: { cookies: { url: 'https://www.example.com/', all: ['sid'], not: { guest: 'T' } }, command: 'whoami' },
      autologin: {
        "mode": "auto",
        "switch": "#tab-password",
        "submit": "button[type=submit]"
      }
    }), 'fixture.example.com')).not.toThrow()
    expect(() => validateV2Manifest(manifest({ login_url: 'http://www.example.com/signin', autologin: { mode: 'off' } }), 'fixture.example.com')).not.toThrow()
    expect(() => validateV2Manifest(manifest({ login_url: 'https://www.example.com/signin' }), 'fixture.example.com')).not.toThrow()
  })

  it.each([
    [{ login_hosts: [] }, /login_url is required/],
    [{ login_url: 'https://www.example.com/', autologin: { password: 42 } }, /mode: auto\|off/],
    [{ login_url: 'https://www.example.com/', autologin: { mode: 'sometimes' } }, /mode: auto\|off/],
    [{ login_url: 'https://user:pass@www.example.com/login' }, /without credentials/],
    [{ login_url: 'https://elsewhere.example.net/login' }, /host must be declared/],
    [{ login_url: 'https://www.example.com/', login_hosts: ['bad host'] }, /login_hosts/],
    [{ login_url: 'https://www.example.com/', extra: 1 }, /unknown auth field/],
    [{ login_url: 'https://www.example.com/', check: {} }, /cookies or command/],
    [{ login_url: 'https://www.example.com/', check: { command: 'post' } }, /read Extension command/],
    [{ login_url: 'https://www.example.com/', check: { command: 'missing' } }, /read Extension command/],
    [{ login_url: 'https://www.example.com/', check: { cookies: { url: 'https://tracker.example.net/', all: ['sid'] } } }, /check.cookies.url host/],
    [{ login_url: 'https://www.example.com/', check: { cookies: { url: 'https://www.example.com/' } } }, /at least one cookie/],
  ])('rejects %j', (auth, message) => {
    expect(() => validateV2Manifest(manifest(auth), 'fixture.example.com')).toThrow(message)
  })

  it('validates command-level auth', () => {
    const bad = manifest({ login_url: 'https://www.example.com/' })
    bad.commands[0].auth = 'sometimes'
    expect(() => validateV2Manifest(bad, 'fixture.example.com')).toThrow(/auth must be required\|optional\|none/)
  })

  it('every built-in Adapter with a declared login validates', () => {
    const root = path.join(repo, 'adapters')
    const declared = fs.readdirSync(root).filter((name) => JSON.parse(fs.readFileSync(path.join(root, name, 'manifest.json'), 'utf8')).auth)
    expect(declared.length).toBeGreaterThanOrEqual(20)
    for (const name of declared) expect(() => validateV2AdapterDir(path.join(root, name)), name).not.toThrow()
  })
})
