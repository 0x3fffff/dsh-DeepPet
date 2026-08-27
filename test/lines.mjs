// 台词库的结构与引用完整性。
//
// 台词是数据不是代码，改起来没有编译器兜着：写错一个表情名就是一张裂图，
// 而那种错**只有肉眼看得见**——桌宠不会报错，它只是显示不出来。所以这里把
// 每一条引用都对着已装配的素材核一遍。
// 用法：node test/lines.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const linesPath = join(root, "assets", "台词.json");
const faceDir = join(root, "pet", "public", "立绘", "表情");

const cases = [];
const push = (name, ok, detail) => cases.push([name, ok, detail]);

if (!existsSync(linesPath)) {
  console.log(`FAIL: 找不到台词库 ${linesPath}`);
  process.exit(1);
}

let lines;
try {
  lines = JSON.parse(readFileSync(linesPath, "utf8"));
} catch (err) {
  console.log(`FAIL: 台词库不是合法 JSON —— ${err.message}`);
  process.exit(1);
}

// 池名和桌宠代码里的常量必须对上。少一个池不会报错，只会静悄悄地不说话。
const REQUIRED = ["done", "error", "canceled", "start", "long", "streak", "low-balance"];
for (const pool of REQUIRED) {
  const arr = lines[pool];
  push(`存在 ${pool} 池`, Array.isArray(arr) && arr.length > 0, arr);
}

const extra = Object.keys(lines).filter((k) => !k.startsWith("_") && !REQUIRED.includes(k));
push("没有多余的池（拼错池名等于白写）", extra.length === 0, extra);

if (!existsSync(faceDir)) {
  console.log("SKIP: 未装配运行时素材；先跑 node scripts/build-assets.mjs");
  process.exit(0);
}
const faces = new Set(readdirSync(faceDir).map((f) => parse(f).name));

let badFace = null;
let badText = null;
let total = 0;
const dupes = [];
for (const pool of REQUIRED) {
  const arr = Array.isArray(lines[pool]) ? lines[pool] : [];
  const seen = new Set();
  for (const item of arr) {
    total++;
    if (typeof item?.t !== "string" || !item.t.trim()) badText ??= { pool, item };
    if (!faces.has(item?.face)) badFace ??= { pool, face: item?.face, t: item?.t };
    if (seen.has(item?.t)) dupes.push(`${pool}: ${item.t}`);
    seen.add(item?.t);
  }
}
push("每条都有非空台词", badText === null, badText);
push(`每条的表情都真实存在（共 ${total} 条 / ${faces.size} 张表情）`, badFace === null, badFace);
push("同一池内没有重复台词", dupes.length === 0, dupes);

// 池太小的话「不连着重复」这条约束就没意义了——两句话轮流出现比固定一句还怪。
for (const pool of REQUIRED) {
  const n = Array.isArray(lines[pool]) ? lines[pool].length : 0;
  push(`${pool} 池够大（${n} 条 ≥ 4）`, n >= 4, n);
}

let ok = true;
for (const [name, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: 台词库引用完整" : "FAIL: 台词库有问题");
process.exit(ok ? 0 : 1);
