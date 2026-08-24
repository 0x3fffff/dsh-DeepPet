// 贴边排版的纯算术。抽出来是为了能在 node 里直接测——它是「真正靠边」这个
// 修复的核心，而它出错的表现（气泡被屏幕边裁掉半个、尖角跑到气泡外面）
// 只有肉眼才看得出来，不该只靠肉眼守着。
//
// 单位无关：settleEdge 传物理像素，layoutBubble 传逻辑像素，同一套算术。

/**
 * 立绘两侧那段全透明边距有多宽。
 *
 * 窗口宽度取的是气泡留白（180），而立绘只有 80 上下，居中放置后两侧各空出
 * 这么多。贴边时窗口正是靠这段边距悬到屏幕外的——照**窗口**边对齐的话贴完
 * 还差这么多，看起来就是「没真正靠边」。
 *
 * @param {number} winW 窗口宽度
 * @param {number} spriteW 立绘宽度（同单位）；<=0 表示布局还没下来
 * @returns {number}
 */
export function edgeInset(winW, spriteW) {
  if (!(spriteW > 0)) return 0; // 退化成按窗口边对齐，总好过算出个负数
  return Math.max(0, (winW - spriteW) / 2);
}

/**
 * 贴边后窗口有一截悬在屏幕外，窗口坐标系里留给气泡的那一段是 [lo, hi]。
 *
 * `margin` **只扣在被屏幕边裁掉的那一侧**。它的用途是「贴边时气泡别顶到
 * 屏幕边」——另一侧压根没有屏幕边在旁边，那里的界限是窗口边，隔着一段全透明
 * 区域，气泡正好贴住它也看不出来。
 *
 * 之前两侧都扣，于是不贴边时白白少了 2×margin 的可用宽度：180 变成 168，
 * 「🔧 正在执行 npm 命令」这类刚好 162 的串在部分 DPI 下就被挤成了两行。
 *
 * @param {number} inner 窗口宽度
 * @param {number} spriteW 立绘宽度
 * @param {"left"|"right"|null} edge
 * @param {number} [margin] 贴边侧与屏幕边留的空隙
 */
export function visibleBand(inner, spriteW, edge, margin = 0) {
  const off = edgeInset(inner, spriteW);
  return {
    lo: edge === "left" ? off + margin : 0,
    hi: edge === "right" ? inner - off - margin : inner,
  };
}

/**
 * 气泡该往哪挪、尖角该往回挪多少。
 *
 * 策略：**能居中就居中**（尖角正对立绘，最自然），放不下才最小幅度内移，
 * 尖角按相反方向挪回立绘中心，再夹一层保证它不跑出圆角外。
 *
 * @param {object} p
 * @param {number} p.inner 窗口宽度；立绘中心在 inner/2
 * @param {number} p.lo 可见带左界
 * @param {number} p.hi 可见带右界
 * @param {number} p.width 气泡实测宽度（已受 maxWidth 限制）
 * @param {number} p.tailInset 尖角至少离气泡两端多远
 * @returns {{ shift: number, tail: number }}
 */
export function bubbleOffsets({ inner, lo, hi, width, tailInset }) {
  const h = width / 2;
  const c = inner / 2;
  const minShift = lo + h - c;
  const maxShift = hi - h - c;
  // 先取 min(0, maxShift)：右边放不下才往左推；再抬到 minShift 之上。
  // 调用方已把 maxWidth 压到带宽以内，所以这两个界限不会互相矛盾。
  const shift = Math.max(minShift, Math.min(0, maxShift));
  const limit = Math.max(0, h - tailInset);
  return { shift, tail: Math.max(-limit, Math.min(limit, -shift)) };
}

/** 可见带里留给气泡的最大宽度。边距已经由 visibleBand 扣好了。 */
export function bandWidth(lo, hi) {
  return Math.max(1, hi - lo);
}
