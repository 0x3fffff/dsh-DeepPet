// 余额提醒的端到端（Windows，需要真实桌宠 exe）。
//
// 迟滞规则本身在 test/balance-alert.mjs 里钉死了，那是纯算术。这里测的是
// 另一半——**装到桌宠身上之后还成不成立**：动画真的播了没有、气泡真的跟着
// 延长到 8 秒没有、工作中真的没停下来演没有、关掉开关真的闭嘴了没有。
// 这些只有跑起来才知道，而这个项目在动画交接上已经栽过两次（闪动、白帧）。
//
// 注入走 debug-balance，它调的是**真实的 onBalance**——同一个状态机、同一套
// 排队规则、同一段播放代码。绕开它们的话测的就是一条只在测试里存在的旁路。
// 用法：node test/balance.mjs
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
skipIfPetRunning();

const lines = JSON.parse(readFileSync(join(root, "assets", "台词.json"), "utf8"));
const lowTexts = new Set(lines["low-balance"].map((l) => l.t));

const PORT = 18817;
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
const push = (name, ok, detail) => cases.push([name, ok, detail]);
let ws;
let saved = null;

// 阈值和气泡时长都由测试自己定死，不拿用户存盘的值当基准——size.mjs 就是
// 因为拿用户设置当 100% 基线而在别人机器上假红过。
const THRESHOLD = 5;
const BUBBLE_MS = 3000; // 故意短于动画的 8 秒，好证明气泡真的被延长了

try {
  ws = await waitForPet(pet, connected);
  await sleep(2200);
  const drive = (p) => ws.send(JSON.stringify({ type: "debug-test", payload: p }));
  drive({ cmd: "edge", side: null }); // 别贴边，否则走的是「只出气泡」那条分支
  await sleep(400);

  saved = await ask(ws, { type: "debug-settings" }, "settings");
  const base = {
    ...saved, lines: true, sound: false, bubble_ms: BUBBLE_MS,
    balance_alert: true, balance_threshold: THRESHOLD,
  };
  await ask(ws, { type: "debug-settings", set: base }, "settings");
  await sleep(400);

  const layout = () => ask(ws, { type: "debug-layout" }, "layout");
  const reset = async () => {
    await ask(ws, { type: "debug-reset-balance" }, "balance");
    await sleep(300);
  };
  /** 注入一个余额读数，返回桌宠报回来的余额内部状态。 */
  const feed = (amount, currency = "CNY") =>
    ask(ws, { type: "debug-balance", amount, currency }, "balance");

  // ---- 余额充足：什么都不该发生 ----
  await reset();
  await feed(50);
  await sleep(500);
  {
    const l = await layout();
    push("余额充足时不播动画", l.action !== "low-balance", l.action);
    push("余额充足时不弹气泡", !l.bubbleShown, l.bubbleText);
  }

  // ---- 跌破阈值：全套播报 ----
  await feed(3.2);
  await sleep(700);
  let low;
  {
    const l = await layout();
    low = l;
    push(`跌破阈值时播 low-balance 动画（action=${JSON.stringify(l.action)}）`,
      l.action === "low-balance", l.action);
    push(`主行是 low-balance 池的台词（${JSON.stringify(l.bubbleText?.main)}）`,
      lowTexts.has(l.bubbleText?.main), l.bubbleText);
    push(`副行报出具体金额（${JSON.stringify(l.bubbleText?.sub)}）`,
      (l.bubbleText?.sub ?? "").includes("3.2") && (l.bubbleText?.sub ?? "").includes("¥"),
      l.bubbleText);
    push("气泡此刻可见", l.bubbleShown === true, l);
  }

  // ---- 气泡跟着 8 秒动画延长，而不是按 bubble_ms 收 ----
  // bubble_ms 设成了 3 秒。4.5 秒时气泡若已经收了，就是没延长——那时桌宠
  // 会在无声比划后半段，你已经不知道她在说什么。
  await sleep(4500 - 700);
  {
    const l = await layout();
    push(`bubble_ms(${BUBBLE_MS}ms) 之后气泡仍挂着（已过 4.5s）`, l.bubbleShown === true, l);
    push("此时动画仍是 low-balance", l.action === "low-balance", l.action);
  }
  // 8 秒之后该收干净、回到空闲。
  await sleep(4200);
  {
    const l = await layout();
    push("8 秒后气泡收起", l.bubbleShown === false, l);
    push(`8 秒后回到空闲（shown=${JSON.stringify(l.shown)}）`,
      l.shown !== "lowBalance", l.shown);
  }

  // ---- 迟滞：锁定后不再重复打扰 ----
  // 这是整个功能的成败所在。坏掉的表现不是报错，是每 10 分钟响一次。
  for (const amt of [3.1, 3.0, 2.9]) {
    await feed(amt);
    await sleep(400);
  }
  {
    const l = await layout();
    push("锁定后连喂三次低余额都不再播动画", l.action !== "low-balance", { action: l.action });
    push("锁定后也不再弹气泡", !l.bubbleShown, l.bubbleText);
  }

  // ---- 跌到 0.4 倍：允许补报最后一次 ----
  await feed(THRESHOLD * 0.4 - 0.1);
  await sleep(700);
  {
    const l = await layout();
    push(`跌到 ¥${(THRESHOLD * 0.4 - 0.1).toFixed(1)} 补报一次`, l.action === "low-balance", l.action);
  }
  await sleep(8200);
  await feed(1.0);
  await sleep(600);
  push("补报之后彻底闭嘴", (await layout()).action !== "low-balance");

  // ---- 充值回升到 1.2 倍：重新武装 ----
  await feed(THRESHOLD * 1.2 + 1);
  await sleep(500);
  push("充值那一次本身不该报警", (await layout()).action !== "low-balance");
  await feed(4);
  await sleep(700);
  push("重新武装后再跌破可以再报", (await layout()).action === "low-balance");
  await sleep(8200);

  // ---- 音效真的响了没有 ----
  //
  // 这一条是补上来的：原来整个文件都跑在 sound:false 下（图安静），于是
  // 「音效」这半从没被验证过，而它恰恰坏了——自动播放解锁自己的 pause()
  // 会把刚起的播放掐掉，全程不报错。
  //
  // 判据用 currentTime 前进而不是 !paused：paused 为 false 只说明「请求了
  // 播放」，被策略拦下时它照样是 false；currentTime 动了才是真的在出声。
  await reset();
  await ask(ws, { type: "debug-settings", set: { ...base, sound: true } }, "settings");
  await sleep(400);
  await feed(2.2);
  await sleep(1500);
  {
    const l = await layout();
    const a = l.audio?.low;
    push(`余额提醒的音频元素已创建（${JSON.stringify(a && a.src)}）`, !!a, l.audio);
    push("音频没有加载错误", !a || a.error === null, a);
    push(`音效真的在播（currentTime=${a?.currentTime}，paused=${a?.paused}）`,
      !!a && a.paused === false && a.currentTime > 0, a);
  }
  await sleep(7000); // 让 8 秒那段播完，别和后面的用例串味
  await ask(ws, { type: "debug-settings", set: base }, "settings");
  await sleep(300);

  // ---- 工作中：只出气泡，不停下来演 ----
  await reset();
  drive({ cmd: "working", active: true });
  await sleep(1800); // 800ms 防抖 + 打字动画交接
  await feed(2.5);
  await sleep(700);
  {
    const l = await layout();
    push(`工作中不打断打字动画（action=${JSON.stringify(l.action)}）`,
      l.action === "typing-intro" || l.action === "typing-loop", l.action);
    push(`工作中仍然出气泡（${JSON.stringify(l.bubbleText?.main)}）`,
      l.bubbleShown === true && lowTexts.has(l.bubbleText?.main), l.bubbleText);
  }
  drive({ cmd: "working", active: false });
  await sleep(1200);

  // ---- 关掉开关：彻底闭嘴 ----
  await reset();
  await ask(ws, { type: "debug-settings", set: { ...base, balance_alert: false } }, "settings");
  await sleep(400);
  await feed(0.5);
  await sleep(700);
  {
    const l = await layout();
    push("关掉开关后不播动画", l.action !== "low-balance", l.action);
    push("关掉开关后不弹气泡", !l.bubbleShown, l.bubbleText);
  }

  // ---- 退出 DSH 的消息真的发得出去 ----
  //
  // 静态断言只能证明代码里写着这几行，证不了跨三个进程边界之后消息还在。
  // 走的是设置窗口点下去之后的同一个函数；这里的 mock 服务器只记录不执行，
  // 所以没有任何东西会被杀掉。
  {
    const got = new Promise((resolve) => {
      const on = (raw) => {
        let m; try { m = JSON.parse(String(raw)); } catch { return; }
        if (m.type === "shutdown") { ws.off("message", on); resolve(true); }
      };
      ws.on("message", on);
      setTimeout(() => { ws.off("message", on); resolve(false); }, 4000);
    });
    ws.send(JSON.stringify({ type: "debug-shutdown" }));
    push("退出 DSH 的 shutdown 消息真的发到了插件", (await got) === true);
  }

  // ---- 关掉台词：退回一行纯信息 ----
  await reset();
  await ask(ws, { type: "debug-settings", set: { ...base, lines: false } }, "settings");
  await sleep(400);
  await feed(2.0);
  await sleep(700);
  {
    const l = await layout();
    push(`关掉台词后主行就是金额（${JSON.stringify(l.bubbleText?.main)}）`,
      (l.bubbleText?.main ?? "").includes("2") && !l.bubbleText?.sub, l.bubbleText);
  }
} catch (err) {
  push("验证跑完", false, String(err.message ?? err));
} finally {
  try { if (ws && saved) await ask(ws, { type: "debug-settings", set: saved }, "settings"); } catch {}
  try { ws?.close(); } catch {}
  wss.close();
  try { pet.kill(); } catch {}
}

let ok = true;
for (const [label, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${label}${good || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: 余额提醒端到端成立" : "FAIL: 余额提醒有问题");
process.exit(ok ? 0 : 1);
