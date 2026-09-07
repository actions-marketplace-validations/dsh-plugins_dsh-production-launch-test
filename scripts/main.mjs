/**
 * main — action 编排入口。
 *
 * 数据流：inputs → 预检（桌面/Node/pnpm/Chrome）→ 隔离安装 dsh → 准备测试 profile
 * → 物化并安装插件 → 写入 settings.yaml（locale + 模拟 LLM providers）→ 起模拟 LLM
 * → 起 dsh（host.log）→ headed Chrome 执行用户脚本（web-console.log + screenshots）
 * → 扫描日志判定成败 → 上传 artifact → 退出码。
 */

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { detectDesktop, mapLocale, nodeVersionOk, readInputs } from './lib/env.mjs'
import { installDshFromSource } from './lib/dsh-source.mjs'
import { installDsh, mergeSettingsYaml, prepareProfile, spawnDsh } from './lib/install.mjs'
import { createLogger, scanLogs } from './lib/logs.mjs'
import { materializePlugin, parsePluginsInput, readBundles } from './lib/plugins.mjs'
import { ensurePnpm, run } from './lib/proc.mjs'
import { preflightChrome, runInChrome } from './lib/runner.mjs'
import {
  providerSettings,
  SIM_API_KEY_ENV,
  parseSimulatedLlmSpec,
  startSimulatedLlm,
} from './lib/simulated-llm.mjs'
import { writeOutputs, writeSummary } from './lib/upload.mjs'

/** user-script 为 {owner}/{repo}/{path}@{ref} 时从 GitHub raw 拉取脚本内容。 */
async function resolveUserScript(source, token, log) {
  const match = /^(?<owner>[^/\s]+)\/(?<repo>[^/\s]+)\/(?<path>.+)@(?<ref>[^@\s]+)$/u.exec(source.trim())
  if (match?.groups === undefined || source.includes('\n')) return source
  const { owner, repo, path, ref } = match.groups
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`
  log(`拉取用户脚本：${url}`)
  const response = await fetch(url, {
    headers: token !== '' ? { authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) throw new Error(`拉取用户脚本失败：HTTP ${response.status} ${url}`)
  return await response.text()
}

async function main() {
  const inputs = readInputs()
  const workRoot = process.env.RUNNER_TEMP !== undefined && process.env.RUNNER_TEMP !== ''
    ? join(process.env.RUNNER_TEMP, 'dsh-plt')
    : join(tmpdir(), 'dsh-plt')
  const artifactsDir = resolve(process.cwd(), 'artifacts')
  const homeDir = join(workRoot, 'home')
  const materializeDir = join(workRoot, 'materialized')
  await mkdir(artifactsDir, { recursive: true })
  await mkdir(materializeDir, { recursive: true })

  const hostLogPath = join(artifactsDir, 'host.log')
  const webLogPath = join(artifactsDir, 'web-console.log')
  const simLogPath = join(artifactsDir, 'simulated-llm.log')
  const pluginLogPath = join(artifactsDir, 'plugins.log')
  const runnerLogPath = join(artifactsDir, 'runner.log')

  const hostLog = createLogger(hostLogPath)
  const webLog = createLogger(webLogPath)
  const simLog = createLogger(simLogPath)
  const pluginLog = createLogger(pluginLogPath)
  const log = createLogger(runnerLogPath)

  let dsh
  let sim
  let webUrl
  const failureReasons = []

  try {
    // ---------- 预检 ----------
    log('=== 预检 ===')
    const desktop = detectDesktop()
    if (!desktop.ok) throw new Error(desktop.reason)
    if (!nodeVersionOk()) {
      throw new Error(`Node ${process.version} 不满足 DSH engines（^22.19.0 || >=24）；`
        + `请先 actions/setup-node@v4 安装 node ${inputs.nodeVersion}`)
    }
    await ensurePnpm(log)
    await preflightChrome(log)

    // ---------- 安装 DSH ----------
    log('=== 安装 DSH ===')
    const bin = inputs.dshSource !== ''
      ? await installDshFromSource({
          source: inputs.dshSource,
          version: inputs.dshVersion,
          rootDir: workRoot,
          token: inputs.githubToken,
          log,
        })
      : await installDsh({ version: inputs.dshVersion, rootDir: workRoot, log })

    // ---------- 准备 profile ----------
    log('=== 准备测试 profile ===')
    const profileDir = await prepareProfile({ bin, homeDir, profile: inputs.profile, log: hostLog })

    // ---------- 插件 ----------
    const specs = parsePluginsInput(inputs.pluginsRaw)
    if (specs.length > 0) {
      log(`=== 安装 ${specs.length} 个插件 ===`)
      const bundlesBefore = await readBundles(profileDir)
      const targets = []
      for (const spec of specs) {
        const { target, display } = await materializePlugin(spec, {
          workDir: materializeDir,
          token: inputs.githubToken,
          log: pluginLog,
        })
        pluginLog(`物化 ${spec.raw} → ${target}`)
        targets.push({ target, display })
      }
      await run(process.execPath,
        [bin, 'plugin', '--profile', inputs.profile, 'add', ...targets.map(t => t.target)],
        { env: { ...process.env, DSH_HOME: homeDir, NO_UPDATE_NOTIFIER: '1' }, log: pluginLog })
      const bundlesAfter = await readBundles(profileDir)
      pluginLog(`bundles：${bundlesBefore.length} → ${bundlesAfter.length}`)
      if (bundlesAfter.length < bundlesBefore.length + specs.length) {
        failureReasons.push(`插件安装后 dsh.profile.bundles 未全部注册`
          + `（${bundlesBefore.length} → ${bundlesAfter.length}，预期 +${specs.length}）`)
      }
    } else {
      log('未指定插件，跳过插件安装')
    }

    // ---------- 模拟 LLM + settings ----------
    const protocols = parseSimulatedLlmSpec(inputs.simulatedLlm)
    const { dshLocale } = mapLocale(inputs.lang)
    const sections = {}
    if (dshLocale !== undefined) sections.locale = { preference: dshLocale }
    if (protocols !== null) {
      sim = await startSimulatedLlm({ protocols, log: simLog })
      sections['llm-pi-ai'] = { providers: providerSettings(protocols, sim.baseURL) }
    }
    if (Object.keys(sections).length > 0) {
      await mergeSettingsYaml(join(homeDir, 'settings.yaml'), sections)
      log(`settings.yaml 已写入：${Object.keys(sections).join(', ')}`)
    }

    // ---------- 启动 DSH ----------
    log('=== 启动 DSH ===')
    dsh = spawnDsh({
      bin,
      profile: inputs.profile,
      homeDir,
      extraEnv: protocols !== null ? { [SIM_API_KEY_ENV]: 'simulated' } : {},
      log: hostLog,
    })
    webUrl = await dsh.ready
    log(`DSH 就绪：${webUrl}`)
    await writeOutputs({ 'web-url': webUrl })

    // ---------- Chrome 用户脚本 ----------
    log('=== Chrome 用户脚本 ===')
    const userScript = await resolveUserScript(inputs.userScript, inputs.githubToken, log)
    await runInChrome({
      webUrl,
      lang: inputs.lang,
      userScript,
      artifactsDir,
      timeoutSeconds: inputs.timeoutSeconds,
      consoleLog: webLog,
      log,
    })
  } catch (error) {
    failureReasons.push(error instanceof Error ? error.message : String(error))
  } finally {
    if (dsh !== undefined) {
      log('停止 DSH…')
      await dsh.stop()
    }
    if (sim !== undefined) await sim.close()
  }

  // ---------- 失败扫描 ----------
  failureReasons.push(...scanLogs({ hostLogPath, webLogPath }))

  // ---------- 汇总与上传 ----------
  const ok = failureReasons.length === 0
  const summary = [
    `## dsh-production-launch-test ${ok ? '✅ 通过' : '❌ 失败'}`,
    '',
    `| 项 | 值 |`,
    `| --- | --- |`,
    `| dsh-version | \`${inputs.dshVersion}\` |`,
    `| runner | \`${process.platform}\` |`,
    `| lang | \`${inputs.lang}\` |`,
    `| simulated-llm | \`${inputs.simulatedLlm}\` |`,
    `| web-url | ${webUrl ?? '(未启动)'} |`,
    ...(ok ? [] : ['', '### 失败原因', '', ...failureReasons.map(r => `- ${r}`)]),
    '',
  ].join('\n')
  await writeSummary(summary)

  // 上传由 action.yml 的嵌套 actions/upload-artifact 步骤完成
  // （composite run 步骤拿不到 ACTIONS_RUNTIME_TOKEN，@actions/artifact 无法上传）
  if (process.env.GITHUB_ACTIONS !== 'true') {
    log(`非 GitHub Actions 环境，产物保留在 ${artifactsDir}`)
  }
  await writeOutputs({ 'logs-dir': artifactsDir })

  if (!ok) {
    console.error(`\n::error::dsh-production-launch-test 失败：\n${failureReasons.join('\n')}`)
    process.exitCode = 1
    return
  }
  log('全部通过 ✅')
}

main().catch(error => {
  console.error(`::error::编排器未捕获异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
