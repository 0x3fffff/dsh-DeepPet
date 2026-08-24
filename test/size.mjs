// 尺寸倍率与气泡换行（Windows，需要真实桌宠 exe）。
//
// 两件事在这里一起测，因为它们共用同一条链路：设置改倍率 → Rust 重算窗口
// 并广播 → 前端重排气泡。
//
//   1. 调倍率时**脚底不动**。窗口默认是钉住左上角长大的，那会让桌宠往下沉，
//      本来站在屏幕底部的话直接沉出屏幕。
//   2. 「🔧 正在执行 npm 命令」保持单行。它实测 162 逻辑像素，而上限一度被
//      两侧各扣 6px 压到 168——只剩 6px 余量，换个 DPI 就折成两行。
// 用法：node test/size.mjs
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

const PORT = 18787;
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
    const to = setTimeout(() => reject(new Error(`等 ${want} 超时`)), 6000);
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

function geom(ws) {
  return ask(ws, { type: "debug-geom" }, "geom");
}

const cases = [];
let ws;
let saved = null;
try {
  ws = await waitForPet(pet, connected);
  await sleep(2000);
  const drive = (payload) => ws.send(JSON.stringify({ type: "debug-test", payload }));

  drive({ cmd: "edge", side: null });
  await sleep(500);
  saved = await ask(ws, { type: "debug-settings" }, "settings");
  // 显式压到 100%。**不能拿用户当前的设置当基线**——用户在设置里调成 135%
  // 之后，「设到 160% 应当变大 1.4 倍」就不成立了（160/135 只有 1.19 倍），
  // 测试会红在一个根本没坏的地方。
  const base = { ...saved, pet_scale: 1, bubble_scale: 1 };
  await ask(ws, { type: "debug-settings", set: base }, "settings");
  await sleep(600);

  // ---- 1. 换行 ----
  drive({ cmd: "working", active: true });
  await sleep(1200);
  drive({ cmd: "progress", kind: "tool", tool: "pwsh", text: "\u{1F527} 正在执行 npm\u00A0命令" });
  await sleep(900);
  let lay = await ask(ws, { type: "debug-layout" }, "layout");
  const oneLine = Math.round(13 * 1.5 + 8 * 2 + 2); // 字号×行高 + 上下内边距 + 边框
  cases.push([`npm 那条保持单行（气泡高 ${lay.bubbleH}，单行约 ${oneLine}）`,
    lay.bubbleH <= oneLine + 6, lay]);
  cases.push([`不贴边时气泡上限就是整窗（${lay.bubbleMaxW} vs 窗口 ${lay.innerW}）`,
    lay.bubbleMaxW === lay.innerW, lay]);

  // ---- 2. 缩放锚点 ----
  drive({ cmd: "reset" });
  // 先回到主屏右下角。停在屏幕顶部附近的话，放大会顶出上边缘被拉回来，
  // 「脚底不动」本来就不该成立——不复位就是让上一次拖到哪儿决定测试成败。
  drive({ cmd: "reset-position" });
  await sleep(1000);
  const before = await geom(ws);
  await ask(ws, { type: "debug-settings", set: { ...base, pet_scale: 1.6 } }, "settings");
  await sleep(900);
  const after = await geom(ws);
  const bottomBefore = before.y + before.h;
  const bottomAfter = after.y + after.h;
  const cxBefore = before.x + before.w / 2;
  const cxAfter = after.x + after.w / 2;
  cases.push([`放大到 160% 后立绘确实变大（${before.spriteH} → ${after.spriteH}）`,
    after.spriteH > before.spriteH * 1.4, { before: before.spriteH, after: after.spriteH }]);
  cases.push([`放大时脚底不动（${bottomBefore} → ${bottomAfter}）`,
    Math.abs(bottomAfter - bottomBefore) <= 2, { bottomBefore, bottomAfter }]);
  cases.push([`放大时水平中心不动（${cxBefore} → ${cxAfter}）`,
    Math.abs(cxAfter - cxBefore) <= 2, { cxBefore, cxAfter }]);

  // ---- 3. 气泡倍率 ----
  await ask(ws, { type: "debug-settings", set: { ...base, bubble_scale: 1.5 } }, "settings");
  await sleep(600);
  drive({ cmd: "working", active: true });
  await sleep(1200);
  drive({ cmd: "progress", kind: "tool", tool: "pwsh", text: "\u{1F527} 正在执行 npm\u00A0命令" });
  await sleep(900);
  const big = await ask(ws, { type: "debug-layout" }, "layout");
  cases.push([`气泡 150% 时字和宽度一起放大（高 ${lay.bubbleH} → ${big.bubbleH}）`,
    big.bubbleH > lay.bubbleH * 1.3 && big.bubbleMaxW > lay.bubbleMaxW * 1.3,
    { before: lay, after: big }]);
} catch (err) {
  cases.push(["验证跑完", false, String(err.message ?? err)]);
} finally {
  // 别把测试用的倍率留在用户的 settings.json 里。
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
console.log(ok ? "PASS: 尺寸倍率与气泡换行符合预期" : "FAIL: 尺寸/换行有问题");
process.exit(ok ? 0 : 1);
