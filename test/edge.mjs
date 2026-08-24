// 贴边验证（Windows）。
// 「靠边」的判据不是窗口贴住屏幕边，而是**立绘**贴住屏幕边——窗口比立绘宽
// 得多，两侧各有约 50px 全透明边距。所以这里 PrintWindow 抓下桌宠，扫出
// 第一个非透明像素所在的列，再算它离屏幕边有多远。这正是修复前后差 50px、
// 而且只有肉眼才看得出来的那个量。
// 用法：node test/edge.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { skipIfPetRunning, waitForPet } from "./lib/wait-pet.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.env.DSH_PET_BINARY
  || join(root, "packages", "win32-x64", "bin", "dsh-deep-pet.exe");

if (process.platform !== "win32") {
  console.log("SKIP: 贴边验证目前只实现了 Windows 版");
  process.exit(0);
}
if (!existsSync(exe)) {
  console.log("SKIP: 未找到已入包的桌宠二进制；先跑 scripts/stage-binary.mjs");
  process.exit(0);
}

// 已经有一只桌宠在跑的话，这里拉起的那只会抢不到单例锁而立刻自杀。
skipIfPetRunning();

const outDir = process.env.DSH_PET_SHOT_DIR || join(root, "test", ".shots");
mkdirSync(outDir, { recursive: true });

const PORT = 18779;
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
const connected = new Promise((r) => wss.on("connection", r));

const pet = spawn(exe, [], {
  env: { ...process.env, DSH_PET_WS_URL: `ws://127.0.0.1:${PORT}`, DSH_PET_DEBUG: "1" },
  stdio: "ignore",
  windowsHide: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeout = (ms, msg) => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms));

function probe(shot) {
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", join(root, "test", "edge.ps1"),
      "-PetPid", String(pet.pid), "-Shot", shot,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    ps.stdout.on("data", (d) => { out += d; });
    ps.stderr.on("data", (d) => { err += d; });
    ps.on("close", () => {
      const line = out.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (!line) return reject(new Error(err.trim() || "探测脚本无输出"));
      try { resolve(JSON.parse(line)); } catch { reject(new Error(`无法解析: ${line}`)); }
    });
  });
}

const cases = [];
function ask(ws, msg, want) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`等 ${want} 超时`)), 5000);
    const on = (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (!m[want]) return;
      clearTimeout(to); ws.off("message", on); resolve(m[want]);
    };
    ws.on("message", on);
    ws.send(JSON.stringify(msg));
  });
}

try {
  const ws = await waitForPet(pet, connected);
  await sleep(1800); // 等 applyLayout 把立绘尺寸定下来

  for (const side of ["left", "right"]) {
    // 先离开贴边态再进——贴边状态是持久化的，若上一轮就停在这一侧，
    // render() 会认为类别没变而不重播，测的就成了上一轮的残留。
    ws.send(JSON.stringify({ type: "debug-test", payload: { cmd: "edge", side: null } }));
    await sleep(400);
    ws.send(JSON.stringify({ type: "debug-test", payload: { cmd: "edge", side } }));
    // 等靠边动画播完并定格：`action === null` 表示画的已经是那张常驻静图。
    // 原来是固定 sleep 1600ms 猜的——而这段动画有 8 秒，抓到的一直是播到
    // 一半的样子，于是时好时坏。窗口要留够整段时长再加余量。
    let lay = null;
    for (let i = 0; i < 45; i++) {
      await sleep(300);
      lay = await ask(ws, { type: "debug-layout" }, "layout");
      if (lay.shown === `edge:${side}` && lay.action === null) break;
      lay = null;
    }
    if (!lay) throw new Error(`${side} 侧的靠边姿势一直没有定格`);
    const r = await probe(join(outDir, `edge-${side}.png`));
    if (!r.ok) throw new Error(r.reason);
    // 立绘在 webview 里的布局盒（DOM 量的），换算到屏幕物理坐标。
    // 这一步刻意不复用桌宠算贴边时用的那个 inset，否则等于自己验自己。
    const sf = r.win.w / lay.innerW;
    const spriteL = Math.round(r.win.x + lay.spriteLeft * sf);
    const spriteR = Math.round(spriteL + lay.spriteW * sf);
    const gap = side === "left" ? spriteL - r.mon.x : (r.mon.x + r.mon.w) - spriteR;
    const winGap = side === "left" ? r.gapLeft : r.gapRight;
    console.log(`[${side}] 窗口离屏幕边 ${winGap}px，立绘离屏幕边 ${gap}px  ` +
      `(win ${r.win.x},${r.win.y} ${r.win.w}x${r.win.h} / 立绘 ${Math.round(lay.spriteW * sf)}px / mon ${r.mon.w}x${r.mon.h})`);
    // 修复前这个值是 (窗口宽 - 立绘宽)/2，本机上 81px。
    cases.push([`立绘盒真的贴住屏幕${side === "left" ? "左" : "右"}边`,
      Math.abs(gap) <= 2, gap]);
    // 窗口必须有一截悬在屏幕外——没有的话说明还在按窗口边对齐。
    cases.push([`窗口${side === "left" ? "左" : "右"}侧确实悬出屏幕`,
      winGap < -8, winGap]);
    // 立绘**盒**贴住了不等于**画面**贴住了：靠边的姿势如果在帧里留了内边距，
    // 看上去仍然是浮着的。所以再查一次真实落笔的位置。
    const inkGap = side === "left"
      ? (r.win.x + r.inkL) - r.mon.x
      : (r.mon.x + r.mon.w) - (r.win.x + r.inkR + 1);
    console.log(`      画面实际落笔 ${r.inkL}~${r.inkR}（立绘盒 ${Math.round(lay.spriteLeft * sf)}~${spriteR - r.win.x}），离屏幕边 ${inkGap}px`);
    cases.push([`靠边姿势的画面本身也顶到帧边（${side}）`, Math.abs(inkGap) <= 3, inkGap]);
  }
} catch (e) {
  cases.push(["贴边验证执行完成", false, String(e.message ?? e)]);
} finally {
  try { pet.kill(); } catch {}
  wss.close();
}

let ok = true;
for (const [name, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? `PASS: 贴边对齐正确（截图在 ${outDir}）` : "FAIL: 贴边对齐未通过");
setTimeout(() => process.exit(ok ? 0 : 1), 500);
