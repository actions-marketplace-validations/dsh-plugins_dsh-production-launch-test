/**
 * runner — 桌面 Chrome 驱动与用户脚本执行。
 *
 * 桌面环境由 env.mjs 的预检保证，因此 Chrome 一律有头运行
 * （DSH_PLT_HEADLESS=1 仅供本地调试覆盖）。
 */

import { chromium } from 'playwright-core'
import { installBrowserApi } from './browser-api.mjs'
import { mapLocale } from './env.mjs'

const HEADLESS = process.env.DSH_PLT_HEADLESS === '1'

/** 预检：确认能拉起系统 Chrome（headed），失败时给出可读报错。 */
export async function preflightChrome(log = () => {}) {
  try {
    const browser = await chromium.launch({ channel: 'chrome', headless: true })
    const version = browser.version()
    await browser.close()
    log(`Chrome 预检通过：${version}`)
    return version
  } catch (error) {
    throw new Error('未找到系统 Chrome 或无法启动。请在 runner 上安装 Chrome'
      + '（GitHub 托管的 windows/macos/ubuntu runner 均预装）。'
      + `原始错误：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 打开 DSH Web GUI 并执行用户脚本。
 * @param {{ webUrl: string, lang: string, userScript: string,
 *   artifactsDir: string, timeoutSeconds: number,
 *   consoleLog: (line: string) => void, log?: (line: string) => void }} options
 */
export async function runInChrome({
  webUrl,
  lang,
  userScript,
  artifactsDir,
  timeoutSeconds,
  consoleLog,
  log = () => {},
}) {
  const { chromeLocale } = mapLocale(lang)
  const browser = await chromium.launch({ channel: 'chrome', headless: HEADLESS })
  const screenshotsDir = `${artifactsDir}/screenshots`
  try {
    const context = await browser.newContext({
      locale: chromeLocale,
      viewport: { width: 1440, height: 900 },
    })
    const page = await context.newPage()

    page.on('console', msg => {
      const location = msg.location()
      const at = location?.url !== undefined && location.url !== ''
        ? ` @ ${location.url}:${location.lineNumber ?? 0}`
        : ''
      consoleLog(`[console.${msg.type()}] ${msg.text()}${at}`)
    })
    page.on('pageerror', error => {
      consoleLog(`[pageerror] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    })
    page.on('requestfailed', request => {
      consoleLog(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`)
    })

    await installBrowserApi(page, { screenshotsDir, log })

    log(`打开 ${webUrl}`)
    await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    // 启动页要么让位于主界面，要么停在 "Failed to load plugins" 横幅
    const failureBanner = page.getByText('Failed to load plugins')
    const ready = (async () => {
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
      await page.waitForTimeout(2000)
    })()
    const failed = failureBanner.first().waitFor({ timeout: 60_000 }).then(() => true).catch(() => false)
    await Promise.race([ready, failed])
    if (await failureBanner.first().isVisible().catch(() => false)) {
      consoleLog('[dsh-plt] PLUGIN_LOAD_FAILURE_BANNER 页面出现 "Failed to load plugins" 横幅')
    }
    await page.screenshot({ path: `${screenshotsDir}/00-boot.png` }).catch(() => {})

    if (userScript.trim() !== '') {
      log('执行用户脚本…')
      const timeoutMs = timeoutSeconds * 1000
      let timeout
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`用户脚本超时（${timeoutSeconds}s）`)), timeoutMs)
      })
      try {
        const result = await Promise.race([
          page.evaluate(async (source) => {
            // click / sendMessage / selectModel / screenshot / waitFor / sleep / currentUrl
            // 已由 exposeFunction 挂到 window，用户脚本直接以全局函数调用。
            const factory = new Function(`"use strict"; return (async () => {\n${source}\n})()`)
            const value = await factory()
            if (value === undefined) return null
            try {
              return JSON.parse(JSON.stringify(value))
            } catch {
              return String(value)
            }
          }, userScript),
          timeoutPromise,
        ])
        if (result !== null) log(`用户脚本返回：${JSON.stringify(result)}`)
      } finally {
        clearTimeout(timeout)
      }
    } else {
      log('未提供 user-script，仅做启动冒烟（已截图 00-boot.png）')
    }

    await page.screenshot({ path: `${screenshotsDir}/99-final.png` }).catch(() => {})
  } finally {
    await browser.close()
  }
}
