// 「视频什么时候可以接管画面」这一个判断。
//
// 单独成文件是因为它有过一个只在真机上冒头的死角：原来的写法是等一个
// 600 毫秒的兜底，醒来后如果视频还没解出画面就 `return`——**永久放弃**。
// 静图停在最后一帧，activeVideo 保持 null，没有任何东西会再试一次。表现
// 就是「动作卡死在这一帧，动一下才恢复」（动一下会触发新一轮 playAction）。
//
// 最容易撞上它的路径是拖动：跑步动画走静图，静图上屏时会 pause 两个 video，
// 按住不动搁一会儿，WebView2 就把暂停且不可见的媒体解码器释放了；松手时
// 重新赋 src 要走完整的加载解码，600 毫秒不够用。
//
// 那个 `return` 防的东西是对的——不确认有画面就交接，会亮出一个空的 video
// 并熄掉静图，桌宠**整个消失**，比闪一下严重得多。所以这里保留「必须真的
// 有画面才交接」，只是把「暂时没好」和「永远不会好」分开：前者继续等。
//
// 全部逻辑只认 readyState / videoWidth / 事件，不碰别的 DOM，所以能拿一个
// 假 video 直接单测（见 test/video-ready.mjs）。

/** 快路径窗口：这段时间内拿到「已呈现一帧」的信号就立刻交接。 */
export const FAST_MS = 600;
/** 硬上限：等这么久还没有画面就认赔，不再占着代次。 */
export const HARD_MS = 15000;

/**
 * 这个 video 现在有画面可交接吗。
 *
 * readyState >= 2 是 HAVE_CURRENT_DATA（当前帧可用）；videoWidth > 0 排掉
 * 「元数据还没解出来」的那一段——只看 readyState 会在个别实现上放过一个
 * 尺寸为 0 的元素，交接过去就是一片空白。
 */
export function presentable(v) {
  return !!v && v.readyState >= 2 && v.videoWidth > 0;
}

/**
 * 等到可以把画面交给这个 video。
 *
 * @param {object} v            video 或鸭子类型的替身
 * @param {() => boolean} isCurrent  代次守卫：返回 false 表示这次播放已被接管
 * @param {object} [opts]
 * @param {number} [opts.fastMs]  快路径窗口，默认 FAST_MS
 * @param {number} [opts.hardMs]  硬上限，默认 HARD_MS
 * @param {Function} [opts.setTimer]   注入定时器，供测试用
 * @param {Function} [opts.clearTimer]
 * @returns {Promise<boolean>} true = 交接；false = 别交接（被接管 / 出错 / 超上限）
 */
export function whenPresentable(v, isCurrent, opts = {}) {
  const fastMs = opts.fastMs ?? FAST_MS;
  const hardMs = opts.hardMs ?? HARD_MS;
  const setTimer = opts.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));

  return new Promise((resolve) => {
    let done = false;
    let fastTimer;
    let hardTimer;
    // 一次播放里可能挂上好几个监听，全部记下来统一摘——漏摘的监听会在
    // 元素被复用（两个 video 是乒乓轮换的）时对着下一段动作乱开火。
    const listeners = [];

    const settle = (ok) => {
      if (done) return;
      done = true;
      clearTimer(fastTimer);
      clearTimer(hardTimer);
      for (const [type, fn] of listeners) v.removeEventListener?.(type, fn);
      listeners.length = 0;
      resolve(ok);
    };

    /** 被新播放接管就作废：再交接就是把过时的画面盖回屏幕上。 */
    const check = () => {
      if (done) return;
      if (!isCurrent()) { settle(false); return; }
      if (presentable(v)) settle(true);
    };

    const on = (type) => {
      const fn = () => check();
      listeners.push([type, fn]);
      v.addEventListener?.(type, fn);
    };

    // 「已呈现一帧」的直接信号。不可用时后面几个事件顶上。
    v.requestVideoFrameCallback?.(() => check());
    // loadeddata 才是 readyState 跨到 2 的那一刻，canplay/playing 是它之后的
    // 事——三个都挂上，因为哪个先到取决于实现，而我们只要最早的那个。
    for (const t of ["loadeddata", "canplay", "playing"]) on(t);
    // 加载真的失败了就别再等：让调用方把静图留在原位，而不是占着代次不放。
    const onError = () => settle(false);
    listeners.push(["error", onError]);
    v.addEventListener?.("error", onError);

    // 快路径：事件都没来，但它其实已经有画面了（缓存命中时常见）。
    fastTimer = setTimer(() => { check(); }, fastMs);
    // 硬上限：等到这份上就是真出问题了，认赔比无限期挂着强。
    hardTimer = setTimer(() => { settle(false); }, hardMs);

    // 同步先看一眼：src 已在缓存里时可能一进来就是就绪的，没必要空等一轮。
    check();
  });
}
