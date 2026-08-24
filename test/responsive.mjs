// 桌宠会不会「未响应」（Windows，需要真实桌宠 exe）。
//
// 用户报「桌宠经常未响应，双击才有反应」。实测抓到主线程 `IsHungAppWindow`
// 为真——是字面意义的卡死，不只是感觉慢。
//
// 成因在命中测试的轮询里：`should_ignore` **拿着 hit_state 锁**去调
// `win.scale_factor()` / `inner_position()` / `cursor_position()`，而这三个在
// Tauri 里都是 `window_getter!`——往主事件循环投消息再阻塞等回复。于是
// 「持锁 + 等主线程」和「主线程侧 set_hit 等锁」凑成一个环，主线程一停就是
// 好几秒；穿透状态切不回来，那一瞬点下去落到背后的窗口，就是「要点两下」。
//
// 所以这个测试必须**同时**满足两个条件才测得到：主线程有负载（播视频），
// 并且反复触发命中测试的开关翻转。少一个都测不出来。
// 用法：node test/responsive.mjs
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

const PORT = 18809;
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
try {
  ws = await waitForPet(pet, connected);
  await sleep(2200);
  const drive = (payload) => ws.send(JSON.stringify({ type: "debug-test", payload }));
  drive({ cmd: "edge", side: null });
  await sleep(500);

  const lay = await ask(ws, { type: "debug-layout" }, "layout");
  const g = await ask(ws, { type: "debug-geom" }, "geom");
  const sf = g.w / lay.innerW;
  const cx = Math.round(g.x + (lay.spriteLeft + lay.spriteW / 2) * sf);
  const cy = Math.round(g.y + (lay.spriteTop + lay.spriteH / 2) * sf);

  // 让主线程忙起来：工作态会一直循环播 alpha 视频，正是复现所需的负载。
  drive({ cmd: "working", active: true });
  await sleep(2500);

  const probe = () => new Promise((resolve, reject) => {
    const ps = spawn("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "test", "latency.ps1"),
      "-PetPid", String(pet.pid), "-X", String(cx), "-Y", String(cy), "-Rounds", "12",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    ps.stdout.on("data", (d) => { out += d; });
    ps.stderr.on("data", (d) => { err += d; });
    ps.on("close", () => {
      const line = out.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (!line) return reject(new Error(err.trim().slice(0, 200) || "探测脚本无输出"));
      try { resolve(JSON.parse(line)); } catch { reject(new Error(`无法解析: ${line}`)); }
    });
  });

  const r = await probe();
  if (!r.ok) throw new Error(r.reason);
  console.log(`光标移上立绘后变为可点击的耗时 ms: 中位 ${r.median} 最差 ${r.worst}`
    + `  超时 ${r.timedOut}/${r.samples.length}  卡死采样 ${r.hungSamples}/${r.totalSamples}`
    + `  被人手打断 ${r.interfered}`);
  if (r.samples.length < 4) {
    // 人一直在动鼠标就没得测。这时候必须说清楚，而不是拿三两个样本下结论。
    cases.push([`有效样本太少（${r.samples.length}，被打断 ${r.interfered} 次）——测量期间别碰鼠标`,
      false, r]);
  }
  console.log(`  逐次: ${JSON.stringify(r.samples)}`);

  // 主线程一次都不该被判为卡死。这是最硬的那条：IsHungAppWindow 为真意味着
  // 窗口 5 秒没处理消息，用户看到的就是标题栏上的「未响应」。
  cases.push(["压测期间主线程从未卡死", r.hungSamples === 0, `${r.hungSamples} 次`]);
  // 轮询是 30ms 一跳，加上注入和采样的抖动，正常应当在这个量级。
  cases.push([`翻转延迟的中位数正常（${r.median}ms）`, r.median >= 0 && r.median <= 120, r.median]);
  // 硬指标是「有没有整轮翻不过来」。单次几百毫秒的抖动可能是机器本身忙
  // （实测时后台跑着 cargo 就会这样），但**一轮都翻不过来**不是抖动。
  cases.push([`没有一轮翻不过来（超时 ${r.timedOut}/${r.samples.length}）`, r.timedOut === 0,
    { worst: r.worst, timedOut: r.timedOut, samples: r.samples }]);
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
  console.log(`${good ? "PASS" : "FAIL"} ${label}${good ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: 桌宠在压测下保持响应" : "FAIL: 桌宠会卡住或迟迟不接受点击");
process.exit(ok ? 0 : 1);
