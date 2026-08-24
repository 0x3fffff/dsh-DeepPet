import { currentMonitor, getCurrentWindow, LogicalPosition, PhysicalPosition } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { bandWidth, bubbleOffsets, edgeInset, visibleBand } from "./bubble-layout.js";
import { listen } from "@tauri-apps/api/event";

const RUN_FRAMES = Array.from(
  { length: 8 },
  (_, i) => `/立绘/跑步/跑步_${String(i + 1).padStart(2, "0")}.webp`,
);
const IDLE = "/立绘/表情/平常.webp";
const SEARCHING = "/立绘/表情/寻找.webp";
const TASK_FAILED = "/立绘/表情/晕.webp";
// 「已终止」用中性表情：不庆祝，也不卖惨——是你自己按的终止。
const TASK_CANCELED = "/立绘/表情/坐下.webp";
const AUDIO = "/音效/任务完成.mp3";
const FPS = 12;

// 动作库：由 assets/动作清单.json 驱动，构建时转成 WebM（VP9+alpha）并产出
// /动作/index.json。加动作只改清单，**不动这里的代码**。
const ACTION_INDEX = "/动作/index.json";
const LINES_URL = "/台词.json";
const faceUrl = (name: string) => `/立绘/表情/${name}.webp`;
const actionUrl = (id: string) => `/动作/${id}.webm`;
const holdUrl = (id: string) => `/动作/${id}-hold.webp`;

const POS_KEY = "deep-pet-position-v2";
const EDGE_KEY = "deep-pet-edge-v1";
// 方向迟滞：反向累计移动达到该阈值（逻辑像素）才翻转朝向。
const HYSTERESIS_PX = 16;
// 重连节奏与预算。DSH 崩溃/被强杀时插件的 cleanup 不会执行，没人来杀桌宠，
// 所以由桌宠自己兜底：断连超过预算就自我了断。预算要够长，好让 DSH 正常
// 重启期间桌宠能活下来。
const RECONNECT_INTERVAL_MS = 1500;
const RECONNECT_BUDGET_MS = 30_000;

// 随机待机：太密显得多动症，太疏等于没做。
const IDLE_ANIM_MIN_MS = 25_000;
const IDLE_ANIM_MAX_MS = 70_000;
// 长时间无操作：系统级空闲超过它就进瞌睡/玩手机。
const LONG_IDLE_MS = 5 * 60_000;
const LONG_IDLE_SWAP_MIN_MS = 60_000;
const LONG_IDLE_SWAP_MAX_MS = 120_000;
// 空闲轮询。长闲态下加密，好让「一有输入立刻醒」不打折扣。
const IDLE_POLL_MS = 5_000;
const IDLE_POLL_FAST_MS = 1_000;
// 进入工作态的防抖：半秒就结束的任务不该闪一下打字入场再跳走。
const WORKING_DEBOUNCE_MS = 800;
// 开场白的冷却。完成/出错每次都说（那本来就是你要的反馈），开场白不行——
// 连着跑 20 个小任务就是 20 句「交给我吧」，那是纯噪音。
const START_LINE_COOLDOWN_MS = 3 * 60_000;
// 「这个有点难」的判据：干了这么久、或者折腾了这么多次工具调用。
// 开始那一刻是判断不出难易的（那时只有一个 running 状态），只能中途看。
const LONG_TASK_MS = 90_000;
const LONG_TASK_TOOLS = 12;
// 按工具调用次数触发时的下限：十几个飞快的调用只说明活儿碎，不说明难。
const LONG_TASK_MIN_MS = 15_000;
// 台词自己也占气泡，给它一段固定时长（比进度气泡长，比播报短）。
const LINE_SHOW_MS = 4_000;
// 进度气泡的节律：亮一下、歇一会，不常驻占着屏幕。冷却曾经是 5s，叠上
// 插件侧 6s 的 todo 遮蔽后，一个 turn 里最靠前的那几个工具调用（think、
// pwsh 之类）会整个落进盲区，一条都看不到。收紧到这个量级后绝大部分调用
// 都能露一次面，任务间隙依然会完全消失。
const PROGRESS_SHOW_MS = 3_000;
const PROGRESS_COOLDOWN_MS = 1_500;
// 贴边吸附阈值（逻辑像素）。松手时判定，拖动中不判——否则路过左边就被吸住。
const EDGE_SNAP_PX = 24;
// 判定「这是拖动」而不是「这是一次点击」的位移阈值（逻辑像素）。
// 移动窗口、进入跑步态、松手后吸附三件事共用它——从前只有前两件用，
// 于是任何一次点击（包括双击的那两下）都会闪一下跑步动画。
const DRAG_THRESHOLD_PX = 8;
// 贴边时气泡与屏幕边之间留的空隙（逻辑像素）。
const BUBBLE_EDGE_MARGIN = 6;
// 尖角至少离气泡两端这么远，免得它挪到圆角外面去。
const TAIL_INSET = 10;
// todo 遮蔽窗口：一条 todo 之后短时间内压住工具级进度，免得立刻被盖掉。
// 从插件侧搬到这里，好让限流逻辑集中在一处、且被丢弃的事件仍能进测试日志。
const TODO_SHADOW_MS = 2_000;

interface InitInfo {
  ws_url: string;
  version: string;
  debug: boolean;
  sprite_w: number;
  sprite_h: number;
  headroom: number;
  bubble_max_w: number;
}

const appWindow = getCurrentWindow();
const img = document.getElementById("pet-img") as HTMLImageElement;
const bubble = document.getElementById("bubble") as HTMLElement;
const menu = document.getElementById("menu") as HTMLElement;
const menuSettings = document.getElementById("menu-settings") as HTMLElement;
const menuTest = document.getElementById("menu-test") as HTMLElement;
const videos = [
  document.getElementById("pet-video") as HTMLVideoElement,
  document.getElementById("pet-video-b") as HTMLVideoElement,
];

/**
 * 桌宠设置。存在会合目录的 settings.json 里，归属「桌宠」这个机器级单例
 * 而不是任何一个 DSH profile——一只桌宠服务 N 个插件，存进某个插件的配置
 * 就说不清谁说了算。`bubbleMs` 因此也从插件配置搬到了这里。
 */
interface Settings {
  bubble_style: string;
  bubble_ms: number;
  sound: boolean;
  pet_scale: number;
  bubble_scale: number;
  lines: boolean;
}
let settings: Settings = {
  bubble_style: "classic", bubble_ms: 5000, sound: true,
  pet_scale: 1, bubble_scale: 1, lines: true,
};

function applySettings() {
  bubble.dataset.style = settings.bubble_style;
  // 字号、内边距、圆角、尖角全挂在这一个变量上（见 bubble.css），
  // 所以整体缩放只需要写这一处。最大宽度由 Rust 随 InitInfo 一起下发。
  bubble.style.setProperty("--bubble-scale", String(settings.bubble_scale || 1));
  layoutBubble();
}

// ---- 动作库 ----
interface ActionDef {
  id: string;
  pool: string;
  role?: "intro" | "loop";
  next?: string;
  hold?: boolean;
}

const byId = new Map<string, ActionDef>();
const byPool = new Map<string, ActionDef[]>();

async function loadActions() {
  try {
    const list: ActionDef[] = await (await fetch(ACTION_INDEX)).json();
    for (const a of list) {
      byId.set(a.id, a);
      const arr = byPool.get(a.pool);
      if (arr) arr.push(a); else byPool.set(a.pool, [a]);
    }
  } catch {
    // 动作库缺失时退化成静态立绘。基本功能不该依赖有没有视频素材。
  }
}

/** 从池里随机取一个，尽量不连着取同一个；intro 角色不参与随机。 */
function pick(pool: string, avoid?: string): ActionDef | undefined {
  const all = (byPool.get(pool) ?? []).filter((a) => a.role !== "intro");
  if (all.length === 0) return undefined;
  const candidates = all.length > 1 && avoid ? all.filter((a) => a.id !== avoid) : all;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

// ---- 台词库 ----
// 数据不是代码：加一句只改 assets/台词.json。用户还能把它复制到会合目录
// 改称呼和口味——发给社区之后「主人」这个称呼肯定有人想换，与其我内置好几套
// 语气去猜别人的口味，不如让他们自己写。
interface Line {
  t: string;
  face: string;
}

type LinePool = "done" | "error" | "canceled" | "start" | "long" | "streak";

const lines = new Map<LinePool, Line[]>();
// 每池上一句，用来避免连着抽到同一句——池子再大，连说两遍同一句也很出戏。
const lastLine = new Map<LinePool, string>();

async function loadLines() {
  try {
    // 用户自定义优先。整体替换而不是逐池合并——合并的话「我只想改完成那一池」
    // 和「我想删掉某几句」会得到完全不同的直觉，说不清楚。
    let data: unknown = null;
    try {
      const custom = await invoke<string | null>("get_lines");
      if (custom) data = JSON.parse(custom);
    } catch {
      // 用户那份写坏了就当没有，退回内置的。
    }
    if (!data) data = await (await fetch(LINES_URL)).json();
    const src = data as Record<string, unknown>;
    for (const pool of ["done", "error", "canceled", "start", "long", "streak"] as LinePool[]) {
      const arr = Array.isArray(src?.[pool]) ? (src[pool] as unknown[]) : [];
      const clean = arr.filter((x: unknown): x is Line =>
        !!x && typeof (x as Line).t === "string" && typeof (x as Line).face === "string");
      if (clean.length) lines.set(pool, clean);
    }
  } catch {
    // 台词库缺失或写坏了都退化成不说话，而不是让桌宠起不来。
    // test/lines.mjs 会在构建期把引用错误挡住。
  }
}

/** 从台词池里抽一句，尽量不连着抽到同一句。台词关掉或池为空时返回 null。 */
function pickLine(pool: LinePool): Line | null {
  if (!settings.lines) return null;
  const all = lines.get(pool);
  if (!all || !all.length) return null;
  const avoid = lastLine.get(pool);
  const candidates = all.length > 1 && avoid ? all.filter((l) => l.t !== avoid) : all;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  lastLine.set(pool, chosen.t);
  return chosen;
}

// ---- 播放通道 ----
// 静图走 <img>，动作走两个轮换的 <video>。
//
// 交接的铁律是**新的准备好了再撤旧的**，而且两个方向都要守。原来只守了一半：
//   - 静图→视频：等 `playing` 再隐藏静图 ✔
//   - 视频→静图：设完 img.src 就立刻藏掉视频 ✘ —— 图还没解码完，那一瞬两边
//     都没内容，就是肉眼看到的一闪；
//   - 视频→视频：在同一个 <video> 上换 src 会立刻清空当前帧 ✘ —— 每次
//     typing-intro→typing-loop、每次长闲换动作、每次 edge-lean→定格都会闪。
// 所以静图先离屏解码、视频用两个元素乒乓，旧层在等待期间一直定格在最后一帧。

let currentAction: string | null = null;
let endHandler: (() => void) | null = null;
let endTarget: HTMLVideoElement | null = null;
let activeVideo: HTMLVideoElement | null = null;
// 交接代数。异步等待期间又来了新的播放请求时，旧的那次醒来必须自觉作废，
// 否则会把已经过时的画面盖回屏幕上。
let playGen = 0;

function clearEndHandler() {
  if (endHandler && endTarget) endTarget.removeEventListener("ended", endHandler);
  endHandler = null;
  endTarget = null;
}

/**
 * 等到这个 video 真的把一帧交给了合成器。
 *
 * requestVideoFrameCallback 的语义正是「已呈现一帧」，比 `playing`（只表示
 * 播放已开始）准。它不可用、或解码失败/被策略拦下时都要有退路，否则画面会
 * 永远卡在旧层——所以再挂一个 `playing` 和一个超时兜底。
 */
function firstFrame(v: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; resolve(); };
    const anyV = v as unknown as { requestVideoFrameCallback?: (cb: () => void) => void };
    anyV.requestVideoFrameCallback?.(fin);
    v.addEventListener("playing", fin, { once: true });
    window.setTimeout(fin, 600);
  });
}

// 离屏预解码用的元素。直接给 #pet-img 赋 src 会有一段「已换 src、尚未解码」
// 的空窗，那正是视频→静图那一闪的来源。
const preloader = new Image();

async function decoded(url: string) {
  try {
    preloader.src = url;
    await preloader.decode();
  } catch {
    // decode 不被支持、或图本身挂了，都不该把状态机卡住——照常上屏，
    // 最差也只是退回原来的行为。
  }
}

// 空帧看门狗（仅调试模式）。闪动的本质是「静图已经熄了，而视频还没有画面」
// 这一瞬——它只持续一两帧，截图抓不到（一次 PrintWindow 就要 300ms）。所以
// 在页面里按 rAF 直接盯这个不变量，自动化测试再去读计数。
let blankFrames = 0;
let watchArmed = false;

function nothingVisible() {
  if (img.style.opacity !== "0") return false;
  for (const v of videos) {
    if (v.style.opacity !== "0" && v.readyState >= 2 && v.videoWidth) return false;
  }
  return true;
}

function startBlankWatch() {
  // 看门狗读的是 inline style，而两个 video 的初始 inline opacity 是空串
  // （透明由 CSS 给）。空串 !== "0"，它会把一个其实看不见的 video 当成
  // 「可见」而漏报——能报假绿的看门狗比没有还糟。先把 inline 值钉死。
  for (const v of videos) if (!v.style.opacity) v.style.opacity = "0";
  const tick = () => {
    // 首次真正画出东西之后才开始计数，免得把启动前的空白算进去。
    if (!watchArmed) {
      if (!nothingVisible()) watchArmed = true;
    } else if (nothingVisible()) {
      blankFrames++;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function hideVideos(except?: HTMLVideoElement) {
  for (const v of videos) {
    if (v === except) continue;
    v.style.opacity = "0";
    try { v.pause(); } catch {}
  }
}

function showStill(url: string, mirror = false) {
  const gen = ++playGen;
  currentAction = null;
  clearEndHandler();
  void (async () => {
    await decoded(url);
    if (gen !== playGen) return; // 等待期间已被新的播放接管
    img.src = url;
    img.style.transform = mirror ? "scaleX(-1)" : "scaleX(1)";
    img.style.opacity = "1";
    // 图解码好了、也点亮了，这时候撤视频层才不会露白。
    hideVideos();
    activeVideo = null;
  })();
}

interface PlayOpts {
  mirror?: boolean;
  loop?: boolean; // 覆盖清单里的 role
  rate?: number;  // 变速，用于让完成动画适配气泡时长
  onEnd?: () => void;
}

function playAction(id: string, opts: PlayOpts = {}): boolean {
  const def = byId.get(id);
  if (!def) return false;
  const gen = ++playGen;
  clearEndHandler();
  currentAction = id;
  // 装新动作的永远是当前**没在显示**的那个元素，旧的继续定格在最后一帧。
  const next = videos.find((v) => v !== activeVideo) ?? videos[0];
  next.loop = opts.loop ?? def.role === "loop";
  next.playbackRate = opts.rate ?? 1;
  next.style.transform = opts.mirror ? "scaleX(-1)" : "scaleX(1)";
  next.src = actionUrl(id);
  if (!next.loop && opts.onEnd) {
    endTarget = next;
    endHandler = () => { clearEndHandler(); opts.onEnd?.(); };
    next.addEventListener("ended", endHandler);
  }
  void next.play().catch(() => {});
  void firstFrame(next).then(() => {
    if (gen !== playGen) return;
    // 超时兜底会在解码失败时也把我们唤醒。这时候若照常交接，就会亮出一个
    // 空的 video 并熄掉静图——桌宠**整个消失**，比原来的一闪严重得多。
    // 所以交接前确认它真的有画面，没有就把静图留在原位。
    if (next.readyState < 2 || !next.videoWidth) return;
    next.style.opacity = "1";
    // 只熄灭绘制，保留布局盒——命中区和鼠标事件都还挂在 img 上。
    img.style.opacity = "0";
    hideVideos(next);
    activeVideo = next;
  });
  return true;
}

// ---- 拖动时的跑步动画 ----
let mode: "idle" | "running" | "task" = "idle";
let facing: "left" | "right" = "left";
let runTimer: number | undefined;
let runIndex = 0;
let scale = 1;
let bubbleTimer: number | undefined;
let audio: HTMLAudioElement | undefined;

appWindow.scaleFactor().then((s) => { scale = s; }).catch(() => {});

function startRun(dir: "left" | "right") {
  facing = dir;
  stopRun();
  runIndex = 0;
  showStill(RUN_FRAMES[0], facing === "right");
  runTimer = window.setInterval(() => {
    runIndex = (runIndex + 1) % RUN_FRAMES.length;
    img.src = RUN_FRAMES[runIndex];
  }, Math.round(1000 / FPS));
}

function stopRun() {
  if (runTimer !== undefined) { window.clearInterval(runTimer); runTimer = undefined; }
}

// ---- 状态与仲裁 ----
// 优先级（高者胜）：拖动 > 播报 > 工作中 > 长闲 > 随机待机 > 平常。
// 「贴边」不在这个序列里，它是正交的模式：贴边期间身体固定为趴屏幕的静图、
// 压掉待机一族，而工作/播报只出气泡不换身体。位置归你，状态归它。

type Edge = "left" | "right" | null;

const st = {
  dragging: false,
  working: false,
  longIdle: false,
  edge: null as Edge,
};

/** 当前呈现的类别。只有类别变了才重新进场，否则会把正在播的动作打断重来。 */
let shown = "";

function wantKind(): string {
  if (st.dragging) return "drag";
  if (st.edge) return `edge:${st.edge}`;
  if (burst) return `announce:${burstState(burst)}`;
  if (st.working) return "working";
  if (st.longIdle) return "longIdle";
  return "idle";
}

function render(force = false) {
  const want = wantKind();
  if (!force && want === shown) return;
  shown = want;
  mode = want === "drag" ? "running" : want.startsWith("announce:") ? "task" : "idle";
  clearIdleTimer();
  clearLongIdleTimer();
  if (want !== "drag") stopRun();

  if (want === "drag") { startRun(facing); return; }
  if (want.startsWith("edge:")) { enterEdge(want.endsWith("right")); return; }
  if (want.startsWith("announce:")) { enterAnnounce(); return; }
  if (want === "working") { enterWorking(); return; }
  if (want === "longIdle") { enterLongIdle(); return; }
  enterIdle();
}

// ---- 贴边 ----
const EDGE_ACTION = "edge-lean";

function enterEdge(mirror: boolean) {
  // 入场动画播完定格在末帧静图。末帧图由 build-animation.mjs 从动画自己的
  // 最后一帧导出，所以衔接零跳变。
  const ok = playAction(EDGE_ACTION, {
    mirror,
    onEnd: () => { if (shown.startsWith("edge:")) showStill(holdUrl(EDGE_ACTION), mirror); },
  });
  if (!ok) showStill(holdUrl(EDGE_ACTION), mirror);
}

// ---- 工作中 ----
function enterWorking() {
  const intro = (byPool.get("working") ?? []).find((a) => a.role === "intro");
  const loop = intro?.next ?? pick("working")?.id;
  if (intro) {
    playAction(intro.id, {
      onEnd: () => { if (shown === "working" && loop) playAction(loop, { loop: true }); },
    });
  } else if (loop) {
    playAction(loop, { loop: true });
  } else {
    showStill(IDLE);
  }
}

// ---- 长时间无操作 ----
let longIdleTimer: number | undefined;
let lastLongIdle: string | undefined;

function clearLongIdleTimer() {
  if (longIdleTimer !== undefined) { window.clearTimeout(longIdleTimer); longIdleTimer = undefined; }
}

function enterLongIdle() {
  const a = pick("long-idle", lastLongIdle);
  if (!a) { showStill(IDLE); return; }
  lastLongIdle = a.id;
  // 循环播放：人不在的时候画面不该每 8 秒回一次站姿。
  playAction(a.id, { loop: true });
  longIdleTimer = window.setTimeout(() => {
    if (shown === "longIdle") enterLongIdle();
  }, rand(LONG_IDLE_SWAP_MIN_MS, LONG_IDLE_SWAP_MAX_MS));
}

// ---- 待机 ----
let idleTimer: number | undefined;
let lastIdleAnim: string | undefined;

function clearIdleTimer() {
  if (idleTimer !== undefined) { window.clearTimeout(idleTimer); idleTimer = undefined; }
}

function idleStill() {
  // 确认连不上时空闲态换成「寻找」，让「它在找 DSH」和「它卡死了」可区分。
  return searching ? SEARCHING : IDLE;
}

function enterIdle() {
  showStill(idleStill());
  scheduleIdleAnim();
}

function scheduleIdleAnim() {
  clearIdleTimer();
  idleTimer = window.setTimeout(() => {
    if (shown !== "idle") return;
    const a = pick("idle", lastIdleAnim);
    if (!a) { scheduleIdleAnim(); return; }
    lastIdleAnim = a.id;
    playAction(a.id, {
      onEnd: () => {
        if (shown !== "idle") return;
        showStill(idleStill());
        scheduleIdleAnim();
      },
    });
  }, rand(IDLE_ANIM_MIN_MS, IDLE_ANIM_MAX_MS));
}

/** 连接状态变化时让空闲立绘即时跟进（平常 ⇄ 寻找）。 */
function refreshIdleStill() {
  if (shown === "idle" && currentAction === null) showStill(idleStill());
}

// ---- 气泡排版 ----
// 窗口宽度取的是气泡留白（180 逻辑像素），而立绘只有 80 上下，居中放置后
// 两侧各有约 50px 的全透明边距。贴边时窗口正是靠这段边距悬到屏幕外的，于是
// 气泡的可见带也窄了同样多——直接居中就会被屏幕边裁掉一半。
//
// 策略：**能居中就居中**（尖角正对立绘，最自然），放不下才最小幅度内移，
// 并把尖角按相反方向挪回立绘中心。尖角本身再夹一层，保证不跑出圆角外。
let spriteWLogical = 0;
let bubbleMaxW = 180;

function layoutBubble() {
  const inner = window.innerWidth;
  if (!inner) return;
  // 边距只扣在贴边那一侧（见 bubble-layout.js）。两侧都扣的话不贴边时白少
  // 12px，刚好卡在上限附近的串会被挤成两行。
  const { lo, hi } = visibleBand(inner, spriteWLogical, st.edge, BUBBLE_EDGE_MARGIN);
  // 先压 max-width，再量实际宽度——顺序反了就会拿旧宽度去算位移。
  bubble.style.maxWidth = `${Math.min(bubbleMaxW, bandWidth(lo, hi))}px`;
  const { shift, tail } = bubbleOffsets({
    inner, lo, hi,
    width: bubble.offsetWidth,
    tailInset: TAIL_INSET,
  });
  bubble.style.setProperty("--shift", `${shift.toFixed(1)}px`);
  bubble.style.setProperty("--tail-shift", `${tail.toFixed(1)}px`);
}

function showBubble(text: string, ms: number, sub?: string) {
  bubble.textContent = "";
  // 逐段 textContent，**不拼 innerHTML**：副行是会话标题，由模型生成，
  // 拼 HTML 等于把它当标记解释。
  const main = document.createElement("div");
  main.textContent = text;
  bubble.append(main);
  if (sub) {
    const el = document.createElement("div");
    el.className = "sub";
    el.textContent = sub;
    bubble.append(el);
  }
  layoutBubble(); // 宽度随内容变，位移和尖角得按这一条的实际宽度重算
  bubble.classList.add("show");
  if (bubbleTimer !== undefined) window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => bubble.classList.remove("show"), ms);
}

function ensureAudio() {
  if (audio) return;
  audio = new Audio(AUDIO);
  // 借首次用户手势解锁自动播放。
  audio.play().then(() => { audio!.pause(); audio!.currentTime = 0; }).catch(() => {});
}

function playDone() {
  if (!settings.sound) return;
  ensureAudio();
  if (audio) { audio.currentTime = 0; audio.play().catch(() => {}); }
}

/**
 * 一轮播报。并发完成时不排队而是合并——排队会让桌宠播报几十秒前的状态，
 * 而桌宠的价值恰恰是「一眼看过去知道现在怎么样」。
 */
interface Burst {
  successes: number;
  successTitle: string;
  successLabel: string;
  errorTitle: string | null;
  errorLabel: string;
  canceledTitle: string | null;
  canceledLabel: string;
  soundPlayed: boolean;
  /** 连续失败次数，由插件下发。1 表示这是第一次栽。 */
  streak: number;
  /**
   * 这一轮播报抽中的台词。**必须在决定身体之前抽**：身体（表情）和文字来自
   * 同一条台词的 face 标签，各抽各的就会出现「我是不是很笨」配一张晕脸这种
   * 对不上的组合。播报类别变了要重抽。
   */
  line: Line | null;
  linePool: LinePool | null;
}

/** 优先级：出错 > 已终止 > 完成。 */

/** 这一轮播报里到底有没有真标题——没有的话副行是废话，不如不显示。 */
function hasTitle(b: Burst, state: "error" | "canceled" | "success") {
  if (state === "error") return !!b.errorTitle;
  if (state === "canceled") return !!b.canceledTitle;
  return !!b.successTitle;
}

function burstState(b: Burst): "error" | "canceled" | "success" {
  if (b.errorTitle !== null) return "error";
  if (b.canceledTitle !== null) return "canceled";
  return "success";
}

let burst: Burst | null = null;
// 播报代次。两次完成相隔 1 秒时，旧的那次排的「回空闲」会在新气泡还挂着的
// 时候触发，导致立绘先变回平常、文字还在——用代次号让只有最新一次生效。
let announceGen = 0;

function decorate(label: string, title: string) {
  const t = title ? `「${title}」` : "任务";
  return label ? `[${label}] ${t}` : t;
}

/** 完成动画的原生时长（秒），用来把播放速率算成刚好塞进 bubbleMs。 */
const DONE_NATIVE_S = 5.17;

function enterAnnounce() {
  const b = burst;
  if (!b) return;
  const state = burstState(b);
  if (state === "error") {
    // 表情跟着台词走（face 标签）。台词关掉或抽不到就退回固定那张。
    showStill(b.line ? faceUrl(b.line.face) : TASK_FAILED);
  } else if (state === "canceled") {
    showStill(b.line ? faceUrl(b.line.face) : TASK_CANCELED);
  } else {
    // bubbleMs 说了算：预算短于原生时长就按比例加速，让动画完整播完而不是被
    // 砍在半路；长于则原速播完、停在最后一帧（视频播完自然定格）。
    const rate = Math.max(1, (DONE_NATIVE_S * 1000) / Math.max(1, settings.bubble_ms));
    if (!playAction("done", { rate })) showStill(IDLE);
  }
}

/** 这一轮播报该用哪个台词池。连续失败第 2 次起换一池更沮丧的说法。 */
function poolFor(b: Burst): LinePool {
  const state = burstState(b);
  if (state === "error") return b.streak >= 2 ? "streak" : "error";
  if (state === "canceled") return "canceled";
  return "done";
}

function renderAnnounceBubble(b: Burst, bubbleMs: number) {
  const state = burstState(b);
  const line = b.line;
  let text: string;
  let sub: string | undefined;
  if (state === "error") {
    text = `${decorate(b.errorLabel, b.errorTitle as string)}出错了`;
    if (b.successes > 0) text += `（另有 ${b.successes} 个完成）`;
  } else if (state === "canceled") {
    text = `${decorate(b.canceledLabel, b.canceledTitle as string)}已终止`;
    if (b.successes > 0) text += `（另有 ${b.successes} 个完成）`;
  } else {
    text = b.successes > 1
      ? `${decorate(b.successLabel, b.successTitle)}等 ${b.successes} 个任务完成`
      : `${decorate(b.successLabel, b.successTitle)}完成`;
  }
  if (line) {
    // 台词当主角，原来那句信息降为副行。标题为空时 decorate 会退化成「任务
    // 完成」这种废话，那时副行直接省掉——并发合并的「等 N 个」仍要留着。
    sub = hasTitle(b, state) || b.successes > 1 ? text : undefined;
    text = line.t;
  }
  showBubble(text, bubbleMs, sub);
  const gen = ++announceGen;
  window.setTimeout(() => {
    if (gen !== announceGen) return; // 已被更新的播报接管
    burst = null;
    render();
  }, bubbleMs);
}

function onTaskComplete(title: string, outcome: string, label: string, streak = 0) {
  const bubbleMs = settings.bubble_ms;
  const before = burst ? burstState(burst) : null;
  if (!burst) {
    burst = {
      successes: 0, successTitle: "", successLabel: "",
      errorTitle: null, errorLabel: "",
      canceledTitle: null, canceledLabel: "",
      soundPlayed: false, streak: 0, line: null, linePool: null,
    };
  }
  if (outcome === "error") {
    burst.errorTitle = title;
    burst.errorLabel = label;
    burst.streak = Math.max(burst.streak, streak);
  } else if (outcome === "canceled") {
    burst.canceledTitle = title;
    burst.canceledLabel = label;
  } else {
    burst.successes++;
    burst.successTitle = title;
    burst.successLabel = label;
  }
  // 音效每轮爆发最多响一次，且只在这一轮纯粹是成功时：只有「任务完成」这一个
  // 音效，失败或被终止时放它都是错的；连续完成时反复重放还会切成一串断音。
  if (!burst.soundPlayed && burstState(burst) === "success") {
    burst.soundPlayed = true;
    playDone();
  }
  // 台词要赶在 render 之前定下来——enterAnnounce 拿它的 face 决定身体。
  const pool = poolFor(burst);
  if (burst.linePool !== pool) {
    burst.linePool = pool;
    burst.line = pickLine(pool);
  }
  // 只有播报**类别**变了才重新进场（例如成功中途转成出错）；合并进来的后续
  // 完成不该把动画从头重播。
  render(before !== null && before !== burstState(burst));
  renderAnnounceBubble(burst, bubbleMs);
}

// ---- 任务进度气泡 ----
// 间歇式而非常驻：显示一会就消失，静默期间来的新进展只记不显，静默结束后显示
// 最新的那条。忙碌任务下是「亮一下、歇一会」的节律，安静时完全不出现。
let progressPending: string | null = null;
let progressBusyUntil = 0;
let progressTimer: number | undefined;
// todo 比 tool/call 更适合展示（模型自己写的短句），所以一条 todo 之后
// 短时间内压住工具级的进度，免得立刻被「正在修改 x.ts」盖掉。
let todoUntil = 0;

function onProgress(text: string, kind?: string, tool?: string) {
  if (!text) return;
  const now = Date.now();
  // 「折腾」的另一半判据：工具调用次数。但光有次数不够——十几个飞快的调用
  // 只说明活儿碎，不说明难，这时候说「有点难」是错的。所以还要求真的干了
  // 一会儿。
  if (kind === "tool" && st.working) {
    toolsThisTask++;
    if (!saidLongLine && !burst
      && toolsThisTask >= LONG_TASK_TOOLS
      && now - workingSince >= LONG_TASK_MIN_MS) {
      saidLongLine = true;
      clearLongTimer();
      speak("long");
      return; // 这一条进度让位给台词
    }
  }
  if (kind === "todo") {
    todoUntil = now + TODO_SHADOW_MS;
  } else if (now < todoUntil) {
    trace("progress", tool || kind || "", text, "被 todo 遮蔽");
    return;
  }
  // 后来者覆盖：排队会让桌宠播报几十秒前的状态，而它的价值恰恰是「一眼看
  // 过去知道现在怎么样」。被覆盖掉的那条要进日志，否则丢了都不知道。
  if (progressPending) trace("progress", tool || kind || "", progressPending, "被新事件覆盖");
  progressPending = text;
  pendingTool = tool || kind || "";
  scheduleProgress();
}

function scheduleProgress() {
  if (progressTimer !== undefined) return;
  progressTimer = window.setTimeout(() => {
    progressTimer = undefined;
    const text = progressPending;
    const tool = pendingTool;
    progressPending = null;
    pendingTool = "";
    if (!text) return;
    // 播报期间不抢气泡（那个信息更重要），任务已结束也不再显示。
    if (burst) { trace("progress", tool, text, "被播报占用"); return; }
    if (!st.working) { trace("progress", tool, text, "任务已结束"); return; }
    showBubble(text, PROGRESS_SHOW_MS);
    trace("progress", tool, text, "已显示");
    progressBusyUntil = Date.now() + PROGRESS_SHOW_MS + PROGRESS_COOLDOWN_MS;
    if (progressPending) scheduleProgress();
  }, Math.max(0, progressBusyUntil - Date.now()));
}
let pendingTool = "";

// ---- 工作中的台词 ----
// 开场白 + 「跑得久」各一条路径，都受频率约束：开场白带冷却，「跑得久」
// 每个任务最多说一次。
let lastStartLine = 0;
let workingSince = 0;
let toolsThisTask = 0;
let saidLongLine = false;
let longTimer: number | undefined;

function clearLongTimer() {
  if (longTimer !== undefined) { window.clearTimeout(longTimer); longTimer = undefined; }
}

/**
 * 说一句台词。它和进度气泡抢同一个气泡，规则是**台词抢拍**——一个任务里最多
 * 说一次，抢一下不乱；而进度本来就是间歇的，少一条无所谓。被抢掉的那条进度
 * 会走既有的「被播报占用」记进测试日志。
 */
function speak(pool: LinePool, sub?: string) {
  const line = pickLine(pool);
  if (!line) return false;
  showBubble(line.t, LINE_SHOW_MS, sub);
  showStill(faceUrl(line.face));
  trace("line", pool, line.t, "已显示");
  // 说完回到该有的样子：工作态就继续打字，空闲态就回静图。
  window.setTimeout(() => { if (currentAction === null) render(true); }, LINE_SHOW_MS);
  return true;
}

/** 任务跑久了就吐槽一句。到点时若任务已经结束，什么都不做。 */
function scheduleLongLine() {
  clearLongTimer();
  longTimer = window.setTimeout(() => {
    longTimer = undefined;
    if (!st.working || saidLongLine || burst) return;
    saidLongLine = true;
    speak("long");
  }, LONG_TASK_MS);
}

// ---- 工作态（带防抖）----
let workingDebounce: number | undefined;

function setWorking(active: boolean) {
  if (workingDebounce !== undefined) { window.clearTimeout(workingDebounce); workingDebounce = undefined; }
  if (active === st.working) return;
  if (active) {
    // 半秒就结束的任务不该闪一下打字入场再跳走。
    workingDebounce = window.setTimeout(() => {
      workingDebounce = undefined;
      st.working = true;
      workingSince = Date.now();
      toolsThisTask = 0;
      saidLongLine = false;
      render();
      // 先进工作态再说话：进场动画归 render，台词只是盖在上面的一层。
      if (Date.now() - lastStartLine >= START_LINE_COOLDOWN_MS) {
        if (speak("start")) lastStartLine = Date.now();
      }
      scheduleLongLine();
    }, WORKING_DEBOUNCE_MS);
  } else {
    st.working = false;
    clearLongTimer();
    bubble.classList.remove("show"); // 任务结束，进度气泡立刻收
    render();
  }
}

// ---- 长时间无操作轮询 ----
async function pollIdle() {
  let next = IDLE_POLL_MS;
  try {
    const ms = await invoke<number>("system_idle_ms");
    // 工作中压过瞌睡：agent 在跑时桌宠该在打字，睡着了你会以为任务停了。
    const want = !st.working && ms >= LONG_IDLE_MS;
    if (want !== st.longIdle) { st.longIdle = want; render(); }
    if (st.longIdle) next = IDLE_POLL_FAST_MS; // 加密轮询，让「一有输入立刻醒」不打折扣
  } catch {}
  window.setTimeout(() => { void pollIdle(); }, next);
}

function onBalance(msg: any) {
  if (msg.type === "balance") {
    const sym = msg.currency === "CNY" ? "¥" : `${msg.currency} `;
    showBubble(`余额 ${sym}${msg.amount}`, 5000);
  } else if (msg.type === "balance-error") {
    showBubble(`余额查询失败：${msg.reason}`, 5000);
  }
}

// ---- 布局 & 连接 ----
// 一只桌宠服务多个 DSH profile：每个插件把自己的端口登记进会合目录，
// 桌宠轮询该目录并「连出去」连上每一个。方向选「桌宠当客户端」而不是
// 「桌宠当服务端」，是因为 webview 里的 WebSocket 只能连不能听——让桌宠
// 当服务端就得在 Rust 里再塞一个 WS 服务器加一层桥接。
interface PluginEntry { pid: number; url: string; label: string }

interface Link {
  ws: WebSocket;
  label: string;
  open: boolean;
  /** 这个插件自己报的工作态。多 profile 下取或——否则 A 的任务开始会被
      B 的任务结束抹掉。 */
  working: boolean;
}

/** 按 url 索引：登记文件和 DSH_PET_WS_URL 可能指向同一个插件，去重靠它。 */
const links = new Map<string, Link>();
/** 连不上的目标按退避推迟重试，避免每轮轮询都去敲一个死端口。 */
const retryAt = new Map<string, number>();
const retryStep = new Map<string, number>();

let closedByUs = false;
// 已确认连不上（区别于「刚启动、还没试过」），决定空闲态显示哪张立绘。
let searching = false;
// 曾经连上过。没连上过之前不适用「目录空了就立刻关窗」那条规则——
// 桌宠可能比拉起它的插件写登记文件更快。
let everConnected = false;
// 从进程启动就开始计时：拉起来后一直连不上，同样算孤儿。
let offlineSince = Date.now();
let pollTimer: number | undefined;
// 由 DSH_PET_DEBUG 开启。仅用于测试从外部驱动内部状态，插件从不设置它。
let debugMode = false;
let selfVersion = "";
let envUrl = "";

function applyLayout(info: InitInfo) {
  for (const el of [img, ...videos]) {
    el.style.width = `${info.sprite_w}px`;
    el.style.height = `${info.sprite_h}px`;
    el.style.marginLeft = `${-info.sprite_w / 2}px`;
  }
  spriteWLogical = info.sprite_w;
  bubbleMaxW = info.bubble_max_w;
  bubble.style.bottom = `${info.sprite_h + 10}px`;
  layoutBubble();
  refreshHit(); // 立绘尺寸定下来了，命中区才有意义
}

/**
 * 把窗口收回屏幕内。
 *
 * 判据用的是**立绘**而不是窗口：窗口两侧各有一段全透明边距，贴边时本来就是
 * 靠它悬出屏幕的，按窗口边收会把贴边状态一起收掉。
 */
async function clampOnScreen() {
  try {
    const mon = await currentMonitor();
    if (!mon) return;
    const pos = await appWindow.outerPosition();
    const size = await appWindow.outerSize();
    const inset = edgeInset(size.width, spriteWLogical * (await appWindow.scaleFactor()));
    const left = mon.position.x;
    const right = mon.position.x + mon.size.width;
    const bottom = mon.position.y + mon.size.height;
    let x = pos.x;
    let y = pos.y;
    if (pos.x + inset < left) x = left - inset;
    if (pos.x + size.width - inset > right) x = right - size.width + inset;
    if (pos.y + size.height > bottom) y = bottom - size.height;
    if (y < mon.position.y) y = mon.position.y;
    if (x !== pos.x || y !== pos.y) {
      await appWindow.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
    }
  } catch {}
}

/** 断连兜底：预算耗尽就关窗，谁也不用来收尸。 */
function giveUp() {
  closedByUs = true;
  if (pollTimer !== undefined) { window.clearTimeout(pollTimer); pollTimer = undefined; }
  for (const link of links.values()) { try { link.ws.close(); } catch {} }
  links.clear();
  appWindow.close();
}

function openCount() {
  let n = 0;
  for (const link of links.values()) if (link.open) n++;
  return n;
}

/** 任意一个插件在工作就算工作中。 */
function anyWorking() {
  for (const l of links.values()) if (l.working) return true;
  return false;
}

function handleMessage(msg: any, link: Link) {
  const label = link.label;
  if (msg.type === "task-complete") {
    onTaskComplete(msg.title ?? "", msg.outcome ?? "success", msg.label ?? label, Number(msg.streak) || 0);
  } else if (msg.type === "working") {
    link.working = !!msg.active;
    setWorking(anyWorking());
  } else if (msg.type === "progress") {
    onProgress(String(msg.text ?? ""), msg.kind, msg.tool);
  } else if (msg.type === "balance" || msg.type === "balance-error") {
    onBalance(msg);
  } else if (debugMode && msg.type === "debug-open-settings") {
    void invoke<string>("open_settings")
      .then((url) => { for (const l of links.values()) if (l.open) l.ws.send(JSON.stringify({ type: "debug-info", url })); })
      .catch((e) => { for (const l of links.values()) if (l.open) l.ws.send(JSON.stringify({ type: "debug-info", error: String(e) })); });
  } else if (debugMode && msg.type === "debug-set-style") {
    // 走完整链路：set_settings 写盘 + Rust emit + 本窗口 listen 回来生效。
    void invoke("set_settings", { settings: { ...settings, bubble_style: msg.style } }).catch(() => {});
  } else if (debugMode && msg.type === "debug-test") {
    // 测试面板的指令通道，从 WS 侧也开一个口：自动化验证不好去点面板上的按钮。
    handleTest(msg.payload);
  } else if (debugMode && msg.type === "debug-trace") {
    for (const l of links.values()) {
      if (l.open) l.ws.send(JSON.stringify({ type: "debug-info", trace: traceRing.slice(), blankFrames }));
    }
    if (msg.clear) { traceRing.length = 0; blankFrames = 0; }
  } else if (debugMode && msg.type === "debug-layout") {
    // 把立绘在 webview 里的真实布局盒报出去，供贴边验证换算成屏幕坐标。
    // 报的是 DOM 量出来的值而不是我们算贴边时用的那个数——否则等于自己
    // 验自己。
    const r = img.getBoundingClientRect();
    const payload = {
      innerW: window.innerWidth,
      spriteLeft: r.left, spriteW: r.width,
      spriteTop: r.top, spriteH: r.height,
      // 呈现状态一并报出：验证「双击不该切成跑步」需要看到 mode/shown；
      // action 为 null 表示当前画的是静图（动作播完并定格了）——贴边验证靠它
      // 等到确定的时刻，而不是猜一个 sleep。
      shown, mode, action: currentAction, edge: st.edge, working: st.working,
      // 气泡的实测尺寸。「断成两行」这件事只能靠量高度看出来——单行是
      // 字号×1.5 加上下内边距，两行就多一整行。
      bubbleW: bubble.offsetWidth, bubbleH: bubble.offsetHeight,
      // 气泡的两行分开报：台词是主角、标题是副行，验证台词得能分辨这两者。
      // 当前静图的文件名（不含目录和扩展名）。验证「表情跟着台词走」需要它。
      still: (img.getAttribute("src") ?? "").split("/").pop()?.replace(/\.webp$/, "") ?? "",
      bubbleText: {
        main: bubble.firstElementChild?.textContent ?? bubble.textContent ?? "",
        sub: bubble.querySelector(".sub")?.textContent ?? "",
      },
      bubbleMaxW, petScale: settings.pet_scale, bubbleScale: settings.bubble_scale,
    };
    for (const l of links.values()) if (l.open) l.ws.send(JSON.stringify({ type: "debug-info", layout: payload }));
  } else if (debugMode && msg.type === "debug-hitstate") {
    // 把 Rust 轮询线程最近一次的判定摊开：光标、窗口原点、命中矩形、结论。
    void invoke<unknown>("get_hit_debug")
      .then((hit) => {
        for (const l of links.values()) {
          if (l.open) l.ws.send(JSON.stringify({ type: "debug-info", hit }));
        }
      })
      .catch(() => {});
  } else if (debugMode && msg.type === "debug-geom") {
    // 窗口在屏幕上的真实位置和尺寸。缩放锚点（脚底 + 水平中心）只能靠它验证，
    // 因为那是窗口层面的事，DOM 里看不见。
    void Promise.all([appWindow.outerPosition(), appWindow.outerSize()])
      .then(([pos, size]) => {
        const payload = {
          x: pos.x, y: pos.y, w: size.width, h: size.height,
          spriteW: spriteWLogical, spriteH: img.offsetHeight,
        };
        for (const l of links.values()) {
          if (l.open) l.ws.send(JSON.stringify({ type: "debug-info", geom: payload }));
        }
      })
      .catch(() => {});
  } else if (debugMode && msg.type === "debug-settings") {
    // 读/写设置。写走的是真实的 set_settings，所以 Rust 那边的重算和广播
    // 都会真的发生——测试测的是整条链路，不是一个旁路。
    const done = () => {
      for (const l of links.values()) {
        if (l.open) l.ws.send(JSON.stringify({ type: "debug-info", settings }));
      }
    };
    if (msg.set) {
      void invoke("set_settings", { settings: msg.set })
        .then(() => { settings = msg.set; applySettings(); })
        .catch(() => {})
        .finally(() => window.setTimeout(done, 250));
    } else {
      done();
    }
  } else if (debugMode && msg.type === "debug-hit") {
    // 测试专用：直接驱动穿透状态，好在不注入鼠标点击的前提下验证 force 路径。
    void invoke("set_hit", { force: !!msg.force, rects: [] }).catch(() => {});
  }
  // 注意 `bye` 不再意味着关闭桌宠——它只表示「这个插件要走了」。
  // 该不该关窗由下面的 poll 统一判定：登记目录空了才算干净退出。
}

function connect(url: string, label: string) {
  let ws: WebSocket;
  try { ws = new WebSocket(url); } catch { return; }
  const link: Link = { ws, label, open: false, working: false };
  links.set(url, link);
  ws.onopen = () => {
    link.open = true;
    everConnected = true;
    searching = false;
    retryAt.delete(url);
    retryStep.delete(url);
    ws.send(JSON.stringify({ type: "hello", version: selfVersion }));
    refreshIdleStill(); // 从「寻找」切回「平常」
  };
  ws.onmessage = (e) => {
    let msg: any;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "bye") { try { ws.close(); } catch {} return; }
    handleMessage(msg, link);
  };
  ws.onclose = () => {
    links.delete(url);
    // 插件断开时撤销它的工作态，否则桌宠会永远卡在打字。
    setWorking(anyWorking());
    // 连不上就退避：1.5s 起，每次翻倍，封顶 12s。
    const step = Math.min((retryStep.get(url) ?? 0) + 1, 4);
    retryStep.set(url, step);
    retryAt.set(url, Date.now() + RECONNECT_INTERVAL_MS * 2 ** (step - 1));
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

/** 把登记目录和环境变量合成一张 url → label 表，url 相同视为同一个插件。 */
async function collectTargets(): Promise<Map<string, string>> {
  const targets = new Map<string, string>();
  try {
    for (const p of await invoke<PluginEntry[]>("list_plugins")) targets.set(p.url, p.label ?? "");
  } catch {}
  // 环境变量是开发/测试用的旁路；真实链路里它和登记文件指向同一个端口。
  if (envUrl && !targets.has(envUrl)) targets.set(envUrl, "");
  return targets;
}

async function poll() {
  if (closedByUs) return;
  const targets = await collectTargets();

  // 已经不在名单上的插件：断开。
  for (const [url, link] of links) {
    if (!targets.has(url)) { try { link.ws.close(); } catch {} links.delete(url); }
  }
  // 名单上还没连的：连（受退避约束）。
  const now = Date.now();
  for (const [url, label] of targets) {
    const link = links.get(url);
    if (link) { link.label = label || link.label; continue; }
    if ((retryAt.get(url) ?? 0) > now) continue;
    connect(url, label);
  }

  const open = openCount();
  if (open > 0) {
    offlineSince = now;
  } else {
    // 名单空 = 所有插件都干净地注销了 = DSH 正常退出，立刻关窗，
    // 不必让用户干等 30 秒。名单非空却连不上 = 崩溃，走预算兜底。
    if (targets.size === 0 && everConnected) return giveUp();
    if (!searching) { searching = true; refreshIdleStill(); }
    if (now - offlineSince >= RECONNECT_BUDGET_MS) return giveUp();
  }
  pollTimer = window.setTimeout(() => { void poll(); }, RECONNECT_INTERVAL_MS);
}

async function init() {
  try {
    try {
      settings = await invoke<Settings>("get_settings");
    } catch {
      // 读不到就用默认值，不该因此起不来
    }
    applySettings();
    const info = await invoke<InitInfo>("get_init");
    debugMode = info.debug;
    if (debugMode) startBlankWatch(); // 必须等这里——IIFE 开头时它还是 false
    selfVersion = info.version;
    envUrl = info.ws_url;
    applyLayout(info);
  } catch {
    // 拿不到初始化信息也照样进轮询：预算会在超时后收尾。
  }
  void poll();
}

/** 余额只问第一条打开的连接——多个 profile 可能配着不同的 key，问全部会弹出多个气泡。 */
function requestBalance() {
  for (const link of links.values()) {
    if (link.open) { link.ws.send(JSON.stringify({ type: "balance" })); return; }
  }
  showBubble("桌宠未连接 DSH", 3000);
}

// ---- 位置持久化 ----
async function restorePosition() {
  try {
    const saved = localStorage.getItem(POS_KEY);
    if (saved) {
      const [x, y] = saved.split(",").map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        await appWindow.setPosition(new PhysicalPosition(x, y));
        return;
      }
    }
    // currentMonitor 是模块级函数，不是 Window 的方法——写成 appWindow.currentMonitor()
    // 会抛 TypeError 被下面的 catch 吞掉，右下角初始定位就永远不生效。
    const monitor = await currentMonitor();
    if (monitor) {
      const size = await appWindow.outerSize();
      // 这里不能用全局 scale：它由一个未 await 的 then 填充，restorePosition
      // 在启动瞬间跑，多半还停在 1。
      const m = Math.round(24 * (await appWindow.scaleFactor()));
      await appWindow.setPosition(
        new PhysicalPosition(monitor.size.width - size.width - m, monitor.size.height - size.height - m),
      );
    }
  } catch {}
}

async function persistPosition() {
  try {
    const pos = await appWindow.outerPosition();
    localStorage.setItem(POS_KEY, `${pos.x},${pos.y}`);
  } catch {}
}

// ---- 贴边吸附 ----
// 松手时判定，拖动过程中不判——否则你只是路过左边就被吸住。
// 右边缘暂时镜像复用左边的动作（发饰和围裙会翻面），等专用动作做出来后
// 在动作清单里加一行即可换掉。
/** 立绘两侧那段全透明边距有多宽（物理像素）。缘由见 bubble-layout.js。 */
function winEdgeInset(winWPhys: number, sf: number) {
  return edgeInset(winWPhys, spriteWLogical * sf);
}

/** 把窗口摆到某一侧，使立绘的边贴住屏幕边。测试面板的「强制贴边」也走它。 */
async function alignToEdge(edge: "left" | "right") {
  const mon = await currentMonitor();
  if (!mon) return;
  const pos = await appWindow.outerPosition();
  const size = await appWindow.outerSize();
  const inset = winEdgeInset(size.width, await appWindow.scaleFactor());
  const x = edge === "left"
    ? mon.position.x - inset
    : mon.position.x + mon.size.width - size.width + inset;
  await appWindow.setPosition(new PhysicalPosition(Math.round(x), pos.y));
}

async function settleEdge() {
  try {
    const mon = await currentMonitor();
    if (!mon) { st.edge = null; return; }
    const pos = await appWindow.outerPosition();
    const size = await appWindow.outerSize();
    const sf = await appWindow.scaleFactor();
    const snap = EDGE_SNAP_PX * sf; // 阈值按逻辑像素定义，这里换算成物理像素
    const inset = winEdgeInset(size.width, sf);
    const left = mon.position.x;
    const right = mon.position.x + mon.size.width;
    const spriteLeft = pos.x + inset;
    const spriteRight = pos.x + size.width - inset;
    let edge: Edge = null;
    let x = pos.x;
    if (spriteLeft - left <= snap) { edge = "left"; x = left - inset; }
    else if (right - spriteRight <= snap) { edge = "right"; x = right - size.width + inset; }
    if (edge) await appWindow.setPosition(new PhysicalPosition(Math.round(x), pos.y));
    st.edge = edge;
    // 和位置一起持久化：否则重启后它在同一个位置却开始播正常待机动作，
    // 一个「站在屏幕外面」的姿势，看起来就是坏了。
    try { localStorage.setItem(EDGE_KEY, edge ?? ""); } catch {}
    layoutBubble(); // 可见带宽变了，气泡的位移和尖角要重算
  } catch {
    st.edge = null;
  }
}

// ---- 拖动（pointer 事件 + 捕获）----
let dragging = false;
let grabDx = 0;
let grabDy = 0;
let lastX = 0;
let lastY = 0;
let moved = 0;
let dirAccum = 0;
// 抓取偏移要等一次 IPC 往返才算得出来；算出来之前不许移动窗口，
// 否则第一帧会拿上一次拖动残留的偏移把窗口甩出去。
let grabReady = false;

// 每帧只发一次 setPosition。pointermove 在高回报率鼠标上可以到几百 Hz，
// 而每次 setPosition 都是一次 IPC 往返——不合帧就会堆出一串过期指令，
// 窗口越追越落后于光标，正是光标跑出窗口的根源。
let pendingPos: { x: number; y: number } | null = null;
let posScheduled = false;

function movePet(x: number, y: number) {
  pendingPos = { x, y };
  if (posScheduled) return;
  posScheduled = true;
  requestAnimationFrame(() => {
    posScheduled = false;
    const p = pendingPos;
    pendingPos = null;
    if (!p) return;
    void appWindow.setPosition(new LogicalPosition(p.x, p.y)).catch(() => {});
  });
}

function endDrag() {
  if (!dragging) return;
  dragging = false;
  st.dragging = false;
  grabReady = false;
  refreshHit(); // 收回 force，回到按立绘命中
  if (moved >= DRAG_THRESHOLD_PX) {
    void settleEdge().then(() => { render(); persistPosition(); });
  } else {
    render();
  }
}

img.addEventListener("pointerdown", async (e) => {
  if (e.button !== 0) return; // 仅左键拖动，右键交给菜单
  // `dragging` 只管命中区 force，必须**立即**置位；`st.dragging`（也就是跑步
  // 动画）等真的移动超过阈值再说。两者从前是一起置位的，于是任何一次点击、
  // 包括双击的那两下，都会闪一下跑步动画。
  dragging = true;
  // 先抢指针捕获再做异步 IPC。原来它排在 await 之后，而 outerPosition()
  // 是一次到 Rust 的往返——快速拖动时光标在这几毫秒里就能跑出立绘范围，
  // 等 await 回来再抢已经晚了，之后的 pointerup 就落到别的窗口去了。
  try { img.setPointerCapture(e.pointerId); } catch {}
  refreshHit(); // force 可交互，且不再按位置判定
  moved = 0;
  dirAccum = 0;
  grabReady = false;
  lastX = e.screenX;
  lastY = e.screenY;
  ensureAudio();
  try {
    const pos = await appWindow.outerPosition();
    grabDx = e.screenX - pos.x / scale;
    grabDy = e.screenY - pos.y / scale;
    grabReady = true;
  } catch {}
});

img.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  // buttons === 0 说明按键其实已经松开、而我们漏掉了那次 pointerup
  // （快速拖动时光标跑到窗口外，pointerup 落到了别的窗口）。这是最后一道
  // 兜底：光标一回到立绘上就能把卡住的跑动状态收回来。
  if (e.buttons === 0) { endDrag(); return; }
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  lastX = e.screenX;
  lastY = e.screenY;
  moved += Math.abs(dx) + Math.abs(dy);
  if (moved < DRAG_THRESHOLD_PX) return;
  if (!st.dragging) {
    // 越过阈值的这一刻才算真的开始拖：此时才进跑步态、才离开贴边态。
    st.dragging = true;
    st.edge = null;
    render();
  }
  if (grabReady) movePet(e.screenX - grabDx, e.screenY - grabDy);
  // 水平方向决定朝向；纯垂直拖动按左处理。
  const dir: "left" | "right" = dx < 0 ? "left" : dx > 0 ? "right" : "left";
  if (mode !== "running") {
    startRun(dir);
  } else if (dir !== facing) {
    // 方向迟滞：反向累计移动达到阈值才翻转，滤掉小幅抖动。
    dirAccum += Math.abs(dx);
    if (dirAccum >= HYSTERESIS_PX) {
      startRun(dir);
      dirAccum = 0;
    }
  } else {
    dirAccum = 0;
  }
});

img.addEventListener("pointerup", endDrag);
img.addEventListener("pointercancel", endDrag);
img.addEventListener("lostpointercapture", endDrag);
// 同时挂到 window 上：指针捕获万一没抢到，落在窗口内任意位置的 pointerup
// 仍能收尾。endDrag 是幂等的，重复触发无害。
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", endDrag);
window.addEventListener("blur", endDrag);

img.addEventListener("dblclick", () => requestBalance());

// ---- 右键菜单 ----
const MENU_W = 118;
const MENU_H = 76;

function openMenu(x: number, y: number) {
  const left = Math.max(4, Math.min(x, window.innerWidth - MENU_W - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - MENU_H - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.classList.add("open");
  refreshHit();
}

function closeMenu() {
  if (!menu.classList.contains("open")) return;
  menu.classList.remove("open");
  refreshHit();
}

img.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  openMenu(e.clientX, e.clientY);
});

menuSettings.addEventListener("click", () => {
  closeMenu();
  void invoke("open_settings").catch(() => showBubble("打不开设置窗口", 3000));
});

menuTest.addEventListener("click", () => {
  closeMenu();
  void invoke("open_test").catch(() => showBubble("打不开测试面板", 3000));
});

// 设置窗口和桌宠窗口是两个 webview，靠 Rust 转发的事件同步。
void listen<Settings>("settings-changed", (e) => {
  settings = e.payload;
  applySettings();
});

// 尺寸倍率变了：Rust 已经改好窗口大小、并按「固定脚底 + 水平中心」摆好位置，
// 这里补上它不知道的那部分——贴边要重新对齐（Rust 不知道贴的是哪边），
// 不贴边则要保证没被推出屏幕。
void listen<InitInfo>("layout-changed", (e) => {
  applyLayout(e.payload);
  void (async () => {
    if (st.edge) await alignToEdge(st.edge);
    else await clampOnScreen();
    layoutBubble();
    refreshHit();
    void persistPosition();
  })();
});

// 桌宠被拖到已拔掉的显示器上就再也找不回来了——设置面板里的「重置位置」
// 走这条路把它叫回主屏右下角。
void listen("reset-position", () => {
  try { localStorage.removeItem(POS_KEY); } catch {}
  void restorePosition();
});

window.addEventListener("click", closeMenu);
window.addEventListener("blur", closeMenu);

// ---- 鼠标穿透 ----
// 窗口里绝大部分是全透明的气泡留白区，整窗吃点击的话桌宠飘到哪就挡住哪。
// 这里把可交互区域实时报给 Rust，由 Rust 轮询光标位置决定整窗是否穿透。
interface Rect { x: number; y: number; w: number; h: number }

// 用 offset* 而不是 getBoundingClientRect：前者是未经 transform 的布局盒，
// 不受立绘镜像和菜单展开动画影响（菜单刚打开时还停在 scale(0.92)）。
function rectOf(el: HTMLElement): Rect {
  return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
}

let lastHit = "";

function refreshHit() {
  // 拖动中和菜单打开时 force——无条件可交互，且**不做位置判断**：
  // - 拖动：光标会跑出窗口（窗口追不上），按位置判定会半途打开穿透，
  //   webview 当场失去鼠标，拖动中断且再也收不到 pointerup；
  // - 菜单：让窗口内任意一点都能点掉菜单，且不依赖菜单动画期间的尺寸。
  const force = dragging || menu.classList.contains("open");
  const rects: Rect[] = force ? [] : [rectOf(img)];
  const key = `${force}|${JSON.stringify(rects)}`;
  if (key === lastHit) return;
  lastHit = key;
  void invoke("set_hit", { force, rects }).catch(() => {});
}

// ---- 测试面板通道 ----
// 面板是个独立窗口，通过 Rust 转发驱动这只真桌宠（而不是在面板里内嵌预览）——
// 只有这样才能看到真实的透明合成、尺寸、镜像和命中区。
let traceOn = false;

/**
 * 把一条事件脉络投给测试面板。
 *
 * 只记**脱敏后**的气泡文本和工具名，不记参数原文：面板是普通窗口，会出现在
 * 录屏和屏幕共享里，完整路径和命令行不该落进来。工具名本身不含用户数据。
 * 面板关着时连 IPC 都不发。
 */
const traceRing: any[] = [];

function trace(type: string, tool: string, text: string, result: string) {
  if (!traceOn && !debugMode) return;
  const entry = { t: Date.now(), type, tool, text, result };
  if (debugMode) {
    // 调试模式下留一份在内存里，好让自动化测试能断言限流的每一次判定——
    // 否则只有人眼看着面板才知道对不对。
    traceRing.push(entry);
    if (traceRing.length > 50) traceRing.shift();
  }
  if (traceOn) void invoke("pet_trace", { entry }).catch(() => {});
}

function handleTest(m: any) {
  switch (m?.cmd) {
    case "play": {
      const id = String(m.id ?? "");
      if (!byId.has(id)) return;
      // 播完回到当前该有的样子；force 是因为 `shown` 没变过。
      playAction(id, { mirror: !!m.mirror, loop: !!m.loop, onEnd: () => render(true) });
      return;
    }
    case "still":
      showStill(String(m.url ?? IDLE), !!m.mirror);
      return;
    case "working":
      setWorking(!!m.active);
      return;
    case "progress":
      onProgress(String(m.text ?? ""), m.kind, m.tool);
      return;
    case "complete":
      onTaskComplete(String(m.title ?? "测试任务"), String(m.outcome ?? "success"), "测试",
        Number(m.streak) || 0);
      return;
    case "speak":
      speak(String(m.pool ?? "done") as LinePool);
      return;
    case "long-idle":
      st.longIdle = !!m.on;
      render();
      return;
    case "edge": {
      const side = m.side === "left" || m.side === "right" ? m.side : null;
      st.edge = side;
      if (side) void alignToEdge(side).then(layoutBubble);
      else layoutBubble();
      render();
      return;
    }
    case "open-test":
      // 自动化验证用：设置窗口曾经渲染成纯白，测试面板同样需要被真的打开看过。
      void invoke("open_test").catch(() => {});
      return;
    case "reset-position":
      // 回到主屏右下角。尺寸测试要从一个**确定**的位置起步：桌宠若停在屏幕
      // 顶部附近，放大会顶出上边缘而被 clampOnScreen 拉回来——那时「脚底不动」
      // 本来就不该成立，让位置决定测试成败只会得到时灵时不灵的结果。
      try { localStorage.removeItem(POS_KEY); } catch {}
      void restorePosition().then(layoutBubble);
      return;
    case "reset":
      burst = null;
      st.longIdle = false;
      st.edge = null;
      setWorking(false);
      layoutBubble();
      render(true);
      return;
  }
}

void listen<boolean>("trace-enabled", (e) => { traceOn = !!e.payload; });
void listen<any>("pet-test", (e) => { handleTest(e.payload); });

/**
 * 预热静图。跑步是 12fps 逐帧换 src 的，第一圈里任何一帧没解码好就是一次
 * 空白闪烁；表情几张也一并热上，切过去时才真的零延迟。
 */
function warmStills() {
  for (const url of [...RUN_FRAMES, IDLE, SEARCHING, TASK_FAILED, TASK_CANCELED]) {
    const im = new Image();
    im.src = url;
    void im.decode?.().catch(() => {});
  }
}

void (async () => {
  warmStills();
  await Promise.all([loadActions(), loadLines()]);
  try { st.edge = (localStorage.getItem(EDGE_KEY) || null) as Edge; } catch {}
  render(true);
  // 窗口配置成初始隐藏：先把位置摆好再现身，避免在默认位置闪一下再跳走。
  void restorePosition().finally(() => { void invoke("show_pet").catch(() => {}); });
  void init();
  void pollIdle();
})();
