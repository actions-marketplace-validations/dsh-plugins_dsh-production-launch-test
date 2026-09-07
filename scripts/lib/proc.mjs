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
  const displayArgs = args.map(arg => redact.reduce((acc, secret) =>
    secret === '' ? acc : acc.split(secret).join('***'), arg))
  log(`$ ${command} ${displayArgs.join(' ')}`)
  return new Promise((resolve, reject) => {
    // Windows 上 .cmd/.bat 入口必须经 shell 解析（Node >=20 直接 spawn 会 EINVAL）
    const needsShell = process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command)
    const child = needsShell
      ? spawn([command, ...args.map(arg => (arg.includes(' ') ? `"${arg}"` : arg))].join(' '), {
          cwd,
          env: env ?? process.env,
          shell: true,
          windowsHide: true,
        })
      : spawn(command, args, {
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

/**
 * 终止整个进程树（dsh 会派生子进程）。
 * Windows 用 taskkill /T；POSIX 上要求 spawn 时 detached:true，按进程组发信号。
 * @param {import('node:child_process').ChildProcess} child
 * @param {(line: string) => void} [log]
 */
export async function killTree(child, log = () => {}) {
  if (child.exitCode !== null || child.killed) return
  try {
    if (process.platform === 'win32') {
      await run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { log, allowFailure: true })
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch { /* 已退出 */ }
          resolve()
        }, 5000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  } catch (error) {
    log(`killTree 告警：${error instanceof Error ? error.message : String(error)}`)
  }
}
