// 视频交接时机的回归。
//
// 这里钉的是一个真机上才冒头、且**不会报错**的缺陷：600 毫秒的兜底醒来后
// 若视频还没解出画面，旧代码直接 return，永久放弃交接——静图停在最后一帧，
// 桌宠看起来就是「动作卡死了，动一下才恢复」。最容易撞上的是拖动：跑步走
// 静图，静图上屏会 pause 两个 video，按住不动搁一会儿解码器就被释放了，
// 松手时重新加载超过 600 毫秒。
//
// 用假 video 测，因为真正要验的三件事都跟 DOM 无关：
//   1. 已经有画面就立刻交接（不空等）；
//   2. 暂时没好要**继续等**，好了照样交接（这条就是修复本身）；
//   3. 被新播放接管、或加载失败、或等到硬上限，都要拒绝交接——不确认有画面
//      就交接会亮出空 video 并熄掉静图，桌宠整个消失。
//
// 反向对照：把 video-ready.js 里 fastTimer 的 check() 换成 settle(false)
// （即恢复「600ms 没好就放弃」），「暂时没好但后来好了」那几条必须变红。
// 用法：node test/video-ready.mjs
import { FAST_MS, HARD_MS, presentable, whenPresentable } from "../pet/src/video-ready.js";

const cases = [];
const push = (name, ok, detail) => cases.push([name, ok, detail]);

/** 假 video：只实现 readyState / videoWidth / 事件这三样。 */
function fakeVideo({ readyState = 0, videoWidth = 0, rVFC = false } = {}) {
  const handlers = new Map();
  const v = {
    readyState,
    videoWidth,
    listenerCount: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
    addEventListener(t, fn) {
      if (!handlers.has(t)) handlers.set(t, new Set());
      handlers.get(t).add(fn);
    },
    removeEventListener(t, fn) { handlers.get(t)?.delete(fn); },
    emit(t) { for (const fn of [...(handlers.get(t) ?? [])]) fn(); },
    /** 模拟「解码好了」：先把状态改对，再发事件——顺序反了就测不出真问题。 */
    becomeReady(t = "loadeddata") {
      this.readyState = 4;
      this.videoWidth = 288;
      this.emit(t);
    },
  };
  if (rVFC) v.requestVideoFrameCallback = (cb) => { v._rvfc = cb; };
  return v;
}

/** 可控时钟：定时器不真的等，由测试决定什么时候到点。 */
function fakeClock() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimer(fn, ms) { const id = ++seq; pending.set(id, { fn, ms }); return id; },
    clearTimer(id) { pending.delete(id); },
    /** 触发所有到期时间 <= ms 的定时器。 */
    fire(ms) {
      for (const [id, t] of [...pending]) {
        if (t.ms <= ms) { pending.delete(id); t.fn(); }
      }
    },
    size: () => pending.size,
  };
}

const settled = (p) => Promise.race([p, Promise.resolve("pending")]);
const tick = () => new Promise((r) => setImmediate(r));

// ---- 1. 已经有画面：立刻交接，不等定时器 ----
{
  const v = fakeVideo({ readyState: 4, videoWidth: 288 });
  const c = fakeClock();
  const r = await whenPresentable(v, () => true, { setTimer: c.setTimer, clearTimer: c.clearTimer });
  push("进来就有画面则立刻交接", r === true, r);
  push("立刻交接后不留悬空的定时器", c.size() === 0, c.size());
  push("立刻交接后监听全部摘干净", v.listenerCount() === 0, v.listenerCount());
}

// ---- 2. 修复本身：600ms 时还没好，之后好了，仍然要交接 ----
{
  const v = fakeVideo();
  const c = fakeClock();
  const p = whenPresentable(v, () => true, { setTimer: c.setTimer, clearTimer: c.clearTimer });
  c.fire(FAST_MS);                       // 快路径到点，此时仍然没画面
  await tick();
  push("600ms 时没画面不该就此交接", (await settled(p)) === "pending");
  v.becomeReady("loadeddata");           // 晚到的解码
  push("晚一点解出画面仍然交接（修复本身）", (await p) === true);
}
// canplay / playing 走的是同一条路，各验一次——哪个事件先到取决于实现。
for (const evt of ["canplay", "playing"]) {
  const v = fakeVideo();
  const c = fakeClock();
  const p = whenPresentable(v, () => true, { setTimer: c.setTimer, clearTimer: c.clearTimer });
  c.fire(FAST_MS);
  await tick();
  v.becomeReady(evt);
  push(`晚到的 ${evt} 也能触发交接`, (await p) === true);
}
// requestVideoFrameCallback 是「已呈现一帧」的直接信号，可用时要认。
{
  const v = fakeVideo({ rVFC: true });
  const c = fakeClock();
  const p = whenPresentable(v, () => true, { setTimer: c.setTimer, clearTimer: c.clearTimer });
  await tick();
  v.readyState = 4; v.videoWidth = 288;
  v._rvfc();
  push("requestVideoFrameCallback 可用时认它", (await p) === true);
}

// ---- 3. 事件来了但其实还没画面：不能交接 ----
// 这条守的是原来那个 `readyState < 2` 判断的初衷：交接一个空 video 会熄掉
// 静图，桌宠**整个消失**，比卡一帧严重得多。
{
  const v = fakeVideo();
  const c = fakeClock();
  const p = whenPresentable(v, () => true, { setTimer: c.setTimer, clearTimer: c.clearTimer });
  v.emit("canplay");                     // 事件到了，但 readyState 还是 0
  c.fire(FAST_MS);
  await tick();
  push("事件到了但没画面时不交接", (await settled(p)) === "pending");
  v.becomeReady();
  push("真有画面之后才交接", (await p) === true);
}

// ---- 4. 被新播放接管：作废 ----
{
  const v = fakeVideo();
  const c = fakeClock();
  let current = true;
  const p = whenPresentable(v, () => current, { setTimer: c.setTimer, clearTimer: c.clearTimer });
  current = false;                       // 期间来了新的 playAction
  v.becomeReady();
  push("被新播放接管则拒绝交接", (await p) === false);
  push("作废后监听也摘干净", v.listenerCount() === 0, v.listenerCount());
}

// ---- 5. 加载失败 / 硬上限：认赔，别无限期挂着 ----
{
  const v = fakeVideo();
  const c = fakeClock();
  const p = whenPresentable(v, () => true, { setTimer: c.setTimer, clearTimer: c.clearTimer });
  v.emit("error");
  push("加载失败则拒绝交接", (await p) === false);
}
{
  const v = fakeVideo();
  const c = fakeClock();
  const p = whenPresentable(v, () => true, { setTimer: c.setTimer, clearTimer: c.clearTimer });
  c.fire(HARD_MS);
  push("等到硬上限则认赔", (await p) === false);
  push("认赔后定时器和监听都清干净", c.size() === 0 && v.listenerCount() === 0,
    { timers: c.size(), listeners: v.listenerCount() });
}

// ---- presentable 本身 ----
push("readyState 不足时不算有画面", presentable({ readyState: 1, videoWidth: 288 }) === false);
push("videoWidth 为 0 时不算有画面", presentable({ readyState: 4, videoWidth: 0 }) === false);
push("两者都满足才算有画面", presentable({ readyState: 2, videoWidth: 1 }) === true);
push("传进来是空的也不该炸", presentable(null) === false && presentable(undefined) === false);

// 常量本身：快路径窗口决定「正常情况多快交接」，硬上限决定「最坏等多久」。
// 写死在这里是为了改动时必须有意识地也改测试。
push("快路径窗口是 600ms", FAST_MS === 600, FAST_MS);
push("硬上限是 15s", HARD_MS === 15000, HARD_MS);

let ok = true;
for (const [name, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: 视频交接时机成立" : "FAIL: 视频交接可能卡死在静图上");
process.exit(ok ? 0 : 1);
