// 插件核心逻辑冒烟测试（mock ctx，不依赖真实 DSH 进程）。
// 注意：这里的 mock 是照着代码的期望造的，只能测「代码自洽」。
// 「代码与 DSH 的真实契约一致」由 test/contract.mjs 负责。
// 用法：node test/plugin-smoke.mjs
import { WebSocket } from "ws";
import { apply } from "../plugin/lib/index.js";

const AGENT = { id: "s1", session: { id: "s1" }, status: "idle" };

/**
 * 起一个插件实例，连上去，跑 steps，收集广播到桌宠的消息。
 * @param title sessionTitle.get 的返回；undefined 模拟「标题还没生成」
 */
async function run(title, steps, opts = {}) {
  const listeners = {}, logs = [], got = [];
  const ctx = {
    on: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
    // 变参：session/event 的签名是 (session, event)，不是单一 payload。
    emit: (ev, ...args) => { for (const fn of listeners[ev] ?? []) fn(...args); },
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
  const all = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    all.push(m);
    if (m.type === "task-complete") got.push(m);
  });
  got.all = all;

  steps(ctx);
  await new Promise((r) => setTimeout(r, 300));
  ws.close();
  cleanup();
  return got;
}

const status = (s) => { AGENT.status = s; return { agent: AGENT, status: s }; };
const SESSION = { id: AGENT.id };
/** 造一条 turn/end 的 session 事件。cause 仅在 aborted 时有意义。 */
const turnEnd = (kind, cause) => [SESSION, {
  type: "turn/end", seq: 1, time: Date.now(),
  data: { turn: 1, reason: cause ? { kind, reason: { kind: cause } } : { kind } },
}];
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

// 连续失败计数：桌宠据此换一池更沮丧的台词。数错了不会报错，只会在心情上
// 说反话——所以把三种转移都钉死。
{
  const fail = (ctx) => {
    ctx.emit("agent/status", status("running"));
    ctx.emit("agent/error", { agent: AGENT, turn: 1, step: 1, error: new Error("boom") });
    ctx.emit("agent/status", status("idle"));
  };
  const ok = (ctx) => { ctx.emit("agent/status", status("running")); ctx.emit("agent/status", status("idle")); };
  const got = await run("测试对话", (ctx) => { fail(ctx); fail(ctx); fail(ctx); ok(ctx); fail(ctx); });
  cases.push(["连续失败累加、成功即清零",
    got.map((m) => m.streak).join(",") === "1,2,3,0,1", got.map((m) => `${m.outcome}:${m.streak}`)]);
}

// 「已终止」既不算成功也不算失败：那是用户按的，不该清零也不该累加。
{
  const got = await run("测试对话", (ctx) => {
    ctx.emit("agent/status", status("running"));
    ctx.emit("agent/error", { agent: AGENT, turn: 1, step: 1, error: new Error("boom") });
    ctx.emit("agent/status", status("idle"));            // error, streak 1
    ctx.emit("agent/status", status("running"));
    ctx.emit("session/event", ...turnEnd("aborted", "user"));
    ctx.emit("agent/status", status("idle"));            // canceled, streak 仍是 1
    ctx.emit("agent/status", status("running"));
    ctx.emit("agent/error", { agent: AGENT, turn: 1, step: 1, error: new Error("boom") });
    ctx.emit("agent/status", status("idle"));            // error, streak 2
  });
  cases.push(["终止不影响连续失败计数",
    got.map((m) => m.streak).join(",") === "1,1,2", got.map((m) => `${m.outcome}:${m.streak}`)]);
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

// 用户点「终止对话」：不发 agent/error，只在 turn/end 上留 aborted/user
{
  const got = await run("测试对话", (ctx) => {
    ctx.emit("agent/status", status("running"));
    ctx.emit("session/event", ...turnEnd("aborted", "user"));
    ctx.emit("agent/status", status("idle"));
  });
  cases.push(["用户终止 → canceled",
    got.length === 1 && got[0].outcome === "canceled", got]);
}

// turn/end 里的 error 同样要能判成失败（有些失败不发 agent/error）
{
  const got = await run("测试对话", (ctx) => {
    ctx.emit("agent/status", status("running"));
    ctx.emit("session/event", ...turnEnd("error"));
    ctx.emit("agent/status", status("idle"));
  });
  cases.push(["turn/end error → error", got.length === 1 && got[0].outcome === "error", got]);
}

// 出错优先于终止
{
  const got = await run("测试对话", (ctx) => {
    ctx.emit("agent/status", status("running"));
    ctx.emit("session/event", ...turnEnd("aborted", "user"));
    ctx.emit("agent/error", { agent: AGENT, turn: 1, step: 1, error: new Error("boom") });
    ctx.emit("agent/status", status("idle"));
  });
  cases.push(["出错优先于终止", got.length === 1 && got[0].outcome === "error", got]);
}

// disposed 中止（通常是 DSH 正在退出）应当完全不播报，而不是庆祝
{
  const got = await run("测试对话", (ctx) => {
    ctx.emit("agent/status", status("running"));
    ctx.emit("session/event", ...turnEnd("aborted", "disposed"));
    ctx.emit("agent/status", status("idle"));
  });
  cases.push(["disposed 中止 → 完全不播报", got.length === 0, got]);
}

// completed 正常收尾不受影响
{
  const got = await run("测试对话", (ctx) => {
    ctx.emit("agent/status", status("running"));
    ctx.emit("session/event", ...turnEnd("completed"));
    ctx.emit("agent/status", status("idle"));
  });
  cases.push(["turn/end completed → success", got.length === 1 && got[0].outcome === "success", got]);
}

// 工作态：running 时报 active:true，回到 idle 报 false
{
  const got = await run("测试对话", finish);
  const w = got.all.filter((m) => m.type === "working").map((m) => m.active);
  cases.push(["工作态 true → false", JSON.stringify(w.slice(-2)) === "[true,false]", w]);
}

// 桌宠连上时补发当前状态——它可能在 DSH 已经跑着任务时才启动
{
  const got = await run("测试对话", (ctx) => { ctx.emit("agent/status", status("running")); });
  const first = got.all.find((m) => m.type === "working");
  cases.push(["连接时补发工作态", first !== undefined, got.all.slice(0, 2)]);
}

// 进度：工具调用（脱敏细节由 test/redact.mjs 覆盖）
{
  const got = await run("测试对话", (ctx) => {
    ctx.emit("agent/status", status("running"));
    ctx.emit("session/event", SESSION, {
      type: "tool/call", seq: 2, time: Date.now(),
      data: { turn: 1, step: 1, callId: "c1", name: "edit", arguments: JSON.stringify({ file_path: "src/main.ts" }) },
    });
  });
  const p = got.all.find((m) => m.type === "progress");
  cases.push(["tool/call → 进度气泡", p?.text === "🧑‍💻 正在修改 main.ts", p]);
}

// 进度：插件**不做**限流，每一条都发，并带上 kind/tool 供桌宠侧仲裁。
// 遮蔽判定曾经在插件里，被压掉的事件就此消失，测试面板因此永远看不到
// 「有过这个事件、但被丢了」。限流现在集中在桌宠侧（main.ts 的 onProgress）。
{
  const got = await run("测试对话", (ctx) => {
    ctx.emit("agent/status", status("running"));
    ctx.emit("session/event", SESSION, {
      type: "todo/write", seq: 2, time: Date.now(),
      data: { todos: [{ content: "重写呈现层", status: "in_progress" }, { content: "别的", status: "pending" }] },
    });
    ctx.emit("session/event", SESSION, {
      type: "tool/call", seq: 3, time: Date.now(),
      data: { turn: 1, step: 1, callId: "c1", name: "edit", arguments: JSON.stringify({ file_path: "x.ts" }) },
    });
  });
  const ps = got.all.filter((m) => m.type === "progress");
  cases.push(["todo 与随后的工具进度都下发，不在插件侧丢弃",
    ps.length === 2
    && ps[0].kind === "todo" && ps[0].text === "🧠 重写呈现层"
    && ps[1].kind === "tool" && ps[1].text === "🧑‍💻 正在修改 x.ts",
    ps]);
  // 工具名要原样带上：测试面板的日志靠它认出 think/pwsh 这类没有专属文案的
  // 工具，而气泡文本里只有「正在使用 xxx」的截断版本。
  cases.push(["工具进度带上未截断的工具名", ps[1]?.tool === "edit", ps[1]]);
}

// think 有专属文案（思考中），pwsh 走命令文案；两者都要非空下发。
{
  const got = await run("测试对话", (ctx) => {
    ctx.emit("agent/status", status("running"));
    for (const name of ["think", "pwsh"]) {
      ctx.emit("session/event", SESSION, {
        type: "tool/call", seq: 2, time: Date.now(),
        data: { turn: 1, step: 1, callId: "c1", name, arguments: "{}" },
      });
    }
  });
  const ps = got.all.filter((m) => m.type === "progress");
  cases.push(["think → 思考中、pwsh → 执行命令",
    ps.length === 2
    && ps[0].tool === "think" && ps[0].text === "🧠 思考中..."
    && ps[1].tool === "pwsh" && ps[1].text === "🔧 正在执行命令",
    ps.map((p) => `${p.tool}: ${p.text}`)]);
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
