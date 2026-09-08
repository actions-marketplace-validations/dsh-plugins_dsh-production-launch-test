<div align="center">

# dsh-production-launch-test

**一个 GitHub Action：在带桌面环境的 runner 上启动 DSH 生产 Web GUI，并用真实 Chrome 驱动它做端到端测试。**

[English](README.md) | 简体中文

</div>

## 功能

给定一个 DSH 版本，本 action 会：

1. 校验 runner 确实带有**桌面环境**（没有则直接失败）；
2. 用 pnpm 把 `@deepseek-ai/dsh@<dsh-version>` 隔离安装到按版本独立的目录，
   并使用独立的 `DSH_HOME`，不会触碰你本机真实的 DSH 安装；
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
| pnpm | 缺失时由 action 自备 pnpm 11.17（corepack 优先，退回 `npm i -g`）。 |
| 中文字体 | `lang` 为 zh 系且运行在 Linux 时，action 自动检测 `fc-list :lang=zh`，缺失则尝试 `apt-get install fonts-noto-cjk`（装不上仅告警，截图可能出现豆腐块 □）。Windows / macOS 自带中文字体，无需处理。 |
| 权限 | 用到 `artifact:` 插件规格时，工作流需授予 `actions: read`（artifact 经 REST API 下载）。 |

日志与截图由 action 内嵌的 `actions/upload-artifact` 步骤上传
（composite 的 run 步骤拿不到 `ACTIONS_RUNTIME_TOKEN`，不能进程内上传），
artifact 名 `dsh-test-<OS>-<dsh版本>-<尝试次数>`，保留 14 天。

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
            try { await click('继续'); } catch {}
            await selectWorkspace();
            await click('新会话');
            await selectModel('sim-openai-completions/test-model');
            await sendMessage('测试');
            await waitFor('工具结果已收到', 30000);
            await click('设置');
            await screenshot('settings');
```

完整的插件仓库工作流见 [examples/basic.yml](examples/basic.yml)。

### 全量兼容矩阵

[.github/workflows/all-plugins-all-versions.yml](.github/workflows/all-plugins-all-versions.yml)
（手动触发，也可直接复制为调用方示例）**每次触发都重新解析**：

- dsh 版本清单：npm `@deepseek-ai/dsh` 全部版本 ∪ GitHub Releases（`dsh-v*` tag），
  取 ≥ `0.1.0-rc.6`；npm 上缺失的版本（如 `0.1.2-alpha.1` / `0.1.3-alpha.1`）由 action
  自动从源码构建安装；
- 7 个 DSH 生态插件（`dsh-thought-buddy`、`dsh-approve-for-me`、`dsh-auxiliary`、
  `dsh-better-sidebar-loader`、`dsh-code-review`、`dsh-loader`、`dsh-network-settings`）
  的 npm dist-tags 在 `latest` 与 `next` 中取较新者，全部装进同一个测试 profile；

然后按 `windows / macos / ubuntu × <全部 dsh 版本>` 矩阵运行（`fail-fast: false`），
每个环境的插件兼容性以独立单元呈现。

## 输入

| 输入 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `dsh-version` | ✅ | — | 要安装并启动的 `@deepseek-ai/dsh` 版本（如 `0.1.3-alpha.1`）。npm 上不存在该版本时（GitHub Releases 独占，如 `0.1.2-alpha.1`），action 自动克隆 `deepseek-ai/deepseek-harness` 的 `dsh-v<版本>` tag 从源码构建安装（`pnpm install` → `build:official` → `release:pack --family dsh`）。 |
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
path/to/plugin                                        # 本地目录（含 package.json），自动 pnpm pack
path/to/plugin.tgz                                    # 本地已打包的 tgz，直接引用
path:path/to/plugin                                   # 显式 path: 前缀（两种形态同义）
@npm-scope/plugin@version                             # npm 源，直接透传
```

本地路径相对调用方 workspace 解析；带 ref 或子路径的 github 规格统一经
`git clone` + checkout + `pnpm pack`（仓库内 `.tgz` 文件走 `raw.githubusercontent.com`
直接下载）物化为本地 tarball，再交给 `dsh plugin --profile <profile> add`；
裸 `github:` 与 npm 规格原样透传。安装完成后 action 会校验每个插件都已注册进
`dsh.profile.bundles`；任何安装失败都会让 action 失败。

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
| `click(text, opts?)` | 按 role（`button`/`link`/`menuitem`/`tab`，先精确后模糊）点击，回退到可见文本，最后兜底类名/`aria-label` 子串匹配（如 `click('close')` 可命中 `class="kOalmG_close"` 的图标按钮——CSS module 的 hash 前缀会变，子串后缀稳定）。 |
| `selectWorkspace(path?)` | 经 `workspace/create` RPC 注册/复用目录为工作区并在其中建会话，随后刷新进入（也用于离开设置等子页面）；省略 path 时用系统临时目录下的固定工作区。 |
| `sendMessage(text)` | 聚焦聊天输入框、填入文本并按 Enter 提交；页面没有可见输入框时（例如还停在“选择工作区”欢迎页）回退到 `session/prompt` RPC 提交。 |
| `selectModel('provider/model')` | 经页面自身的 `session.selectModel` RPC 在最近一个会话上切换模型。 |
| `screenshot(name?)` | 保存 `artifacts/screenshots/NN-<name>.png`，返回路径。 |
| `waitFor(text, timeoutMs?)` | 等待 `text` 在页面可见（默认 15s）。 |
| `sleep(ms)` | 等待指定毫秒。 |
| `currentUrl()` | 返回当前页面 URL。 |

> 首次启动会弹「内测声明」弹窗，用 `try { await click('继续'); } catch {}` 关闭
> （英文界面为 `click('Continue')`）。
>
> DSH 会话始终声明工具，所以模拟 LLM 会话首轮命中规则 2（固定工具调用），
> 随后命中规则 1（收尾文本 `工具结果已收到，任务完成。`）；断言请针对收尾文本，
> 而不是纯文本回显。

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
