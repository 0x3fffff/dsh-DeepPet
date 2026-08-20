// 插件核心逻辑冒烟测试（mock ctx，不依赖真实 DSH 进程）。
// 用法：node test/plugin-smoke.mjs
import { WebSocket } from "ws";
import { apply } from "../plugin/lib/index.js";

const listeners = {};
const logs = [];
const ctx = {
  on: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
  emit: (ev, payload) => { for (const fn of listeners[ev] ?? []) fn(payload); },
  sessionTitle: { get: () => ({ title: "测试对话" }) },
  credentials: { resolve: async () => ({ value: "sk-test", source: "env" }) },
  logger: { info: (m) => logs.push(String(m)), warn: console.warn },
};

const config = {
  enabled: true,
  apiKeyEnv: "DEEPSEEK_API_KEY",
  balanceBaseUrl: "https://api.deepseek.com",
  petBinary: "", // 不真正拉起桌宠
  petDownloadUrl: "",
  bubbleMs: 5000,
};

const cleanup = apply(ctx, config);
if (typeof cleanup !== "function") {
  console.error("FAIL: apply 未返回 cleanup 函数");
  process.exit(1);
}

setTimeout(async () => {
  try {
    // 从日志里取端口。
    const line = logs.find((l) => l.includes("ws://127.0.0.1:"));
    if (!line) { console.error("FAIL: 未找到 WS 端口日志"); process.exit(1); }
    const port = Number(line.match(/:(\d+)/)?.[1]);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const got = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("超时未收到 task-complete")), 3000);
      ws.on("open", () => {
        // 先触发 running 再触发 idle，模拟一次任务完成。
        ctx.emit("agent/status", { agent: { id: "s1", session: { id: "s1" } }, status: "running" });
        ctx.emit("agent/status", { agent: { id: "s1", session: { id: "s1" } }, status: "idle" });
      });
      ws.on("message", (d) => {
        const m = JSON.parse(String(d));
        clearTimeout(t);
        resolve(m);
      });
      ws.on("error", reject);
    });
    if (got.type === "task-complete" && got.title === "测试对话") {
      console.log("PASS: 收到 task-complete", JSON.stringify(got));
    } else {
      console.error("FAIL: 意外消息", JSON.stringify(got));
      process.exit(1);
    }
    ws.close();
    cleanup();
    process.exit(0);
  } catch (err) {
    console.error("FAIL:", err.message);
    process.exit(1);
  }
}, 500);
