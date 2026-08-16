export class SessionRegistry {
  // Provider 的模型调用只携带 sessionId；chat.inject 需要 sessionKey。
  // 所以在 Agent 启动时保存二者映射，限流发生时才能通知正确的对话。
  private readonly bySessionId = new Map<string, string>();
  private latestSessionKey?: string;

  begin(ctx: { sessionId?: string; sessionKey?: string }) {
    if (!ctx.sessionKey) return;
    this.latestSessionKey = ctx.sessionKey;
    if (ctx.sessionId) this.bySessionId.set(ctx.sessionId, ctx.sessionKey);
  }

  end(ctx: { sessionId?: string; sessionKey?: string }) {
    if (ctx.sessionId) this.bySessionId.delete(ctx.sessionId);
    if (ctx.sessionKey && this.latestSessionKey === ctx.sessionKey) this.latestSessionKey = undefined;
  }

  resolve(sessionId?: string): string | undefined {
    // 正常情况下通过 sessionId 精确定位。latestSessionKey 只用于
    // maxConcurrent=1 时的兼容回退，多任务并发部署不应依赖这个回退。
    return (sessionId && this.bySessionId.get(sessionId)) || this.latestSessionKey;
  }
}
