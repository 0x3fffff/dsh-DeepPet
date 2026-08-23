// 贴边排版回归。
// 「真正靠边」这个修复的代价是：贴边后窗口有一截悬在屏幕外，气泡的可见带
// 因此变窄。算错的表现是气泡被屏幕边裁掉半个、或者尖角跑到气泡外面——两样
// 都只有肉眼才看得出来，所以把不变量在这里钉死。
// 用法：node test/bubble-layout.mjs
import { bandWidth, bubbleOffsets, edgeInset, visibleBand } from "../pet/src/bubble-layout.js";

const cases = [];
const push = (name, ok, detail) => cases.push([name, ok, detail]);
const near = (a, b) => Math.abs(a - b) < 1e-9;

// 真实数值：1080p、scale 1 下窗口 180 宽、立绘 81 宽。
const INNER = 180;
const SPRITE = 81;
const MARGIN = 6;
const TAIL_INSET = 10;

push("边距 = (窗口 - 立绘) / 2", near(edgeInset(INNER, SPRITE), 49.5), edgeInset(INNER, SPRITE));
// 立绘宽度还没拿到时必须退化成 0，否则 inset 会变成半个窗口宽，
// 贴边会把桌宠甩出屏幕。
push("立绘宽未知时边距为 0", edgeInset(INNER, 0) === 0 && edgeInset(INNER, -5) === 0);

{
  const none = visibleBand(INNER, SPRITE, null);
  const left = visibleBand(INNER, SPRITE, "left");
  const right = visibleBand(INNER, SPRITE, "right");
  push("不贴边时整窗可见", none.lo === 0 && none.hi === INNER, none);
  push("贴左时左侧 49.5 悬出屏幕", near(left.lo, 49.5) && left.hi === INNER, left);
  push("贴右时右侧 49.5 悬出屏幕", left.lo + right.hi === INNER && right.lo === 0, right);
}

// 不变量：短气泡不该动，尖角正对立绘。这是最常见的情形，动一下都是退步。
for (const edge of [null, "left", "right"]) {
  const { lo, hi } = visibleBand(INNER, SPRITE, edge);
  const { shift, tail } = bubbleOffsets({
    inner: INNER, lo, hi, width: 60, margin: MARGIN, tailInset: TAIL_INSET,
  });
  push(`短气泡在 ${edge ?? "不贴边"} 时保持居中`, shift === 0 && tail === 0, { shift, tail });
}

// 不变量（穷举）：气泡整体落在可见带内，且尖角不跑出气泡。
{
  let worstOverflow = 0;
  let worstTail = 0;
  let bad = null;
  for (const inner of [140, 180, 220, 360]) {
    for (const sprite of [0, 40, 81, 120, inner]) {
      for (const edge of [null, "left", "right"]) {
        const { lo, hi } = visibleBand(inner, sprite, edge);
        const maxW = Math.min(inner, bandWidth(lo, hi, MARGIN));
        // 从很窄到刚好顶满带宽，逐档取样。
        for (let w = 8; w <= maxW; w += 3) {
          const { shift, tail } = bubbleOffsets({
            inner, lo, hi, width: w, margin: MARGIN, tailInset: TAIL_INSET,
          });
          const c = inner / 2 + shift;
          // 允许 1e-9 的浮点尘埃，但不允许真的越界。
          const over = Math.max(lo - (c - w / 2), (c + w / 2) - hi);
          worstOverflow = Math.max(worstOverflow, over);
          worstTail = Math.max(worstTail, Math.abs(tail) - Math.max(0, w / 2 - TAIL_INSET));
          if (over > 1e-9 && !bad) bad = { inner, sprite, edge, w, shift, lo, hi };
        }
      }
    }
  }
  push("气泡永远不越出可见带", worstOverflow <= 1e-9, bad ?? `最大越界 ${worstOverflow}`);
  push("尖角永远不跑出气泡", worstTail <= 1e-9, `最大溢出 ${worstTail}`);
}

// 顶满带宽的气泡必须真的被推进带内——这正是没修之前被屏幕边裁掉的那一档。
{
  const { lo, hi } = visibleBand(INNER, SPRITE, "right");
  const w = bandWidth(lo, hi, MARGIN); // 118.5
  const { shift, tail } = bubbleOffsets({
    inner: INNER, lo, hi, width: w, margin: MARGIN, tailInset: TAIL_INSET,
  });
  const rightEdge = INNER / 2 + shift + w / 2;
  push("顶满带宽时贴着可见带右界", near(rightEdge, hi - MARGIN), { shift, rightEdge, hi });
  // 尖角要挪回立绘中心，且此时它必须还在气泡里（否则修复本身就白做了）。
  push("顶满带宽时尖角仍指着立绘", near(tail, -shift) && Math.abs(tail) <= w / 2 - TAIL_INSET,
    { tail, shift, limit: w / 2 - TAIL_INSET });
}

let ok = true;
for (const [name, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: 贴边排版不变量成立" : "FAIL: 贴边排版有回归");
process.exit(ok ? 0 : 1);
