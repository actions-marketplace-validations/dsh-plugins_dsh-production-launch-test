/**
 * semver — 极简 semver 解析与比较（仅覆盖 x.y.z[-prerelease] 形态）。
 */

/**
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number, pre: string[] } | null}
 */
export function parseSemver(version) {
  const match = /^(?<core>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<pre>[\w.-]+))?(?:\+[\w.-]+)?$/u
    .exec(String(version).trim())
  if (match?.groups === undefined) return null
  return {
    major: Number(match.groups.core),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
    pre: match.groups.pre === undefined ? [] : match.groups.pre.split('.'),
  }
}

/**
 * 比较两个 semver。a < b → -1，相等 → 0，a > b → 1。
 * 规则：数值段依次比较；无预发布 > 有预发布；预发布标识符数值 < 字母，段数少 < 段数多。
 */
export function compareSemver(a, b) {
  const va = parseSemver(a)
  const vb = parseSemver(b)
  if (va === null || vb === null) throw new Error(`非法 semver：${va === null ? a : b}`)
  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] < vb[key] ? -1 : 1
  }
  if (va.pre.length === 0 && vb.pre.length === 0) return 0
  if (va.pre.length === 0) return 1
  if (vb.pre.length === 0) return -1
  const len = Math.max(va.pre.length, vb.pre.length)
  for (let i = 0; i < len; i += 1) {
    const pa = va.pre[i]
    const pb = vb.pre[i]
    if (pa === undefined) return -1
    if (pb === undefined) return 1
    const na = /^\d+$/u.test(pa)
    const nb = /^\d+$/u.test(pb)
    if (na && nb) {
      const diff = Number(pa) - Number(pb)
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (na !== nb) {
      return na ? -1 : 1
    } else if (pa !== pb) {
      return pa < pb ? -1 : 1
    }
  }
  return 0
}

/** semver 升序排序（原地）。 */
export function sortSemver(versions) {
  return versions.sort(compareSemver)
}
