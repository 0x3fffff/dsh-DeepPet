// 集成冒烟：插件拉起真实桌宠 exe，验证 exe 连上插件的 WS 并完成版本握手。
// 需要先编译 + 入包：cd pet && pnpm build && pnpm tauri build --no-bundle
//                    node scripts/stage-binary.mjs
// 用法：node test/integration-smoke.mjs
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apply } from "../plugin/lib/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BINARIES = {
  "win32-x64": join(root, "packages", "win32-x64", "bin", "dsh-deep-pet.exe"),
};

const key = `${process.platform}-${process.arch}`;
const exe = process.env.DSH_PET_BINARY || BINARIES[key];
if (!exe || !existsSync(exe)) {
  console.log(`SKIP: 未找到已入包的桌宠二进制（${exe ?? key}）；先跑 scripts/stage-binary.mjs`);
  process.exit(0);
}

const listeners = {};
const logs = [];
const warns = [];
const ctx = {
  on: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
  // 变参：session/event 的签名是 (session, event)，不是单一 payload。
    emit: (ev, ...args) => { for (const fn of listeners[ev] ?? []) fn(...args); },
  sessionTitle: { get: () => ({ title: "集成测试" }) },
  credentials: { resolve: async () => ({ value: "sk-test", source: "env" }) },
  logger: { info: (m) => logs.push(String(m)), warn: (m) => warns.push(String(m)) },
};

const config = {
  enabled: true,
  apiKeyEnv: "DEEPSEEK_API_KEY",
  balanceBaseUrl: "https://api.deepseek.com",
  petBinary: exe,
};

const cleanup = apply(ctx, config);

setTimeout(() => {
  const portLine = logs.find((l) => l.includes("ws://127.0.0.1:"));
  const connected = logs.some((l) => l.includes("pet connected"));
  // 版本一致时握手必须完全静默——有版本警告说明二进制与插件源码不同步。
  const versionWarn = warns.find((w) => w.includes("版本"));
  console.log("port log:", portLine ?? "(none)");
  console.log("pet connected:", connected ? "YES" : "NO");
  console.log("version handshake:", versionWarn ? `WARN -> ${versionWarn}` : "clean");
  const ok = Boolean(portLine) && connected && !versionWarn;
  if (ok) {
    console.log("PASS: 插件拉起 exe、exe 已连上并完成握手");
    ctx.emit("agent/status", { agent: { id: "s1", session: { id: "s1" } }, status: "running" });
    ctx.emit("agent/status", { agent: { id: "s1", session: { id: "s1" } }, status: "idle" });
    console.log("task-complete broadcasted without error");
  } else {
    console.log("FAIL: 集成验证未通过");
  }
  cleanup();
  setTimeout(() => process.exit(ok ? 0 : 1), 800);
}, 6000);
