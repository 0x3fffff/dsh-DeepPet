// 按 assets/动作清单.json 把 qtrle 母版转成运行时用的 WebM（VP9 + alpha）。
//
// 为什么是 WebM 而不是帧序列：新增的 8 段动作在 15fps 下共 978 帧，按帧序列
// 约 24 MB——会把二进制顶回优化前的水平。同分辨率 WebM 约 5 MB，小 4.7 倍。
// 「Windows 下视频会被提升到 DirectComposition 覆盖层、在透明窗口里变成黑块」
// 这个风险已实测排除：透明置顶窗口里 VP9-alpha 合成正确，桌面从角色轮廓边缘
// 透出来。
//
// 母版每个 70~140 MB，**不进 git**；转出的 .webm 进 git，所以 CI 和新克隆
// 都不需要母版。加动作只需改清单 + 重跑本脚本，不用改代码。
//
// 用法：node scripts/build-animation.mjs [--force]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { alignFilter, alphaBox, refFraming, scalesFor } from "./lib/framing.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "assets", "动作");

// 母版是 576×736（0.7826），立绘是 384×512（0.75）。压成 3:4 让角色与立绘
// 对齐不跳变，也让动画能复用同一个显示盒子。
const WIDTH = 288;
const HEIGHT = 384;
// 30fps 在约 108×144 的实际显示尺寸上看不出差别，帧数却翻倍。
const FPS = 15;
const CRF = 34;

// 取景归一化。母版自己就有两批取景（详见 lib/framing.mjs）：待机/瞌睡/玩手机
// 等 7 段里角色高占画面 97.4%、呆毛尖顶在 y=0；开始打字只有 93.5%，恰好与
// 立绘吻合。不归一化的话，「平常 → 待机动画」和「平常 → 开始打字」两条路
// 里必有一条会跳 4%——修好一条就弄坏另一条。
const REFRAME = true;

const force = process.argv.includes("--force");
const manifest = JSON.parse(readFileSync(join(root, "assets", "动作清单.json"), "utf8"));
const masterDir = join(root, manifest.masterDir);

mkdirSync(OUT_DIR, { recursive: true });

/** 产出比母版新就跳过——母版解码很慢，重跑不该每次全量重编。 */
function fresh(src, dst) {
  return !force && existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs;
}

const WIDTH_HEIGHT = `scale=${WIDTH}:${HEIGHT}`;

/**
 * 先把每段的归一化变换全部算出来，再开始编码。
 *
 * 分两趟是因为**接续的段必须沿用上一段的变换**：`typing-loop` 的首帧就是
 * `typing-intro` 的末帧（已经在打字的姿势，角色高只有 85.9%），按它自己的
 * 首帧归一化会被放大 9%——连续打字时角色比刚开始打字时大一截。清单里的
 * `next` 已经声明了这层接续关系，直接拿来用。
 *
 * 换句话说「整段按首帧对齐」成立的前提是**首帧是中性起手式**；`next` 指向的
 * 那一段恰恰不满足这个前提，所以它不自己量，而是继承。
 */
function planReframes() {
  const plan = new Map();
  if (!REFRAME) return plan;
  const target = refFraming();
  const continues = new Map(); // 子 id -> 父 id
  for (const a of manifest.actions) if (a.next) continues.set(a.next, a.id);

  // 先算不接续任何人的（首帧是中性起手式的那些）。
  for (const a of manifest.actions) {
    if (continues.has(a.id)) continue;
    const src = join(masterDir, a.file);
    if (!existsSync(src)) continue;
    const box = alphaBox(src, WIDTH_HEIGHT);
    if (!box) continue;
    const scales = scalesFor(box, target);
    const { filter, over } = alignFilter(box, { ...scales, baseline: target.baseline });
    plan.set(a.id, { filter, ...scales, over });
  }
  // 再让接续的段原样继承。父段缺失时就不归一化，总比错得离谱好。
  for (const [child, parent] of continues) {
    const p = plan.get(parent);
    if (p) plan.set(child, { ...p, from: parent });
  }
  return plan;
}

const plan = planReframes();

const index = [];
const reframes = [];
let missing = 0;
let encoded = 0;
let totalBytes = 0;

for (const a of manifest.actions) {
  const src = join(masterDir, a.file);
  const webm = join(OUT_DIR, `${a.id}.webm`);
  const hold = a.hold === "last-frame" ? join(OUT_DIR, `${a.id}-hold.webp`) : null;

  if (!existsSync(src)) {
    // 母版不在（例如别人克隆了仓库但没有素材）——已有产出仍然可用。
    if (existsSync(webm)) {
      console.log(`跳过 ${a.id}（母版不在，沿用已有产出）`);
    } else {
      console.error(`缺失 ${a.id}：找不到母版 ${src}`);
      missing++;
      continue;
    }
  } else if (fresh(src, webm) && (!hold || fresh(src, hold))) {
    console.log(`跳过 ${a.id}（产出已是最新）`);
  } else {
    const t0 = Date.now();
    // base 把母版按目标尺寸缩好（非等比：母版 576×736 是 0.7826，产物是 3:4），
    // 归一化的坐标就是在这之后的产物坐标里算的。
    const base = WIDTH_HEIGHT;
    const p = plan.get(a.id);
    const reframe = p ? `,${p.filter}` : "";
    if (p) reframes.push({ id: a.id, ...p });
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-i", src,
      "-an",                                        // 音频单独管
      "-vf", `fps=${FPS},${base}${reframe}`,
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", // yuva = 带 alpha
      "-b:v", "0", "-crf", String(CRF), "-row-mt", "1",
      webm,
    ], { stdio: "inherit" });
    if (hold) {
      // 末帧静图：贴边播完之后常驻用。用动画自己的末帧而不是单独的 PNG，
      // 衔接才不会跳。归一化变换必须和上面**逐字相同**，否则定格那一下会跳。
      execFileSync("ffmpeg", [
        "-y", "-v", "error", "-sseof", "-0.2", "-i", src,
        "-vf", `${base}${reframe}`, "-vframes", "1",
        "-c:v", "libwebp", "-lossless", "0", "-q:v", "90",
        hold,
      ], { stdio: "inherit" });
    }
    encoded++;
    console.log(`编码 ${a.id}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${(statSync(webm).size / 1024).toFixed(0)} KB`);
  }

  totalBytes += existsSync(webm) ? statSync(webm).size : 0;
  if (hold && existsSync(hold)) totalBytes += statSync(hold).size;

  index.push({
    id: a.id,
    pool: a.pool,
    ...(a.role ? { role: a.role } : {}),
    ...(a.next ? { next: a.next } : {}),
    ...(hold ? { hold: true } : {}),
  });
}

// 清掉清单里已经删掉的动作留下的产物。
const known = new Set(index.flatMap((a) => [`${a.id}.webm`, `${a.id}-hold.webp`]));
for (const f of readdirSync(OUT_DIR)) {
  if (f !== "index.json" && !known.has(f)) {
    rmSync(join(OUT_DIR, f), { force: true });
    console.log(`清除 ${f}（已不在清单里）`);
  }
}

if (reframes.length) {
  console.log(""); // 与上面的编码日志隔开
  console.log("取景归一化（以立绘为准）：");
  for (const r of reframes) {
    const clip = [
      r.over.top > 0.5 ? `顶 ${r.over.top.toFixed(0)}px` : "",
      r.over.bottom > 0.5 ? `底 ${r.over.bottom.toFixed(0)}px` : "",
      r.over.side > 0.5 ? `侧 ${r.over.side.toFixed(0)}px` : "",
    ].filter(Boolean).join("，");
    console.log(`  ${r.id.padEnd(14)} 横 ${r.scaleX.toFixed(4)}  纵 ${r.scaleY.toFixed(4)}`
      + (r.from ? `  （沿用 ${r.from}）` : "")
      + (clip ? `  ! 裁切 ${clip}` : ""));
  }
}

writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(`\n${index.length} 个动作，新编码 ${encoded} 个，合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
if (missing) { console.error(`${missing} 个缺母版`); process.exit(1); }
