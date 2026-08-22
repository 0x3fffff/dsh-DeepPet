// 从 qtrle 母版生成完成动画的 WebP 帧序列。
//
// 母版（95 MB，argb 无损）不进 git，留在仓库外；产出的 78 帧（约 1.8 MB）
// 提交进 git，这样 CI 和新克隆都不需要母版。母版换了就重跑一次这个脚本。
//
// 用法：node scripts/build-animation.mjs [--master <path>]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 帧率取 15：原生 30fps 在 108×144 的显示尺寸上看不出差别，帧数却翻倍。
const FPS = 15;
// 缩放到 3:4 —— 和立绘同比例。母版是 576×736（0.7826），比立绘的 384×512
// （0.75）宽 4.3%；实测第 0 帧的内容框与 平常.png 在归一化坐标下几乎重合，
// 说明角色本身也宽了这 4.3%。压成 3:4 既让角色与立绘对齐不跳变，也让动画
// 能复用同一个 <img> 和同一套尺寸计算，不需要任何新的布局代码。
const WIDTH = 288;
const HEIGHT = 384;
// 运动中的 78 张，压缩痕迹不可见，不必花 q95 的钱。
const QUALITY = 80;

const argMaster = process.argv.indexOf("--master");
const master = argMaster >= 0
  ? process.argv[argMaster + 1]
  : join(root, "..", "立绘", "完成任务", "完成任务-rle.mov");

if (!existsSync(master)) {
  console.error(`找不到母版：${master}\n用 --master <path> 指定，或把母版放回该位置。`);
  process.exit(1);
}

const outDir = join(root, "assets", "立绘", "完成任务");
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) {
  if (f.endsWith(".webp")) rmSync(join(outDir, f), { force: true });
}

console.log(`母版 ${master}`);
console.log(`输出 ${outDir}  ${WIDTH}x${HEIGHT} @${FPS}fps q${QUALITY}`);

execFileSync("ffmpeg", [
  "-y", "-v", "error",
  "-i", master,
  "-an",                                        // 音频单独用 音效/任务完成.mp3
  "-vf", `fps=${FPS},scale=${WIDTH}:${HEIGHT}`, // 非等比：这就是那 4.3% 的校正
  "-c:v", "libwebp",                            // 不加会被写成单个动画 WebP
  "-lossless", "0", "-q:v", String(QUALITY),
  join(outDir, "f_%03d.webp"),
], { stdio: "inherit" });

const frames = readdirSync(outDir).filter((f) => f.endsWith(".webp")).sort();
let bytes = 0;
for (const f of frames) bytes += (await import("node:fs")).statSync(join(outDir, f)).size;
console.log(`生成 ${frames.length} 帧，合计 ${(bytes / 1024).toFixed(0)} KB`);
