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
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

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
  { dir: "立绘/表情", mode: "webp" },
  { dir: "立绘/跑步", mode: "webp" },
  { dir: "立绘/完成任务", mode: "copy" }, // 已是 WebP
  { dir: "音效", mode: "copy", only: ["任务完成.mp3"] },
];

/** 输出比输入新就跳过——这个脚本挂在每次构建上，不该每次都重压 31 张图。 */
function fresh(src, dst) {
  return existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs;
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });

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
  for (const f of files) {
    const src = join(srcDir, f);
    if (entry.mode === "webp" && f.toLowerCase().endsWith(".png")) {
      const dst = join(outDir, `${parse(f).name}.webp`);
      if (!fresh(src, dst)) {
        execFileSync("ffmpeg", ["-y", "-v", "error", "-i", src,
          "-c:v", "libwebp", "-lossless", "0", "-q:v", String(SPRITE_QUALITY), dst]);
      }
      bytes += statSync(dst).size;
    } else {
      const dst = join(outDir, f);
      if (!fresh(src, dst)) copyFileSync(src, dst);
      bytes += statSync(dst).size;
    }
    count++;
  }
}
console.log(`装配 ${count} 个运行时素材，合计 ${(bytes / 1024 / 1024).toFixed(2)} MB → pet/public/`);
