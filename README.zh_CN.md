<div align="center">

# dsh-production-launch-test

**一个 GitHub Action：在带桌面环境的 runner 上启动 DSH 生产 Web GUI，并用真实 Chrome 驱动它做端到端测试。**

[English](README.md) | 简体中文

</div>

## 功能

给定一个 DSH 版本，本 action 会：

1. 校验 runner 确实带有**桌面环境**（没有则直接失败）；
2. 用 pnpm 把 `@deepseek-ai/dsh@<dsh-version>` 隔离安装到独立目录
   （与 `.test` 相同的多版本隔离方案：独立安装目录 + 独立 `DSH_HOME`）；
3. 准备测试 profile 并安装指定插件；
4. 可选启动**模拟 LLM** 服务（固定输入 → 固定输出），覆盖
   `openai-completions` / `openai-responses` / `anthropic-messages` 三种协议，
   并以 provider 路由的形式接入 DSH；
5. 启动生产 Web GUI，通过 playwright-core 用**有头的系统 Chrome** 驱动页面，
   执行注入了浏览器 API（`click`、`sendMessage`、`selectModel`、`screenshot` 等）的 `user-script`；
6. 把宿主控制台输出和网页控制台输出保存为 `.log` 文件，连同截图一起打包上传为 workflow artifact；
7. **任何插件加载失败都让 action 失败**——无论是宿主日志、浏览器控制台，
   还是页面上的 `Failed to load plugins` 横幅。

## 运行环境要求

| 要求 | 说明 |
| --- | --- |
| 桌面环境 | Windows / macOS runner 直接通过。Linux runner 须先提供显示服务（如 Xvfb）——`DISPLAY`/`WAYLAND_DISPLAY` 均未设置时 action 直接失败。 |
| Node | `^22.19.0 \|\| >=24`（DSH engines）。请先运行 `actions/setup-node@v4`。 |
| Chrome | 系统 Chrome，经 playwright-core `channel: 'chrome'` 调用。GitHub 托管的桌面 runner 均已预装。 |
| pnpm | 缺失时由 action 通过 corepack 自备 pnpm 11.17。 |

## 使用

```yaml
jobs:
  test:
    runs-on: windows-latest # macos-latest / ubuntu-latest（ubuntu 需先起 Xvfb）
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'

      # 仅 Linux：提供桌面显示服务
      - name: 启动 Xvfb
        if: runner.os == 'Linux'
        shell: bash
        run: |
          sudo apt-get update && sudo apt-get install -y xvfb
          nohup sudo Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
          echo "DISPLAY=:99" >> "$GITHUB_ENV"

      - name: DSH 生产环境启动测试
        uses: <owner>/dsh-production-launch-test@v1
        with:
          dsh-version: 0.1.3-alpha.1
          lang: zh-CN
          simulated-llm: all
          plugins: |
            artifact:plugin-build-artifact
            github:user/repo#commit=1234abc
            @dsh-plugin/dsh-loader
          user-script: |
            await click('设置');
            await screenshot('settings');
            await sendMessage('测试');
            await waitFor('模拟回复', 30000);
```

完整的插件仓库工作流见 [examples/basic.yml](examples/basic.yml)。

## 输入

| 输入 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `dsh-version` | ✅ | — | 要安装并启动的 `@deepseek-ai/dsh` npm 版本（如 `0.1.3-alpha.1`）。 |
| `lang` | | `zh-CN` | Web GUI 界面语言（BCP 47）。映射到 DSH `locale.preference`（`zh`/`en`），并同步 Chrome 的 `navigator.languages`。 |
| `simulated-llm` | | `false` | 空格分隔的协议列表：`openai-completions` / `openai-responses` / `anthropic-messages` / `all` / `false`。`true` 等价于 `all`。 |
| `plugins` | | — | 每行一个插件规格（语法见下）。 |
| `user-script` | | — | 在浏览器页面执行的 JS 源码（包装为 async 函数），或 `{owner}/{repo}/{path}@{ref}` 从 GitHub 拉取。 |
| `github-token` | | `${{ github.token }}` | 拉取私有 GitHub 插件/脚本与下载 artifact 的 token。 |
| `node-version` | | `24` | 约定调用方经 setup-node 安装的 Node 主版本，用于预检报错提示。 |
| `profile` | | `test` | 测试 profile 名（由生成的 `web` profile 复制而来）。 |
| `timeout-seconds` | | `600` | 用户脚本阶段的整体超时（秒）。 |

## 插件规格语法

每行一个规格；空行与 `#` 注释会被忽略。

```
artifact:plugin-build-artifact                        # 当前 run 的 artifact（含 package.json 的目录或 *.tgz）
github:user/repo                                      # pnpm 原生 git 源，直接透传
github:user/repo#commit=1234abc                       # 指定提交
github:user/repo@release-tag                          # release tag
github:user/repo#path/to/plugin                       # 仓库子目录中的插件
github:user/repo#path/to/plugin&commit=1234abc        # 子目录 + 提交
github:user/repo#path/to/plugin@release-tag           # 子目录 + tag
github:user/repo#path/to/plugin.tgz                   # 仓库内的 .tgz 产物文件
github:user/repo#path/to/plugin.tgz&commit=1234abc
github:user/repo#path/to/plugin.tgz@release-tag
@npm-scope/plugin@version                             # npm 源，直接透传
```

带 ref 或 path 的规格统一经 `git clone` + checkout + `pnpm pack`（仓库内 `.tgz`
文件走 `raw.githubusercontent.com` 直接下载）物化为本地 tarball，再交给
`dsh plugin --profile <profile> add`；裸 `github:` 与 npm 规格原样透传。安装完成后
action 会校验每个插件都已注册进 `dsh.profile.bundles`；任何安装失败都会让 action 失败。

## 模拟 LLM

零依赖 `node:http` 服务，监听 `127.0.0.1`，实现：

| 协议 | 端点 |
| --- | --- |
| openai-completions | `POST /v1/chat/completions`（JSON + SSE 流式） |
| openai-responses | `POST /v1/responses`（JSON + SSE 流式） |
| anthropic-messages | `POST /v1/messages`（JSON + SSE 流式） |
| 模型发现 | `GET /v1/models` |

每个启用的协议都会写入 `<DSH_HOME>/settings.yaml` 成为 `llm-pi-ai` 的
provider 路由（`sim-<协议>`），暴露模型 `test-model`，因此可以直接用
`selectModel('sim-openai-completions/test-model')` 选中它。

固定规则按请求特征确定性命中：

1. 请求含工具结果 → 固定收尾文本（`工具结果已收到，任务完成。`）；
2. 声明了工具且本轮未调用 → 产生一次固定工具调用 `simulated_echo`；
3. 请求含图片 → 固定确认文本（`已收到 N 张图片。`）；
4. 其余 → 固定回显应答（`模拟回复：<最后一条用户消息>`），方便配合 `waitFor` 断言。

所有请求/响应摘要都会写入 `simulated-llm.log`。

## 用户脚本浏览器 API

脚本执行前注入为页面全局函数（均为异步）：

| API | 行为 |
| --- | --- |
| `click(text, opts?)` | 按 role（`button`/`link`/`menuitem`/`tab`，先精确后模糊）点击，回退到可见文本。 |
| `sendMessage(text)` | 聚焦聊天输入框、填入文本并按 Enter 提交。 |
| `selectModel('provider/model')` | 经页面自身的 `session.selectModel` RPC 在最近一个会话上切换模型。 |
| `screenshot(name?)` | 保存 `artifacts/screenshots/NN-<name>.png`，返回路径。 |
| `waitFor(text, timeoutMs?)` | 等待 `text` 在页面可见（默认 15s）。 |
| `sleep(ms)` | 等待指定毫秒。 |
| `currentUrl()` | 返回当前页面 URL。 |

脚本被包装为 `async () => { … }`，可直接顶层 `await`。脚本抛错会让 action 失败。

## 日志、artifacts 与失败条件

所有产物落在 `artifacts/`，上传为 `dsh-test-<平台>-<dsh-version>-<run_attempt>`：

- `host.log` —— DSH 进程的控制台输出；
- `web-console.log` —— 浏览器全部 `console`/`pageerror`/`requestfailed` 事件；
- `simulated-llm.log` —— 模拟 LLM 请求日志；
- `plugins.log` —— 插件物化与 `dsh plugin add` 输出；
- `runner.log` —— 编排日志；
- `screenshots/` —— `00-boot.png`、`99-final.png` 及你的 `screenshot()` 产物。

命中以下任一情况，action 失败：

- 宿主日志出现 `Failed to load`、`UnsupportedDshVersionError`、插件树失败，或 DSH 进程提前退出；
- 网页控制台出现 `Failed to load plugins`、`failed to apply`、`keyed slot`、`Uncaught`，或页面出现失败横幅；
- 任一插件安装报错或未注册进 `dsh.profile.bundles`；
- 用户脚本抛错或超时。

## 输出

| 输出 | 说明 |
| --- | --- |
| `web-url` | 本次运行带 token 的 Web GUI 地址（job 结束后即失效）。 |
| `logs-dir` | 产物目录的本地路径（便于自定义二次上传）。 |

## 开发

```bash
npm ci
npm test          # node:test 单元测试 + simulated-llm HTTP 集成测试
```

目录结构：`action.yml`（composite 契约）、`scripts/main.mjs`（编排器）、
`scripts/lib/*.mjs`（env / install / plugins / simulated-llm / runner / browser-api /
logs / upload）、`tests/`、`.github/workflows/self-test.yml`（狗食矩阵）、
`examples/basic.yml`。

本地端到端运行（带 Chrome 的 Windows/macOS 桌面、Node 24、pnpm）：

```bash
INPUT_DSH_VERSION=0.1.2-alpha.5 \
INPUT_SIMULATED_LLM=all \
INPUT_PLUGINS='@dsh-plugin/dsh-loader' \
INPUT_USER_SCRIPT='await screenshot("home");' \
DSH_PLT_HEADLESS=1 \
node scripts/main.mjs
```

`DSH_PLT_HEADLESS=1` 是调试开关；action 正常一律有头运行——这正是桌面环境检测所保证的。
