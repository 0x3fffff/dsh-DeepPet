// 台词的触发与频率（Windows，需要真实桌宠 exe）。
//
// 台词最容易出的两种错都不会报异常，只会「感觉不对」：该说的时候不说、
// 不该说的时候一直说。所以这里驱动真实信号，直接读桌宠报出来的气泡内容。
//
// 覆盖：完成/出错各自从对应池里抽、连续失败换池、开场白带冷却、
// 关掉开关后回到纯信息播报。
// 用法：node test/speech.mjs
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const lines = JSON.parse(readFileSync(join(root, "assets", "台词.json"), "utf8"));
const poolTexts = (pool) => new Set(lines[pool].map((l) => l.t));

const PORT = 18813;
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
const connected = new Promise((r) => wss.on("connection", r));
const pet = spawn(exe, [], {
  env: { ...process.env, DSH_PET_WS_URL: `ws://127.0.0.1:${PORT}`, DSH_PET_DEBUG: "1" },
  stdio: "ignore",
  windowsHide: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(ws, msg, want) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`等 ${want} 超时`)), 8000);
    const on = (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m[want] === undefined) return;
      clearTimeout(to);
      ws.off("message", on);
      resolve(m[want]);
    };
    ws.on("message", on);
    ws.send(JSON.stringify(msg));
  });
}

const cases = [];
let ws;
let saved = null;
try {
  ws = await waitForPet(pet, connected);
  await sleep(2200);
  const drive = (p) => ws.send(JSON.stringify({ type: "debug-test", payload: p }));
  drive({ cmd: "edge", side: null });
  await sleep(400);
  saved = await ask(ws, { type: "debug-settings" }, "settings");
  const bubble = async () => (await ask(ws, { type: "debug-layout" }, "layout")).bubbleText;

  // ---- 完成：台词当主角，标题降为副行 ----
  drive({ cmd: "complete", outcome: "success", title: "重构气泡布局" });
  await sleep(700);
  let b = await bubble();
  cases.push([`完成时说的是台词（${JSON.stringify(b)}）`, poolTexts("done").has(b?.main), b]);
  cases.push(["标题降为副行且仍可见", (b?.sub ?? "").includes("重构气泡布局"), b]);

  // ---- 出错 ----
  drive({ cmd: "reset" });
  await sleep(500);
  drive({ cmd: "complete", outcome: "error", title: "修 WS 重连", streak: 1 });
  await sleep(700);
  b = await bubble();
  cases.push([`出错时用 error 池（${JSON.stringify(b?.main)}）`, poolTexts("error").has(b?.main), b]);

  // ---- 连续失败换池 ----
  drive({ cmd: "reset" });
  await sleep(500);
  drive({ cmd: "complete", outcome: "error", title: "修 WS 重连", streak: 3 });
  await sleep(700);
  b = await bubble();
  cases.push([`连续失败换 streak 池（${JSON.stringify(b?.main)}）`, poolTexts("streak").has(b?.main), b]);
  // 表情必须来自**这一条**台词的 face 标签。各抽各的就会出现「我是不是很笨」
  // 配一张晕脸——第一版就是这样，截图才看出来。
  {
    const want = lines.streak.find((l) => l.t === b?.main)?.face;
    const shown = (await ask(ws, { type: "debug-layout" }, "layout")).still;
    cases.push([`表情跟着这条台词走（期望 ${want}，实际 ${shown}）`,
      !!want && shown === want, { want, shown, line: b?.main }]);
  }

  // ---- 不连着抽到同一句 ----
  const seen = [];
  for (let i = 0; i < 6; i++) {
    drive({ cmd: "reset" });
    await sleep(400);
    drive({ cmd: "complete", outcome: "success", title: "任务" });
    await sleep(600);
    seen.push((await bubble())?.main);
  }
  let repeated = false;
  for (let i = 1; i < seen.length; i++) if (seen[i] === seen[i - 1]) repeated = true;
  cases.push([`连抽 6 次没有相邻重复`, !repeated, seen]);
  cases.push([`连抽 6 次至少出现 3 种说法`, new Set(seen).size >= 3, seen]);

  // ---- 开场白不能把打字动画顶掉 ----
  // 第一版就是这么坏的：setWorking 同一个 tick 里先 render() 发起
  // playAction("typing-intro")，紧接着 speak() 里的 showStill 又 ++playGen
  // 把它作废，于是任务开始后好几秒不打字。而开场白有 3 分钟冷却，只有隔了
  // 一阵的第一个任务才会这样——这种间歇性缺陷，不专门测就只能等用户来报。
  drive({ cmd: "reset" });
  await sleep(600);
  drive({ cmd: "working", active: true });
  await sleep(1600); // 800ms 防抖 + 交接
  const w = await ask(ws, { type: "debug-layout" }, "layout");
  cases.push([`任务开始后立刻在播打字动画（action=${JSON.stringify(w.action)}）`,
    w.action === "typing-intro" || w.action === "typing-loop", w]);
  cases.push([`开场白同时出现在气泡里（${JSON.stringify(w.bubbleText?.main)}）`,
    poolTexts("start").has(w.bubbleText?.main), w.bubbleText]);
  drive({ cmd: "working", active: false });
  await sleep(500);

  // ---- 关掉开关：回到纯信息播报 ----
  await ask(ws, { type: "debug-settings", set: { ...saved, lines: false } }, "settings");
  await sleep(500);
  drive({ cmd: "reset" });
  await sleep(400);
  drive({ cmd: "complete", outcome: "success", title: "重构气泡布局" });
  await sleep(700);
  b = await bubble();
  cases.push([`关掉台词后回到信息播报（${JSON.stringify(b?.main)}）`,
    (b?.main ?? "").includes("重构气泡布局") && !b?.sub, b]);
} catch (err) {
  cases.push(["验证跑完", false, String(err.message ?? err)]);
} finally {
  try { if (ws && saved) await ask(ws, { type: "debug-settings", set: saved }, "settings"); } catch {}
  try { ws?.close(); } catch {}
  wss.close();
  try { pet.kill(); } catch {}
}

let ok = true;
for (const [label, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${label}${good ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: 台词触发与频率符合预期" : "FAIL: 台词有问题");
process.exit(ok ? 0 : 1);
