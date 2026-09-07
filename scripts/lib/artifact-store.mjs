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
import { mkdir, rm } from 'node:fs/promises'
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
  await extractZip(zipPath, destDir, log)
  await rm(zipPath, { force: true })
  return destDir
}

async function extractZip(zipPath, destDir, log) {
  if (process.platform === 'linux') {
    const result = await run('unzip', ['-o', '-q', zipPath, '-d', destDir], { log, allowFailure: true })
    if (result.code === 0) return
    log('unzip 不可用，回退 tar')
  }
  // Windows bsdtar 把 D:\... 误判为 rmt 远程主机语法，必须 --force-local
  const forceLocal = process.platform === 'win32' ? ['--force-local'] : []
  await run('tar', [...forceLocal, '-xf', zipPath, '-C', destDir], { log })
}
