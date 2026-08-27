import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);

/** Cordis 插件名，供 loader 诊断。 */
const name = "deep-pet";

/** 本插件依赖的 DSH 服务。 */
const inject = ["sessionTitle", "credentials", "agents"];

/**
 * 会合目录。一只桌宠服务多个 DSH profile：每个插件把自己的端口登记到
 * `plugins/<pid>.json`，桌宠轮询该目录并主动连出去。
 * 这个路径必须和 Tauri 的 `app_local_data_dir()` 算出来的一致
 * （`%LOCALAPPDATA%\<identifier>`）；scripts/check-versions.mjs 会核对。
 */
const PET_IDENTIFIER = "com.dsh.deeppet";
const PET_HOME = join(process.env.LOCALAPPDATA || homedir(), PET_IDENTIFIER);
const PLUGIN_DIR = join(PET_HOME, "plugins");

/** pid 是否还活着。`EPERM` 说明进程在但没权限，同样算活着。 */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; }
}

/**
 * 清掉 pid 已死的登记文件。DSH 崩溃时 cleanup 不会执行，登记会留下，
 * 桌宠就会一直去敲一个永远没人应的端口。
 */
function sweepStalePlugins() {
  let files;
  try { files = readdirSync(PLUGIN_DIR); } catch { return; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const path = join(PLUGIN_DIR, f);
    let pid;
    try { pid = JSON.parse(readFileSync(path, "utf8"))?.pid; } catch { pid = undefined; }
    if (typeof pid !== "number" || !isAlive(pid)) {
      try { rmSync(path, { force: true }); } catch {}
    }
  }
}

/**
 * 任务进度文案。**全部来自真实数据**——`tool/call` 带工具名和模型产出的原始
 * 参数，`todo/write` 带模型自己写的短句（契约：a short imperative line shown
 * in the UI）。不编轮播文案：这句话为真的时候它才真的有用。
 *
 * 脱敏不是可选项：这个气泡是置顶的，会出现在截屏、录屏和屏幕共享里。
 */
const FILE_TOOLS = {
  edit: "🧑‍💻 正在修改",
  write: "🧑‍💻 正在写入",
  read: "📖 正在阅读",
  read_image: "🖼️ 正在查看",
};

/**
 * 只取文件名：完整路径既塞不进 180px 的气泡，也不该出现在你的截屏里。
 *
 * 分隔符用 `fromCharCode(92)` 而不是字面量反斜杠：这段代码经过多层转义
 * 传递时，`[\/]` 很容易被折叠成 `[/]`，那样 Windows 路径就一刀都切不动，
 * 完整路径会原样显示——脱敏形同虚设。这是本文件里唯一一处出错会泄露信息
 * 的地方，所以宁可写得笨一点。
 */
const BACKSLASH = String.fromCharCode(92);

function baseName(p) {
  if (typeof p !== "string" || !p) return "";
  const parts = p.split("/").flatMap((seg) => seg.split(BACKSLASH)).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function programName(cmd) {
  if (typeof cmd !== "string") return "";
  const trimmed = cmd.trim();
  // 带引号的程序路径（Windows 上 `"C:\Program Files\..."` 很常见）先按引号取，
  // 否则会在路径中间的空格处断开。不带引号又含空格的路径本身就是歧义的，
  // 退化成取第一个空白分隔的词——**精度是尽力而为，安全是保证**：
  // 无论走哪条分支，命令行的其余部分都不会出现在气泡里。
  let first;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    first = end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  } else {
    first = trimmed.split(/\s+/)[0] ?? "";
  }
  return baseName(first).replace(/\.(exe|cmd|bat|ps1)$/i, "");
}

function truncate(text, n) {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

/**
 * 不断行空格（U+00A0）。
 *
 * 气泡只有 180px 宽，长一点的串会折成两行。折在哪里很重要：断在
 * 「🔧 正在执行 npm」/「命令」上，第二行只剩两个字，难看得很。用它把程序名
 * 和后面的「命令」绑死，断点就只能落在前面那个普通空格上，两行都是完整词组。
 */
const NBSP = String.fromCharCode(160);

function progressFromToolCall(name, argsJson) {
  let args = {};
  try { args = JSON.parse(argsJson) || {}; } catch {}
  const verb = FILE_TOOLS[name];
  if (verb) {
    const file = baseName(args.file_path ?? args.path);
    return file ? `${verb} ${truncate(file, 20)}` : `${verb}文件`;
  }
  if (name === "think") return "🧠 思考中...";
  if (name === "bash" || name === "pwsh") {
    const prog = programName(args.command);
    return prog ? `🔧 正在执行 ${truncate(prog, 14)}${NBSP}命令` : "🔧 正在执行命令";
  }
  return `⚙️ 正在使用 ${truncate(String(name ?? ""), 16)}`;
}

/** 插件版本，用于与桌宠二进制做协议对齐检查。 */
const { version: VERSION } = require("../package.json");

/**
 * 各平台桌宠二进制所在的 optionalDependencies 包。npm/pnpm 按包内的
 * `os`/`cpu` 字段只安装匹配当前平台的那一个，版本与本插件精确 pin，
 * 因此二进制与插件永远同版本——不存在缓存陈旧或校验缺失的问题。
 */
const PLATFORM_PACKAGES = {
  "win32-x64": "@0x3fffff/dsh-deep-pet-win32-x64",
};

/** Schemastery 配置 schema。 */
const Config = z.object({
  enabled: z.boolean().default(true),
  apiKeyEnv: z.string().default("DEEPSEEK_API_KEY"),
  balanceBaseUrl: z.string().default("https://api.deepseek.com"),
  petBinary: z.string().default(""),
  label: z.string().default(""),
  logEvents: z.boolean().default(false),
});

function apply(ctx, config) {
  if (config.enabled === false) return;

  const clients = new Set();
  const prevStatus = new Map();
  // 本轮运行期间出过 agent/error 的 agent id。agent/status 只有
  // 'idle' | 'running' 两个值，分不出成败——这个集合就是那个判别器。
  const failed = new Set();
  // 本轮被「终止」的 agent id。取消**不发 agent/error**——DSH 把它记在
  // session 日志的 turn/end 上（reason.kind === 'aborted'）。少了这一路，
  // 用户在网页端点「终止对话」会被当成任务完成来庆祝（已实测）。
  const canceled = new Set();
  // 被非用户原因中止的 agent id（`parent`：子 agent 被上级撤销；`disposed`：
  // agent 正在销毁，通常 DSH 本来就在退出）。这些**完全不播报**——落到
  // 「完成」分支会变成关 DSH 时闪一下庆祝，比播报还糟。
  const suppressed = new Set();
  const helloTimers = new Set();
  // 连续失败次数：桌宠据此换一池更沮丧的台词。计数在内存里，任一成功即清零，
  // DSH 重启也清零——「昨天失败过三次」对今天的心情没有意义。
  // 只数顶层 agent，和播报口径一致。
  let failStreak = 0;
  let lastWorking = false;
  let child = null;
  let regFile = null;
  let regPort = 0;

  const log = (msg) => {
    try { ctx.logger?.info?.(msg); } catch { console.log(msg); }
  };
  const warn = (msg) => {
    try { ctx.logger?.warn?.(msg); } catch { console.warn(msg); }
  };

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });

  const send = (ws, obj) => {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  const broadcast = (obj) => {
    for (const ws of clients) send(ws, obj);
  };

  wss.on("connection", (ws) => {
    log("deep-pet: pet connected");
    clients.add(ws);
    // 补发当前工作态：桌宠可能在 DSH 已经跑着任务时才启动/重连。
    send(ws, { type: "working", active: currentlyWorking() });
    // 正常桌宠一连上就报版本；超时没报说明是不带握手的旧二进制。
    const helloTimer = setTimeout(() => {
      helloTimers.delete(helloTimer);
      warn(`桌宠未上报版本，可能是早于 ${VERSION} 的旧二进制`);
    }, 3000);
    helloTimers.add(helloTimer);
    const settleHello = () => {
      if (helloTimers.delete(helloTimer)) clearTimeout(helloTimer);
    };
    const drop = () => { clients.delete(ws); settleHello(); };
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg) return;
      // 桌宠连上后先报自己的版本；不一致说明用了手工指定的 petBinary。
      if (msg.type === "hello") {
        settleHello();
        // 补发已知的网页地址：桌宠可能是刚起来的，错过了上一次广播。
        if (webUrl) send(ws, { type: "web-url", url: webUrl });
        if (msg.version !== VERSION) {
          warn(`桌宠版本 ${msg.version ?? "未知"} 与插件版本 ${VERSION} 不一致，行为可能异常`);
        }
        return;
      }
      if (msg.type === "balance") void sendBalance(ws, msg.auto === true);
    });
    ws.on("close", drop);
    ws.on("error", drop);
  });

  /**
   * 从 session 日志里读 turn 的收尾原因。
   *
   * `agent/error` 仍然要留着，不是被这个替代：它的契约写明会报告失败
   * 「即使该错误在 turn 内没有位置、没有持久记录」——也就是有些失败压根
   * 不产生 turn/end。两者互补。
   */
  ctx.on("session/event", (session, event) => {
    // 任务进度：**无条件**广播每一条，限流全部交给桌宠侧。
    // 从前 todo 的遮蔽判定在这里，被压掉的事件就此消失——桌宠侧的测试日志
    // 因此永远看不到「有过这个事件、但被丢了」，排查时无从下手。限流集中到
    // 一处之后，这里只负责脱敏和分类。
    if (event?.type === "todo/write") {
      const cur = event.data?.todos?.find?.((t) => t?.status === "in_progress");
      if (cur?.content) {
        broadcast({ type: "progress", kind: "todo", text: `🧠 ${truncate(String(cur.content), 24)}` });
      }
      return;
    }
    if (event?.type === "tool/call") {
      const name = String(event.data?.name ?? "");
      broadcast({
        type: "progress",
        kind: "tool",
        // 工具名本身不含用户数据（参数才含），单独带上供测试面板显示。
        tool: name,
        text: progressFromToolCall(name, event.data?.arguments),
      });
      return;
    }
    if (event?.type !== "turn/end") return;
    const id = session?.id;
    const reason = event.data?.reason;
    const kind = reason?.kind;
    const cause = reason?.reason?.kind; // 仅 aborted 有
    if (config.logEvents) {
      log(`deep-pet: turn/end id=${id} reason=${kind}${cause ? `/${cause}` : ""}`);
    }
    if (id === undefined) return;
    if (kind === "error") { failed.add(id); return; }
    if (kind !== "aborted") return;
    // 只有用户和插件发起的终止值得播报。`parent` 是子 agent 被上级撤销，
    // `disposed` 是 agent 正在销毁（通常 DSH 本来就在退出）——都不是用户的
    // 动作，播报纯属噪音。
    if (cause === "user" || cause === "hook") canceled.add(id);
    else suppressed.add(id);
  });

  /** 当前有没有顶层 agent 在跑。直接查 status 比自己维护计数可靠。 */
  function currentlyWorking() {
    try { return ctx.agents.roots().some((a) => a.status === "running"); } catch { return false; }
  }

  function pushWorking(force = false) {
    const active = currentlyWorking();
    if (!force && active === lastWorking) return;
    lastWorking = active;
    broadcast({ type: "working", active });
  }

  ctx.on("agent/error", ({ agent }) => {
    if (config.logEvents) log(`deep-pet: agent/error id=${agent?.id}`);
    if (agent?.id !== undefined) failed.add(agent.id);
  });

  // agent 被销毁时清掉它的痕迹，否则这两个容器会随会话数无界增长。
  ctx.on("agent/disposed", ({ agent }) => {
    if (config.logEvents) log(`deep-pet: agent/disposed id=${agent?.id}`);
    prevStatus.delete(agent?.id);
    failed.delete(agent?.id);
    canceled.delete(agent?.id);
    suppressed.delete(agent?.id);
  });

  // 一次完整 agent 运行结束（running -> idle）触发一次气泡。
  ctx.on("agent/status", ({ agent, status }) => {
    const id = agent.id;
    if (config.logEvents) log(`deep-pet: agent/status id=${id} status=${status}`);
    const prev = prevStatus.get(id);
    prevStatus.set(id, status);
    if (status === "running") {
      // 新一轮开始，清掉上一轮的判定痕迹
      failed.delete(id);
      canceled.delete(id);
      suppressed.delete(id);
      pushWorking();
      return;
    }
    pushWorking();
    if (prev !== "running") return;
    // 优先级：出错 > 已终止 > 完成。错误是必须看到的；用户自己触发的终止
    // 压过庆祝，但不该压过失败。两个 delete 无论是否顶层都要执行，否则
    // 标记会残留到下一轮。
    const hadError = failed.delete(id);
    const wasCanceled = canceled.delete(id);
    const wasSuppressed = suppressed.delete(id);
    // 只庆祝顶层 agent。子 agent 同样会发 agent/status——一个任务内部派三个
    // 子 agent 就会庆祝四次。取不到 agents 服务时宁可多报也不漏报。
    let isRoot = true;
    try { isRoot = ctx.agents.roots().some((a) => a.id === id); } catch {}
    if (!isRoot) return;
    // 出错优先于抑制：DSH 退出途中真出了错，仍然要让用户看到。
    if (!hadError && !wasCanceled && wasSuppressed) return;
    const outcome = hadError ? "error" : wasCanceled ? "canceled" : "success";
    let title;
    try { title = ctx.sessionTitle.get(agent.session)?.title; } catch { title = undefined; }
    // 标题在「产生足够输入」之前是 undefined（见 sessionTitle.get 的契约），
    // 全新会话很常见。此时照样报喜，只是气泡退化成不带标题的说法——
    // 静默跳过会让「插件没反应」和「插件坏了」在用户眼里完全一样。
    // 不再下发 bubbleMs：气泡时长是桌宠的显示行为，归桌宠设置管
    // （一只桌宠服务多个 profile，各配一个时长说不清谁说了算）。
    if (outcome === "error") failStreak++;
    else if (outcome === "success") failStreak = 0;
    // 「已终止」既不算成功也不算失败：那是用户按的，不该清零也不该累加。
    broadcast({
      type: "task-complete",
      title: title ?? "",
      outcome,
      label: config.label,
      streak: failStreak,
    });
  });

  /**
   * DSH 网页的地址。由网页端经 RPC 报上来——插件自己不知道：它只知道自己
   * 那个 WS 服务的端口，网页服务是另一个进程口。协议在这里就卡死，别把
   * 一个没校验过的串一路传到桌宠那边去调 ShellExecute。
   */
  let webUrl = "";

  function setWebUrl(url) {
    if (typeof url !== "string" || !/^https?:\/\//.test(url) || url.length > 2048) return;
    if (url === webUrl) return;
    webUrl = url;
    broadcast({ type: "web-url", url: webUrl });
  }

  /**
   * 查一次余额并回给桌宠。
   *
   * `auto` 原样回传，桌宠据此决定失败时要不要弹气泡：定时轮询的失败必须
   * 静默，否则没配 API Key 的人会每 10 分钟被弹一次「未找到 API Key」，
   * 一整天。双击手动查的失败照旧要看得见——那正是他排查问题的入口。
   */
  async function sendBalance(ws, auto = false) {
    const reply = (obj) => send(ws, { ...obj, auto });
    try {
      const hit = await ctx.credentials.resolve(credentialRef(config.apiKeyEnv));
      if (!hit || !hit.value) return reply({ type: "balance-error", reason: "未找到 API Key" });
      const base = config.balanceBaseUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/user/balance`, {
        headers: { Authorization: `Bearer ${hit.value}`, Accept: "application/json" },
      });
      if (!res.ok) return reply({ type: "balance-error", reason: `HTTP ${res.status}` });
      const body = await res.json();
      const info = body?.balance_infos?.find((b) => b.currency === "CNY") ?? body?.balance_infos?.[0];
      if (!info) return reply({ type: "balance-error", reason: "响应缺少余额字段" });
      reply({ type: "balance", currency: info.currency, amount: info.total_balance });
    } catch (err) {
      reply({ type: "balance-error", reason: String(err?.message ?? err) });
    }
  }

  /**
   * 定位桌宠二进制：优先用 `petBinary`（本地开发/自行编译用），
   * 否则从当前平台对应的 optionalDependencies 包里解析。
   */
  function resolveBinary() {
    if (config.petBinary) return config.petBinary;
    const key = `${process.platform}-${process.arch}`;
    const pkg = PLATFORM_PACKAGES[key];
    if (!pkg) {
      throw new Error(`桌宠暂不支持当前平台 ${key}；可自行编译后用 petBinary 指向二进制`);
    }
    const bin = process.platform === "win32" ? "dsh-deep-pet.exe" : "dsh-deep-pet";
    try {
      return require.resolve(`${pkg}/bin/${bin}`);
    } catch {
      throw new Error(`未找到桌宠二进制包 ${pkg}@${VERSION}；请重装插件，且安装时不要跳过 optional 依赖`);
    }
  }

  let launching = false;

  /** 拉起桌宠。桌宠用文件锁做单例，重复调用不会开出第二个窗口。 */
  async function launchPet() {
    if (launching) return;
    launching = true;
    try {
      const port = await new Promise((resolve, reject) => {
        const ready = () => {
          const a = wss.address();
          if (a && typeof a === "object") resolve(a.port);
        };
        if (wss.address()) ready();
        else {
          wss.once("listening", ready);
          wss.once("error", reject);
        }
      });
      log(`deep-pet: websocket ready on ws://127.0.0.1:${port}`);
      // 先登记再拉起，这样桌宠一启动就能在目录里看到我们。
      try {
        mkdirSync(PLUGIN_DIR, { recursive: true });
        sweepStalePlugins();
        regPort = port;
        regFile = join(PLUGIN_DIR, `${process.pid}.json`);
        writeFileSync(regFile, JSON.stringify({ pid: process.pid, port, label: config.label }));
      } catch (err) {
        warn(`登记会合目录失败 ${err?.message ?? err}`);
      }
      const bin = resolveBinary();
      child = spawn(bin, [], {
        env: { ...process.env, DSH_PET_WS_URL: `ws://127.0.0.1:${port}` },
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", (err) => warn(`启动桌宠失败 ${err.message}`));
      child.on("exit", () => { child = null; });
    } catch (err) {
      warn(String(err?.message ?? err));
    } finally {
      launching = false;
    }
  }

  /** 桌宠是否在跑（已连上，或本插件刚拉起、还没回报 hello）。 */
  function isPetRunning() {
    return clients.size > 0 || child !== null;
  }

  /**
   * 网页按钮的入口：已经连上就重置位置（不重复启动），没连上就拉起。
   * 返回给调用方的 JSON 只带一个动作名，好让按钮把结果展示出来。
   */
  function ensurePet() {
    if (isPetRunning()) {
      broadcast({ type: "reset-position" });
      return { action: "reset" };
    }
    void launchPet();
    return { action: "launch" };
  }

  // 网页按钮：注册 client→host 的私有 RPC 通道 /pet。
  //
  // 用 ctx.inject 而不是把 "connection" 写进插件的 inject 数组——这个 Cordis
  // 版本的 Inject 没有「可选依赖」，写进去会让**纯 CLI 用户的插件直接加载不
  // 了**，桌宠也就起不来。而 ctx.inject 的语义正好：服务在才跑回调，不在就
  // 什么都不做。
  //
  // 也不能像先前那样在 apply 里一次性 ctx.get：那只看得到「此刻」有没有这个
  // 服务，网页端晚一步连上来就再也注册不上了。
  ctx.inject(["connection"], (scoped) => {
    const rpc = scoped.get("connection")?.rpc;
    if (!rpc?.handle) return;
    // handle 返回的是异步 disposer，必须留着——插件卸载时不注销通道，
    // 重载后再注册同一个 channel 就会撞车。
    const dispose = rpc.handle("/pet", async (endpoint, payload) => {
      if (endpoint === "launch") return { ok: true, value: ensurePet() };
      // 网页把自己的 location.origin 报上来，转给桌宠给右键菜单用。
      if (endpoint === "web-url") {
        setWebUrl(payload?.url);
        return { ok: true, value: { url: webUrl } };
      }
      return { ok: false, error: { code: "not-found", message: `unknown endpoint ${endpoint}`, details: {} } };
    }, { authority: "loopback" });
    return () => { void dispose?.(); };
  });

  // 插件加载即拉起一次。
  void launchPet();

  // 插件销毁时清理。
  return () => {
    for (const t of helloTimers) clearTimeout(t);
    helloTimers.clear();
    // 注销登记。只在文件确实还是我们这一份时才删：插件热重载时新的 apply
    // 会用同一个 pid 覆盖写，无条件删会把新登记一并抹掉。
    if (regFile) {
      try {
        const cur = JSON.parse(readFileSync(regFile, "utf8"));
        if (cur?.port === regPort) rmSync(regFile, { force: true });
      } catch {}
    }
    try { broadcast({ type: "bye" }); } catch {}
    for (const ws of clients) { try { ws.close(); } catch {} }
    try { wss.close(); } catch {}
    // 不杀桌宠：它可能正在为别的 profile 服务。登记目录空了它自己会关窗。
    void child;
  };
}

export { Config, apply, inject, name };
// 仅供测试：脱敏是安全相关的，必须能被直接断言。
export { baseName, programName, progressFromToolCall };
