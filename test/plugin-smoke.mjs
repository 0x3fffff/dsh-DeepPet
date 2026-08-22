// 插件核心逻辑冒烟测试（mock ctx，不依赖真实 DSH 进程）。
// 注意：这里的 mock 是照着代码的期望造的，只能测「代码自洽」。
// 「代码与 DSH 的真实契约一致」由 test/contract.mjs 负责。
// 用法：node test/plugin-smoke.mjs
import { WebSocket } from "ws";
import { apply } from "../plugin/lib/index.js";

const AGENT = { id: "s1", session: { id: "s1" } };

/**
 * 起一个插件实例，连上去，跑 steps，收集广播到桌宠的消息。
 * @param title sessionTitle.get 的返回；undefined 模拟「标题还没生成」
 */
async function run(title, steps, opts = {}) {
  const listeners = {}, logs = [], got = [];
  const ctx = {
    on: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
    emit: (ev, payload) => { for (const fn of listeners[ev] ?? []) fn(payload); },
    sessionTitle: { get: () => (title === undefined ? undefined : { title }) },
    // 默认这个 agent 就是顶层；传 roots: [] 模拟子 agent。
    agents: { roots: () => opts.roots ?? [AGENT] },
    credentials: { resolve: async () => ({ value: "sk-test", source: "env" }) },
    logger: { info: (m) => logs.push(String(m)), warn: () => {} },
  };
  const cleanup = apply(ctx, {
    enabled: true,
    apiKeyEnv: "DEEPSEEK_API_KEY",
    balanceBaseUrl: "https://api.deepseek.com",
    petBinary: "___no_such_binary___", // 只测消息，不真的拉起桌宠
    label: opts.label ?? "",
    logEvents: false,
  });

  await new Promise((r) => setTimeout(r, 400));
  const port = Number(logs.find((l) => l.includes("ws://"))?.match(/:(\d+)/)?.[1]);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.on("open", r));
  ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.type === "task-complete") got.push(m); });

  steps(ctx);
  await new Promise((r) => setTimeout(r, 300));
  ws.close();
  cleanup();
  return got;
}

const status = (s) => ({ agent: AGENT, status: s });
const finish = (ctx) => { ctx.emit("agent/status", status("running")); ctx.emit("agent/status", status("idle")); };

const cases = [];

// 正常完成
{
  const got = await run("测试对话", finish);
  cases.push(["正常完成 → success + 标题",
    got.length === 1 && got[0].outcome === "success" && got[0].title === "测试对话", got]);
}

// 运行期间报错
{
  const got = await run("测试对话", (ctx) => {
    ctx.emit("agent/status", status("running"));
    ctx.emit("agent/error", { agent: AGENT, turn: 1, step: 1, error: new Error("boom") });
    ctx.emit("agent/status", status("idle"));
  });
  cases.push(["运行中报错 → error",
    got.length === 1 && got[0].outcome === "error", got]);
}

// 标题还没生成：不能静默跳过
{
  const got = await run(undefined, finish);
  cases.push(["无标题仍然报喜（title 为空串）",
    got.length === 1 && got[0].outcome === "success" && got[0].title === "", got]);
}

// 上一轮的失败标记不能渗到下一轮
{
  const got = await run("测试对话", (ctx) => {
    ctx.emit("agent/status", status("running"));
    ctx.emit("agent/error", { agent: AGENT, turn: 1, step: 1, error: new Error("boom") });
    ctx.emit("agent/status", status("idle"));   // 第一轮：error
    ctx.emit("agent/status", status("running"));
    ctx.emit("agent/status", status("idle"));   // 第二轮：应当是 success
  });
  cases.push(["失败标记不跨轮次残留",
    got.length === 2 && got[0].outcome === "error" && got[1].outcome === "success", got]);
}

// 子 agent 不该庆祝：一个任务内部派三个子 agent 会庆祝四次
{
  const got = await run("测试对话", finish, { roots: [] });
  cases.push(["子 agent 不触发庆祝", got.length === 0, got]);
}

// label 用于在一只桌宠服务多个 profile 时区分来源
{
  const got = await run("测试对话", finish, { label: "web" });
  cases.push(["label 随消息下发", got.length === 1 && got[0].label === "web", got]);
}

// 没有前置 running 的 idle 不该触发（例如启动时的初始状态广播）
{
  const got = await run("测试对话", (ctx) => { ctx.emit("agent/status", status("idle")); });
  cases.push(["孤立的 idle 不触发", got.length === 0, got]);
}

let ok = true;
for (const [label, good, got] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${label}${good ? "" : ` -> ${JSON.stringify(got)}`}`);
}
console.log(ok ? "PASS: 插件冒烟通过" : "FAIL: 插件冒烟未通过");
process.exit(ok ? 0 : 1);
