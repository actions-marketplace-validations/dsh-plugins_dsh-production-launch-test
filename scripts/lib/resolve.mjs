/**
 * resolve — 全量版本矩阵解析的纯逻辑（网络部分在 scripts/resolve-matrix.mjs）。
 */

import { compareSemver, parseSemver, sortSemver } from './semver.mjs'

/** DSH 官方仓库与 release tag 前缀。 */
export const DSH_REPO = 'deepseek-ai/deepseek-harness'
export const DSH_TAG_PREFIX = 'dsh-v'

/** 参与全量测试的插件清单（dsh-plugins 工作区）。 */
export const SWEEP_PLUGINS = [
  'dsh-thought-buddy',
  'dsh-approve-for-me',
  'dsh-auxiliary',
  'dsh-better-sidebar-loader',
  'dsh-code-review',
  'dsh-loader',
  'dsh-network-settings',
]

/**
 * 合并 npm 版本与 GitHub Releases 版本，过滤 ≥ minVersion 并升序。
 * npm 上存在的版本 source 为空串（走 dsh-version 安装）；
 * 仅 GitHub 存在的版本 source 为 artifact 名（由 build-source job 先行构建上传）。
 * @param {string[]} npmVersions
 * @param {string[]} releaseTags - 形如 dsh-v0.1.3-alpha.1
 * @param {string} minVersion
 * @returns {{ version: string, source: string }[]}
 */
export function mergeDshVersions(npmVersions, releaseTags, minVersion) {
  const npmSet = new Set(npmVersions.filter(v => parseSemver(v) !== null))
  const all = new Set(npmSet)
  for (const tag of releaseTags) {
    if (!tag.startsWith(DSH_TAG_PREFIX)) continue
    const version = tag.slice(DSH_TAG_PREFIX.length)
    if (parseSemver(version) !== null) all.add(version)
  }
  const sorted = sortSemver([...all].filter(v => compareSemver(v, minVersion) >= 0))
  return sorted.map(version => ({
    version,
    source: npmSet.has(version) ? '' : `artifact:dsh-src-${version}`,
  }))
}

/**
 * 在 latest 与 next 之间取较新的版本（semver 比较；缺失一侧回退另一侧）。
 * @param {{ latest?: string, next?: string }} distTags
 * @returns {string}
 */
export function pickPluginVersion(distTags) {
  const { latest, next } = distTags
  if (latest !== undefined && next !== undefined) {
    return compareSemver(latest, next) >= 0 ? latest : next
  }
  const chosen = latest ?? next
  if (chosen === undefined) throw new Error('dist-tags 中 latest 与 next 均不存在')
  return chosen
}

/** 生成 GitHub Actions matrix 对象。 */
export function buildMatrix(dshEntries) {
  return {
    os: ['windows-latest', 'macos-latest', 'ubuntu-latest'],
    dsh: dshEntries,
  }
}
