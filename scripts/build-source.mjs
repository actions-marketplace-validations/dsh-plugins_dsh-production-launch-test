/**
 * build-source — 从 GitHub 源码树构建 DSH 并把 dist/npm 的 tgz 集合复制到输出目录。
 *
 * 用法：node scripts/build-source.mjs <owner/repo@ref> <outDir>
 * 供 all-plugins-all-versions 工作流的 build-source job 使用（每个源码版本构建一次）。
 * 环境变量 GITHUB_TOKEN / GH_TOKEN 用于私有仓库克隆（公开仓库可空）。
 */

import { cp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildDistFromGithub } from './lib/dsh-source.mjs'
import { ensurePnpm } from './lib/proc.mjs'

async function main() {
  const [spec, outDir] = process.argv.slice(2)
  if (spec === undefined || outDir === undefined || !spec.startsWith('github:')) {
    throw new Error('用法：node scripts/build-source.mjs github:<owner>/<repo>@<ref> <outDir>')
  }
  const rootDir = join(tmpdir(), 'dsh-plt-source-build')
  await mkdir(rootDir, { recursive: true })
  const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim()
  await ensurePnpm(line => console.log(line))
  const distDir = await buildDistFromGithub(spec.slice('github:'.length), rootDir, token,
    line => console.log(line))
  await mkdir(outDir, { recursive: true })
  await cp(distDir, resolve(outDir), { recursive: true })
  console.log(`dist/npm 已复制到 ${resolve(outDir)}`)
}

main().catch(error => {
  console.error(`build-source 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
