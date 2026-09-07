/**
 * upload — artifacts 打包上传与 action 输出/摘要写入。
 */

import { appendFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 递归收集目录下全部文件。 */
async function listFiles(dir) {
  const files = []
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry)
    const info = await stat(full)
    if (info.isDirectory()) files.push(...await listFiles(full))
    else files.push(full)
  }
  return files
}

/**
 * 上传产物目录为当前 run 的 artifact。
 * @param {{ dir: string, name: string, log?: (line: string) => void }} options
 * @returns {Promise<boolean>} 是否成功（非 Actions 环境或上传失败时返回 false 并告警）
 */
export async function uploadArtifacts({ dir, name, log = () => {} }) {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    log(`非 GitHub Actions 环境，跳过 artifact 上传（产物保留在 ${dir}）`)
    return false
  }
  try {
    const { DefaultArtifactClient } = await import('@actions/artifact')
    const client = new DefaultArtifactClient()
    const files = await listFiles(dir)
    if (files.length === 0) {
      log(`产物目录为空，跳过上传：${dir}`)
      return false
    }
    const { size } = await client.uploadArtifact(name, files, dir, { retentionDays: 14 })
    log(`artifact ${name} 上传完成（${files.length} 个文件，${size} 字节）`)
    return true
  } catch (error) {
    log(`artifact 上传失败（不阻断结果判定）：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/** 写 action 输出（web-url / logs-dir）。 */
export async function writeOutputs(outputs) {
  const file = process.env.GITHUB_OUTPUT
  if (file === undefined || file === '') return
  const lines = Object.entries(outputs)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value).replace(/\n/gu, ' ')}`)
  if (lines.length > 0) await appendFile(file, `${lines.join('\n')}\n`, 'utf8')
}

/** 写 job 摘要（GITHUB_STEP_SUMMARY）。 */
export async function writeSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file === undefined || file === '') return
  await appendFile(file, markdown, 'utf8')
}
