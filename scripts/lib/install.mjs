/**
 * install — DSH 隔离安装、profile 准备与进程控制。
 *
 * 与 .test 目录的约定一致：
 *   - 每个版本 `pnpm install --prefix versions/<ver> --store-dir <共享 store>` 独立安装；
 *   - 独立的 DSH_HOME，启动入口为 node <ver>/node_modules/@deepseek-ai/dsh/lib/bin.js；
 *   - pnpm-workspace.yaml 需显式 allowBuilds 白名单（pnpm 11.17 不认 onlyBuiltDependencies）；
 *   - 首启 --profile web 生成 web profile，复制为测试 profile。
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { binOf, killTree, run } from './proc.mjs'

/** pnpm 11.17 需要的构建脚本白名单（见 .test 测试记录六）。 */
const ALLOW_BUILDS = [
  '@deepseek-ai/dsh-subprocess-local',
  '@google/genai',
  'esbuild',
  'koffi',
  'node-pty',
  'protobufjs',
]

function pnpmWorkspaceYaml() {
  const builds = ALLOW_BUILDS.map(name => `  ${name}: true`).join('\n')
  return `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n\nallowBuilds:\n${builds}\n`
}

/** UTF-8 无 BOM 写入（Windows PowerShell 的 Set-Content -Encoding UTF8 会带 BOM，这里用 Node 写天然无 BOM）。 */
async function writeText(path, content) {
  await writeFile(path, content, 'utf8')
}

/**
 * 隔离安装 @deepseek-ai/dsh@<version>，返回 bin.js 路径。
 * @param {{ version: string, rootDir: string, log: (line: string) => void }} options
 */
export async function installDsh({ version, rootDir, log }) {
  const versionDir = join(rootDir, 'versions', version)
  const storeDir = join(rootDir, '.pnpm-store')
  const bin = join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(bin)) {
    log(`dsh@${version} 已安装，复用 ${versionDir}`)
    return bin
  }
  await mkdir(versionDir, { recursive: true })
  await writeText(join(versionDir, 'pnpm-workspace.yaml'), pnpmWorkspaceYaml())
  log(`安装 @deepseek-ai/dsh@${version} → ${versionDir}`)
  await run(binOf('pnpm'), [
    'install', '--prefix', versionDir, '--store-dir', storeDir,
    `@deepseek-ai/dsh@${version}`,
  ], { log })
  if (!existsSync(bin)) {
    throw new Error(`安装完成但未找到 ${bin}，请确认 npm 上存在 @deepseek-ai/dsh@${version}`)
  }
  return bin
}

/**
 * 拉起一个 dsh 进程并等待就绪行，返回进程句柄与 web 地址。
 * @param {{ bin: string, profile: string, homeDir: string, extraEnv?: NodeJS.ProcessEnv,
 *   log: (line: string) => void, readyTimeoutMs?: number }} options
 */
export function spawnDsh({ bin, profile, homeDir, extraEnv = {}, log, readyTimeoutMs = 90_000 }) {
  const args = [bin, '--profile', profile, '--host', '127.0.0.1', '--port', '0', '--no-open']
  log(`$ node ${args.join(' ')}`)
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      DSH_HOME: homeDir,
      NO_UPDATE_NOTIFIER: '1',
      ...extraEnv,
    },
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  let settled = false
  const ready = new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      if (!settled) reject(new Error(`dsh 启动超时（${readyTimeoutMs / 1000}s）未见就绪行`))
    }, readyTimeoutMs)
    const onData = chunk => {
      const text = chunk.toString()
      for (const line of text.split(/\r?\n/u)) {
        if (line !== '') log(line)
      }
      buffer += text
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(buffer)
      if (match?.[1] !== undefined && !settled) {
        settled = true
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', code => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`dsh 进程提前退出（code ${code}），详见 host 日志`))
      }
    })
  })
  return { child, ready, stop: () => killTree(child, log) }
}

/**
 * 准备测试 profile：首启 web profile 生成目录，复制为 <profile> 并改名；
 * 预置 pnpm-workspace.yaml 的 allowBuilds（插件里的 node-pty 等需要构建）。
 * @param {{ bin: string, homeDir: string, profile: string, log: (line: string) => void }} options
 * @returns {Promise<string>} 测试 profile 目录
 */
export async function prepareProfile({ bin, homeDir, profile, log }) {
  const webDir = join(homeDir, 'profiles', 'web')
  const profileDir = join(homeDir, 'profiles', profile)
  if (!existsSync(webDir)) {
    log('首启 --profile web 以生成 profile 目录…')
    const first = spawnDsh({ bin, profile: 'web', homeDir, log, readyTimeoutMs: 120_000 })
    try {
      await first.ready
    } finally {
      await first.stop()
    }
    log('web profile 已生成')
  }
  if (!existsSync(profileDir)) {
    await mkdir(profileDir, { recursive: true })
    await cp(webDir, profileDir, {
      recursive: true,
      filter: source => !source.includes('node_modules'),
    })
    const pkgPath = join(profileDir, 'package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    pkg.name = `dsh-profile-${profile}`
    await writeText(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    log(`测试 profile 已创建：${profileDir}`)
  }
  // 无论新建与否都保证 allowBuilds 在位
  await writeText(join(profileDir, 'pnpm-workspace.yaml'), pnpmWorkspaceYaml())
  return profileDir
}

/**
 * 把若干顶层段落合并进 <DSH_HOME>/settings.yaml。
 * 已有的同名顶层段落整体替换，其余原样保留。
 * @param {string} settingsPath
 * @param {Record<string, unknown>} sections - 顶层键 → 段落对象
 */
export async function mergeSettingsYaml(settingsPath, sections) {
  const existing = existsSync(settingsPath) ? await readFile(settingsPath, 'utf8') : ''
  const keys = Object.keys(sections)
  // 按顶层键切块：顶层行 = 无缩进且以冒号结尾
  const kept = []
  let skipping = false
  for (const line of existing.split(/\r?\n/u)) {
    const topLevel = /^(?<key>[^\s#][^:]*):/u.exec(line)
    if (topLevel?.groups !== undefined) {
      skipping = keys.includes(topLevel.groups.key.trim())
    }
    if (!skipping) kept.push(line)
  }
  const rendered = [toYaml(sections)]
  const body = [...kept.join('\n').trimEnd().split('\n').filter(l => l !== ''), ...rendered]
    .filter(part => part !== undefined && String(part).trim() !== '')
  await writeText(settingsPath, `${body.join('\n').trimEnd()}\n`)
}

/** 极简 YAML 序列化（仅覆盖本 action 生成的对象/数组/标量结构）。 */
function toYaml(value, indent = 0) {
  const pad = '  '.repeat(indent)
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'object' && item !== null) {
        const inner = toYaml(item, indent + 1)
        return `${pad}- ${inner.trimStart()}`
      }
      return `${pad}- ${scalar(item)}`
    }).join('\n')
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value)
      .map(([key, val]) => {
        if (typeof val === 'object' && val !== null) {
          return `${pad}${key}:\n${toYaml(val, indent + 1)}`
        }
        return `${pad}${key}: ${scalar(val)}`
      })
      .join('\n')
  }
  return `${pad}${scalar(value)}`
}

function scalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = String(value)
  if (/[:#\n"']|^\s|\s$|^[-?@`]|\b/u.test(text) || text === '') {
    return JSON.stringify(text)
  }
  return text
}
