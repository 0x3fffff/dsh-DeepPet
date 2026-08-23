// 按清单把 assets/ 里的运行时素材装配进 pet/public/。
//
// 为什么要有这一步：
//   1. 原来 assets/ 和 pet/public/ 是两份字节级相同的手工拷贝，靠纪律同步；
//      现在 pet/public/ 是产物（已 gitignore），双份不同步这类 bug 在结构上消失。
//   2. frontendDist 会把整个 dist 嵌进 exe，所以进了 pet/public 的每一个字节
//      都会变成二进制字节、再变成每个用户要下载的 npm 包字节。清单里只列
//      运行时真正用到的东西——那四张 1536×1024 总览大图（9.6 MB）因此不再随包分发。
//   3. 立绘转 WebP：PNG 对平涂动漫图效率很低，31 张 9.0 MB → 约 2.1 MB，
//      而它们实际只显示约 108×144 物理像素。
//
// 用法：node scripts/build-assets.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

import { alignFilter, alphaBox, refFraming } from "./lib/framing.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "assets");
const OUT = join(root, "pet", "public");

// 立绘是长时间盯着的东西，q95 相对 q90 只多约 350 KB，留作将来「桌宠尺寸」
// 设置的余量。动画帧在 build-animation.mjs 里已按 q80 生成。
const SPRITE_QUALITY = 95;

/**
 * 运行时清单。只有列在这里的才会进二进制——`立绘/` 下那几张散放的总览大图
 * （表情.png / 表情2 / 表情3 / 跑步.png）不属于任何一条，因此天然被排除。
 */
const MANIFEST = [
  // align: "each" 逐张对齐；"group" 整组用同一个位移。
  // 跑步必须整组：8 帧的包围盒底在 468~498 之间起伏，那是跑动的上下颠簸，
  // 逐帧对齐会把它压平，跑起来就僵了。
  { dir: "立绘/表情", mode: "webp", align: "each" },
  { dir: "立绘/跑步", mode: "webp", align: "group" },
  { dir: "动作", mode: "copy" }, // WebM + 末帧静图 + index.json，由 build-animation.mjs 产出
  { dir: "音效", mode: "copy", only: ["任务完成.mp3"] },
];

// ---- 静图与动作的对齐 ----
//
// 立绘和动作视频原本是三套取景（详见 scripts/lib/framing.mjs），切换时角色会
// 「胀」一下。基准取「平常」这张立绘，所以立绘这边**缩放系数正好是 1**，
// 只需要把各张的脚底对到同一条基线上；真正被缩放的是动作那边。
//
// 只对基线、不对高度：坐下比站着矮是对的，硬拉到等高就成了「坐着却和站着
// 一样高」。水平也不动——包围盒中心会被抬起的手臂带偏（表情间散布 25px，
// 跑步 8 帧散布 20px，那是摆臂），按它对齐等于为了迁就手臂去挪身体。
// 源 PNG 不动，全部是产物侧的变换。

/** 输出比输入新就跳过——这个脚本挂在每次构建上，不该每次都重压 31 张图。 */
function fresh(src, dst) {
  return existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs;
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });

const target = refFraming();
console.log(`对齐基准（平常）：宽 ${(target.width * 100).toFixed(1)}% / 高 ${(target.height * 100).toFixed(1)}%`
  + ` / 基线 ${(target.baseline * 100).toFixed(1)}%`);

/** 溢出画布的量，逐张记下来给用户看——放大到顶出画布的那几张是要重画的信号。 */
const overflow = [];

let count = 0;
let bytes = 0;
for (const entry of MANIFEST) {
  const srcDir = join(SRC, entry.dir);
  const outDir = join(OUT, entry.dir);
  if (!existsSync(srcDir)) {
    console.error(`清单指向的目录不存在：${srcDir}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const files = (entry.only ?? readdirSync(srcDir)).filter((f) => statSync(join(srcDir, f)).isFile());

  // 整组对齐：先量一遍，用**最低点**（脚踩地的那一帧）定位，其余帧保持
  // 各自相对它的偏移，跑动的起伏因此原样保留。
  const pngs = entry.align && entry.mode === "webp"
    ? files.filter((f) => f.toLowerCase().endsWith(".png"))
    : [];
  const boxes = new Map();
  for (const f of pngs) {
    const box = alphaBox(join(srcDir, f));
    if (box) boxes.set(f, box);
  }
  let groupBottom = 0;
  if (entry.align === "group") {
    for (const box of boxes.values()) groupBottom = Math.max(groupBottom, box.bottom);
  }

  for (const f of files) {
    const src = join(srcDir, f);
    if (entry.mode === "webp" && f.toLowerCase().endsWith(".png")) {
      const dst = join(outDir, `${parse(f).name}.webp`);
      const box = boxes.get(f);
      const args = ["-y", "-v", "error", "-i", src];
      if (box) {
        // 逐张：各自的包围盒底对到基线。
        // 整组：用组内最低点（脚踩地的那一帧）对基线，各帧沿用同一个位移，
        // 跑步那 30px 的上下颠簸因此原样保留。
        const anchorBottom = entry.align === "group" ? groupBottom : box.bottom;
        const { filter, over } = alignFilter(box, {
          scaleX: 1, scaleY: 1, baseline: target.baseline, anchorBottom,
        });
        args.push("-vf", filter);
        if (over.top > 0.5 || over.bottom > 0.5 || over.side > 0.5) {
          overflow.push({
            name: parse(f).name,
            top: Math.round(over.top),
            bottom: Math.round(over.bottom),
            side: Math.round(over.side),
          });
        }
      }
      args.push("-c:v", "libwebp", "-lossless", "0", "-q:v", String(SPRITE_QUALITY), dst);
      if (!fresh(src, dst)) execFileSync("ffmpeg", args);
      bytes += statSync(dst).size;
    } else {
      const dst = join(outDir, f);
      if (!fresh(src, dst)) copyFileSync(src, dst);
      bytes += statSync(dst).size;
    }
    count++;
  }
}

if (overflow.length) {
  console.log(`对齐后有 ${overflow.length} 张顶出画布（超出部分被裁掉，是该重画的信号）：`);
  for (const o of overflow.sort((a, b) => (b.top + b.bottom + b.side) - (a.top + a.bottom + a.side))) {
    const parts = [o.top > 0 ? `顶部 ${o.top}px` : "", o.bottom > 0 ? `底部 ${o.bottom}px` : "",
      o.side > 0 ? `两侧 ${o.side}px` : ""].filter(Boolean);
    console.log(`  ${o.name}: ${parts.join("，")}`);
  }
}
console.log(`装配 ${count} 个运行时素材，合计 ${(bytes / 1024 / 1024).toFixed(2)} MB → pet/public/`);
