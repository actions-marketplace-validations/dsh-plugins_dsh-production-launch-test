/**
 * upload — action 输出/摘要写入。
 *
 * artifacts 上传不在进程内进行：composite action 的 run 步骤拿不到
 * ACTIONS_RUNTIME_TOKEN，@actions/artifact 无法工作。上传由 action.yml 末尾的
 * 嵌套 actions/upload-artifact 步骤完成；下载（artifact: 插件规格、dsh-source）
 * 走 lib/artifact-store.mjs 的 REST + GITHUB_TOKEN 通道。
 */

import { appendFile } from 'node:fs/promises'

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
