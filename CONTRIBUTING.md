# 参与维护

## 本地开发

```bash
npm ci
npm run check
```

主要源码位于 `src/`：

- `index.ts`：注册 OpenClaw Provider、生命周期 Hook 和模型流包装器。
- `limiter.ts`：严格滑动窗口限流与可取消等待。
- `session-registry.ts`：把模型调用的 `sessionId` 映射回对话 `sessionKey`。
- `notifier.ts`：通过 `chat.inject` 向原生对话写入状态提示。

修改限流算法时，请同时补充 `test/limiter.test.ts`。提交前必须保证：

```bash
npm run check
```

全部通过。

## 发布安装包

更新 `package.json` 版本号后执行：

```bash
npm ci
npm run check
npm pack
```

生成的 `.tgz` 是 OpenClaw 安装包；GitHub 仓库本身仍然保存完整源码。
