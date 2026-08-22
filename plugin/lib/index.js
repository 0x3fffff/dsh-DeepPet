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

/** 插件版本，用于与桌宠二进制做协议对齐检查。 */
const { version: VERSION } = require("../package.json");

/**
 * 各平台桌宠二进制所在的 optionalDependencies 包。npm/pnpm 按包内的
 * `os`/`cpu` 字段只安装匹配当前平台的那一个，版本与本插件精确 pin，
 * 因此二进制与插件永远同版本——不存在缓存陈旧或校验缺失的问题。
 */
const PLATFORM_PACKAGES = {
  "win32-x64": "dsh-deep-pet-win32-x64",
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
  const helloTimers = new Set();
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
        if (msg.version !== VERSION) {
          warn(`桌宠版本 ${msg.version ?? "未知"} 与插件版本 ${VERSION} 不一致，行为可能异常`);
        }
        return;
      }
      if (msg.type === "balance") void sendBalance(ws);
    });
    ws.on("close", drop);
    ws.on("error", drop);
  });

  ctx.on("agent/error", ({ agent }) => {
    if (config.logEvents) log(`deep-pet: agent/error id=${agent?.id}`);
    if (agent?.id !== undefined) failed.add(agent.id);
  });

  // agent 被销毁时清掉它的痕迹，否则这两个容器会随会话数无界增长。
  ctx.on("agent/disposed", ({ agent }) => {
    if (config.logEvents) log(`deep-pet: agent/disposed id=${agent?.id}`);
    prevStatus.delete(agent?.id);
    failed.delete(agent?.id);
  });

  // 一次完整 agent 运行结束（running -> idle）触发一次气泡。
  ctx.on("agent/status", ({ agent, status }) => {
    const id = agent.id;
    if (config.logEvents) log(`deep-pet: agent/status id=${id} status=${status}`);
    const prev = prevStatus.get(id);
    prevStatus.set(id, status);
    if (status === "running") {
      failed.delete(id); // 新一轮开始，清掉上一轮的失败标记
      return;
    }
    if (prev !== "running") return;
    // 未验证的假设：用户主动取消（Ctrl+C）是否也走 agent/error 尚未在真实
    // DSH 上确认过。Agent.cancel() 的文档没有提对应事件——若它其实什么都不
    // 发，取消仍会被当成成功。用 logEvents: true 跑一次 DSH 按 Ctrl+C 即可确认。
    const hadError = failed.delete(id); // 无论是否顶层都要清，否则标记会残留
    // 只庆祝顶层 agent。子 agent 同样会发 agent/status——一个任务内部派三个
    // 子 agent 就会庆祝四次。取不到 agents 服务时宁可多报也不漏报。
    let isRoot = true;
    try { isRoot = ctx.agents.roots().some((a) => a.id === id); } catch {}
    if (!isRoot) return;
    const outcome = hadError ? "error" : "success";
    let title;
    try { title = ctx.sessionTitle.get(agent.session)?.title; } catch { title = undefined; }
    // 标题在「产生足够输入」之前是 undefined（见 sessionTitle.get 的契约），
    // 全新会话很常见。此时照样报喜，只是气泡退化成不带标题的说法——
    // 静默跳过会让「插件没反应」和「插件坏了」在用户眼里完全一样。
    // 不再下发 bubbleMs：气泡时长是桌宠的显示行为，归桌宠设置管
    // （一只桌宠服务多个 profile，各配一个时长说不清谁说了算）。
    broadcast({ type: "task-complete", title: title ?? "", outcome, label: config.label });
  });

  async function sendBalance(ws) {
    const reply = (obj) => send(ws, obj);
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

  // WS 绑定后拉起桌宠窗口。
  void (async () => {
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
      // 总是尝试拉起。桌宠自己用文件锁做单例，多余的进程会在显示窗口之前
      // 安静退出——所以这里不必再实现一套跨进程抢锁。
      child = spawn(bin, [], {
        env: { ...process.env, DSH_PET_WS_URL: `ws://127.0.0.1:${port}` },
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", (err) => warn(`启动桌宠失败 ${err.message}`));
      child.on("exit", () => { child = null; });
    } catch (err) {
      warn(String(err?.message ?? err));
    }
  })();

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
