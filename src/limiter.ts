export type Clock = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

export type WaitingNotice = {
  waitMs: number;
  retryAt: number;
  queuePosition: number;
};

export type AcquireOptions = {
  signal?: AbortSignal;
  onWaiting?: (notice: WaitingNotice) => void | Promise<void>;
};

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  }),
};

/**
 * 严格滑动窗口限流器。
 *
 * 这里只串行化“取得调用额度”的过程，不会串行化真正的模型执行过程。
 * 也就是说：拿到额度以后，各模型请求仍然可以并发执行；但任意连续
 * windowMs 时间内，最多只会有 limit 个请求开始。
 */
export class RollingWindowLimiter {
  private admittedAt: number[] = [];
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(
    readonly limit = 17,
    readonly windowMs = 60_000,
    readonly safetyMs = 300,
    private readonly clock: Clock = systemClock,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    if (windowMs < 1) throw new Error("windowMs must be positive");
  }

  acquire(options: AcquireOptions = {}): Promise<{ waitedMs: number }> {
    // 把额度申请接到同一条 Promise 链上，避免两个并发请求同时判断“还有额度”
    // 而发生超发。注意：这里只排队额度申请，不等待模型请求完成。
    const queuePosition = ++this.queued;
    const run = this.tail.then(() => this.admit(queuePosition, options));
    this.tail = run.then(() => undefined, () => undefined);
    return run.finally(() => { this.queued -= 1; });
  }

  private prune(now: number) {
    // 清除已经离开最近 windowMs 滑动窗口的请求时间。
    const cutoff = now - this.windowMs;
    while (this.admittedAt.length && this.admittedAt[0] <= cutoff) this.admittedAt.shift();
  }

  private async admit(queuePosition: number, options: AcquireOptions) {
    options.signal?.throwIfAborted();
    let totalWait = 0;

    for (;;) {
      const now = this.clock.now();
      this.prune(now);
      if (this.admittedAt.length < this.limit) {
        // 当前窗口尚未达到 QPM 上限，记录本次放行时间并立即返回。
        this.admittedAt.push(now);
        return { waitedMs: totalWait };
      }

      // 已达到上限：等最早一次请求离开 60 秒窗口后，才有一个新额度。
      // safetyMs 用来避免本机与上游计时边界存在几百毫秒误差。
      const retryAt = this.admittedAt[0] + this.windowMs + this.safetyMs;
      const waitMs = Math.max(1, retryAt - now);
      await options.onWaiting?.({ waitMs, retryAt, queuePosition });
      // 关键点：这里是 await 等待，并没有抛出 429，也没有结束 Agent run。
      // 等待完成后会回到循环重新检查额度，因此原任务会自动继续。
      await this.clock.sleep(waitMs, options.signal);
      totalWait += waitMs;
    }
  }
}
