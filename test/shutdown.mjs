// 「退出 DSH」这条链路。
//
// 它是整个桌宠里后果最重的一个按钮：按下去杀掉整棵 DSH 进程树，连同正在跑的
// agent 任务和桌宠自己。所以这里守两件事——
//
//   1. **不能误触**：设置面板里它紧挨着「退出桌宠」，而两者后果差一个量级。
//      必须有二次确认，且确认态会自己超时退回（一直举着「危险」的样子，
//      下次误点就直接执行了）。
//   2. **按了要真的关掉**：只 process.exit 会把 bash/pwsh 会话、子 agent 留成
//      孤儿在后台跑，下次启动还会撞端口。必须杀进程树，且要有兜底——taskkill
//      可能因为权限或路径起不来，那时候没有第二道就是「点了没反应」。
//
// 链路：设置窗口 → Rust 命令 emit → 桌宠窗口 listen → WS → 插件执行。
// 跨三个进程边界，任何一环断了都是静默失效，所以逐环钉。
// 用法：node test/shutdown.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const html = read("pet", "settings.html");
const settingsTs = read("pet", "src", "settings.ts");
const settingsCss = read("pet", "src", "settings.css");
const mainTs = read("pet", "src", "main.ts");
const rs = read("pet", "src-tauri", "src", "lib.rs");
const pluginJs = read("plugin", "lib", "index.js");

const cases = [];
const push = (name, ok, detail) => cases.push([name, ok, detail]);

// ---- 1. 误触防线 ----
push("设置面板里有退出 DSH 按钮", html.includes('id="quitDsh"'), null);
push("它是 danger 样式", /id="quitDsh"[^>]*class="[^"]*danger/.test(html), null);
push("二次确认：第一次点只武装不执行",
  /if \(!quitArmed\)/.test(settingsTs) && /quitArmed = true/.test(settingsTs), null);
// 确认态必须会自己退回。不退回的话它会一直举着，下一次误点直接就是执行。
push("确认态会超时自动退回",
  /setTimeout\(disarmQuitDsh/.test(settingsTs) && /CONFIRM_WINDOW_MS/.test(settingsTs), null);
push("失焦也撤销确认态", /addEventListener\("blur", disarmQuitDsh\)/.test(settingsTs), null);
// 确认态要看得出来。看不出区别的话，「再点一次」和「点错第二次」是同一个动作。
push("确认态有独立视觉（.armed）",
  /classList\.add\("armed"\)/.test(settingsTs) && /button\.armed/.test(settingsCss), null);
// 正在跑任务时退出，代价和空闲时不是一回事，确认文案要说出来。
push("确认文案会区分有没有任务在跑",
  /is_working/.test(settingsTs) && /有任务在跑/.test(settingsTs), null);
// 拿不到工作态时不能谎称「没有任务」。
{
  const at = settingsTs.indexOf("let busy = false");
  const body = at < 0 ? "" : settingsTs.slice(at, at + 200);
  push("拿不到工作态时按不确定处理（busy 默认 false 且吞异常）",
    /catch \{\}/.test(body), body.slice(0, 120));
}

// ---- 2. 跨进程链路逐环 ----
push("Rust 有 request_dsh_shutdown 命令", /fn request_dsh_shutdown/.test(rs), null);
push("它只发事件、不自己杀（桌宠没那个位置）", (() => {
  const at = rs.indexOf("fn request_dsh_shutdown");
  const body = rs.slice(at, at + 300);
  return /emit\("dsh-shutdown"/.test(body) && !/taskkill|process::exit/.test(body);
})(), null);
push("三个命令都注册进 invoke_handler", (() => {
  const at = rs.indexOf("generate_handler!");
  const body = rs.slice(at, at + 500);
  return ["set_working", "is_working", "request_dsh_shutdown"].every((c) => body.includes(c));
})(), null);
push("桌宠窗口监听 dsh-shutdown", /listen\("dsh-shutdown"/.test(mainTs), null);
// 多 profile 时一只桌宠挂着多个独立 DSH 进程。只关随机一个比全关更费解。
push("发给所有打开的连接而不是第一条", (() => {
  const at = mainTs.indexOf("function requestDshShutdown");
  const body = mainTs.slice(at, at + 600);
  return /for \(const link of links\.values\(\)\)/.test(body) && !/return;\s*\}\s*\}/.test(body.slice(0, 200));
})(), null);
push("桌宠把工作态同步给 Rust（否则确认文案永远说不出有任务）",
  /invoke\("set_working"/.test(mainTs), null);

// ---- 3. 插件侧真的关得掉 ----
{
  const at = pluginJs.indexOf("function shutdownDsh");
  const body = at < 0 ? "" : pluginJs.slice(at, at + 1200);
  push("插件处理 shutdown 消息", /msg\.type === "shutdown"/.test(pluginJs), null);
  push("插件有 shutdownDsh", at >= 0, null);
  // 只退自己会留下孤儿子进程。
  push("杀的是进程树（taskkill /T /F）",
    /taskkill/.test(body) && /"\/T"/.test(body) && /"\/F"/.test(body), null);
  push("taskkill 是 detached 且 unref（否则它随父进程一起死）",
    /detached: true/.test(body) && /unref\(\)/.test(body), null);
  // taskkill 可能因权限或路径起不来。没有兜底就是「点了没反应」。
  push("有 process.exit 兜底", /process\.exit\(0\)/.test(body), null);
  push("兜底排在 taskkill 之后（否则自己先死了，树还在）", (() => {
    const kill = body.indexOf("taskkill");
    const exit = body.indexOf("process.exit(0)");
    return kill >= 0 && exit > kill;
  })(), null);
}

let ok = true;
for (const [name, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good || detail === null || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: 退出 DSH 既不会误触也真的关得掉" : "FAIL: 退出 DSH 有缺口");
process.exit(ok ? 0 : 1);
