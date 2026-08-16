# OpenClaw Xingyun QPM Queue

这是一个可独立维护的 OpenClaw Provider 插件项目。源码使用 TypeScript，
关键限流与续跑逻辑带有中文注释。

This provider plugin pauses each underlying Xingyun model call before transport
when the rolling QPM window is full. The original OpenClaw agent Promise remains
pending, so the task continues automatically after admission instead of ending
with HTTP 429.

Default policy: **17 requests per rolling 60 seconds**, plus 300 ms boundary
safety. Xingyun's advertised maximum is 18 QPM; keeping one request of headroom
reduces boundary and out-of-process traffic risk.

## Requirements

- OpenClaw 2026.7.1 or newer.
- Xingyun exposes an OpenAI Chat Completions compatible endpoint.
- Node.js 22 or newer.
- To show messages in native WebChat/Control UI, enable the bundled
  `admin-http-rpc` plugin. Notification failures never interrupt model calls.
- This implementation is process-local. For multiple Gateway replicas, replace
  `RollingWindowLimiter` with a Redis-backed atomic limiter.

## Build and install

```bash
npm install
npm run check
npm pack
openclaw plugins install ./openclaw-xingyun-qpm-0.1.0.tgz
openclaw plugins enable admin-http-rpc
openclaw gateway restart
```

## 推送到 GitHub

下载源码仓库 ZIP 并解压后，在项目根目录执行：

```bash
git init
git add .
git commit -m "feat: initial Xingyun QPM queue plugin"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

仓库已经包含 `.gitignore`、GitHub Actions、单元测试和维护说明。
推送后，每次提交和 Pull Request 都会自动执行 TypeScript 构建与测试。

Environment:

```bash
export XINGYUN_API_KEY="..."
export XINGYUN_BASE_URL="https://your-xingyun-host/v1"
export XINGYUN_MODEL_ID="your-model-id"
export OPENCLAW_GATEWAY_URL="http://127.0.0.1:18789"
export OPENCLAW_GATEWAY_TOKEN="your-gateway-token"
```

Configure the plugin and select its provider:

```json5
{
  plugins: {
    allow: ["xingyun-qpm", "admin-http-rpc"],
    entries: {
      "xingyun-qpm": {
        enabled: true,
        config: {
          baseUrl: "https://your-xingyun-host/v1",
          modelId: "your-model-id",
          requestsPerMinute: 17,
          windowMs: 60000,
          safetyMs: 300,
          notify: true,
          notifyResumed: true
        }
      },
      "admin-http-rpc": { enabled: true }
    }
  },
  agents: {
    defaults: {
      model: { primary: "xingyun-qpm/your-model-id" },
      maxConcurrent: 1,
      subagents: { maxConcurrent: 1 }
    }
  }
}
```

When queued, the current conversation receives:

> ⏳ 当前模型调用正在限流排队，任务没有中断，预计 23 秒后自动继续。

Once admitted:

> ✅ 模型调用额度已恢复，任务正在继续执行。

## Important compatibility check

OpenClaw's Provider SDK and admin RPC allowlist evolve with releases. After
installation run:

```bash
openclaw plugins inspect xingyun-qpm --runtime --json
openclaw gateway status --deep --require-rpc
```

If `chat.inject` is not present in your release's `admin-http-rpc` allowlist,
the queue still works and logs the wait, but native chat notification will be
skipped. In that case use the Gateway WebSocket client to invoke `chat.inject`,
or add it to the trusted private admin RPC allowlist for your pinned release.

Injected status messages are transcript entries. The plugin emits at most one
waiting message per model turn, rather than one message per second.
