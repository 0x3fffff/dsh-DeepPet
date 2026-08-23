// 静图与动作在**屏幕上**是否真的对齐（Windows，需要真实桌宠 exe）。
//
// test/framing.mjs 量的是素材文件的几何，这里量的是最终画到屏幕上的像素。
// 两者都要：素材对齐了，仍可能被 CSS 盒子尺寸、object-fit 或视频层的定位
// 毁掉——而用户看到的恰恰是最后这一步。
//
// 判据是**脚底基线**：静图和各动作在屏幕上的最低落笔行必须落在同一处。
// 修复前动作的脚底比静图低 2.1%（约 3px），修复后是 0~1px。
//
// 这里**不断言高度**。屏幕截图是在动画播了一会之后抓的，量到的是动作中的
// 姿势而不是首帧——typing-intro 坐在桌前、phone 低头看手机，头本来就该更低，
// 高度不同是对的。首帧的高度由 test/framing.mjs 在素材层精确守着。
// 用法：node test/framing-live.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

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

const outDir = process.env.DSH_PET_SHOT_DIR || join(root, "test", ".shots");
mkdirSync(outDir, { recursive: true });

const PORT = 18783;
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
const connected = new Promise((r) => wss.on("connection", r));
const pet = spawn(exe, [], {
  env: { ...process.env, DSH_PET_WS_URL: `ws://127.0.0.1:${PORT}`, DSH_PET_DEBUG: "1" },
  stdio: "ignore",
  windowsHide: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ink(shot) {
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", join(root, "test", "ink.ps1"),
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
let ws;
try {
  ws = await Promise.race([connected, sleep(15000).then(() => { throw new Error("桌宠没连上来"); })]);
  const drive = (payload) => ws.send(JSON.stringify({ type: "debug-test", payload }));

  // 先复位。贴边状态是持久化的——test/edge.mjs 跑过之后桌宠一起来就是趴着的，
  // 基线会抓到靠边姿势（宽度只有正常的 70%，还偏在一侧），后面每一条都对不上。
  drive({ cmd: "reset" });
  await sleep(600);

  // 基线必须等静图真的画完。固定 sleep 不可靠——试过 1500ms，抓到的是一张
  // 只解码了 24×24 的半成品，于是后面每一条都「偏 113px」，看起来像取景全错，
  // 其实只是基线坏了。所以轮询到连续两次落笔范围一致为止。
  let base = null;
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    const got = await ink(join(outDir, "framing-still.png"));
    if (!got.ok) continue;
    if (base && got.inkT === base.inkT && got.inkB === base.inkB
      && got.inkL === base.inkL && got.inkR === base.inkR) { base = got; break; }
    base = got;
    if (i === 11) base = null;
  }
  if (!base) throw new Error("静图落笔范围一直没稳定下来");
  // 再确认它不是半成品：立绘盒约 144 物理像素高，落笔该占其中绝大部分。
  const layout = await ask(ws, { type: "debug-layout" });
  const spriteH = layout.layout?.spriteH ?? 0;
  if (base.inkB - base.inkT < spriteH * 0.6) {
    throw new Error(`基线落笔只有 ${base.inkB - base.inkT}px，立绘盒 ${Math.round(spriteH)}px——抓到了半成品`);
  }

  // 只测**首帧就是中性起手式**的那些。接续段（typing-loop）的首帧是上一段的
  // 末帧，本来就不该和静图重合。
  const index = JSON.parse(readFileSync(join(root, "pet", "public", "动作", "index.json"), "utf8"));
  const continuation = new Set(index.map((a) => a.next).filter(Boolean));

  console.log(`静图落笔  y ${base.inkT}~${base.inkB}（高 ${base.inkB - base.inkT + 1}）`
    + `  x ${base.inkL}~${base.inkR}（宽 ${base.inkR - base.inkL + 1}）`);
  console.log("（只比脚底那一行；高度随动作中的姿势变化，是正常的）");

  for (const a of index) {
    if (continuation.has(a.id)) continue;
    drive({ cmd: "play", id: a.id });
    await sleep(700); // 等视频交接完成（旧层定格 → 新层首帧）
    const got = await ink(join(outDir, `framing-${a.id}.png`));
    if (!got.ok) { cases.push([`${a.id} 能抓到画面`, false, got.reason]); continue; }
    const dBottom = got.inkB - base.inkB;
    console.log(`${a.id.padEnd(14)} 落笔 y ${got.inkT}~${got.inkB}  底差 ${dBottom >= 0 ? "+" : ""}${dBottom}px`);
    // 容差 3 物理像素：立绘盒只有约 144px 高，3px 已经是 2%——修复前的差距是
    // 2.1%（约 3px），所以这个阈值确实能把回归拦下来。
    cases.push([`${a.id} 与静图脚底对齐`, Math.abs(dBottom) <= 3, `底差 ${dBottom}px`]);
    drive({ cmd: "reset" });
    await sleep(400);
  }
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
console.log(ok ? `PASS: 屏幕上静图与动作对齐（截图在 ${outDir}）` : "FAIL: 屏幕上仍有跳变");
process.exit(ok ? 0 : 1);
