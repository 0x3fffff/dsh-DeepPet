// 集成冒烟：插件用真实 petBinary 拉起桌宠 exe，验证 exe 连上插件的 WS。
// 用法：node test/integration-smoke.mjs
import { apply } from "../plugin/lib/index.js";

const listeners = {};
const logs = [];
const ctx = {
  on: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
  emit: (ev, payload) => { for (const fn of listeners[ev] ?? []) fn(payload); },
  sessionTitle: { get: () => ({ title: "集成测试" }) },
  credentials: { resolve: async () => ({ value: "sk-test", source: "env" }) },
  logger: { info: (m) => logs.push(String(m)), warn: console.warn },
};

const exe = "E:\\Programming tools\\DSH table pet\\dsh-DeepPet\\pet\\src-tauri\\target\\release\\dsh-deep-pet.exe";
const config = {
  enabled: true,
  apiKeyEnv: "DEEPSEEK_API_KEY",
  balanceBaseUrl: "https://api.deepseek.com",
  petBinary: exe,
  petDownloadUrl: "",
  bubbleMs: 5000,
};

const cleanup = apply(ctx, config);

setTimeout(() => {
  const portLine = logs.find((l) => l.includes("ws://127.0.0.1:"));
  const connected = logs.some((l) => l.includes("pet connected"));
  console.log("port log:", portLine ?? "(none)");
  console.log("pet connected:", connected ? "YES" : "NO");
  if (portLine && connected) {
    console.log("PASS: 插件拉起 exe，exe 已连上插件 WS");
    // 触发一次任务完成，确认广播不抛错。
    ctx.emit("agent/status", { agent: { id: "s1", session: { id: "s1" } }, status: "running" });
    ctx.emit("agent/status", { agent: { id: "s1", session: { id: "s1" } }, status: "idle" });
    console.log("task-complete broadcasted without error");
  } else {
    console.log("FAIL: 集成验证未通过");
  }
  cleanup();
  setTimeout(() => process.exit(connected && portLine ? 0 : 1), 800);
}, 6000);
