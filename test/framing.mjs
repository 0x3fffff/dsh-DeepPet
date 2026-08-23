// 取景不变量守卫。
//
// 「静图切动作时角色胀一下」这个缺陷本身很难在代码里看出来——它是**素材几何**
// 的性质，不是逻辑的性质。而我在修它的过程中连着踩了两个坑，两个都只有量一遍
// 产物才发现得了：
//
//   1. 用默认解码器量 WebM 的 alpha，全部动作齐刷刷报「角色占满 100%」——
//      默认的 vp9 解码器丢掉了 alpha 边通道。整套校准差点建在这个假数上。
//   2. `typing-loop` 被放大了 9%。「整段按首帧对齐」的前提是首帧为中性起手式，
//      而它的首帧是「已经在打字」，压根不满足。
//
// 所以这个文件量的是**产物**，不是代码。
// 用法：node test/framing.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { alphaBox, framing, refFraming } from "../scripts/lib/framing.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(root, "pet", "public");
const ACTIONS = join(PUBLIC, "动作");

if (!existsSync(ACTIONS)) {
  console.log("SKIP: 未装配运行时素材；跑 node scripts/build-assets.mjs");
  process.exit(0);
}
try {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "quiet", "-version"]);
} catch {
  console.log("SKIP: 没有 ffmpeg");
  process.exit(0);
}

const cases = [];
const target = refFraming();

/** 基线容差：产物是 288/384/512 三种画布，取整误差本来就有一两个像素。 */
const BASELINE_TOL = 0.008; // 归一化后 0.8%，288 宽的画布上约 3px

// 运行时真正会显示的静图。其余表情打进了包但代码从未引用。
const STILLS = ["平常", "寻找", "晕", "坐下"];
for (const name of STILLS) {
  const f = join(PUBLIC, "立绘", "表情", `${name}.webp`);
  if (!existsSync(f)) { cases.push([`${name} 存在`, false, f]); continue; }
  const g = framing(alphaBox(f));
  cases.push([`${name} 脚底落在基线上`,
    Math.abs(g.baseline - target.baseline) <= BASELINE_TOL,
    `基线 ${(g.baseline * 100).toFixed(2)}% vs 目标 ${(target.baseline * 100).toFixed(2)}%`]);
}

// 动作首帧。`next` 指向的段是接续段，它的首帧是上一段的末帧而不是起手式，
// 落不到基线上是**正确的**——所以按继承关系排除，而不是加大容差蒙混过去。
const index = JSON.parse(readFileSync(join(ACTIONS, "index.json"), "utf8"));
const continuation = new Set(index.map((a) => a.next).filter(Boolean));
for (const a of index) {
  const f = join(ACTIONS, `${a.id}.webm`);
  if (!existsSync(f)) { cases.push([`${a.id} 存在`, false, f]); continue; }
  const box = alphaBox(f);
  if (!box) { cases.push([`${a.id} 能解出 alpha`, false, "整幅全透明"]); continue; }
  // 首帧若报「角色占满整幅」，多半是 alpha 边通道又被丢了——那是个会让
  // 整套校准建在沙上的假数，必须当场失败而不是照单全收。
  cases.push([`${a.id} alpha 边通道解出来了`,
    box.t > 0 || box.l > 0 || box.b < box.h - 1 || box.r < box.w - 1,
    `bbox ${box.l},${box.t} - ${box.r},${box.b} of ${box.w}x${box.h}`]);
  if (continuation.has(a.id)) continue;
  const g = framing(box);
  cases.push([`${a.id} 首帧脚底落在基线上`,
    Math.abs(g.baseline - target.baseline) <= BASELINE_TOL,
    `基线 ${(g.baseline * 100).toFixed(2)}% vs 目标 ${(target.baseline * 100).toFixed(2)}%`]);
  cases.push([`${a.id} 首帧角色高与立绘一致`,
    Math.abs(g.height - target.height) <= 0.02,
    `高 ${(g.height * 100).toFixed(2)}% vs 目标 ${(target.height * 100).toFixed(2)}%`]);
}

// 接续段不该被单独缩放。它和上一段共用同一个变换，所以两者的**画面宽度**
// 必须一致——typing-loop 那次被放大 9%，就是在这个维度上露的马脚。
for (const a of index) {
  if (!a.next) continue;
  const parent = alphaBox(join(ACTIONS, `${a.id}.webm`));
  const child = alphaBox(join(ACTIONS, `${a.next}.webm`));
  if (!parent || !child) continue;
  const pw = framing(parent).width;
  const cw = framing(child).width;
  cases.push([`${a.next} 沿用了 ${a.id} 的缩放（没被单独放大）`,
    Math.abs(pw - cw) <= 0.03, `宽 ${(cw * 100).toFixed(1)}% vs ${(pw * 100).toFixed(1)}%`]);
}

// 跑步是整组对齐的：最低的那一帧落在基线上，而 8 帧之间必须仍有明显起伏——
// 逐帧对齐会把这个起伏压平，跑起来就成了原地滑行。
const runs = [];
for (let i = 1; i <= 8; i++) {
  const f = join(PUBLIC, "立绘", "跑步", `跑步_${String(i).padStart(2, "0")}.webp`);
  if (existsSync(f)) runs.push(alphaBox(f));
}
if (runs.length === 8) {
  const bottoms = runs.map((b) => b.bottom / b.h);
  const lowest = Math.max(...bottoms);
  cases.push(["跑步最低帧落在基线上",
    Math.abs(lowest - target.baseline) <= BASELINE_TOL,
    `${(lowest * 100).toFixed(2)}% vs ${(target.baseline * 100).toFixed(2)}%`]);
  const spread = lowest - Math.min(...bottoms);
  cases.push(["跑步的上下颠簸没有被对齐压平",
    spread >= 0.02, `起伏 ${(spread * 100).toFixed(2)}%（约 ${Math.round(spread * 512)}px）`]);
} else {
  cases.push(["跑步 8 帧齐全", false, `找到 ${runs.length} 帧`]);
}

let ok = true;
for (const [label, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${label}${good ? "" : ` -> ${detail}`}`);
}
console.log(ok ? "PASS: 取景不变量成立" : "FAIL: 取景不变量被破坏");
process.exit(ok ? 0 : 1);
