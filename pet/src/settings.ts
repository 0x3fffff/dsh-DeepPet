import { invoke } from "@tauri-apps/api/core";

interface Settings {
  bubble_style: string;
  bubble_ms: number;
  sound: boolean;
}

/**
 * 样式注册表。加一种气泡 = 这里加一行 + bubble.css 里加一段。
 * 之所以用「手工精调的固定样式类」而不是参数化主题：玻璃要高光和渐变、
 * 像素要硬边和阶梯尖角、便签要纸感和微倾——这些差异在同一组参数里
 * 表达不出来，硬套只会得到一堆「圆角矩形换颜色」。
 */
const STYLES: Array<{ id: string; name: string }> = [
  { id: "classic", name: "经典" },
  { id: "dark", name: "暗色" },
  { id: "glass", name: "玻璃" },
  { id: "note", name: "便签" },
  { id: "pixel", name: "像素" },
];

const stylesEl = document.getElementById("styles") as HTMLElement;
const bubbleMsEl = document.getElementById("bubbleMs") as HTMLInputElement;
const bubbleMsLabel = document.getElementById("bubbleMsLabel") as HTMLOutputElement;
const soundEl = document.getElementById("sound") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLElement;

let settings: Settings = { bubble_style: "classic", bubble_ms: 5000, sound: true };
let statusTimer: number | undefined;

function note(text: string) {
  statusEl.textContent = text;
  if (statusTimer !== undefined) window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => { statusEl.textContent = ""; }, 2500);
}

async function save() {
  try {
    await invoke("set_settings", { settings });
    note("已保存");
  } catch (err) {
    note(`保存失败：${String(err)}`);
  }
}

function renderStyles() {
  stylesEl.textContent = "";
  for (const s of STYLES) {
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", String(s.id === settings.bubble_style));

    const preview = document.createElement("div");
    preview.className = "bubble";
    preview.dataset.style = s.id;
    preview.textContent = "任务完成";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = s.name;

    card.append(preview, name);
    card.addEventListener("click", () => {
      settings.bubble_style = s.id;
      for (const el of stylesEl.children) {
        el.setAttribute("aria-selected", String(el === card));
      }
      void save();
    });
    stylesEl.append(card);
  }
}

function renderBubbleMs() {
  bubbleMsEl.value = String(settings.bubble_ms);
  bubbleMsLabel.textContent = `${(settings.bubble_ms / 1000).toFixed(1)} 秒`;
}

bubbleMsEl.addEventListener("input", () => {
  settings.bubble_ms = Number(bubbleMsEl.value);
  renderBubbleMs();
});
// 拖动滑块时只更新显示，松手才写盘——否则一次拖动会写几十次文件。
bubbleMsEl.addEventListener("change", () => { void save(); });

soundEl.addEventListener("change", () => {
  settings.sound = soundEl.checked;
  void save();
});

document.getElementById("resetPos")!.addEventListener("click", async () => {
  await invoke("reset_position").catch(() => {});
  note("桌宠已回到主屏右下角");
});

document.getElementById("quit")!.addEventListener("click", async () => {
  await invoke("quit_pet").catch(() => {});
});

async function init() {
  try {
    settings = await invoke<Settings>("get_settings");
  } catch {
    note("读取设置失败，显示的是默认值");
  }
  renderStyles();
  renderBubbleMs();
  soundEl.checked = settings.sound;
}

void init();
