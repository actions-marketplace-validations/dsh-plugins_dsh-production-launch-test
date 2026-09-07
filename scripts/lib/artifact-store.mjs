/**
 * artifact-store — 经 GitHub REST API 下载当前仓库的 artifact。
 *
 * composite action 的 run 步骤拿不到 ACTIONS_RUNTIME_TOKEN（那是 JS action 专属），
 * 因此不能用 @actions/artifact；改用 REST + GITHUB_TOKEN（需要 actions: read 权限）：
 *   GET /repos/{owner}/{repo}/actions/artifacts?name=<name>
 *   GET <archive_download_url>（Bearer 鉴权，自动跟随 302 到签名 URL）
 * zip 解压：win/macOS 用系统 bsdtar，linux 用 unzip（GNU tar 不支持 zip）。
 */

import { createWriteStream } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { run } from './proc.mjs'

/**
 * 按名字下载 artifact 并解压到 destDir，返回 destDir。
 * 优先匹配当前 run（GITHUB_RUN_ID）的 artifact，其次取最新未过期同名 artifact。
 * @param {{ name: string, destDir: string, token: string, log: (line: string) => void }} options
 */
export async function downloadArtifactByName({ name, destDir, token, log }) {
  const repo = process.env.GITHUB_REPOSITORY
  if (repo === undefined || repo === '') {
    throw new Error(`artifact:${name} 需要 GitHub Actions 环境（GITHUB_REPOSITORY 未设置）`)
  }
  if (token === '') {
    throw new Error(`artifact:${name} 需要 github-token（actions: read 权限）`)
  }
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  }
  const listUrl = `https://api.github.com/repos/${repo}/actions/artifacts?per_page=100&name=${encodeURIComponent(name)}`
  const listRes = await fetch(listUrl, { headers })
  if (!listRes.ok) throw new Error(`查询 artifact ${name} 失败：HTTP ${listRes.status}`)
  const { artifacts = [] } = await listRes.json()
  const candidates = artifacts.filter(a => a.name === name && !a.expired)
  if (candidates.length === 0) {
    throw new Error(`仓库 ${repo} 中找不到未过期的 artifact：${name}`)
  }
  const runId = process.env.GITHUB_RUN_ID
  const artifact = candidates.find(a => String(a.workflow_run?.id) === runId) ?? candidates[0]
  log(`下载 artifact：${name}（id=${artifact.id}，run=${artifact.workflow_run?.id ?? '?'}）`)

  const dlRes = await fetch(artifact.archive_download_url, { headers, redirect: 'follow' })
  if (!dlRes.ok || dlRes.body === null) {
    throw new Error(`下载 artifact ${name} 失败：HTTP ${dlRes.status}`)
  }
  await mkdir(destDir, { recursive: true })
  const zipPath = join(destDir, '__artifact.zip')
  await pipeline(dlRes.body, createWriteStream(zipPath))
  await assertZipMagic(zipPath, dlRes)
  await extractZip(zipPath, destDir, log)
  await rm(zipPath, { force: true })
  return destDir
}

/** 校验下载内容确实是 zip（PK\x03\x04），否则带响应信息报错便于诊断。 */
async function assertZipMagic(zipPath, response) {
  const handle = await open(zipPath, 'r')
  try {
    const buf = Buffer.alloc(4)
    await handle.read(buf, 0, 4, 0)
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new Error(`artifact 下载内容不是 zip（前 4 字节 ${buf.toString('hex')}；`
        + `HTTP ${response.status}，content-type=${response.headers.get('content-type')}，`
        + `content-encoding=${response.headers.get('content-encoding')}，url=${response.url}）`)
    }
  } finally {
    await handle.close()
  }
}

async function extractZip(zipPath, destDir, log) {
  if (process.platform === 'linux') {
    const result = await run('unzip', ['-o', '-q', zipPath, '-d', destDir], { log, allowFailure: true })
    if (result.code === 0) return
    log('unzip 不可用，回退 tar')
  }
  if (process.platform === 'win32') {
    // 规避 bsdtar 版本差异（D:\ 误判 rmt 语法、--force-local 支持不一）
    await run('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`], { log })
    return
  }
  // macOS / linux 回退：bsdtar 直接读 zip；以 destDir 为 cwd 规避路径解析差异
  await run('tar', ['-xf', '__artifact.zip'], { cwd: destDir, log })
}
