// 取景基准：让静图和动作里的角色**画得一样大、站在同一条线上**。
//
// 起因是一个肉眼可见的缺陷：从静态立绘切到动作视频时角色会「胀」一下。
// 两边的画布都是 3:4，问题不在比例，在角色在帧里的画法——量下来是三套取景：
//
//   立绘 23 张            角色高 93.8%  脚底留白 4.7%  呆毛顶 y=8
//   开始打字（母版）        角色高 93.5%  脚底留白 4.9%  呆毛顶 y=7
//   其余 7 个动作（母版）    角色高 97.4%  脚底留白 2.6%  呆毛顶 y=0  ← 偏大
//
// 也就是说母版自己就有两批取景，相差约 4%。以立绘为准把所有素材归一化：
// 那 7 个动作要缩小，其余接近不动——**每个变换都是缩小或不变，不会裁掉像素**。
// 反过来以动作为准的话，立绘和开始打字都得放大，实测会裁掉发梢和手指。
//
// 源素材一律不改，全部是产物侧的变换。
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(dirname(fileURLToPath(import.meta.url))), "..");

/** 唯一基准：动作动画就是从这个姿势起手的，立绘也全都照它画。 */
export const REF_STILL = join(root, "assets", "立绘", "表情", "平常.png");

/**
 * 解出一帧 RGBA，返回不透明像素的包围盒。
 *
 * `vf` 用来先套上和正式编码相同的缩放，这样量出来的坐标直接就是产物坐标。
 * webm 必须显式指定 libvpx-vp9——默认的 vp9 解码器会丢掉 WebM 的 alpha
 * 边通道，量出来会是「整幅不透明」，那是个会让整套校准建在沙上的陷阱。
 */
export function alphaBox(file, vf) {
  const probeVf = vf ? ["-vf", vf] : [];
  const args = ["-v", "error"];
  if (file.endsWith(".webm")) args.push("-vcodec", "libvpx-vp9");
  args.push("-i", file, ...probeVf, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-");
  const buf = execFileSync("ffmpeg", args, { maxBuffer: 1 << 28 });

  let w;
  let h;
  if (vf) {
    // 套了滤镜就不能问容器要尺寸，得从滤镜里读目标尺寸。
    const m = /scale=(\d+):(\d+)/.exec(vf);
    if (!m) throw new Error(`无法从滤镜推断尺寸：${vf}`);
    w = Number(m[1]);
    h = Number(m[2]);
  } else {
    const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).toString().trim();
    [w, h] = probe.split(",").slice(0, 2).map(Number);
  }

  let l = w;
  let r = -1;
  let t = h;
  let b = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      // 阈值 8 而不是 0：有损 alpha 会在轮廓外留一圈极淡的杂边。实测 8~200
      // 之间结果稳定，所以这个阈值不是在调参数凑数。
      if (buf[row + x * 4 + 3] > 8) {
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        if (y > b) b = y;
      }
    }
  }
  if (r < 0) return null; // 整幅全透明
  return { w, h, l, r, t, b, cx: (l + r) / 2, width: r - l + 1, height: b - t + 1, bottom: b + 1 };
}

/** 把包围盒换算成与画布尺寸无关的比例，好在 384×512 和 288×384 之间比较。 */
export function framing(box) {
  return {
    width: box.width / box.w,
    height: box.height / box.h,
    baseline: box.bottom / box.h,
  };
}

let cachedRef = null;

/** 基准取景。整个流水线只算一次。 */
export function refFraming() {
  if (!cachedRef) {
    const box = alphaBox(REF_STILL);
    if (!box) throw new Error(`基准立绘没有不透明像素：${REF_STILL}`);
    cachedRef = framing(box);
  }
  return cachedRef;
}

/**
 * 算出把一张图摆正所需的 ffmpeg 滤镜，以及它会溢出画布多少。
 *
 * 先等比/非等比缩放，再垫一圈大留白、最后裁回原尺寸——这样无论位移是正是负
 * 都走同一条链路，不必分情况拼 pad/crop。
 *
 * `anchorBottom` 与 `box` 分开传是为了整组对齐：跑步 8 帧要用组内最低点当锚，
 * 各帧沿用同一个位移，那 30px 的上下颠簸才不会被逐帧对齐压平。
 */
export function alignFilter(box, { scaleX, scaleY, baseline, anchorBottom }) {
  const { w, h, cx, l, r, t } = box;
  const anchor = (anchorBottom ?? box.bottom) - 1;
  const sw = Math.round(w * scaleX);
  const sh = Math.round(h * scaleY);
  const dy = baseline * h - 1 - anchor * scaleY;
  const dx = cx * (1 - scaleX); // 水平只抵消缩放，位置不动
  const M = Math.max(w, h); // 留白要够大，容得下任意方向的位移
  const filter = `format=rgba,scale=${sw}:${sh}:flags=lanczos,`
    + `pad=${sw + 2 * M}:${sh + 2 * M}:${M}:${M}:color=#00000000,`
    + `crop=${w}:${h}:${Math.round(M - dx)}:${Math.round(M - dy)}`;
  const over = {
    top: Math.max(0, -(t * scaleY + dy)),
    bottom: Math.max(0, (box.b * scaleY + dy) - (h - 1)),
    side: Math.max(0, (r * scaleX + dx) - (w - 1), -(l * scaleX + dx)),
  };
  return { filter, over };
}

/** 让 box 的取景对上 target 所需的两个缩放系数。 */
export function scalesFor(box, target) {
  const f = framing(box);
  return { scaleX: target.width / f.width, scaleY: target.height / f.height };
}
