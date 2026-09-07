/**
 * browser-api — 注入浏览器页面的用户脚本 API。
 *
 * 所有函数经 page.exposeFunction 暴露为页面全局，用户脚本直接调用：
 *   await click('设置')
 *   await sendMessage('测试')
 *   await selectModel('sim-openai-completions/test-model')
 *   await screenshot('settings')
 *   await waitFor('模拟回复')
 *   await sleep(500)
 *   const url = await currentUrl()
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 在页面上安装全部 API。
 * @param {import('playwright-core').Page} page
 * @param {{ screenshotsDir: string, log?: (line: string) => void }} options
 */
export async function installBrowserApi(page, { screenshotsDir, log = () => {} }) {
  await mkdir(screenshotsDir, { recursive: true })
  let screenshotSeq = 0

  await page.exposeFunction('click', async (target, opts = {}) => {
    if (typeof target !== 'string' || target === '') throw new Error('click(text) 需要非空字符串')
    const timeout = Number(opts.timeout ?? 3000)
    const candidates = [
      () => page.getByRole('button', { name: target, exact: true }),
      () => page.getByRole('link', { name: target, exact: true }),
      () => page.getByRole('menuitem', { name: target, exact: true }),
      () => page.getByRole('tab', { name: target, exact: true }),
      () => page.getByText(target, { exact: true }),
      () => page.getByRole('button', { name: target }),
      () => page.getByText(target),
    ]
    for (const make of candidates) {
      const locator = make().first()
      try {
        await locator.click({ timeout })
        log(`click("${target}") 成功`)
        return true
      } catch {
        // 尝试下一个候选定位方式
      }
    }
    throw new Error(`click("${target}") 失败：页面上没有找到可点击的匹配元素`)
  })

  await page.exposeFunction('sendMessage', async (text) => {
    if (typeof text !== 'string') throw new Error('sendMessage(text) 需要字符串')
    // 优先走 UI 输入框；GUI 停在欢迎页/无可见输入框时回退 session/prompt RPC
    const composer = page.locator(
      'textarea:visible, [contenteditable="true"]:visible, [role="textbox"]:visible').last()
    try {
      await composer.click({ timeout: 3000 })
      await composer.fill(text)
      await composer.press('Enter')
      log(`sendMessage(${JSON.stringify(text)}) 已提交（UI 输入框）`)
      return true
    } catch {
      const result = await page.evaluate(async (promptText) => {
        async function rpc(endpoint, args) {
          const response = await fetch(`/api/${endpoint}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'client-request',
              rpcId: `dsh-plt-${endpoint}`,
              method: endpoint,
              payload: { args },
            }),
          })
          if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}`)
          const body = await response.json()
          if (!body.result?.ok) {
            throw new Error(`${endpoint} 失败：${body.result?.error?.code}: ${body.result?.error?.message}`)
          }
          return body.result.value
        }
        const list = await rpc('session/list', { _request: {} })
        let sessionId = list?.items?.[0]?.id
        if (sessionId === undefined) {
          sessionId = (await rpc('session/create', { request: {} })).sessionId
        }
        await rpc('session/prompt', {
          request: {
            requestId: `dsh-plt-${crypto.randomUUID()}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: promptText }],
          },
        })
        return sessionId
      }, text)
      log(`sendMessage(${JSON.stringify(text)}) 已提交（session/prompt RPC，会话 ${result}）`)
      return true
    }
  })

  await page.exposeFunction('selectModel', async (spec) => {
    if (typeof spec !== 'string' || !spec.includes('/')) {
      throw new Error('selectModel("provider/model") 需要 provider/model 形式')
    }
    const slash = spec.indexOf('/')
    const provider = spec.slice(0, slash)
    const model = spec.slice(slash + 1)
    const result = await page.evaluate(async ({ provider, model }) => {
      async function rpc(endpoint, args) {
        const response = await fetch(`/api/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: `dsh-plt-${endpoint}`,
            method: endpoint,
            payload: { args },
          }),
        })
        if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}`)
        const body = await response.json()
        if (!body.result?.ok) {
          throw new Error(`${endpoint} 失败：${body.result?.error?.code}: ${body.result?.error?.message}`)
        }
        return body.result.value
      }
      const list = await rpc('session/list', { _request: {} })
      let sessionId = list?.items?.[0]?.id
      let created = false
      if (sessionId === undefined) {
        // 全新 home 没有会话：经 RPC 建一个普通会话
        const value = await rpc('session/create', { request: {} })
        sessionId = value.sessionId
        created = true
      }
      const value = await rpc('session/selectModel', { request: { sessionId, provider, model } })
      return { value, created }
    }, { provider, model })
    log(`selectModel("${spec}") → ${JSON.stringify(result?.value ?? result)}`)
    return true
  })

  await page.exposeFunction('screenshot', async (name) => {
    screenshotSeq += 1
    const safe = typeof name === 'string' && name !== ''
      ? name.replace(/[^\w.-]+/gu, '-')
      : 'shot'
    const file = join(screenshotsDir, `${String(screenshotSeq).padStart(2, '0')}-${safe}.png`)
    await page.screenshot({ path: file })
    log(`screenshot → ${file}`)
    return file
  })

  await page.exposeFunction('waitFor', async (text, timeoutMs = 15000) => {
    if (typeof text !== 'string' || text === '') throw new Error('waitFor(text) 需要非空字符串')
    await page.getByText(text).first().waitFor({ timeout: Number(timeoutMs) })
    log(`waitFor("${text}") 命中`)
    return true
  })

  await page.exposeFunction('sleep', (ms) =>
    new Promise(resolve => setTimeout(resolve, Number(ms))))

  await page.exposeFunction('currentUrl', () => page.url())
}

/**
 * Node 侧 RPC：经页面 cookie 调 /api/<endpoint>（在用户脚本开始前使用，
 * 避免在 page.evaluate 期间触发导航销毁执行上下文）。
 * @param {import('playwright-core').Page} page
 * @param {string} webUrl
 */
export async function nodeRpc(page, webUrl, endpoint, args) {
  const origin = new URL(webUrl).origin
  const cookies = await page.context().cookies(origin)
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '),
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `dsh-plt-node-${endpoint}`,
      method: endpoint,
      payload: { args },
    }),
  })
  if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}`)
  const body = await response.json()
  if (!body.result?.ok) {
    throw new Error(`${endpoint} 失败：${body.result?.error?.code}: ${body.result?.error?.message}`)
  }
  return body.result.value
}

/**
 * 确保 GUI 至少有一个会话：没有则创建并刷新页面进入它。
 * @param {import('playwright-core').Page} page
 * @param {string} webUrl
 * @param {(line: string) => void} [log]
 */
export async function ensureSession(page, webUrl, log = () => {}) {
  const list = await nodeRpc(page, webUrl, 'session/list', { _request: {} })
  if (list?.items?.[0]?.id !== undefined) return
  const created = await nodeRpc(page, webUrl, 'session/create', { request: {} })
  log(`新建会话：${created.sessionId}，刷新页面进入`)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(1000)
}
