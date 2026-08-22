// 鼠标穿透验证（Windows）。用 Win32 WindowFromPoint 在操作系统层面确认：
//   死区（气泡留白）上的点击应当落到桌宠背后的窗口；
//   立绘上的点击应当落到桌宠自己。
// 注意：会短暂移动鼠标指针到桌宠位置，测完复位。
// 用法：node test/clickthrough.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.env.DSH_PET_BINARY
  || join(root, "packages", "win32-x64", "bin", "dsh-deep-pet.exe");

if (process.platform !== "win32") {
  console.log("SKIP: 穿透验证目前只实现了 Windows 版");
  process.exit(0);
}
if (!existsSync(exe)) {
  console.log("SKIP: 未找到已入包的桌宠二进制；先跑 scripts/stage-binary.mjs");
  process.exit(0);
}

const PORT = 18778;
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
const connected = new Promise((r) => wss.on("connection", r));

const pet = spawn(exe, [], {
  // DSH_PET_DEBUG 打开桌宠的调试通道，让测试能直接驱动穿透状态，
  // 从而在不注入鼠标点击的前提下验证拖动用的 force 路径。
  env: { ...process.env, DSH_PET_WS_URL: `ws://127.0.0.1:${PORT}`, DSH_PET_DEBUG: "1" },
  stdio: "ignore",
  windowsHide: true,
});

const timeout = (ms, msg) => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probe(petPid, farOnly) {
  return new Promise((resolve, reject) => {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", join(root, "test", "hittest.ps1"), "-PetPid", String(petPid)];
    if (farOnly) args.push("-FarOnly");
    const ps = spawn("powershell", args, { stdio: ["ignore", "pipe", "pipe"] });
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

try {
  await Promise.race([connected, timeout(15000, "桌宠未连上")]);
  // 等前端把命中区报上去（applyLayout 之后）。
  await new Promise((r) => setTimeout(r, 1500));

  const ws = await connected;
  const setForce = async (force) => {
    ws.send(JSON.stringify({ type: "debug-hit", force }));
    await sleep(400); // 让前端发出 invoke，再等 Rust 那 30ms 轮询翻开关
  };

  const p1 = await probe(pet.pid, false);
  if (!p1.ok) throw new Error(p1.reason);

  console.log(`窗口: ${p1.rect}  探测点: ${p1.probe}`);
  console.log(`WS_EX_TRANSPARENT — 死区:${p1.deadTransparent} 立绘:${p1.spriteTransparent}`);
  // 死区应当穿透 → 该点上的窗口不是桌宠。
  const deadOk = p1.deadIsPet === false;
  // 立绘应当可交互 → 该点上的窗口正是桌宠。
  const spriteOk = p1.spriteIsPet === true;
  console.log(`${deadOk ? "PASS" : "FAIL"} 死区（气泡留白）穿透 — 该点窗口${p1.deadIsPet ? "仍是桌宠（挡住了！）" : "是桌宠背后的窗口"}`);
  console.log(`${spriteOk ? "PASS" : "FAIL"} 立绘可交互 — 该点窗口${p1.spriteIsPet ? "是桌宠" : "不是桌宠（点不到！）"}`);

  // 对照组：不 force 时，光标远离窗口必须变穿透——证明这个探针真的能测出差别，
  // 下面那条 PASS 才有意义。
  await setForce(false);
  const ctrl = await probe(pet.pid, true);
  const ctrlOk = ctrl.farTransparent === true;
  console.log(`${ctrlOk ? "PASS" : "FAIL"} 对照：非 force 时光标远离 → ${ctrl.farTransparent ? "穿透（探针有效）" : "未穿透（探针失效，下条结论不可信）"}`);

  // 正题：拖动期间 force，光标跑出窗口也绝不能打开穿透——否则 webview
  // 当场失去鼠标，拖动中断且再也收不到 pointerup，跑动动画就卡住了。
  await setForce(true);
  const forced = await probe(pet.pid, true);
  const forceOk = forced.farTransparent === false;
  console.log(`${forceOk ? "PASS" : "FAIL"} force 时光标跑出窗口 → ${forced.farTransparent ? "仍打开了穿透（拖动会断！）" : "保持可交互"}`);

  const pass = deadOk && spriteOk && ctrlOk && forceOk;
  console.log(pass ? "PASS: 鼠标穿透生效" : "FAIL: 鼠标穿透未通过");
  pet.kill();
  wss.close();
  setTimeout(() => process.exit(pass ? 0 : 1), 500);
} catch (err) {
  console.log("FAIL:", err.message);
  pet.kill();
  wss.close();
  setTimeout(() => process.exit(1), 500);
}
