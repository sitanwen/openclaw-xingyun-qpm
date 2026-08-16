import assert from "node:assert/strict";
import test from "node:test";
import { RollingWindowLimiter, type Clock } from "../src/limiter.js";

class FakeClock implements Clock {
  time = 0;
  now() { return this.time; }
  async sleep(ms: number) { this.time += ms; }
}

test("admits up to the rolling-window limit immediately", async () => {
  const clock = new FakeClock();
  const limiter = new RollingWindowLimiter(2, 60_000, 0, clock);
  assert.deepEqual(await limiter.acquire(), { waitedMs: 0 });
  assert.deepEqual(await limiter.acquire(), { waitedMs: 0 });
});

test("waits until the oldest admission leaves the window", async () => {
  const clock = new FakeClock();
  const notices: number[] = [];
  const limiter = new RollingWindowLimiter(2, 60_000, 300, clock);
  await limiter.acquire();
  clock.time = 10_000;
  await limiter.acquire();
  clock.time = 20_000;
  const result = await limiter.acquire({ onWaiting: ({ waitMs }) => notices.push(waitMs) });
  // 第一次请求发生在 0ms；第三次在 20s 到达。
  // 因此要等到 60s 窗口结束，再加 300ms 安全余量，即等待 40.3s。
  assert.deepEqual(notices, [40_300]);
  assert.deepEqual(result, { waitedMs: 40_300 });
});
