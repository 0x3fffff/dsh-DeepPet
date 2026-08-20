import { getCurrentWindow, LogicalPosition, PhysicalPosition } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

const RUN_FRAMES = Array.from(
  { length: 8 },
  (_, i) => `/立绘/跑步/跑步_${String(i + 1).padStart(2, "0")}.png`,
);
const IDLE = "/立绘/表情/平常.png";
const TASK_DONE = "/立绘/表情/比耶.png";
const AUDIO = "/音效/任务完成.wav";
const FPS = 12;
const POS_KEY = "deep-pet-position-v2";
// 方向迟滞：反向累计移动达到该阈值（逻辑像素）才翻转朝向。
const HYSTERESIS_PX = 16;

interface InitInfo {
  ws_url: string;
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
  setSprite(IDLE, false); // 空闲平常.png 永远朝左、不镜像
}

function startRun(dir: "left" | "right") {
  mode = "running";
  facing = dir;
  stopRun();
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
  ensureAudio();
  if (audio) { audio.currentTime = 0; audio.play().catch(() => {}); }
}

function onTaskComplete(title: string, bubbleMs: number) {
  mode = "task";
  stopRun();
  setSprite(TASK_DONE, false); // 比耶永远朝左、不镜像
  showBubble(`「${title}」完成`, bubbleMs);
  playDone();
  window.setTimeout(() => { if (mode === "task") setIdle(); }, bubbleMs);
}

function onBalance(msg: any) {
  if (msg.type === "balance") {
    const sym = msg.currency === "CNY" ? "¥" : `${msg.currency} `;
    showBubble(`余额 ${sym}${msg.amount}`, 5000);
  } else if (msg.type === "balance-error") {
    showBubble(`余额查询失败：${msg.reason}`, 5000);
  }
}

// ---- 布局 & WebSocket ----
let ws: WebSocket | null = null;
let closedByUs = false;

function applyLayout(info: InitInfo) {
  img.style.width = `${info.sprite_w}px`;
  img.style.height = `${info.sprite_h}px`;
  img.style.marginLeft = `${-info.sprite_w / 2}px`;
  bubble.style.maxWidth = `${info.bubble_max_w}px`;
  bubble.style.bottom = `${info.sprite_h + 10}px`;
}

function connect(wsUrl: string) {
  ws = new WebSocket(wsUrl);
  ws.onmessage = (e) => {
    let msg: any;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "task-complete") onTaskComplete(msg.title ?? "", msg.bubbleMs ?? 5000);
    else if (msg.type === "balance" || msg.type === "balance-error") onBalance(msg);
    else if (msg.type === "bye") { closedByUs = true; try { ws?.close(); } catch {}; appWindow.close(); }
  };
  ws.onclose = () => { ws = null; if (!closedByUs) setTimeout(init, 1500); };
  ws.onerror = () => { try { ws?.close(); } catch {} };
}

async function init() {
  try {
    const info = await invoke<InitInfo>("get_init");
    applyLayout(info);
    if (info.ws_url) connect(info.ws_url);
    else setTimeout(init, 1500);
  } catch {
    setTimeout(init, 1500);
  }
}

function requestBalance() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "balance" }));
  else showBubble("桌宠未连接 DSH", 3000);
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
    const monitor = await appWindow.currentMonitor();
    if (monitor) {
      const size = await appWindow.outerSize();
      const m = Math.round(24 * scale);
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

function endDrag() {
  if (!dragging) return;
  dragging = false;
  if (moved >= 4) {
    if (mode === "running") setIdle();
    persistPosition();
  }
}

img.addEventListener("pointerdown", async (e) => {
  if (e.button !== 0) return; // 仅左键拖动，右键交给菜单
  dragging = true;
  moved = 0;
  dirAccum = 0;
  lastX = e.screenX;
  lastY = e.screenY;
  ensureAudio();
  try {
    const pos = await appWindow.outerPosition();
    grabDx = e.screenX - pos.x / scale;
    grabDy = e.screenY - pos.y / scale;
  } catch {}
  try { img.setPointerCapture(e.pointerId); } catch {}
});

img.addEventListener("pointermove", async (e) => {
  if (!dragging) return;
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  lastX = e.screenX;
  lastY = e.screenY;
  moved += Math.abs(dx) + Math.abs(dy);
  if (moved < 4) return;
  try {
    await appWindow.setPosition(new LogicalPosition(e.screenX - grabDx, e.screenY - grabDy));
  } catch {}
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
}

function closeMenu() {
  menu.classList.remove("open");
}

img.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  openMenu(e.clientX, e.clientY);
});

menuSettings.addEventListener("click", () => {
  closeMenu();
  showBubble("设置面板开发中", 3000);
});

window.addEventListener("click", closeMenu);
window.addEventListener("blur", closeMenu);

setIdle();
void restorePosition();
void init();
