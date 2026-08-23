// 点击 / 双击不该切成跑步动画（Windows）。
//
// 从前 pointerdown 一按下就置 st.dragging 并 render()，于是任何一次点击、
// 包括双击的那两下，都会闪一下跑步动画。位移阈值当时只用来决定「移不移窗口」，
// 没有用来决定「进不进跑步态」。这里注入真实鼠标事件，直接看桌宠报出来的
// 呈现状态。
//
// 注意：会短暂移动鼠标指针并注入点击，测完复位。
// 用法：node test/dblclick.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

const PORT = 18780;
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
const connected = new Promise((r) => wss.on("connection", r));
const pet = spawn(exe, [], {
  env: { ...process.env, DSH_PET_WS_URL: `ws://127.0.0.1:${PORT}`, DSH_PET_DEBUG: "1" },
  stdio: "ignore",
  windowsHide: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeout = (ms, msg) => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms));

function ps(script, args) {
  return new Promise((resolve, reject) => {
    const p = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", join(root, "test", script), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", () => {
      const line = out.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (!line) return reject(new Error(err.trim() || `${script} 无输出`));
      try { resolve(JSON.parse(line)); } catch { reject(new Error(`无法解析: ${line}`)); }
    });
  });
}

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

const cases = [];
let held = false;
try {
  const ws = await Promise.race([connected, timeout(15000, "桌宠未连上")]);
  await sleep(1800);

  const rect = await ps("edge.ps1", ["-PetPid", String(pet.pid)]);
  const lay = await ask(ws, { type: "debug-layout" }, "layout");
  const sf = rect.win.w / lay.innerW;
  // 立绘中心（物理屏幕坐标）。**不能**用窗口中心：窗口上半部是气泡留白，
  // 那里是穿透的，点下去根本不落在桌宠身上。
  const cx = Math.round(rect.win.x + (lay.spriteLeft + lay.spriteW / 2) * sf);
  const cy = Math.round(rect.win.y + (lay.spriteTop + lay.spriteH / 2) * sf);

  // 贴边状态是持久化的，上一次跑测试留下的会被恢复回来——先复位，
  // 否则这里量到的是「趴在屏幕边」而不是平常态。
  ws.send(JSON.stringify({ type: "debug-test", payload: { cmd: "reset" } }));
  await sleep(500);
  const before = await ask(ws, { type: "debug-layout" }, "layout");
  cases.push(["起手是平常态", before.shown === "idle" && before.mode === "idle", before]);

  await ps("click.ps1", ["-Mode", "dblclick", "-X", String(cx), "-Y", String(cy)]);
  // 双击后立刻查：跑步动画哪怕只闪一帧，mode 也会停在 running 直到下次 render。
  const after = await ask(ws, { type: "debug-layout" }, "layout");
  cases.push(["双击后没有切成跑步", after.mode !== "running" && after.shown !== "drag", after]);

  // 反向确认：真的拖起来必须进跑步态，否则上面那条可以靠「永远不跑」蒙混过关。
  await ps("click.ps1", ["-Mode", "drag", "-X", String(cx), "-Y", String(cy),
    "-X2", String(cx + 60)]);
  held = true;
  const dragging = await ask(ws, { type: "debug-layout" }, "layout");
  cases.push(["真的拖动时进入跑步态", dragging.mode === "running", dragging]);
  await ps("click.ps1", ["-Mode", "release"]);
  held = false;
  await sleep(600);
  const settled = await ask(ws, { type: "debug-layout" }, "layout");
  cases.push(["松手后退出跑步态", settled.mode !== "running", settled]);
} catch (e) {
  cases.push(["点击验证执行完成", false, String(e.message ?? e)]);
} finally {
  // 万一中途抛异常，别把鼠标左键按着不放。
  if (held) { try { await ps("click.ps1", ["-Mode", "release"]); } catch {} }
  try { pet.kill(); } catch {}
  wss.close();
}

let ok = true;
for (const [name, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: 点击不误触跑步，拖动仍然正常" : "FAIL: 点击/拖动行为未通过");
setTimeout(() => process.exit(ok ? 0 : 1), 500);
