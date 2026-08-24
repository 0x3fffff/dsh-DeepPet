// 进度气泡的限流判定（Windows，需要真实桌宠 exe）。
//
// 起因：任务里的 think / pwsh 从来看不到气泡。原因是两级静默叠加——插件侧
// 一条 todo 之后压住后续 6 秒的 tool/call，桌宠侧每条气泡再占 2.5s+5s 冷却，
// 一个 turn 里最靠前的那几个工具调用整个落进盲区。限流现在集中在桌宠侧，
// 这里就断言它每一次的判定。
// 用法：node test/progress.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { skipIfPetRunning, waitForPet } from "./lib/wait-pet.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.env.DSH_PET_BINARY
  || join(root, "packages", "win32-x64", "bin", "dsh-deep-pet.exe");

if (process.platform !== "win32") {
  console.log("SKIP: 目前只实现了 Windows 版");
  process.exit(0);
}
if (!existsSync(exe)) {
  console.log("SKIP: 未找到已入包的桌宠二进制；先跑 scripts/stage-binary.mjs");
  process.exit(0);
}

// 已经有一只桌宠在跑的话，这里拉起的那只会抢不到单例锁而立刻自杀。
skipIfPetRunning();

const PORT = 18782;
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
const connected = new Promise((r) => wss.on("connection", r));
const pet = spawn(exe, [], {
  env: { ...process.env, DSH_PET_WS_URL: `ws://127.0.0.1:${PORT}`, DSH_PET_DEBUG: "1" },
  stdio: "ignore",
  windowsHide: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeout = (ms, msg) => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms));

function ask(ws, msg, want) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`等 ${want} 超时`)), 5000);
    const on = (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m[want] === undefined) return;
      clearTimeout(to); ws.off("message", on); resolve(m[want]);
    };
    ws.on("message", on);
    ws.send(JSON.stringify(msg));
  });
}

const cases = [];
try {
  const ws = await waitForPet(pet, connected);
  await sleep(1500);
  // 进度气泡只在工作态显示。防抖 800ms，多等一点。
  ws.send(JSON.stringify({ type: "working", active: true }));
  await sleep(1200);
  await ask(ws, { type: "debug-trace", clear: true }, "trace");

  const prog = (tool, text, kind = "tool") =>
    ws.send(JSON.stringify({ type: "progress", kind, tool, text }));

  // 第一条工具进度应当直接显示。
  prog("think", "🧠 正在思考解决方案");
  await sleep(400);
  // 一条 todo 之后紧跟的工具进度要让位（这是唯一该被丢的一条）。
  prog("", "🧠 重写呈现层", "todo");
  await sleep(80);
  prog("pwsh", "🔧 正在执行 npm 命令");
  // 遮蔽窗口 2s + 显示 3s + 冷却 1.5s，等透。
  await sleep(7200);
  // 遮蔽期过了，pwsh 再来一次必须能显示——这正是从前永远看不到的那一条。
  prog("pwsh", "🔧 正在执行 git 命令");
  // 一条气泡占 3s 显示 + 1.5s 冷却，下一条最坏要等满这 4.5s 才轮到。
  await sleep(5000);

  const tr = await ask(ws, { type: "debug-trace" }, "trace");
  for (const e of tr) console.log(`  ${e.tool || "—"} | ${e.text} | ${e.result}`);

  const shown = tr.filter((e) => e.result === "已显示").map((e) => e.tool);
  const shadowed = tr.filter((e) => e.result === "被 todo 遮蔽").map((e) => e.tool);

  cases.push(["think 能显示", shown.includes("think"), shown]);
  cases.push(["pwsh 能显示", shown.includes("pwsh"), shown]);
  cases.push(["紧跟 todo 的那条被让位", shadowed.includes("pwsh"), shadowed]);
  // 每一条都必须有去向。没有记录的事件才是真正查不出来的那种。
  cases.push(["每条进度都有明确去向", tr.length >= 3 && tr.every((e) => e.result), tr.length]);
} catch (e) {
  cases.push(["进度验证执行完成", false, String(e.message ?? e)]);
} finally {
  try { pet.kill(); } catch {}
  wss.close();
}

let ok = true;
for (const [name, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: 进度限流判定符合预期" : "FAIL: 进度限流未通过");
setTimeout(() => process.exit(ok ? 0 : 1), 500);
