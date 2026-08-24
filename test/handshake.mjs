// 协议版本握手回归测试：桌宠连上后必须报版本，插件对不兼容要出声。
// 用法：node test/handshake.mjs
import { WebSocket } from "ws";
import { createRequire } from "node:module";
import { apply } from "../plugin/lib/index.js";

const { version: VERSION } = createRequire(import.meta.url)("../plugin/package.json");

function makeCtx(logs, warns) {
  const listeners = {};
  return {
    on: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
    sessionTitle: { get: () => ({ title: "t" }) },
    credentials: { resolve: async () => ({ value: "sk", source: "env" }) },
    logger: { info: (m) => logs.push(String(m)), warn: (m) => warns.push(String(m)) },
    // 纯 CLI 的 DSH：没有网页端的 connection 服务，回调不该被调用。
    get: () => undefined,
    inject: () => {},
  };
}

// petBinary 指向一个不存在的路径：只测握手，不真的拉起桌宠窗口。
const config = {
  enabled: true,
  apiKeyEnv: "DEEPSEEK_API_KEY",
  balanceBaseUrl: "https://api.deepseek.com",
  petBinary: "___no_such_binary___",
};

/** 跑一个假桌宠连上去，返回插件发出的版本相关警告。 */
async function scenario(onOpen, waitMs) {
  const logs = [], warns = [];
  const cleanup = apply(makeCtx(logs, warns), config);
  await new Promise((r) => setTimeout(r, 400));
  const port = Number(logs.find((l) => l.includes("ws://"))?.match(/:(\d+)/)?.[1]);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.on("open", r));
  onOpen(ws);
  await new Promise((r) => setTimeout(r, waitMs));
  ws.close();
  cleanup();
  return warns.filter((w) => w.includes("版本"));
}

const hello = (v) => (ws) => ws.send(JSON.stringify({ type: "hello", version: v }));
const HELLO_TIMEOUT_MS = 3600;

const cases = [
  ["版本不符应报警", await scenario(hello("0.0.1"), 600), true],
  ["旧二进制不报版本应报警", await scenario(() => {}, HELLO_TIMEOUT_MS), true],
  ["版本一致应静默", await scenario(hello(VERSION), HELLO_TIMEOUT_MS), false],
];

let ok = true;
for (const [label, hits, want] of cases) {
  const got = hits.length > 0;
  if (got !== want) ok = false;
  console.log(`${got === want ? "PASS" : "FAIL"} ${label}${hits[0] ? ` -> ${hits[0]}` : ""}`);
}
console.log(ok ? "PASS: 握手回归通过" : "FAIL: 握手回归未通过");
process.exit(ok ? 0 : 1);
