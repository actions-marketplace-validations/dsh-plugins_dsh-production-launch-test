/**
 * dsh-source — 从源码构建产物安装 DSH（覆盖只在 GitHub Releases 存在、
 * npm 上没有的版本，如 0.1.2-alpha.1 / 0.1.3-alpha.1）。
 *
 * 与 .test 对 0.1.2-alpha.1 的做法一致：
 *   源码树 pnpm install + build + release:pack → dist/npm/deepseek-ai-*.tgz，
 *   再把全部 tgz 以 file: 依赖写进版本目录的 package.json，pnpm install 出
 *   node_modules/@deepseek-ai/dsh/lib/bin.js。
 *
 * dsh-source 输入形态：
 *   artifact:<name>                当前 run 中含 dist/npm tgz 集合的 artifact
 *   github:<owner>/<repo>@<ref>    现场克隆源码树并构建打包（慢，供本地/临时使用）
 *   dir:<path>                     直接指向含 tgz 集合的本地目录（本地调试）
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { downloadArtifactByName } from './artifact-store.mjs'
import { binOf, run } from './proc.mjs'

/** dist tgz 文件名 → 包名（deepseek-ai-dsh-web-0.1.2-alpha.1.tgz → @deepseek-ai/dsh-web）。 */
export function tgzToPackageName(filename) {
  const match = /^deepseek-ai-(?<name>.+)-(?<version>\d+\.\d+\.\d+-?[\w.]*)?\.tgz$/u.exec(filename)
  if (match?.groups === undefined || match.groups.version === undefined) return null
  return `@deepseek-ai/${match.groups.name}`
}

/**
 * 从源码产物安装 DSH，返回 bin.js 路径。
 * @param {{ source: string, version: string, rootDir: string, token?: string,
 *   log: (line: string) => void }} options
 */
export async function installDshFromSource({ source, version, rootDir, token = '', log }) {
  const versionDir = join(rootDir, 'versions', `src-${version}`)
  const bin = join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(bin)) {
    log(`dsh@${version}（源码构建）已安装，复用 ${versionDir}`)
    return bin
  }

  let distDir
  if (source.startsWith('artifact:')) {
    distDir = await downloadDistArtifact(source.slice('artifact:'.length), rootDir, token, log)
  } else if (source.startsWith('github:')) {
    distDir = await buildDistFromGithub(source.slice('github:'.length), rootDir, token, log)
  } else if (source.startsWith('dir:')) {
    distDir = resolve(source.slice('dir:'.length))
    log(`使用本地产物目录：${distDir}`)
  } else {
    throw new Error(`dsh-source 非法：${source}（支持 artifact:<name>、github:<owner>/<repo>@<ref>、dir:<path>）`)
  }

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

/** 下载含 dist/npm tgz 集合的 artifact，返回 tgz 所在目录。 */
async function downloadDistArtifact(name, rootDir, token, log) {
  const dest = join(rootDir, 'materialized', `dsh-src-${name}`)
  await mkdir(dest, { recursive: true })
  await downloadArtifactByName({ name, destDir: dest, token, log })
  // 产物可能直接是 tgz 平铺，也可能嵌一层目录
  const tgzDir = await findTgzDir(dest)
  if (tgzDir === null) throw new Error(`artifact ${name} 内容中找不到 *.tgz：${dest}`)
  return tgzDir
}

async function findTgzDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  if (entries.some(e => e.isFile() && e.name.endsWith('.tgz'))) return dir
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nested = await findTgzDir(join(dir, entry.name))
      if (nested !== null) return nested
    }
  }
  return null
}

/**
 * 现场克隆源码树并构建打包。
 * 流程：clone → corepack pnpm install → pnpm build → pnpm release:pack → dist/npm。
 * @returns {Promise<string>} dist/npm 目录
 */
export async function buildDistFromGithub(spec, rootDir, token, log) {
  const match = /^(?<repo>[\w.-]+\/[\w.-]+)@(?<ref>[^@\s]+)$/u.exec(spec)
  if (match?.groups === undefined) {
    throw new Error(`dsh-source 的 github 形态应为 github:<owner>/<repo>@<ref>：${spec}`)
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
    await run('git', ['clone', '--depth', '1', '--branch', ref,
      `https://${auth}github.com/${repo}.git`, srcDir], { log, redact: [token] })
  }
  const env = { ...process.env, CI: '1' }
  log('源码树 pnpm install…')
  await run(binOf('pnpm'), ['install'], { cwd: srcDir, env, log })
  log('源码树 pnpm build（完整 monorepo 构建，可能需要数分钟）…')
  await run(binOf('pnpm'), ['build'], { cwd: srcDir, env, log })
  log('release:pack（dsh 家族）…')
  await run(binOf('pnpm'), ['release:pack', '--family', 'dsh'], { cwd: srcDir, env, log })
  if (!existsSync(distDir)) {
    throw new Error(`release:pack 后未找到 ${distDir}`)
  }
  return resolve(distDir)
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
