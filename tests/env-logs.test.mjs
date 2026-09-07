import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectDesktop, mapLocale, nodeVersionOk, readInputs } from '../scripts/lib/env.mjs'
import { createLogger, scanLogs } from '../scripts/lib/logs.mjs'

describe('detectDesktop', () => {
  it('win32 / darwin 直过', () => {
    assert.equal(detectDesktop('win32', {}).ok, true)
    assert.equal(detectDesktop('darwin', {}).ok, true)
  })
  it('linux 有 DISPLAY / WAYLAND_DISPLAY 通过', () => {
    assert.equal(detectDesktop('linux', { DISPLAY: ':99' }).ok, true)
    assert.equal(detectDesktop('linux', { WAYLAND_DISPLAY: 'wayland-0' }).ok, true)
  })
  it('linux 无显示服务 → 失败并给出指引', () => {
    const result = detectDesktop('linux', {})
    assert.equal(result.ok, false)
    assert.match(result.reason, /Xvfb/u)
  })
  it('其它平台拒绝', () => {
    assert.equal(detectDesktop('freebsd', {}).ok, false)
  })
})

describe('mapLocale', () => {
  it('zh-CN → DSH zh + Chrome zh-CN', () => {
    assert.deepEqual(mapLocale('zh-CN'), { dshLocale: 'zh', chromeLocale: 'zh-CN' })
  })
  it('en-US → en', () => {
    assert.deepEqual(mapLocale('en-US'), { dshLocale: 'en', chromeLocale: 'en-US' })
  })
  it('其它语言只影响 Chrome', () => {
    assert.deepEqual(mapLocale('fr-FR'), { chromeLocale: 'fr-FR' })
  })
})

describe('nodeVersionOk', () => {
  it('满足 ^22.19.0 || >=24', () => {
    assert.equal(nodeVersionOk('v22.19.0'), true)
    assert.equal(nodeVersionOk('v24.0.0'), true)
    assert.equal(nodeVersionOk('v22.18.9'), false)
    assert.equal(nodeVersionOk('v23.9.0'), false)
    assert.equal(nodeVersionOk('v20.11.0'), false)
  })
})

describe('readInputs', () => {
  it('缺少 dsh-version 报错', () => {
    assert.throws(() => readInputs({}), /dsh-version/u)
  })
  it('读取默认值', () => {
    const inputs = readInputs({ INPUT_DSH_VERSION: '0.1.3-alpha.1' })
    assert.equal(inputs.dshVersion, '0.1.3-alpha.1')
    assert.equal(inputs.lang, 'zh-CN')
    assert.equal(inputs.profile, 'test')
    assert.equal(inputs.timeoutSeconds, 600)
  })
  it('timeout-seconds 非法报错', () => {
    assert.throws(() => readInputs({ INPUT_DSH_VERSION: 'x', INPUT_TIMEOUT_SECONDS: 'abc' }))
  })
})

describe('logs', () => {
  it('createLogger 落盘 + scanLogs 命中失败模式', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-plt-logs-'))
    try {
      const hostLogPath = join(dir, 'host.log')
      const webLogPath = join(dir, 'web-console.log')
      const hostLog = createLogger(hostLogPath)
      hostLog('dsh web: http://127.0.0.1:1234/?token=x')
      hostLog('UnsupportedDshVersionError: no adapter covers dsh 9.9.9')
      writeFileSync(webLogPath, '[console.error] Failed to load plugins @scope/x\n[console.log] 正常日志\n', 'utf8')

      const reasons = scanLogs({ hostLogPath, webLogPath })
      assert.equal(reasons.length, 2)
      assert.ok(reasons.some(r => r.includes('host.log')))
      assert.ok(reasons.some(r => r.includes('web-console.log')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('干净日志 → 无失败原因', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-plt-logs-'))
    try {
      const hostLogPath = join(dir, 'host.log')
      const webLogPath = join(dir, 'web-console.log')
      writeFileSync(hostLogPath, 'dsh web: http://127.0.0.1:1/?token=x\n', 'utf8')
      writeFileSync(webLogPath, '[console.log] ok\n', 'utf8')
      assert.deepEqual(scanLogs({ hostLogPath, webLogPath }), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
