/**
 * logs — 日志采集与失败模式扫描。
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 创建一个行日志器：追加写入文件并回显到 action 控制台。
 * @param {string} filePath
 * @returns {(line: string) => void}
 */
export function createLogger(filePath) {
  mkdirSync(dirname(filePath), { recursive: true })
  return line => {
    const stamped = `[${new Date().toISOString()}] ${line}`
    try {
      appendFileSync(filePath, `${stamped}\n`, 'utf8')
    } catch {
      // 日志写盘失败不阻断主流程
    }
    console.log(stamped)
  }
}

/** 宿主日志失败模式（插件加载失败 / 版本不兼容 / 进程崩溃信号）。 */
export const HOST_FAILURE_PATTERNS = [
  /Failed to load/iu,
  /UnsupportedDshVersionError/u,
  /plugin tree failed/iu,
  /PLUGIN_LOAD_FAILURE/iu,
]

/** 网页控制台失败模式（DSH web 的插件加载失败信号，见 .test 测试记录五）。 */
export const WEB_FAILURE_PATTERNS = [
  /Failed to load plugins/iu,
  /PLUGIN_LOAD_FAILURE_BANNER/u,
  /failed to apply/iu,
  /keyed slot/iu,
  /Uncaught/u,
]

/**
 * 扫描日志，返回全部失败原因（空数组 = 通过）。
 * @param {{ hostLogPath?: string, webLogPath?: string }} options
 * @returns {string[]}
 */
export function scanLogs({ hostLogPath, webLogPath }) {
  const reasons = []
  const scan = (path, patterns, label) => {
    if (path === undefined) return
    let content
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      return
    }
    const lines = content.split(/\r?\n/u)
    lines.forEach((line, index) => {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          reasons.push(`${label} 第 ${index + 1} 行命中 ${pattern}：${line.slice(0, 300)}`)
          break
        }
      }
    })
  }
  scan(hostLogPath, HOST_FAILURE_PATTERNS, 'host.log')
  scan(webLogPath, WEB_FAILURE_PATTERNS, 'web-console.log')
  return reasons
}
