import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const EXTENSION_DIR = resolve(process.cwd(), '../extension')
const WEBCLI_DIR = resolve(process.cwd())
const JD_ADAPTER_DIR = resolve(process.cwd(), '../adapters/jd.com')

/**
 * ★ `auth.qr.command` runs an Adapter-declared read command in the login tab
 * for precise QR extraction (docs/website-login-analysis §5.1). Login pages are
 * off limits to business commands by design (`assertNotOnLoginPage`), so this
 * is a host-only opt-in; any failure or `found: false` must fall back to the
 * generic QR discovery instead of failing the login flow.
 */
describe('extension host QR command execution', () => {
  it('runs the declared qr.command before the generic discovery and falls back to it', () => {
    const source = readFileSync(resolve(EXTENSION_DIR, 'background', 'service-worker.js'), 'utf8')

    const prepare = source.match(/async function prepareSiteQrLogin[\s\S]{0,1400}?chrome\.scripting\.executeScript/)
    expect(prepare).toBeTruthy()
    // Off switch stays first: no command, no discovery.
    expect(prepare[0]).toContain("manifest.auth?.qr?.mode === 'off'")
    // The command must be a declared read Extension command of the package.
    expect(prepare[0]).toContain('manifest.auth?.qr?.command')
    expect(prepare[0]).toContain("entry.runtime === 'extension'")
    expect(prepare[0]).toContain("entry.safety === 'read'")
    // Declared command first, generic discovery only as the fallback.
    expect(prepare[0]).toContain('await runManagedQrCommand(manifest, tab, qrCommand, commandNotes)')
    expect(prepare[0]).toContain('if (declared) return declared')
    // A declared-command failure must stay visible next to the heuristic reason.
    expect(source).toContain('notes.commandReason')
    expect(source).toContain('heuristic.commandReason = commandNotes.commandReason')
  })

  it('executes the command in the login tab behind the explicit login-page opt-in', () => {
    const source = readFileSync(resolve(EXTENSION_DIR, 'background', 'service-worker.js'), 'utf8')

    const runner = source.match(/async function runManagedQrCommand[\s\S]{0,2000}?^}/m)
    expect(runner).toBeTruthy()
    expect(runner[0]).toContain('getHostAdapterRuntime().execute(tab.id, manifest, url')
    expect(runner[0]).toContain('callToolInTab(tab.id, manifest.name + \'.\' + command.id')
    expect(runner[0]).toContain('{ loginPage: true }')
    // found:false / timeouts / errors fall back to generic discovery.
    expect(runner[0]).toContain("result.found !== true")
    expect(runner[0]).toContain('return null')
    // Protocol: image data URL, bounded like the heuristic copy.
    expect(runner[0]).toContain('result.image_data_url')
    expect(runner[0]).toContain('2_800_000')
    expect(runner[0]).toContain("method: 'command'")
    // Rect protocol (docs §5.1): cross-origin login iframes cannot hand over
    // the image, so a validated element rect is passed through for cropping.
    expect(runner[0]).toContain('result.rect')
    expect(runner[0]).toContain('rect.width >= 20')
    expect(runner[0]).toContain('{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }')
  })

  it('keeps business commands off login pages while the host QR path opts in', () => {
    const source = readFileSync(resolve(EXTENSION_DIR, 'background', 'service-worker.js'), 'utf8')

    const ready = source.match(/async function waitForManagedPageReady[\s\S]{0,2200}?timed out\./)
    expect(ready).toBeTruthy()
    expect(ready[0]).toMatch(/if \(resume && options\.loginPage !== true\) assertNotOnLoginPage/)
    expect(ready[0].match(/options\.loginPage !== true\) assertNotOnLoginPage/g)).toHaveLength(2)
    const readyHook = source.match(/ready: \(tabId, manifest, timeoutMs, traceID, options\) => waitForManagedPageReady/)
    expect(readyHook).toBeTruthy()

    const runtime = readFileSync(resolve(EXTENSION_DIR, 'background', 'host-adapter-runtime.js'), 'utf8')
    expect(runtime).toContain('command = null, traceID = null, options = {}')
    expect(runtime).toContain('ready(tabId, manifest, Math.min(25000, deadline - now()), traceID, options)')
  })

  it('reports the QR discovery method from the extension instead of hardcoding heuristic', () => {
    const source = readFileSync(resolve(WEBCLI_DIR, 'site-login.js'), 'utf8')
    const qrBlock = source.match(/const qr = \{\s*available: result\.available === true[\s\S]{0,420}?\};/)
    expect(qrBlock).toBeTruthy()
    expect(qrBlock[0]).toContain("typeof result.method === 'string' && result.method ? result.method : 'heuristic'")
    expect(qrBlock[0]).toContain('result.expiresAt')
    // Cold SPA logins mount the QR late: the prepare call outlives 10s, and the
    // declared command's failure reason is logged beside the heuristic's.
    expect(source).toContain("'auth_prepare_qr', { site: manifest.name }, 30_000")
    expect(source).toContain('result.commandReason ? ` command=${result.commandReason}`')
  })

  it('crops the login-tab screenshot to the rect when no image came back', () => {
    const source = readFileSync(resolve(WEBCLI_DIR, 'site-login.js'), 'utf8')
    expect(source).toContain('!qr.image && result.rect && flow?.url')
    expect(source).toContain("this._browser.screenshot(flow.url, { clip: result.rect })")
    expect(source).toContain('${manifest.name}.qr.jpg')

    const browser = readFileSync(resolve(WEBCLI_DIR, 'dedicated-browser.js'), 'utf8')
    // The dedicated browser threads the clip into CDP page coordinates.
    expect(browser).toContain('async screenshot(url, options = {})')
    expect(browser).toContain('params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 }')
    expect(browser).toContain('params.captureBeyondViewport = true')
    expect(browser).toContain('this._manager.screenshot(url, options)')

    // The Bridge wiring must not drop the clip on its way to the manager.
    const bridgeWiring = readFileSync(resolve(WEBCLI_DIR, 'bridge.js'), 'utf8')
    expect(bridgeWiring).toContain('screenshot: (url, options) => isDedicated() ? host.screenshot(url, options) : Promise.resolve(null)')
  })

  it('goofish.com reports the cross-origin login iframe rect', () => {
    const adapterDir = resolve(process.cwd(), '../adapters/goofish.com')
    const manifest = JSON.parse(readFileSync(resolve(adapterDir, 'manifest.json'), 'utf8'))
    const qrCommandId = manifest.auth?.qr?.command
    expect(typeof qrCommandId).toBe('string')
    const command = manifest.commands.find((entry) => entry.id === qrCommandId)
    expect(command).toMatchObject({ runtime: 'extension', safety: 'read' })

    const moduleSource = readFileSync(resolve(adapterDir, command.module), 'utf8')
    expect(moduleSource).toContain('__webcliRegisterCommand("get-login-qrcode"')
    // Confined to the goofish top frame, where the havana iframe element lives.
    expect(moduleSource).toMatch(/LOGIN_HOST_RE\.test\(location\.hostname\)/)
    expect(moduleSource).toContain('var LOGIN_HOST_RE = /^(?:www\\.)?goofish\\.com$/;')
    // The QR itself is inside login.taobao.com's iframe: report its page rect
    // (scroll-adjusted) for the host to crop, never an image or a click.
    expect(moduleSource).toContain('login(?:\\.m)?\\.taobao\\.com')
    expect(moduleSource).toMatch(/rect\.left \+ window\.scrollX/)
    expect(moduleSource).toMatch(/rect\.top \+ window\.scrollY/)
    // Cold SPA loads mount the login box late (observed >10s): the command
    // waits it out, and pierces shadow roots plus a login-ish iframe fallback.
    expect(moduleSource).toContain('attempt < 80')
    expect(moduleSource).toContain('element.shadowRoot')
    expect(moduleSource).toContain('(?:login|passport|account|member)')
    // The crop is the QR column, not the whole panel (measured live: QR spans
    // x 0.20-0.39 of the havana panel); an odd aspect falls back to the panel.
    expect(moduleSource).toContain('rect: qrColumnRect(')
    expect(moduleSource).toContain('rect.width * 0.58')
    expect(moduleSource).toContain('aspect >= 0.9 && aspect <= 1.4')
    expect(moduleSource).not.toContain('image_data_url')
    expect(moduleSource).not.toMatch(/\.click\(\)/)
    expect(moduleSource).not.toMatch(/\.value\s*=/)
  })

  it('jd.com declares a validated qr.command matching the real passport page', () => {
    const manifest = JSON.parse(readFileSync(resolve(JD_ADAPTER_DIR, 'manifest.json'), 'utf8'))
    const qrCommandId = manifest.auth?.qr?.command
    expect(typeof qrCommandId).toBe('string')
    const command = manifest.commands.find((entry) => entry.id === qrCommandId)
    expect(command).toMatchObject({ runtime: 'extension', safety: 'read' })

    const modulePath = resolve(JD_ADAPTER_DIR, command.module)
    expect(existsSync(modulePath)).toBe(true)
    const moduleSource = readFileSync(modulePath, 'utf8')
    // Registered under its declared id, restricted to the login hosts, and it
    // answers with the {found, image_data_url} host protocol.
    expect(moduleSource).toContain('__webcliRegisterCommand("get-login-qrcode"')
    expect(moduleSource).toMatch(/LOGIN_HOST_RE\.test\(location\.hostname\)/)
    expect(moduleSource).toContain('found: false')
    expect(moduleSource).toContain('image_data_url')
    // Verified against passport.jd.com/new/login.aspx + login.qrcode.2024.js:
    // the QR is #passport-main-qrcode-img with a qr.m.jd.com server src (so a
    // credentialed in-page fetch converts it to a data URL), the initial src
    // is a CDN placeholder, and an expired QR is refreshed via the page's own
    // refresh control under the .qrcode-error-2016 mask.
    expect(moduleSource).toContain('#passport-main-qrcode-img')
    expect(moduleSource).toContain("credentials: 'include'")
    expect(moduleSource).toContain('PLACEHOLDER_RE = /360buyimg\\.com\\/imagetools/')
    expect(moduleSource).toContain('.qrcode-error-2016 .refresh-btn')
    // It only ever clicks a unique 扫码登录 switch; no form fills or submits.
    expect(moduleSource).toMatch(/candidates\.length === 1 \? candidates\[0\] : null/)
    expect(moduleSource).not.toMatch(/\.value\s*=/)
  })
})
