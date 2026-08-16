import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
import { RollingWindowLimiter } from "./limiter.js";
import { createNotifier } from "./notifier.js";
import { SessionRegistry } from "./session-registry.js";

type Config = {
  baseUrl?: string;
  modelId?: string;
  requestsPerMinute?: number;
  windowMs?: number;
  safetyMs?: number;
  notify?: boolean;
  notifyResumed?: boolean;
};

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "xingyun-qpm",
  name: "Xingyun QPM Queue",
  description: "Queues Xingyun calls without interrupting OpenClaw agent runs.",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as Config;
    const baseUrl = cfg.baseUrl ?? process.env.XINGYUN_BASE_URL ?? "https://api.xingyun.example/v1";
    const modelId = cfg.modelId ?? process.env.XINGYUN_MODEL_ID ?? "xingyun-model";
    // 星云上限为 18 QPM，这里默认只使用 17 个额度，预留 1 个安全余量。
    const limiter = new RollingWindowLimiter(
      cfg.requestsPerMinute ?? 17,
      cfg.windowMs ?? 60_000,
      cfg.safetyMs ?? 300,
    );
    const sessions = new SessionRegistry();
    const notify = createNotifier({
      gatewayUrl: process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789",
      gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN,
      logger: api.logger,
    });
    const notified = new Set<string>();
    let callSequence = 0;

    api.on("before_agent_start", async (_event, ctx) => {
      // Agent 启动时记录 sessionId -> sessionKey，后续限流提示要写回这个会话。
      sessions.begin(ctx);
    });
    api.on("agent_end", async (_event, ctx) => {
      sessions.end(ctx);
    });

    api.registerProvider({
      id: "xingyun-qpm",
      label: "Xingyun (QPM queued)",
      envVars: ["XINGYUN_API_KEY"],
      auth: [createProviderApiKeyAuthMethod({
        providerId: "xingyun-qpm",
        methodId: "api-key",
        label: "Xingyun API key",
        hint: "Xingyun model API key",
        optionKey: "xingyunQpmApiKey",
        flagName: "--xingyun-qpm-api-key",
        envVar: "XINGYUN_API_KEY",
        promptMessage: "Enter your Xingyun API key",
        defaultModel: `xingyun-qpm/${modelId}`,
      })],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey("xingyun-qpm").apiKey;
          if (!apiKey) return null;
          return { provider: {
            baseUrl,
            apiKey,
            api: "openai-completions",
            models: [{
              id: modelId,
              name: `${modelId} (QPM queued)`,
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            }],
          }};
        },
      },
      resolveDynamicModel: (ctx) => ({
        id: ctx.modelId,
        name: ctx.modelId,
        provider: "xingyun-qpm",
        api: "openai-completions",
        baseUrl,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      }),
      wrapStreamFn: (ctx) => {
        if (!ctx.streamFn) return undefined;
        const inner = ctx.streamFn;
        return async (model, context, options) => {
          const sessionId = options?.sessionId;
          const noticeKey = `${sessionId ?? "unknown"}:${++callSequence}`;
          const sessionKey = sessions.resolve(sessionId);
          // wrapStreamFn 会覆盖每一次真实的底层模型调用，包括同一任务内的多轮调用。
          // acquire() 如果没有额度，会保持当前 Promise 等待；不会返回 429，
          // 所以 OpenClaw Agent 不会判定本轮失败，也不需要从头重跑任务。
          const acquired = await limiter.acquire({
            signal: options?.signal,
            onWaiting: async ({ waitMs }) => {
              const seconds = Math.max(1, Math.ceil(waitMs / 1000));
              api.logger.warn(`[xingyun-qpm] queued model call for ${seconds}s`);
              if (cfg.notify !== false && sessionKey && !notified.has(noticeKey)) {
                // 每个模型调用最多发送一次“正在等待”，避免倒计时刷屏和污染上下文。
                notified.add(noticeKey);
                await notify(sessionKey, `⏳ 当前模型调用正在限流排队，任务没有中断，预计 ${seconds} 秒后自动继续。`);
              }
            },
          });
          if (acquired.waitedMs > 0 && cfg.notifyResumed !== false && sessionKey) {
            // 额度恢复后仅提示一次，随后立即执行之前被暂停的原始模型请求。
            await notify(sessionKey, "✅ 模型调用额度已恢复，任务正在继续执行。");
          }
          notified.delete(noticeKey);
          // 这里调用的仍是 OpenClaw 原生 streamFn，流式响应、工具调用和任务上下文
          // 都保持原样；插件只是在请求发出之前增加了一道排队门闩。
          return inner(model, context, options);
        };
      },
    });
  },
});

export default plugin;
