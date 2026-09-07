/**
 * resolve-matrix — 动态解析全量版本矩阵（workflow_dispatch 每次触发都重新拉取）。
 *
 * 输出（写 GITHUB_OUTPUT）：
 *   matrix        JSON：{ os: [...], dsh: [<version>...] }
 *   plugins       多行插件规格（latest 与 next 取较新者）
 *
 * npm 上缺失的版本（GitHub Releases 独占）无需特判：action 会自动源码构建。
 *
 * 用法：node scripts/resolve-matrix.mjs
 * 环境变量：GITHUB_TOKEN / GH_TOKEN（GitHub Releases API 鉴权，可选但建议）
 */

import { appendFile } from 'node:fs/promises'
import {
  DSH_REPO,
  DSH_TAG_PREFIX,
  SWEEP_PLUGINS,
  buildMatrix,
  mergeDshVersions,
  pickPluginVersion,
} from './lib/resolve.mjs'

const MIN_DSH_VERSION = '0.1.0-rc.6'

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers: { accept: 'application/json', ...headers } })
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`)
  return await response.json()
}

async function fetchAllReleases(token) {
  const tags = []
  const headers = token !== '' ? { authorization: `Bearer ${token}` } : {}
  for (let page = 1; page <= 10; page += 1) {
    const releases = await fetchJson(
      `https://api.github.com/repos/${DSH_REPO}/releases?per_page=100&page=${page}`, headers)
    for (const release of releases) tags.push(release.tag_name)
    if (releases.length < 100) break
  }
  return tags
}

async function main() {
  const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim()

  const npmDoc = await fetchJson('https://registry.npmjs.org/@deepseek-ai/dsh',
    { accept: 'application/vnd.npm.install-v1+json' })
  const npmVersions = Object.keys(npmDoc.versions ?? {})
  const releaseTags = await fetchAllReleases(token)
  const dshVersions = mergeDshVersions(npmVersions, releaseTags, MIN_DSH_VERSION)
  console.log(`dsh 版本（≥${MIN_DSH_VERSION}，含 GitHub 独占）：${dshVersions.join(', ')}`)

  const pluginSpecs = []
  for (const name of SWEEP_PLUGINS) {
    const doc = await fetchJson(`https://registry.npmjs.org/@dsh-plugin/${name}`,
      { accept: 'application/vnd.npm.install-v1+json' })
    const version = pickPluginVersion(doc['dist-tags'] ?? {})
    pluginSpecs.push(`@dsh-plugin/${name}@${version}`)
    console.log(`插件 ${name}：latest=${doc['dist-tags']?.latest} next=${doc['dist-tags']?.next} → ${version}`)
  }

  const outputs = {
    matrix: JSON.stringify(buildMatrix(dshVersions)),
    plugins: pluginSpecs.join('\n'),
  }
  const outFile = process.env.GITHUB_OUTPUT
  if (outFile !== undefined && outFile !== '') {
    const lines = []
    for (const [key, value] of Object.entries(outputs)) {
      if (value.includes('\n')) {
        lines.push(`${key}<<dsh-plt-eof`, value, 'dsh-plt-eof')
      } else {
        lines.push(`${key}=${value}`)
      }
    }
    await appendFile(outFile, `${lines.join('\n')}\n`, 'utf8')
  } else {
    console.log(JSON.stringify(outputs, null, 2))
  }
}

main().catch(error => {
  console.error(`resolve-matrix 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
