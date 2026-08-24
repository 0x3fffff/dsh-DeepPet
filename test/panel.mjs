// 测试面板能真的打开并渲染出内容（Windows）。
//
// 设置窗口曾经渲染成纯白——同步的 open_settings 让窗口框架建出来但 WebView2
// 永远初始化不了。测试面板走的是同一套路子，所以同样要被真的打开看过，
// 而不是「代码写了就算」。
// 用法：node test/panel.mjs
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
  console.log("SKIP: 目前只实现了 Windows 版");
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

const PORT = 18781;
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

const cases = [];
try {
  const ws = await waitForPet(pet, connected);
  await sleep(1500);
  ws.send(JSON.stringify({ type: "debug-test", payload: { cmd: "open-test" } }));
  await sleep(3500); // WebView2 冷启动比窗口出现慢得多

  const shot = await ps("shot-window.ps1", [
    "-PetPid", String(pet.pid), "-Title", "测试面板", "-Shot", join(outDir, "panel.png"),
  ]);
  if (!shot.ok) throw new Error(shot.reason);
  console.log(`面板窗口 ${shot.w}x${shot.h}，纯白占比 ${shot.whitePct}%`);
  cases.push(["测试面板窗口打开了", shot.w > 200 && shot.h > 200, shot]);
  // 纯白窗口就是当年设置面板的故障样子。真渲染出来的面板有灰底、分区线、
  // 大量按钮，白点占比远低于此。
  cases.push(["面板不是一片空白（WebView2 真的初始化了）", shot.whitePct < 70, shot.whitePct]);
} catch (e) {
  cases.push(["面板验证执行完成", false, String(e.message ?? e)]);
} finally {
  try { pet.kill(); } catch {}
  wss.close();
}

let ok = true;
for (const [name, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? `PASS: 测试面板可用（截图在 ${outDir}）` : "FAIL: 测试面板未通过");
setTimeout(() => process.exit(ok ? 0 : 1), 500);
