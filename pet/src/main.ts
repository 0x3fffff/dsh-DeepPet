import { currentMonitor, getCurrentWindow, LogicalPosition, PhysicalPosition } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const RUN_FRAMES = Array.from(
  { length: 8 },
  (_, i) => `/立绘/跑步/跑步_${String(i + 1).padStart(2, "0")}.webp`,
);
// 完成动画：78 帧，由 scripts/build-animation.mjs 从 qtrle 母版生成。
// 已压成 3:4，所以能直接喂给同一个 <img>，不需要额外的尺寸计算。
const DONE_FRAMES = Array.from(
  { length: 78 },
  (_, i) => `/立绘/完成任务/f_${String(i + 1).padStart(3, "0")}.webp`,
);
const DONE_FPS = 15;
const IDLE = "/立绘/表情/平常.webp";
const SEARCHING = "/立绘/表情/寻找.webp";
const TASK_FAILED = "/立绘/表情/晕.webp";
const AUDIO = "/音效/任务完成.mp3";
const FPS = 12;
const POS_KEY = "deep-pet-position-v2";
// 方向迟滞：反向累计移动达到该阈值（逻辑像素）才翻转朝向。
const HYSTERESIS_PX = 16;
// 重连节奏与预算。DSH 崩溃/被强杀时插件的 cleanup 不会执行，没人来杀桌宠，
// 所以由桌宠自己兜底：断连超过预算就自我了断，避免留下一个永远置顶、
// 又不在任务栏里的孤儿窗口。预算要够长，好让 DSH 正常重启时桌宠活下来。
const RECONNECT_INTERVAL_MS = 1500;
const RECONNECT_BUDGET_MS = 30_000;

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

/**
 * 桌宠设置。存在会合目录的 settings.json 里，归属「桌宠」这个机器级单例
 * 而不是任何一个 DSH profile——一只桌宠服务 N 个插件，存进某个插件的配置
 * 就说不清谁说了算。`bubbleMs` 因此也从插件配置搬到了这里。
 */
interface Settings {
  bubble_style: string;
  bubble_ms: number;
  sound: boolean;
}
let settings: Settings = { bubble_style: "classic", bubble_ms: 5000, sound: true };

function applySettings() {
  bubble.dataset.style = settings.bubble_style;
}

let mode: "idle" | "running" | "task" = "idle";
let facing: "left" | "right" = "left";
let runTimer: number | undefined;
let runIndex = 0;
let scale = 1;
let bubbleTimer: number | undefined;
let audio: HTMLAudioElement | undefined;

appWindow.scaleFactor().then((s) => { scale = s; }).catch(() => {});

function setSprite(url: string, mirror: boolean) {
  img.src = url;
  img.style.transform = mirror ? "scaleX(-1)" : "scaleX(1)";
}

function setIdle() {
  mode = "idle";
  stopRun();
  stopDone();
  // 确认连不上时空闲态换成「寻找」，让「它在找 DSH」和「它卡死了」对用户
  // 可区分。刚启动还没试过连接时不算——否则每次启动都会闪一下「寻找」。
  setSprite(searching ? SEARCHING : IDLE, false); // 两张都永远朝左、不镜像
}

function startRun(dir: "left" | "right") {
  mode = "running";
  facing = dir;
  stopRun();
  stopDone(); // 拖动打断完成动画
  runIndex = 0;
  setSprite(RUN_FRAMES[0], facing === "right");
  runTimer = window.setInterval(() => {
    runIndex = (runIndex + 1) % RUN_FRAMES.length;
    setSprite(RUN_FRAMES[runIndex], facing === "right");
  }, Math.round(1000 / FPS));
}

function stopRun() {
  if (runTimer !== undefined) { window.clearInterval(runTimer); runTimer = undefined; }
}

let doneTimer: number | undefined;

function stopDone() {
  if (doneTimer !== undefined) { window.clearInterval(doneTimer); doneTimer = undefined; }
}

/**
 * 播一遍完成动画。`bubbleMs` 说了算：预算短于动画原生时长（78 帧 @15fps
 * ≈ 5.2 秒）时按比例加速，让动画**完整播完**而不是被砍在半路——一次性动画
 * 从中间姿势硬切回平常看起来就是坏了。预算长于原生时长时按原速播完，
 * 定格在最后一帧（双手合十，本来就是个完整姿势）。
 */
function startDone(bubbleMs: number) {
  stopDone();
  let i = 0;
  setSprite(DONE_FRAMES[0], false);
  const interval = Math.max(1, Math.min(bubbleMs / DONE_FRAMES.length, 1000 / DONE_FPS));
  doneTimer = window.setInterval(() => {
    i++;
    if (i >= DONE_FRAMES.length) { stopDone(); return; } // 停在最后一帧
    setSprite(DONE_FRAMES[i], false);
  }, interval);
}

function showBubble(text: string, ms: number) {
  bubble.textContent = text;
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
  soundPlayed: boolean;
}

let burst: Burst | null = null;
// 播报代次。两次完成相隔 1 秒时，旧的那次排的「回空闲」会在新气泡还挂着的
// 时候触发，导致立绘先变回平常、文字还在——用代次号让只有最新一次生效。
let announceGen = 0;

function decorate(label: string, title: string) {
  const t = title ? `「${title}」` : "任务";
  return label ? `[${label}] ${t}` : t;
}

function renderBurst(b: Burst, bubbleMs: number, fresh: boolean) {
  const isError = b.errorTitle !== null;
  mode = "task";
  stopRun();
  if (isError) {
    stopDone(); // 出错抢占：中断完成动画，切静态图
    setSprite(TASK_FAILED, false); // 永远朝左、不镜像
  } else if (fresh) {
    // 只有新一轮爆发才起播。合并进来的后续完成不重播——播到一半重头来
    // 会明显卡顿一下；气泡文字更新即可。
    startDone(bubbleMs);
  }
  let text: string;
  if (isError) {
    // 出错优先占据气泡：那才是你需要立刻看到的。
    text = `${decorate(b.errorLabel, b.errorTitle as string)}出错了`;
    if (b.successes > 0) text += `（另有 ${b.successes} 个完成）`;
  } else {
    text = b.successes > 1
      ? `${decorate(b.successLabel, b.successTitle)}等 ${b.successes} 个任务完成`
      : `${decorate(b.successLabel, b.successTitle)}完成`;
  }
  showBubble(text, bubbleMs);
  const gen = ++announceGen;
  window.setTimeout(() => {
    if (gen !== announceGen) return; // 已被更新的播报接管
    burst = null;
    if (mode === "task") setIdle();
  }, bubbleMs);
}

function onTaskComplete(title: string, outcome: string, label: string) {
  const bubbleMs = settings.bubble_ms;
  const ok = outcome !== "error";
  const fresh = burst === null;
  if (!burst) {
    burst = { successes: 0, successTitle: "", successLabel: "", errorTitle: null, errorLabel: "", soundPlayed: false };
  }
  if (ok) {
    burst.successes++;
    burst.successTitle = title;
    burst.successLabel = label;
  } else {
    burst.errorTitle = title;
    burst.errorLabel = label;
  }
  // 音效每轮爆发最多响一次：只有「任务完成」这一个音效，失败时放它是错的，
  // 连续完成时反复 currentTime=0 重放会把它切成一串断音。
  if (ok && !burst.soundPlayed && burst.errorTitle === null) {
    burst.soundPlayed = true;
    playDone();
  }
  renderBurst(burst, bubbleMs, fresh);
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
  img.style.width = `${info.sprite_w}px`;
  img.style.height = `${info.sprite_h}px`;
  img.style.marginLeft = `${-info.sprite_w / 2}px`;
  bubble.style.maxWidth = `${info.bubble_max_w}px`;
  bubble.style.bottom = `${info.sprite_h + 10}px`;
  refreshHit(); // 立绘尺寸定下来了，命中区才有意义
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

function handleMessage(msg: any, label: string) {
  if (msg.type === "task-complete") {
    onTaskComplete(msg.title ?? "", msg.outcome ?? "success", msg.label ?? label);
  } else if (msg.type === "balance" || msg.type === "balance-error") {
    onBalance(msg);
  } else if (debugMode && msg.type === "debug-open-settings") {
    void invoke<string>("open_settings")
      .then((url) => { for (const l of links.values()) if (l.open) l.ws.send(JSON.stringify({ type: "debug-info", url })); })
      .catch((e) => { for (const l of links.values()) if (l.open) l.ws.send(JSON.stringify({ type: "debug-info", error: String(e) })); });
  } else if (debugMode && msg.type === "debug-set-style") {
    // 走完整链路：set_settings 写盘 + Rust emit + 本窗口 listen 回来生效。
    void invoke("set_settings", { settings: { ...settings, bubble_style: msg.style } }).catch(() => {});
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
  const link: Link = { ws, label, open: false };
  links.set(url, link);
  ws.onopen = () => {
    link.open = true;
    everConnected = true;
    searching = false;
    retryAt.delete(url);
    retryStep.delete(url);
    ws.send(JSON.stringify({ type: "hello", version: selfVersion }));
    if (mode === "idle") setIdle(); // 从「寻找」切回「平常」
  };
  ws.onmessage = (e) => {
    let msg: any;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "bye") { try { ws.close(); } catch {} return; }
    handleMessage(msg, link.label);
  };
  ws.onclose = () => {
    links.delete(url);
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
    if (!searching) { searching = true; if (mode === "idle") setIdle(); }
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
  grabReady = false;
  refreshHit(); // 收回 force，回到按立绘命中
  if (moved >= 4) {
    if (mode === "running") setIdle();
    persistPosition();
  }
}

img.addEventListener("pointerdown", async (e) => {
  if (e.button !== 0) return; // 仅左键拖动，右键交给菜单
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
  if (moved < 4) return;
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
const MENU_W = 110;
const MENU_H = 40;

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

// 设置窗口和桌宠窗口是两个 webview，靠 Rust 转发的事件同步。
void listen<Settings>("settings-changed", (e) => {
  settings = e.payload;
  applySettings();
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

setIdle();
// 窗口配置成初始隐藏：先把位置摆好再现身，避免在默认位置闪一下再跳走。
void restorePosition().finally(() => { void invoke("show_pet").catch(() => {}); });
void init();
