// 会合机制验证（约 40 秒）。这是「一只桌宠服务多个 DSH profile」的地基：
//   A 单例：同时拉起两个桌宠，只能活下来一个；
//   B 多连接：两个插件登记到会合目录，同一只桌宠必须两个都连上；
//   C 干净退出：登记目录清空后立刻关窗，不必干等 30 秒预算。
// 用法：node test/rendezvous.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.env.DSH_PET_BINARY
  || join(root, "packages", "win32-x64", "bin", "dsh-deep-pet.exe");
if (process.platform !== "win32") { console.log("SKIP: 单例锁目前只实现了 Windows"); process.exit(0); }
if (!existsSync(exe)) { console.log("SKIP: 未找到已入包的桌宠二进制"); process.exit(0); }

// 必须和插件的 PET_IDENTIFIER / Tauri 的 app_local_data_dir 一致。
const PLUGIN_DIR = join(process.env.LOCALAPPDATA || homedir(), "com.dsh.deeppet", "plugins");
// 用不会与真实 DSH 撞名的假 pid，收尾时只删自己写的那两个文件。
const FAKE = [990001, 990002];
const regPath = (pid) => join(PLUGIN_DIR, `${pid}.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (c) => c.exitCode === null && c.signalCode === null;
// 不带 DSH_PET_WS_URL：强制桌宠只能从会合目录发现插件。
const launch = () => spawn(exe, [], { stdio: "ignore", windowsHide: true });
const cleanReg = () => { for (const pid of FAKE) { try { rmSync(regPath(pid), { force: true }); } catch {} } };

mkdirSync(PLUGIN_DIR, { recursive: true });
cleanReg();
let pass = true;
const report = (ok, label, extra = "") => {
  if (!ok) pass = false;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
};

// ---- A 单例 ----
{
  const first = launch();
  await sleep(3000);
  const second = launch();
  await sleep(3000);
  const ok = alive(first) && !alive(second);
  report(ok, "单例：第二个桌宠自行退出", `先起的${alive(first) ? "存活" : "已退出"}、后起的${alive(second) ? "仍在运行（重复窗口！）" : "已退出"}`);
  first.kill();
  second.kill();
  await sleep(1500); // 等操作系统释放文件锁
}

// ---- B 多连接 + C 干净退出 ----
{
  const servers = FAKE.map((pid, i) => {
    const port = 18811 + i;
    const wss = new WebSocketServer({ host: "127.0.0.1", port });
    const seen = new Promise((r) => wss.on("connection", r));
    writeFileSync(regPath(pid), JSON.stringify({ pid, port, label: `p${i + 1}` }));
    return { pid, port, wss, seen };
  });

  const pet = launch();
  const connected = await Promise.all(servers.map((s) =>
    Promise.race([s.seen.then(() => true), sleep(15000).then(() => false)])));
  report(connected.every(Boolean), "多连接：一只桌宠连上两个插件",
    connected.map((c, i) => `插件${i + 1}${c ? "已连" : "未连"}`).join("、"));

  // 两边各发一次任务完成，确认桌宠不因并发消息崩掉。
  for (const s of servers) {
    for (const c of s.wss.clients) {
      c.send(JSON.stringify({ type: "task-complete", title: `来自 ${s.pid}`, outcome: "success", bubbleMs: 2000, label: `p${s.pid}` }));
    }
  }
  await sleep(1500);
  report(alive(pet), "并发播报后桌宠仍存活");

  // C：注销登记 + 关掉服务，桌宠应当很快关窗，而不是等满 30 秒预算。
  cleanReg();
  for (const s of servers) s.wss.close();
  const t0 = Date.now();
  const exited = await Promise.race([
    new Promise((r) => pet.on("exit", () => r(true))),
    sleep(15000).then(() => false),
  ]);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  report(exited, "干净退出：登记清空后立刻关窗", exited ? `${secs} 秒（远短于 30 秒预算）` : "15 秒内未退出");
  if (!exited) pet.kill();
}

cleanReg();
console.log(pass ? "PASS: 会合机制有效" : "FAIL: 会合机制未通过");
process.exit(pass ? 0 : 1);
