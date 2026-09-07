/**
 * env — 输入解析、桌面环境检测与工具链预检。
 */

import { run } from './proc.mjs'

/**
 * Linux 上确保中文字体可用（zh 系 lang 时）：缺失则尝试安装 fonts-noto-cjk，
 * 失败仅告警（截图可能出现豆腐块，不阻断流程）。
 * @param {string} lang
 * @param {(line: string) => void} log
 */
export async function ensureCjkFonts(lang, log) {
  if (process.platform !== 'linux' || !/^zh/iu.test(String(lang ?? ''))) return
  const probe = await run('fc-list', [':lang=zh', 'family'], { log, allowFailure: true })
  if (probe.code === 0 && probe.stdout.trim() !== '') {
    log(`中文字体已就绪：${probe.stdout.trim().split('\n')[0]} 等`)
    return
  }
  log('未检测到中文字体（fc-list :lang=zh 为空），安装 fonts-noto-cjk…')
  const update = await run('sudo', ['apt-get', 'update'], { log, allowFailure: true })
  if (update.code === 0) {
    const install = await run('sudo', ['apt-get', 'install', '-y', 'fonts-noto-cjk'],
      { log, allowFailure: true })
    if (install.code === 0) {
      log('fonts-noto-cjk 安装完成')
      return
    }
  }
  log('警告：中文字体安装失败（无 sudo/apt 或网络问题），中文界面截图可能出现豆腐块 □')
}

/**
 * 判断当前 runner 是否带桌面环境。
 * - win32 / darwin：桌面操作系统，直接通过；
 * - linux：要求 DISPLAY 或 WAYLAND_DISPLAY 已设置（调用方可先用 Xvfb 提供显示服务）；
 * - 其余平台：一律拒绝。
 * @param {string} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function detectDesktop(platform = process.platform, env = process.env) {
  if (platform === 'win32' || platform === 'darwin') return { ok: true }
  if (platform === 'linux') {
    const display = env.DISPLAY ?? ''
    const wayland = env.WAYLAND_DISPLAY ?? ''
    if (display !== '' || wayland !== '') {
      return { ok: true }
    }
    return {
      ok: false,
      reason: '当前 linux runner 没有桌面环境（DISPLAY/WAYLAND_DISPLAY 均未设置）。'
        + '请先启动 Xvfb 等显示服务（例如 sudo Xvfb :99 & 并 export DISPLAY=:99），'
        + '或改用带桌面环境的 windows / macos runner。',
    }
  }
  return { ok: false, reason: `不支持的平台：${platform}（仅支持 windows / macos / ubuntu 桌面环境）` }
}

/**
 * 把 lang 输入映射为 DSH locale.preference 与 Chrome locale。
 * DSH 内置语言只有 zh / en；其余语言只影响 Chrome（navigator.languages）。
 * @param {string} lang
 * @returns {{ dshLocale?: 'zh' | 'en', chromeLocale: string }}
 */
export function mapLocale(lang) {
  const chromeLocale = String(lang ?? '').trim() || 'zh-CN'
  if (/^zh(?:-|$)/iu.test(chromeLocale)) return { dshLocale: 'zh', chromeLocale }
  if (/^en(?:-|$)/iu.test(chromeLocale)) return { dshLocale: 'en', chromeLocale }
  return { chromeLocale }
}

/** DSH engines：^22.19.0 || >=24.0.0 */
export function nodeVersionOk(version = process.version) {
  const match = /^v(?<major>\d+)\.(?<minor>\d+)/u.exec(version)
  if (match?.groups === undefined) return false
  const major = Number(match.groups.major)
  const minor = Number(match.groups.minor)
  return major >= 24 || (major === 22 && minor >= 19)
}

/**
 * 读取并校验 action 输入（经环境变量透传）。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function readInputs(env = process.env) {
  const dshVersion = (env.INPUT_DSH_VERSION ?? '').trim()
  if (dshVersion === '') {
    throw new Error('缺少必填输入 dsh-version（例如 0.1.3-alpha.1）')
  }
  const timeoutSeconds = Number(env.INPUT_TIMEOUT_SECONDS ?? '600')
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`timeout-seconds 非法：${env.INPUT_TIMEOUT_SECONDS}`)
  }
  return {
    dshVersion,
    lang: (env.INPUT_LANG ?? 'zh-CN').trim() || 'zh-CN',
    simulatedLlm: env.INPUT_SIMULATED_LLM ?? 'false',
    pluginsRaw: env.INPUT_PLUGINS ?? '',
    userScript: env.INPUT_USER_SCRIPT ?? '',
    githubToken: (env.INPUT_GITHUB_TOKEN ?? '').trim(),
    nodeVersion: (env.INPUT_NODE_VERSION ?? '24').trim(),
    profile: (env.INPUT_PROFILE ?? 'test').trim() || 'test',
    timeoutSeconds,
  }
}
