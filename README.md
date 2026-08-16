OpenClaw 星云模型 QPM 限流队列插件

这是一个 OpenClaw Provider 插件，用于控制星云模型的每分钟请求次数。

当最近 60 秒内的模型请求达到上限时，插件不会让星云返回 429，也不会中断当前 Agent 任务，而是让这次模型调用在 OpenClaw 内部排队等待。额度恢复后，插件会自动继续原来的模型请求，Agent 会从原来的执行位置继续运行。

默认策略为：最近连续 60 秒最多放行 17 次模型请求，并额外保留 300 毫秒的边界安全时间。星云限制为 18 QPM，插件主动少使用一个额度，用来降低时间边界误差以及其他进程共享同一密钥时产生 429 的风险。

一、安装

环境要求

OpenClaw 2026.7.1 或更高版本。

Node.js 22 或更高版本。

星云模型接口兼容 OpenAI Chat Completions。

如果需要在 OpenClaw 原生 WebChat 或 Control UI 中显示限流提示，需要启用 OpenClaw 自带的 admin-http-rpc 插件。

构建插件

在项目根目录执行：

npm install
npm run check
npm pack

命令执行成功后，会生成：

openclaw-xingyun-qpm-0.1.0.tgz

安装到 OpenClaw

openclaw plugins install ./openclaw-xingyun-qpm-0.1.0.tgz
openclaw plugins enable admin-http-rpc
openclaw gateway restart

二、配置

环境变量

export XINGYUN_API_KEY="你的星云 API Key"
export XINGYUN_BASE_URL="https://你的星云接口地址/v1"
export XINGYUN_MODEL_ID="你的模型ID"

export OPENCLAW_GATEWAY_URL="http://127.0.0.1:18789"
export OPENCLAW_GATEWAY_TOKEN="你的 OpenClaw Gateway Token"

变量

说明

XINGYUN_API_KEY

星云模型接口密钥。

XINGYUN_BASE_URL

星云 OpenAI 兼容接口地址。

XINGYUN_MODEL_ID

星云模型 ID。

OPENCLAW_GATEWAY_URL

OpenClaw Gateway 地址。

OPENCLAW_GATEWAY_TOKEN

调用 chat.inject 时使用的 Gateway Token。

OpenClaw 配置

在 openclaw.json 中加入：

{
  plugins: {
    allow: ["xingyun-qpm", "admin-http-rpc"],
    entries: {
      "xingyun-qpm": {
        enabled: true,
        config: {
          baseUrl: "https://你的星云接口地址/v1",
          modelId: "你的模型ID",
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
      model: { primary: "xingyun-qpm/你的模型ID" },
      maxConcurrent: 1,
      subagents: { maxConcurrent: 1 }
    }
  }
}

配置项

默认值

说明

baseUrl

环境变量中的地址

星云接口地址。

modelId

环境变量中的模型 ID

使用的星云模型。

requestsPerMinute

17

最近连续 60 秒最多放行的请求数，建议不要直接设为 18。

windowMs

60000

滑动窗口长度，单位为毫秒。

safetyMs

300

窗口边界额外等待时间，单位为毫秒。

notify

true

排队时是否向当前对话发送提示。

notifyResumed

true

额度恢复时是否向当前对话发送提示。

三、限流原理

插件通过 OpenClaw Provider 的 wrapStreamFn 包装每一次真实模型调用。因此同一个 Agent 任务中的多轮模型请求、工具调用后的继续推理以及子 Agent 的模型请求，都会在发往星云之前先申请一个调用额度。

插件使用严格滑动窗口算法：

保存最近 60 秒内已经放行的模型请求时间。

新请求到达时，删除已经超过 60 秒的记录。

如果窗口内请求数少于 17，立即放行。

如果已经达到 17 次，就找到窗口内最早的一次请求。

等到“最早请求时间 + 60 秒 + 300 毫秒安全余量”后，再重新检查并放行。

例如，最近窗口中最早一次请求发生在 12:00:10，当前新请求发生在 12:00:45。最早请求将在 12:01:10 离开 60 秒窗口，加上 300 毫秒安全余量后，新请求预计等待约 25.3 秒。

等待期间插件执行的是一个可取消的异步等待 Promise。它不会返回 HTTP 429，也不会向 OpenClaw 抛出模型调用异常，因此当前 Agent run 会继续保持运行。等待结束后，插件调用原始 streamFn，流式响应、工具调用和任务上下文都会继续沿用原来的 OpenClaw 执行链。

如果用户主动停止任务，OpenClaw 的 AbortSignal 会取消等待，不会在任务取消后继续调用星云模型。

当前限流记录保存在 OpenClaw Gateway 进程内，只适合单 Gateway 实例。如果运行多个 Gateway 进程或多个容器，需要把 RollingWindowLimiter 替换为 Redis 等共享存储实现，否则不同实例无法共享 QPM 计数。

四、用户提示

当请求需要排队时，插件通过 chat.inject 向当前原生对话插入提示：

⏳ 当前模型调用正在限流排队，任务没有中断，预计 23 秒后自动继续。

额度恢复后，插件会提示：

✅ 模型调用额度已恢复，任务正在继续执行。

chat.inject 只会向已有对话写入提示，不会启动新的 Agent turn，因此不会为了显示提示而额外消耗一次模型 QPM。

为了避免刷屏，同一个模型调用最多发送一次“正在限流”提示，不会每秒插入一条倒计时消息。

提示功能与限流功能相互独立。如果 chat.inject 调用失败，插件只记录警告日志，不会中断排队，也不会影响原任务在额度恢复后继续执行。

五、兼容性检查

安装并重启 Gateway 后执行：

openclaw plugins inspect xingyun-qpm --runtime --json
openclaw gateway status --deep --require-rpc

需要确认：

xingyun-qpm 插件已经加载。

Provider xingyun-qpm 已经注册。

Gateway RPC 可以正常访问。

OpenClaw 当前版本的 admin-http-rpc 允许调用 chat.inject。

OpenClaw 的 Provider SDK 和 admin-http-rpc 方法白名单可能随版本变化。如果当前版本不允许通过 admin-http-rpc 调用 chat.inject，限流和任务自动续跑仍然有效，只是原生对话中不会显示提示，Gateway 日志中会出现通知失败警告。

出现这种情况时，可以选择：

为当前固定版本的私有 admin-http-rpc 白名单加入 chat.inject。

将通知模块改为通过 OpenClaw Gateway WebSocket 客户端调用 chat.inject。

设置 notify: false 和 notifyResumed: false，只使用限流排队功能。

本插件目前按 OpenAI Chat Completions 兼容接口实现。如果星云使用 OpenAI Responses API 或 Anthropic Messages API，需要同步调整 Provider 的 api 类型和模型传输配置。
