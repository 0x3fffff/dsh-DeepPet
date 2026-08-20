import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { WebSocketServer } from "ws";

/** Cordis 插件名，供 loader 诊断。 */
const name = "deep-pet";

/** 本插件依赖的 DSH 服务。 */
const inject = ["sessionTitle", "credentials"];

/** Schemastery 配置 schema。 */
const Config = z.object({
  enabled: z.boolean().default(true),
  apiKeyEnv: z.string().default("DEEPSEEK_API_KEY"),
  balanceBaseUrl: z.string().default("https://api.deepseek.com"),
  petBinary: z.string().default(""),
  petDownloadUrl: z.string().default(""),
  bubbleMs: z.number().default(5000),
});

function apply(ctx, config) {
  if (config.enabled === false) return;

  const clients = new Set();
  const prevStatus = new Map();
  let child = null;

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
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg && msg.type === "balance") void sendBalance(ws);
    });
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  // 一次完整 agent 运行结束（running -> idle）触发一次气泡。
  ctx.on("agent/status", ({ agent, status }) => {
    const id = agent.id;
    const prev = prevStatus.get(id);
    prevStatus.set(id, status);
    if (prev !== "running" || status !== "idle") return;
    let title;
    try { title = ctx.sessionTitle.get(agent.session)?.title; } catch { title = undefined; }
    if (!title) return;
    broadcast({ type: "task-complete", title, bubbleMs: config.bubbleMs });
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

  async function resolveBinary() {
    if (config.petBinary) return config.petBinary;
    if (!config.petDownloadUrl) throw new Error("未配置 petBinary 或 petDownloadUrl");
    const dir = join(process.env.DSH_HOME || homedir(), "cache", "deep-pet");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `deep-pet-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);
    if (!existsSync(file)) {
      const res = await fetch(config.petDownloadUrl);
      if (!res.ok) throw new Error(`下载桌宠二进制失败 HTTP ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      if (process.platform !== "win32") chmodSync(file, 0o755);
    }
    return file;
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
      const bin = await resolveBinary();
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
    try { broadcast({ type: "bye" }); } catch {}
    for (const ws of clients) { try { ws.close(); } catch {} }
    try { wss.close(); } catch {}
    if (child) { try { child.kill(); } catch {} }
  };
}

export { Config, apply, inject, name };
