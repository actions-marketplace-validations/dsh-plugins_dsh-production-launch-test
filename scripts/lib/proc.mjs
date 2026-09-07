/**
 * proc — 共享子进程执行助手。
 * 统一处理：输出落日志、token 脱敏、非零退出码报错。
 */

import { spawn } from 'node:child_process'

/**
 * 执行命令并收集输出。
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, log?: (line: string) => void,
 *   redact?: string[], allowFailure?: boolean }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function run(command, args, options = {}) {
  const { cwd, env, log = () => {}, redact = [], allowFailure = false } = options
  const displayArgs = args.map(arg => redact.reduce((text, secret) =>
    secret === '' ? text : text.split(secret).join('***'), text))
  log(`$ ${command} ${displayArgs.join(' ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      shell: false,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      const text = chunk.toString()
      stdout += text
      for (const line of text.split(/\r?\n/u)) {
        if (line !== '') log(`  ${redact.reduce((t, s) => (s === '' ? t : t.split(s).join('***')), line)}`)
      }
    })
    child.stderr.on('data', chunk => {
      const text = chunk.toString()
      stderr += text
      for (const line of text.split(/\r?\n/u)) {
        if (line !== '') log(`  ${redact.reduce((t, s) => (s === '' ? t : t.split(s).join('***')), line)}`)
      }
    })
    child.once('error', reject)
    child.once('close', code => {
      const result = { code: code ?? 1, stdout, stderr }
      if (result.code !== 0 && !allowFailure) {
        reject(new Error(`命令失败（exit=${result.code}）：${command} ${displayArgs.join(' ')}`))
      } else {
        resolve(result)
      }
    })
  })
}

/** Windows 上 node/npm/pnpm 的 .cmd 入口需要走 cmd 解析。 */
export function binOf(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}
