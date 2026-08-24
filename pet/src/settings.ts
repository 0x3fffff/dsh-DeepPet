import { invoke } from "@tauri-apps/api/core";

interface Settings {
  bubble_style: string;
  bubble_ms: number;
  sound: boolean;
  pet_scale: number;
  bubble_scale: number;
  lines: boolean;
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
const linesEl = document.getElementById("lines") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLElement;
const petScaleEl = document.getElementById("petScale") as HTMLInputElement;
const petScaleLabel = document.getElementById("petScaleLabel") as HTMLOutputElement;
const bubbleScaleEl = document.getElementById("bubbleScale") as HTMLInputElement;
const bubbleScaleLabel = document.getElementById("bubbleScaleLabel") as HTMLOutputElement;
const scaleHintEl = document.getElementById("scaleHint") as HTMLElement;

let settings: Settings = {
  bubble_style: "classic", bubble_ms: 5000, sound: true,
  pet_scale: 1, bubble_scale: 1, lines: true,
};
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

function renderScales() {
  petScaleEl.value = String(Math.round(settings.pet_scale * 100));
  bubbleScaleEl.value = String(Math.round(settings.bubble_scale * 100));
  petScaleLabel.textContent = `${petScaleEl.value}%`;
  bubbleScaleLabel.textContent = `${bubbleScaleEl.value}%`;
  // 气泡预览也跟着倍率走——预览和真实气泡用的是同一份 CSS，这里不同步的话
  // 「所见」和「所得」当场就分家了。
  stylesEl.style.setProperty("--bubble-scale", String(settings.bubble_scale));
}

/** 拖动中只预览、不写盘：一次拖动几十次 input，每次都写文件又蠢又慢。 */
function previewSize() {
  void invoke("preview_size", { settings }).catch(() => {});
}

for (const [el, key] of [[petScaleEl, "pet_scale"], [bubbleScaleEl, "bubble_scale"]] as const) {
  el.addEventListener("input", () => {
    settings[key] = Number(el.value) / 100;
    renderScales();
    previewSize();
  });
  el.addEventListener("change", () => { void save(); });
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

linesEl.addEventListener("change", () => {
  settings.lines = linesEl.checked;
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
  // 上限跟屏幕走：桌宠放到比动作视频原生高度还大就会发虚，所以按素材封顶。
  // 只有 4K 以上会真的被压到 200% 以下——不说明的话那个滑块看起来就是坏的。
  try {
    const [min, maxPet, maxBubble] = await invoke<[number, number, number]>("size_limits");
    petScaleEl.min = String(Math.round(min * 100));
    bubbleScaleEl.min = String(Math.round(min * 100));
    petScaleEl.max = String(Math.floor(maxPet * 100));
    bubbleScaleEl.max = String(Math.round(maxBubble * 100));
    if (maxPet < 1.99) {
      scaleHintEl.textContent =
        `拖动时桌宠实时跟着变，松手才保存。这块屏幕上桌宠最大 ${Math.floor(maxPet * 100)}%`
        + "——再大就超出动作素材的原生分辨率，画面会发虚。";
    }
  } catch {
    // 拿不到上限就用 HTML 里写的默认量程，不至于没法调。
  }
  renderStyles();
  renderBubbleMs();
  renderScales();
  soundEl.checked = settings.sound;
  linesEl.checked = settings.lines;
}

void init();
