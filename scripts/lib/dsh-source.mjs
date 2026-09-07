/**
 * dsh-source — npm 上不存在的 dsh 版本自动走源码构建安装。
 *
 * 流程：
 *   clone deepseek-ai/deepseek-harness@dsh-v<version>
 *   → pnpm install + build:official + release:pack --family dsh
 *   → dist/npm/deepseek-ai-*.tgz 全部以 file: 依赖 + overrides 钉进版本目录
 *   → pnpm install 出 node_modules/@deepseek-ai/dsh/lib/bin.js
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { binOf, run } from './proc.mjs'

/** DSH 官方仓库与 release tag 前缀。 */
export const DSH_REPO = 'deepseek-ai/deepseek-harness'
export const DSH_TAG_PREFIX = 'dsh-v'

/** dist tgz 文件名 → 包名（deepseek-ai-dsh-web-0.1.2-alpha.1.tgz → @deepseek-ai/dsh-web）。 */
export function tgzToPackageName(filename) {
  const match = /^deepseek-ai-(?<name>.+)-(?<version>\d+\.\d+\.\d+-?[\w.]*)?\.tgz$/u.exec(filename)
  if (match?.groups === undefined || match.groups.version === undefined) return null
  return `@deepseek-ai/${match.groups.name}`
}

/**
 * 从源码构建并安装 DSH，返回 bin.js 路径。
 * @param {{ version: string, rootDir: string, token?: string,
 *   log: (line: string) => void }} options
 */
export async function installDshFromSource({ version, rootDir, token = '', log }) {
  const versionDir = join(rootDir, 'versions', `src-${version}`)
  const bin = join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(bin)) {
    log(`dsh@${version}（源码构建）已安装，复用 ${versionDir}`)
    return bin
  }
  const distDir = await buildDistFromGithub(`${DSH_REPO}@${DSH_TAG_PREFIX}${version}`, rootDir, token, log)

  const tgzs = (await readdir(distDir)).filter(name => name.endsWith('.tgz'))
  if (tgzs.length === 0) throw new Error(`${distDir} 下没有 *.tgz 产物`)
  const deps = {}
  for (const tgz of tgzs) {
    const name = tgzToPackageName(tgz)
    if (name === null) {
      log(`跳过无法解析包名的产物：${tgz}`)
      continue
    }
    deps[name] = `file:${join(distDir, tgz).split(sep).join('/')}`
  }
  if (deps['@deepseek-ai/dsh'] === undefined) {
    throw new Error(`产物集合中缺少主包 deepseek-ai-dsh-*.tgz（共 ${tgzs.length} 个 tgz）`)
  }
  log(`源码产物共 ${Object.keys(deps).length} 个包，开始 file: 安装`)

  await mkdir(versionDir, { recursive: true })
  await writeFile(join(versionDir, 'package.json'),
    `${JSON.stringify({ private: true, name: `dsh-version-${version}`, dependencies: deps }, null, 2)}\n`, 'utf8')
  await writeFile(join(versionDir, 'pnpm-workspace.yaml'), pnpmWorkspaceYamlSource(deps, versionDir), 'utf8')

  const storeDir = join(rootDir, '.pnpm-store')
  await run(binOf('pnpm'), ['install', '--prefix', versionDir, '--store-dir', storeDir], { log })
  if (!existsSync(bin)) {
    throw new Error(`源码产物安装完成但未找到 ${bin}`)
  }
  return bin
}

/**
 * 克隆源码树并构建打包：clone → pnpm install → build:official → release:pack --family dsh。
 * @param {string} spec - <owner>/<repo>@<ref>
 * @param {string} rootDir
 * @param {string} token
 * @param {(line: string) => void} log
 * @returns {Promise<string>} dist/npm 目录
 */
export async function buildDistFromGithub(spec, rootDir, token, log) {
  const match = /^(?<repo>[\w.-]+\/[\w.-]+)@(?<ref>[^@\s]+)$/u.exec(spec)
  if (match?.groups === undefined) {
    throw new Error(`源码构建规格应为 <owner>/<repo>@<ref>：${spec}`)
  }
  const { repo, ref } = match.groups
  const srcDir = join(rootDir, 'source', `${repo.replace('/', '-')}-${ref}`)
  const distDir = join(srcDir, 'dist', 'npm')
  if (existsSync(distDir) && (await readdir(distDir)).some(n => n.endsWith('.tgz'))) {
    log(`源码构建产物已存在，复用 ${distDir}`)
    return distDir
  }
  if (!existsSync(srcDir)) {
    const auth = token !== '' ? `x-access-token:${token}@` : ''
    log(`克隆 https://github.com/${repo} @ ${ref}…`)
    const lsRemote = await run('git', ['ls-remote', '--tags',
      `https://${auth}github.com/${repo}.git`, `refs/tags/${ref}`],
      { log, redact: [token], allowFailure: true })
    if (lsRemote.code !== 0 || !lsRemote.stdout.includes(ref)) {
      throw new Error(`npm 与 GitHub（${repo} tag ${ref}）都不存在 dsh@${ref.replace(DSH_TAG_PREFIX, '')}，`
        + '请确认 dsh-version 正确')
    }
    let lastError
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await run('git', ['clone', '--depth', '1', '--branch', ref,
          `https://${auth}github.com/${repo}.git`, srcDir], { log, redact: [token] })
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        await rm(srcDir, { recursive: true, force: true }) // 半截 clone 不污染续跑
        log(`clone 第 ${attempt} 次失败，${attempt < 3 ? '重试…' : '放弃'}`)
      }
    }
    if (lastError !== undefined) throw lastError
  }
  if (process.platform === 'win32') patchWindowsSourceBuild(srcDir, log)
  const env = { ...process.env, CI: '1' }
  log('源码树 pnpm install…')
  await run(binOf('pnpm'), ['install'], { cwd: srcDir, env, log })
  log('源码树 pnpm build:official（release:pack 校验 client 构建画像，完整构建需数分钟）…')
  const built = await run(binOf('pnpm'), ['build:official'], { cwd: srcDir, env, log, allowFailure: true })
  if (built.code !== 0) {
    log('build:official 不可用，回退 pnpm build（release:pack 的画像校验可能不通过）…')
    await run(binOf('pnpm'), ['build'], { cwd: srcDir, env, log })
  }
  log('release:pack（dsh 家族）…')
  await run(binOf('pnpm'), ['release:pack', '--family', 'dsh'], { cwd: srcDir, env, log })
  if (!existsSync(distDir)) {
    throw new Error(`release:pack 后未找到 ${distDir}`)
  }
  return resolve(distDir)
}

/**
 * Windows 下 release:pack 的两处上游 bug，最小补丁（仅影响构建期脚本）：
 * 1. process.ts runConcurrent 以 spawn('pnpm', …, {shell:false}) 启动子进程——
 *    CreateProcess 无法直接执行 pnpm.cmd → 给 spawn 选项加 shell: true。
 * 2. tarball.ts 以绝对路径（D:\…）调用系统 bsdtar，runner 版 bsdtar 把盘符
 *    误判为 rmt 远程主机语法（--force-local 版本支持不一，本机 3.8.4 反而不支持）→
 *    改为以包所在目录为 cwd、传 basename。
 */
function patchWindowsSourceBuild(srcDir, log) {
  const patched = []

  const processFile = join(srcDir, 'scripts', 'release', 'process.ts')
  const processSource = readFileSync(processFile, 'utf8')
  const spawnNeedle = "{ cwd: options.cwd, env: options.env, stdio: 'inherit' }"
  const spawnPatched = `${spawnNeedle.slice(0, -1)}, shell: true }`
  if (processSource.includes(spawnPatched)) {
    // 已打过
  } else if (processSource.includes(spawnNeedle)) {
    writeFileSync(processFile, processSource.replace(spawnNeedle, spawnPatched), 'utf8')
    patched.push('process.ts spawn shell:true')
  } else {
    throw new Error(`无法在 ${processFile} 中定位 runConcurrent spawn 选项（上游已变更？）`)
  }

  const tarballFile = join(srcDir, 'scripts', 'release', 'tarball.ts')
  let tarballSource = readFileSync(tarballFile, 'utf8')
  if (tarballSource.includes('cwd: dirname(tarball)')) {
    // 已打过
  } else if (
    tarballSource.includes("capture('tar', ['-tzf', tarball])")
    && tarballSource.includes("capture('tar', ['-xOzf', tarball, 'package/package.json'])")
    && tarballSource.includes("from 'node:path'")
  ) {
    tarballSource = tarballSource
      .replace("import { join } from 'node:path'", "import { basename, dirname, join } from 'node:path'")
      .replace("capture('tar', ['-tzf', tarball])",
        "capture('tar', ['-tzf', basename(tarball)], { cwd: dirname(tarball) })")
      .replace("capture('tar', ['-xOzf', tarball, 'package/package.json'])",
        "capture('tar', ['-xOzf', basename(tarball), 'package/package.json'], { cwd: dirname(tarball) })")
    writeFileSync(tarballFile, tarballSource, 'utf8')
    patched.push('tarball.ts tar 相对路径')
  } else {
    throw new Error(`无法在 ${tarballFile} 中定位 tar 调用（上游已变更？）`)
  }

  if (patched.length > 0) log(`已打 Windows 补丁：${patched.join('；')}`)
}

/**
 * 源码产物安装目录的 pnpm-workspace.yaml。
 * overrides 把全部 @deepseek-ai/* 传递依赖也钉到本地 tgz（关键：否则
 * dsh-sdk-client 等包的内部依赖会去 registry 找 npm 上不存在的版本）；
 * allowBuilds 白名单同时给纯包名与 file: 限定符两种键。
 */
function pnpmWorkspaceYamlSource(deps, versionDir) {
  const overrideLines = Object.entries(deps)
    .map(([name, spec]) => `  "${name}": "${spec}"`)
    .join('\n')
  const builds = ['@google/genai', 'esbuild', 'koffi', 'node-pty', 'protobufjs']
    .map(name => `  "${name}": true`)
  const subprocess = deps['@deepseek-ai/dsh-subprocess-local']
  if (subprocess !== undefined) {
    builds.push(`  "@deepseek-ai/dsh-subprocess-local": true`)
    // pnpm 把 file: 键归一化为相对 versionDir 的路径，allowBuilds 必须用同形键
    const rel = relative(versionDir, subprocess.slice('file:'.length)).split(sep).join('/')
    builds.push(`  "@deepseek-ai/dsh-subprocess-local@file:${rel}": true`)
  }
  return `packages:\n  - .\n\noverrides:\n${overrideLines}\n\nallowBuilds:\n${builds.join('\n')}\n`
}
