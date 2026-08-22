// 孤儿进程兜底验证（约 50 秒）。
// A: DSH 短暂重启 —— 桌宠必须活下来并自动重连。
// B: DSH 崩溃不再回来 —— 桌宠必须在重连预算耗尽后自我了断。
// 用法：node test/orphan.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BINARIES = { "win32-x64": join(root, "packages", "win32-x64", "bin", "dsh-deep-pet.exe") };
const exe = process.env.DSH_PET_BINARY || BINARIES[`${process.platform}-${process.arch}`];
if (!exe || !existsSync(exe)) {
  console.log("SKIP: 未找到已入包的桌宠二进制；先跑 scripts/stage-binary.mjs");
  process.exit(0);
}

const PORT = 18777;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个假 DSH。crash() 直接 terminate 客户端连接，模拟进程被强杀。 */
function fakeDsh(onConnect) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
  const live = new Set();
  wss.on("connection", (ws) => { live.add(ws); ws.on("close", () => live.delete(ws)); onConnect?.(); });
  return {
    crash: () => new Promise((r) => {
      for (const ws of live) { try { ws.terminate(); } catch {} }
      wss.close(() => r());
    }),
  };
}

function launchPet() {
  const child = spawn(exe, [], {
    env: { ...process.env, DSH_PET_WS_URL: `ws://127.0.0.1:${PORT}` },
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (e) => console.error("spawn error:", e.message));
  return child;
}

const alive = (child) => child.exitCode === null && child.signalCode === null;

let pass = true;

// ---- A: 短暂断连应存活 ----
{
  let connects = 0;
  let dsh = fakeDsh(() => connects++);
  const pet = launchPet();
  await sleep(4000);
  const first = connects;
  await dsh.crash();
  await sleep(5000);                       // 断 5 秒，远短于 30 秒预算
  dsh = fakeDsh(() => connects++);         // DSH 回来了
  await sleep(4000);
  const reconnected = connects > first;
  const survived = alive(pet);
  const ok = reconnected && survived;
  if (!ok) pass = false;
  console.log(`${ok ? "PASS" : "FAIL"} A 短暂断连应存活 — 重连:${reconnected ? "是" : "否"} 存活:${survived ? "是" : "否"}`);
  pet.kill();
  await dsh.crash();
  await sleep(1000);
}

// ---- B: 长断连应自尽 ----
{
  const dsh = fakeDsh();
  const pet = launchPet();
  await sleep(4000);
  const connectedFirst = alive(pet);
  await dsh.crash();                       // DSH 再也不回来
  const exited = await Promise.race([
    new Promise((r) => pet.on("exit", () => r(true))),
    sleep(40000).then(() => false),
  ]);
  if (!connectedFirst || !exited) pass = false;
  console.log(`${connectedFirst && exited ? "PASS" : "FAIL"} B 长断连应自尽 — 30 秒预算耗尽后${exited ? "已退出" : "仍在运行（孤儿！）"}`);
  if (!exited) pet.kill();
}

console.log(pass ? "PASS: 孤儿兜底有效" : "FAIL: 孤儿兜底未通过");
process.exit(pass ? 0 : 1);
