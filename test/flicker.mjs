// 切换动作时不该有空帧（Windows，需要真实桌宠 exe）。
//
// 「闪动」的本质是**静图已经熄了、而视频还没有画面**的那一两帧。截图抓不到
// 它——一次 PrintWindow 就要 300ms，而空档只有十几毫秒。所以桌宠在调试模式下
// 按 rAF 自己盯这个不变量，这里驱动一串最容易出问题的切换，再读它的计数。
//
// 从前有两条路必然踩中：
//   · 视频 → 静图：设完 img.src 就立刻藏掉视频，可图还没解码完；
//   · 视频 → 视频：在同一个 <video> 上换 src 会立刻清空当前帧。
// 后者命中每一次 intro→loop、每一次长闲换动作、每一次贴边定格。
// 用法：node test/flicker.mjs
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

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

const PORT = 18784;
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
const connected = new Promise((r) => wss.on("connection", r));
const pet = spawn(exe, [], {
  env: { ...process.env, DSH_PET_WS_URL: `ws://127.0.0.1:${PORT}`, DSH_PET_DEBUG: "1" },
  stdio: "ignore",
  windowsHide: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(ws, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("桌宠没回 debug-info")), 5000);
    const on = (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type !== "debug-info") return;
      clearTimeout(t);
      ws.off("message", on);
      resolve(m);
    };
    ws.on("message", on);
    ws.send(JSON.stringify(msg));
  });
}

const cases = [];
let ws;
try {
  ws = await Promise.race([connected, sleep(15000).then(() => { throw new Error("桌宠没连上来"); })]);
  await sleep(1800); // 等首帧静图上屏，看门狗才会开始计数

  const drive = (payload) => ws.send(JSON.stringify({ type: "debug-test", payload }));
  const index = JSON.parse(readFileSync(join(root, "pet", "public", "动作", "index.json"), "utf8"));
  const ids = index.map((a) => a.id);

  await ask(ws, { type: "debug-trace", clear: true }); // 清零

  // 1) 视频 → 视频：一串动作接着放，中间不回静图。这是原来必闪的那条路。
  for (const id of ids) {
    drive({ cmd: "play", id });
    await sleep(450);
  }
  let got = await ask(ws, { type: "debug-trace" });
  cases.push([`连续切 ${ids.length} 个动作没有空帧`, got.blankFrames === 0, `空帧 ${got.blankFrames}`]);

  // 2) 视频 ⇄ 静图来回。原来设完 img.src 就藏视频，图还没解码完。
  await ask(ws, { type: "debug-trace", clear: true });
  for (let i = 0; i < 6; i++) {
    drive({ cmd: "play", id: ids[i % ids.length] });
    await sleep(400);
    drive({ cmd: "reset" });
    await sleep(400);
  }
  got = await ask(ws, { type: "debug-trace" });
  cases.push(["视频与静图来回切没有空帧", got.blankFrames === 0, `空帧 ${got.blankFrames}`]);

  // 3) intro → loop 的自动接续（开始打字 → 持续打字）。清单里声明的那条链。
  await ask(ws, { type: "debug-trace", clear: true });
  drive({ cmd: "working", active: true });
  // typing-intro 有 9.5 秒，工作态本身还有 800ms 防抖——等短了这一项就成了
  // 空洞通过：交接压根没发生，自然也数不出空帧。
  await sleep(13000);
  got = await ask(ws, { type: "debug-trace" });
  // 先确认这一段真的跑到了工作态——否则 intro→loop 的交接压根没发生，
  // 「零空帧」就是个空洞的通过。
  const layout = await ask(ws, { type: "debug-layout" });
  cases.push(["确实进入了工作态（否则本项无意义）", layout.layout?.shown === "working", layout.layout]);
  cases.push(["intro 自动接 loop 没有空帧", got.blankFrames === 0, `空帧 ${got.blankFrames}`]);
  drive({ cmd: "reset" });
} catch (err) {
  cases.push(["验证跑完", false, String(err.message ?? err)]);
} finally {
  try { ws?.close(); } catch {}
  wss.close();
  try { pet.kill(); } catch {}
}

let ok = true;
for (const [label, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${label}${good ? "" : ` -> ${detail}`}`);
}
console.log(ok ? "PASS: 切换过程中没有空帧" : "FAIL: 切换过程中出现空帧（就是肉眼看到的那一闪）");
process.exit(ok ? 0 : 1);
