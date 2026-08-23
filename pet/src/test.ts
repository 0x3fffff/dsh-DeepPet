// 测试面板。它不渲染任何桌宠画面——每个按钮都只是把一条指令经 Rust 转发给
// 桌宠窗口，由那只真桌宠执行。面板内嵌预览至多能证明视频文件可解码，证明不了
// 透明合成、尺寸、镜像和命中区，而那几样恰恰是最容易出错的。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const actionsBox = document.getElementById("actions") as HTMLElement;
const mirrorBox = document.getElementById("mirror") as HTMLInputElement;
const logBox = document.getElementById("log") as HTMLElement;
const progressText = document.getElementById("progressText") as HTMLInputElement;

interface ActionDef {
  id: string;
  pool: string;
  role?: "intro" | "loop";
  next?: string;
  hold?: boolean;
}

interface TraceEntry {
  t: number;
  type: string;
  tool: string;
  text: string;
  result: string;
}

const POOL_LABEL: Record<string, string> = {
  working: "工作中",
  idle: "随机待机",
  "long-idle": "长时间无操作",
  edge: "屏幕边缘",
  announce: "播报",
};

function send(payload: unknown) {
  void invoke("pet_test", { payload }).catch(() => {});
}

// ---- 动作预览 ----
// 动作列表从 index.json 读，不硬编码：加动作只改 assets/动作清单.json，
// 这里和桌宠一样自动跟上。
async function loadActions() {
  let list: ActionDef[] = [];
  try {
    list = await (await fetch("/动作/index.json")).json();
  } catch {
    actionsBox.textContent = "读不到动作库（/动作/index.json）";
    return;
  }
  const byPool = new Map<string, ActionDef[]>();
  for (const a of list) {
    const arr = byPool.get(a.pool);
    if (arr) arr.push(a); else byPool.set(a.pool, [a]);
  }
  for (const [pool, arr] of byPool) {
    const head = document.createElement("div");
    head.className = "pool";
    head.textContent = POOL_LABEL[pool] ?? pool;
    actionsBox.append(head);
    for (const a of arr) {
      const btn = document.createElement("button");
      // role/hold 直接标在按钮上：intro 播完会自动接 next，hold 会定格在末帧，
      // 看不到这两个标记就会以为是动画卡住了。
      // intro 不一定接 next——edge-lean 就是靠定格末帧收尾的，写成「→ ?」
      // 会看起来像清单缺了一项。
      const tags = [
        a.next ? `→ ${a.next}` : "",
        a.role === "loop" ? "循环" : "",
        a.hold ? "定格末帧" : "",
      ].filter(Boolean).join(" · ");
      btn.innerHTML = `${a.id}${tags ? `<small>${tags}</small>` : ""}`;
      btn.onclick = () => send({
        cmd: "play",
        id: a.id,
        mirror: mirrorBox.checked,
        loop: a.role === "loop",
      });
      actionsBox.append(btn);
    }
  }
}

// ---- 事件触发 ----
for (const btn of document.querySelectorAll<HTMLElement>("button[data-cmd]")) {
  btn.onclick = () => send(JSON.parse(btn.dataset.cmd!));
}

(document.getElementById("sendProgress") as HTMLElement).onclick = () => {
  const text = progressText.value.trim() || progressText.placeholder;
  send({ cmd: "progress", kind: "tool", tool: "（手动）", text });
};

// ---- 实时日志 ----
const RESULT_CLASS: Record<string, string> = {
  "已显示": "ok",
  "被 todo 遮蔽": "drop",
  "被新事件覆盖": "drop",
  "被播报占用": "drop",
  "任务已结束": "drop",
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function appendLog(e: TraceEntry) {
  const d = new Date(e.t);
  const row = document.createElement("div");
  row.className = `line ${RESULT_CLASS[e.result] ?? ""}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  // textContent 逐段写，不拼 innerHTML：这些字段里有工具名和气泡文本，
  // 拼 HTML 等于把它们当标记解释。
  for (const [cls, val] of [["t", time], ["tool", e.tool || "—"], ["text", e.text], ["r", e.result]]) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = val;
    row.append(span);
  }
  const atBottom = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 8;
  logBox.append(row);
  // 只跟到底部时才自动滚，否则你往回翻日志时会被一直拽回来。
  if (atBottom) logBox.scrollTop = logBox.scrollHeight;
  while (logBox.childElementCount > 500) logBox.firstElementChild!.remove();
}

void listen<TraceEntry>("pet-trace", (e) => appendLog(e.payload));

(document.getElementById("clearLog") as HTMLElement).onclick = () => {
  logBox.textContent = "";
};

// 告诉桌宠可以开始投脉络了。关闭由 Rust 在窗口销毁时通知，面板不必管。
void invoke("set_trace", { on: true }).catch(() => {});
void loadActions();
