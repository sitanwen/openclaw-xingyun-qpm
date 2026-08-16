export type Notifier = (sessionKey: string, message: string) => Promise<void>;

/**
 * Uses the official Gateway HTTP admin RPC bridge. The bundled admin-http-rpc
 * plugin must be enabled and the Gateway must allow chat.inject on the running
 * OpenClaw release. Notification failure is deliberately non-fatal.
 */
export function createNotifier(options: {
  gatewayUrl: string;
  gatewayToken?: string;
  logger: { warn(message: string): void };
}): Notifier {
  const url = new URL("/api/v1/admin/rpc", options.gatewayUrl).toString();
  return async (sessionKey, message) => {
    try {
      // chat.inject 只向已有会话追加一条 assistant 提示，不会启动新的 Agent turn，
      // 因此不会因为“提示正在限流”又额外消耗一次模型 QPM。
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.gatewayToken ? { authorization: `Bearer ${options.gatewayToken}` } : {}),
        },
        body: JSON.stringify({ method: "chat.inject", params: { sessionKey, message } }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { ok?: boolean; error?: { message?: string } };
      if (!body.ok) throw new Error(body.error?.message ?? "chat.inject failed");
    } catch (error) {
      // 提醒属于辅助功能。即使 Gateway 提醒失败，也绝不能让模型任务中断。
      options.logger.warn(`[xingyun-qpm] user notification failed: ${String(error)}`);
    }
  };
}
