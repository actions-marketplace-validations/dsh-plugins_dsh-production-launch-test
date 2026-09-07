/**
 * plugins — 插件规格解析与物化。
 *
 * 支持的规格（每行一个，空行与 # 开头的注释忽略）：
 *   artifact:<artifact 名>                        当前 run 的 Actions artifact（目录或 *.tgz）
 *   github:user/repo                              pnpm 原生 git 源，直接透传
 *   github:user/repo#commit=<sha>                 指定提交
 *   github:user/repo@<release-tag>                指定 release tag
 *   github:user/repo#path/<子目录>                 仓库子目录中的插件
 *   github:user/repo#path/<子目录>&commit=<sha>
 *   github:user/repo#path/<子目录>@<release-tag>
 *   github:user/repo#path/<插件>.tgz[&.…|@…]      仓库内的 tgz 产物文件
 *   @npm-scope/plugin[@version] / bare-name[@v]   npm 源，直接透传
 *
 * 物化策略：带 ref/path 的 github 规格统一 git clone + checkout + pnpm pack
 * （或按 raw URL 直接取 .tgz 文件），产出本地 tgz 后交给 dsh plugin add；
 * 不依赖 pnpm 对 github shorthand 的 committish+path 组合语法。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { binOf, run } from './proc.mjs'

/** @typedef {{ kind: 'artifact', name: string, raw: string }} ArtifactSpec */
/** @typedef {{ kind: 'github', owner: string, repo: string, path?: string,
 *   commit?: string, tag?: string, raw: string }} GithubSpec */
/** @typedef {{ kind: 'npm', name: string, raw: string }} NpmSpec */
/** @typedef {ArtifactSpec | GithubSpec | NpmSpec} PluginSpec */

/**
 * 解析 plugins 多行输入为规格数组。
 * @param {string} input
 * @returns {PluginSpec[]}
 */
export function parsePluginsInput(input) {
  const specs = []
  for (const lineRaw of String(input ?? '').split(/\r?\n/u)) {
    const line = lineRaw.trim()
    if (line === '' || line.startsWith('#')) continue
    specs.push(parsePluginSpec(line))
  }
  return specs
}

/**
 * 解析单行插件规格。
 * @param {string} line
 * @returns {PluginSpec}
 */
export function parsePluginSpec(line) {
  if (line.startsWith('artifact:')) {
    const name = line.slice('artifact:'.length).trim()
    if (name === '') throw new Error(`插件规格非法：${line}（artifact: 后缺少名称）`)
    return { kind: 'artifact', name, raw: line }
  }
  if (line.startsWith('github:')) {
    return parseGithubSpec(line)
  }
  // npm 规格：@scope/name[@version] 或 bare[@version]
  if (/^(?:@[\w.-]+\/)?[\w.-]+(?:@[\w.:*~^>= -]+)?$/u.test(line)) {
    return { kind: 'npm', name: line, raw: line }
  }
  throw new Error(`无法识别的插件规格：${line}`)
}

/**
 * github:user/repo 之后的部分：
 *   #commit=<sha> | @<tag> | #<path> | #<path>&commit=<sha> | #<path>@<tag>
 * @param {string} line
 * @returns {GithubSpec}
 */
function parseGithubSpec(line) {
  const rest = line.slice('github:'.length)
  const match = /^(?<repo>[\w.-]+\/[\w.-]+)(?<suffix>.*)$/u.exec(rest)
  if (match?.groups === undefined) {
    throw new Error(`github 插件规格非法：${line}（应为 github:user/repo…）`)
  }
  const [owner, repo] = match.groups.repo.split('/')
  const spec = { kind: 'github', owner, repo, raw: line }
  let suffix = match.groups.suffix
  if (suffix === '') return spec

  if (suffix.startsWith('@')) {
    // github:user/repo@release-tag
    const tag = suffix.slice(1)
    if (tag === '' || tag.includes('#') || tag.includes('&')) {
      throw new Error(`github 插件规格非法：${line}（@ 后应为 release tag）`)
    }
    spec.tag = tag
    return spec
  }
  if (!suffix.startsWith('#')) {
    throw new Error(`github 插件规格非法：${line}`)
  }
  const fragment = suffix.slice(1)
  if (fragment.startsWith('commit=')) {
    spec.commit = fragment.slice('commit='.length)
    if (spec.commit === '') throw new Error(`github 插件规格非法：${line}（commit 为空）`)
    return spec
  }
  // path 形态：<path>[&commit=<sha>][@<tag>]
  const commitMatch = /&commit=(?<commit>[^&@]+)/u.exec(fragment)
  if (commitMatch?.groups !== undefined) spec.commit = commitMatch.groups.commit
  const tagMatch = /@(?<tag>[^&@]+)$/u.exec(fragment.replace(/&commit=[^&@]+/u, ''))
  if (tagMatch?.groups !== undefined) spec.tag = tagMatch.groups.tag
  const path = fragment
    .replace(/&commit=[^&@]+/u, '')
    .replace(/@[^&@]+$/u, '')
  if (path === '') throw new Error(`github 插件规格非法：${line}（# 后缺少 path 或 commit=）`)
  spec.path = path
  return spec
}

/**
 * 物化一个插件规格，产出可传给 `dsh plugin add` 的目标。
 * @param {PluginSpec} spec
 * @param {{ workDir: string, token?: string, log?: (line: string) => void }} options
 * @returns {Promise<{ target: string, display: string, packageName?: string }>}
 */
export async function materializePlugin(spec, options) {
  switch (spec.kind) {
    case 'npm':
      return { target: spec.name, display: spec.name }
    case 'github':
      return materializeGithub(spec, options)
    case 'artifact':
      return materializeArtifact(spec, options)
    default:
      throw new Error(`未知插件规格类型：${JSON.stringify(spec)}`)
  }
}

async function materializeGithub(spec, { workDir, token, log = () => {} }) {
  const { owner, repo, path: subPath, commit, tag } = spec
  const ref = commit ?? (tag !== undefined ? `refs/tags/${tag}` : undefined)
  const displaySuffix = [
    subPath !== undefined ? `#${subPath}` : '',
    commit !== undefined ? ` (commit ${commit})` : '',
    tag !== undefined ? ` (tag ${tag})` : '',
  ].join('')
  const display = `github:${owner}/${repo}${displaySuffix}`

  // 仓库内 tgz 文件：按 raw URL 直接下载
  if (subPath !== undefined && subPath.endsWith('.tgz')) {
    const rawRef = commit ?? tag ?? 'HEAD'
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${rawRef}/${subPath}`
    const dest = join(workDir, `artifact-${shortHash(spec.raw)}.tgz`)
    log(`下载仓库内 tgz：${url}`)
    const response = await fetch(url, {
      headers: token !== undefined && token !== '' ? { authorization: `Bearer ${token}` } : {},
    })
    if (!response.ok) {
      throw new Error(`下载 ${url} 失败：HTTP ${response.status}`)
    }
    await writeFile(dest, Buffer.from(await response.arrayBuffer()))
    return { target: dest, display }
  }

  // 裸 github:user/repo 透传 pnpm
  if (subPath === undefined && ref === undefined) {
    return { target: `github:${owner}/${repo}`, display }
  }

  // 其余统一 clone + checkout + pack
  const cloneDir = join(workDir, `clone-${shortHash(spec.raw)}`)
  const gitArgs = token !== undefined && token !== ''
    ? ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: bearer ${token}`]
    : []
  log(`克隆 ${owner}/${repo}…`)
  await run('git', [...gitArgs, 'init', cloneDir], { log, redact: [token ?? ''] })
  await run('git', [...gitArgs, '-C', cloneDir, 'remote', 'add', 'origin',
    `https://github.com/${owner}/${repo}.git`], { log, redact: [token ?? ''] })
  await run('git', [...gitArgs, '-C', cloneDir, 'fetch', '--depth', '1', 'origin', ref ?? 'HEAD'],
    { log, redact: [token ?? ''] })
  await run('git', [...gitArgs, '-C', cloneDir, 'checkout', 'FETCH_HEAD'],
    { log, redact: [token ?? ''] })

  const packDir = subPath !== undefined ? join(cloneDir, ...subPath.split('/')) : cloneDir
  if (!existsSync(join(packDir, 'package.json'))) {
    throw new Error(`${display}：${packDir} 下没有 package.json，无法打包为插件`)
  }
  return { target: await packDirectory(packDir, workDir, log), display }
}

/** 对含 package.json 的目录执行 pnpm pack（失败回退 npm pack），返回 tgz 路径与包名。 */
async function packDirectory(dir, outDir, log) {
  await mkdir(outDir, { recursive: true })
  let packed = await run(binOf('pnpm'), ['pack', '--pack-destination', outDir],
    { cwd: dir, log, allowFailure: true })
  if (packed.code !== 0) {
    log('pnpm pack 失败，回退 npm pack')
    packed = await run(binOf('npm'), ['pack', '--pack-destination', outDir], { cwd: dir, log })
  }
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  const expectedPrefix = `${String(pkg.name).replace(/^@/u, '').replace('/', '-')}-${pkg.version}`
  const entries = await readdir(outDir)
  const tgz = entries.find(name => name.startsWith(expectedPrefix) && name.endsWith('.tgz'))
    ?? entries.filter(name => name.endsWith('.tgz'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
  if (tgz === undefined) {
    throw new Error(`pack ${dir} 未产出 tgz（输出：${packed.stdout.slice(-500)}）`)
  }
  return resolve(join(outDir, tgz))
}

async function materializeArtifact(spec, { workDir, token, log = () => {} }) {
  // 延迟加载：非 Actions 环境（本地调试）没有 artifact 服务
  const { DefaultArtifactClient } = await import('@actions/artifact')
  const client = new DefaultArtifactClient()
  const dest = join(workDir, `artifact-${shortHash(spec.raw)}`)
  await mkdir(dest, { recursive: true })
  log(`下载 artifact：${spec.name}`)
  const { artifact } = await client.getArtifact(spec.name)
  await client.downloadArtifact(artifact.id, { path: dest, ...(token ? { token } : {}) })

  const entries = await readdir(dest, { recursive: true })
  const tgz = entries.map(String).find(name => name.endsWith('.tgz'))
  if (tgz !== undefined) {
    return { target: resolve(join(dest, tgz)), display: `artifact:${spec.name}` }
  }
  // 目录形态：找含 package.json 的目录并打包
  for (const entry of entries.map(String)) {
    const candidate = join(dest, entry, 'package.json')
    if (existsSync(candidate)) {
      return { target: await packDirectory(join(dest, entry), dest, log), display: `artifact:${spec.name}` }
    }
  }
  if (existsSync(join(dest, 'package.json'))) {
    return { target: await packDirectory(dest, dest, log), display: `artifact:${spec.name}` }
  }
  throw new Error(`artifact:${spec.name} 中既没有 *.tgz 也没有含 package.json 的目录`)
}

function shortHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/**
 * 读取 profile 的 bundles 列表（package.json 的 dsh.profile.bundles）。
 * @param {string} profileDir
 * @returns {Promise<string[]>}
 */
export async function readBundles(profileDir) {
  const pkg = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  return pkg.dsh?.profile?.bundles ?? []
}
