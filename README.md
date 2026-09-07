<div align="center">

# dsh-production-launch-test

**A GitHub Action that boots a production DSH Web GUI on a desktop runner and drives it with real Chrome for end-to-end testing.**

English | [简体中文](README.zh_CN.md)

</div>

## What it does

Given a DSH version, this action:

1. Verifies the runner actually has a **desktop environment** (fails fast otherwise);
2. Installs `@deepseek-ai/dsh@<dsh-version>` into an isolated per-version directory with pnpm,
   with its own `DSH_HOME`, so runs never touch your real DSH installation;
3. Prepares a test profile and installs the requested plugins;
4. Optionally starts a **simulated LLM** server (fixed-input → fixed-output) covering the
   `openai-completions` / `openai-responses` / `anthropic-messages` protocols, and wires it
   into DSH as provider routes;
5. Boots the production Web GUI and drives it with **headed system Chrome** via playwright-core,
   running your `user-script` with an injected browser API (`click`, `sendMessage`, `selectModel`,
   `screenshot`, …);
6. Saves the host console output and the web console output as `.log` files and uploads them
   (plus screenshots) as a workflow artifact;
7. **Fails the action if any plugin fails to load** — in the host log, in the browser console,
   or as the on-page `Failed to load plugins` banner.

## Requirements

| Requirement | Notes |
| --- | --- |
| Desktop environment | Windows / macOS runners pass directly. Linux runners must provide a display first (e.g. Xvfb) — the action fails fast when `DISPLAY`/`WAYLAND_DISPLAY` is unset. |
| Node | `^22.19.0 \|\| >=24` (DSH engines). Run `actions/setup-node@v4` before this action. |
| Chrome | System Chrome, used via playwright-core `channel: 'chrome'`. Preinstalled on all GitHub-hosted desktop runners. |
| pnpm | The action self-provisions pnpm 11.17 when missing (corepack first, falling back to `npm i -g`). |
| CJK fonts | With a `zh*` `lang` on Linux the action checks `fc-list :lang=zh` and tries `apt-get install fonts-noto-cjk` when empty (failure only warns; screenshots may show tofu □). Windows / macOS ship CJK fonts already. |
| Permissions | Workflows using `artifact:` plugin specs must grant `actions: read` (artifacts are downloaded through the REST API). |

Logs and screenshots are uploaded by a nested `actions/upload-artifact` step inside the
action (composite `run` steps never receive `ACTIONS_RUNTIME_TOKEN`, so in-process upload
is impossible). Artifact name: `dsh-test-<OS>-<dsh-version>-<attempt>`, kept for 14 days.

## Usage

```yaml
jobs:
  test:
    runs-on: windows-latest # macos-latest / ubuntu-latest (ubuntu needs Xvfb first)
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'

      # Linux only: provide a desktop display
      - name: Start Xvfb
        if: runner.os == 'Linux'
        shell: bash
        run: |
          sudo apt-get update && sudo apt-get install -y xvfb
          nohup sudo Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
          echo "DISPLAY=:99" >> "$GITHUB_ENV"

      - name: DSH production launch test
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

See [examples/basic.yml](examples/basic.yml) for a complete plugin-repo workflow.

### Full compatibility sweep

[.github/workflows/all-plugins-all-versions.yml](.github/workflows/all-plugins-all-versions.yml)
(manually triggered, also serves as a copy-paste example) resolves **at every run**:

- every DSH version ≥ `0.1.0-rc.6` from npm ∪ GitHub Releases (`dsh-v*` tags) — versions
  that exist only on GitHub (e.g. `0.1.2-alpha.1`, `0.1.3-alpha.1`) are built from source
  automatically by the action itself;
- the newest of each plugin's `latest`/`next` npm dist-tags for seven DSH ecosystem
  plugins (`dsh-thought-buddy`, `dsh-approve-for-me`, `dsh-auxiliary`,
  `dsh-better-sidebar-loader`, `dsh-code-review`, `dsh-loader`, `dsh-network-settings`),
  all installed into one shared profile;

then runs the matrix `windows / macos / ubuntu × <every dsh version>` with
`fail-fast: false`, so each environment's plugin compatibility shows up as its own cell.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `dsh-version` | ✅ | — | `@deepseek-ai/dsh` version to install and boot (e.g. `0.1.3-alpha.1`). When the version is missing from npm (GitHub-Releases-only, e.g. `0.1.2-alpha.1`), the action automatically clones `deepseek-ai/deepseek-harness` at tag `dsh-v<version>` and builds from source (`pnpm install` → `build:official` → `release:pack --family dsh`). |
| `lang` | | `zh-CN` | Web GUI language (BCP 47). Mapped to DSH `locale.preference` (`zh`/`en`) and to Chrome's `navigator.languages`. |
| `simulated-llm` | | `false` | Space-separated protocols: `openai-completions` / `openai-responses` / `anthropic-messages` / `all` / `false`. `true` is an alias of `all`. |
| `plugins` | | — | One plugin spec per line (grammar below). |
| `user-script` | | — | JS source executed in the browser page (wrapped in an async function), or `{owner}/{repo}/{path}@{ref}` to fetch the script from GitHub. |
| `github-token` | | `${{ github.token }}` | Token for private GitHub plugin/script fetches and artifact downloads. |
| `node-version` | | `24` | Documented Node major the caller installed via setup-node; used in the preflight error message. |
| `profile` | | `test` | Test profile name (copied from the generated `web` profile). |
| `timeout-seconds` | | `600` | Overall timeout for the user-script phase. |

## Plugin spec grammar

One spec per line; blank lines and `#` comments are ignored.

```
artifact:plugin-build-artifact                        # artifact of the current run (dir with package.json or *.tgz)
github:user/repo                                      # pnpm-native git source, passed through
github:user/repo#commit=1234abc                       # pinned commit
github:user/repo@release-tag                          # release tag
github:user/repo#path/to/plugin                       # plugin in a repo subdirectory
github:user/repo#path/to/plugin&commit=1234abc        # subdirectory + commit
github:user/repo#path/to/plugin@release-tag           # subdirectory + tag
github:user/repo#path/to/plugin.tgz                   # a .tgz file inside the repo
github:user/repo#path/to/plugin.tgz&commit=1234abc
github:user/repo#path/to/plugin.tgz@release-tag
path/to/plugin                                        # local directory (with package.json), auto pnpm pack
path/to/plugin.tgz                                    # local prepacked tgz, used as-is
path:path/to/plugin                                   # explicit path: prefix (both forms equivalent)
@npm-scope/plugin@version                             # npm source, passed through
```

Local paths resolve against the caller workspace. Specs carrying a ref or a subpath are
materialized by `git clone` + checkout + `pnpm pack` (or a direct
`raw.githubusercontent.com` download for in-repo `.tgz` files) into a local tarball, which
is then handed to `dsh plugin --profile <profile> add`. Bare `github:` and npm specs are
passed through untouched. After installation the action verifies that every plugin was
registered in `dsh.profile.bundles`; any install failure fails the action.

## Simulated LLM

A zero-dependency `node:http` server on `127.0.0.1` implements:

| Protocol | Endpoint |
| --- | --- |
| openai-completions | `POST /v1/chat/completions` (JSON + SSE stream) |
| openai-responses | `POST /v1/responses` (JSON + SSE stream) |
| anthropic-messages | `POST /v1/messages` (JSON + SSE stream) |
| discovery | `GET /v1/models` |

Each enabled protocol is registered in `<DSH_HOME>/settings.yaml` as an `llm-pi-ai`
provider route (`sim-<protocol>`) exposing the model `test-model`, so
`selectModel('sim-openai-completions/test-model')` addresses it directly.

Fixed rules, matched deterministically on request features:

1. Request contains a tool result → fixed closing text (`工具结果已收到，任务完成。`);
2. Tools are declared but not yet called → one fixed tool call `simulated_echo`;
3. Request contains images → fixed acknowledgement (`已收到 N 张图片。`);
4. Anything else → fixed echo reply (`模拟回复：<last user message>`), handy for `waitFor` assertions.

Every request/response summary lands in `simulated-llm.log`.

## User-script browser API

Injected as page globals before your script runs (all async):

| API | Behavior |
| --- | --- |
| `click(text, opts?)` | Clicks by role (`button`/`link`/`menuitem`/`tab`, exact then fuzzy) falling back to visible text. |
| `selectWorkspace(path?)` | Registers/reuses a directory as a workspace via the `workspace/create` RPC, creates a session in it and reloads into it (also leaves sub-pages like settings); without `path` uses a fixed workspace under the system temp dir. |
| `sendMessage(text)` | Focuses the chat composer, fills it and submits with Enter; falls back to the `session/prompt` RPC when no composer is visible (e.g. the workspace picker is still showing). |
| `selectModel('provider/model')` | Calls the page's own `session.selectModel` RPC on the most recent session. |
| `screenshot(name?)` | Saves `artifacts/screenshots/NN-<name>.png`; returns the path. |
| `waitFor(text, timeoutMs?)` | Waits until `text` is visible (default 15s). |
| `sleep(ms)` | Sleeps. |
| `currentUrl()` | Returns the current page URL. |

> First boot shows the beta-notice modal — dismiss it with `try { await click('继续'); } catch {}`
> (or `click('Continue')` in English).
>
> DSH sessions always declare tools, so a simulated-LLM conversation hits rule 2 first
> (a fixed tool call) and then rule 1 (the closing text `工具结果已收到，任务完成。`);
> assert on that instead of the plain-text echo.

The script is wrapped as `async () => { … }`, so top-level `await` works. A thrown error
fails the action.

## Logs, artifacts and failure conditions

Everything lands in `artifacts/` and is uploaded as
`dsh-test-<platform>-<dsh-version>-<run_attempt>`:

- `host.log` — the DSH process console output;
- `web-console.log` — every browser `console`/`pageerror`/`requestfailed` event;
- `simulated-llm.log` — mock LLM request log;
- `plugins.log` — plugin materialization and `dsh plugin add` output;
- `runner.log` — orchestration log;
- `screenshots/` — `00-boot.png`, `99-final.png`, plus your `screenshot()` calls.

The action fails when any of these is detected:

- host log: `Failed to load`, `UnsupportedDshVersionError`, plugin-tree failure, or the
  DSH process exiting early;
- web console: `Failed to load plugins`, `failed to apply`, `keyed slot`, `Uncaught`,
  or the on-page failure banner;
- any plugin install error or a missing `dsh.profile.bundles` registration;
- a user-script error or timeout.

## Outputs

| Output | Description |
| --- | --- |
| `web-url` | The token-authenticated Web GUI URL of this run (dead once the job ends). |
| `logs-dir` | Local path of the artifact payload directory (for custom re-upload). |

## Development

```bash
npm ci
npm test          # node:test unit + simulated-llm HTTP integration tests
```

Layout: `action.yml` (composite contract), `scripts/main.mjs` (orchestrator),
`scripts/lib/*.mjs` (env / install / plugins / simulated-llm / runner / browser-api /
logs / upload), `tests/`, `.github/workflows/self-test.yml` (dogfooding matrix),
`examples/basic.yml`.

Local end-to-end run (Windows/macOS desktop with Chrome, Node 24, pnpm):

```bash
INPUT_DSH_VERSION=0.1.2-alpha.5 \
INPUT_SIMULATED_LLM=all \
INPUT_PLUGINS='@dsh-plugin/dsh-loader' \
INPUT_USER_SCRIPT='await screenshot("home");' \
DSH_PLT_HEADLESS=1 \
node scripts/main.mjs
```

`DSH_PLT_HEADLESS=1` is a debugging override; the action otherwise always runs headed,
which is exactly what the desktop check guarantees.
