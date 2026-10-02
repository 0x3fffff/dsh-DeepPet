// 「打开 DSH」的地址来源与协议校验。
//
// 这个菜单项最终把一个字符串交给 Windows 的 ShellExecute，而 ShellExecute
// 的语义是「按注册表决定用什么打开」——喂进去的东西决定它启动什么程序。
// 协议卡不住就不是「打不开网页」，是「点一下菜单启动了别的东西」。所以
// 插件、桌宠、Rust 各卡一道；中间任何一环被绕过（比如有人直接往桌宠的 WS
// 上发一条 web-url），后面那道还在。
//
// 地址取自 webServer 服务自己报的绑定地址，**不是网页报上来的**。第一版
// 让网页把 location.origin 报上来，方向是反的：这个功能存在的场景恰恰是
// 「DSH 还在跑、网页被关了、想找回来」，那时页面根本没机会报任何东西。
// 用法：node test/open-url.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const html = read("pet", "index.html");
const mainTs = read("pet", "src", "main.ts");
const rs = read("pet", "src-tauri", "src", "lib.rs");
const pluginJs = read("plugin", "lib", "index.js");
const clientJs = read("client", "lib", "client.js");

const cases = [];
const push = (name, ok, detail) => cases.push([name, ok, detail]);

// ---- 菜单项本身 ----
push("index.html 里有 menu-dsh 这一项", html.includes('id="menu-dsh"'), null);
{
  const at = html.indexOf('id="menu-dsh"');
  const line = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
  // 默认藏着：地址还没报上来时，一个点了没反应的菜单项比没有更糟。
  push("默认带 hidden 属性", /\bhidden\b/.test(line), line);
}
push("菜单只使用仍连接的网页服务", mainTs.includes('link.open && link.webUrl') && mainTs.includes('menuDsh.hidden = !dshUrl'), null);
push("断连时重新计算菜单", /links.delete\(url\);\s*refreshDshMenu\(\)/.test(mainTs), null);
push("网页服务卸载会撤销地址", pluginJs.includes('return () => { setWebUrl(""); };'), null);

// Exercise the actual menu selector with mixed desktop/web connections.
{
  const links = new Map();
  const menuDsh = { hidden: false };
  let dshUrl = "";
  const body = /function refreshDshMenu\(\) \{([\s\S]*?)\n\}/.exec(mainTs)?.[1];
  const refresh = new Function("links", "menuDsh", `${body}; return dshUrl;`);
  const desktop = { open: true, webUrl: "" };
  const web = { open: true, webUrl: "http://127.0.0.1:3080" };
  links.set("desktop", desktop);
  dshUrl = refresh(links, menuDsh);
  push("仅桌面端：隐藏入口", menuDsh.hidden && !dshUrl, null);
  links.set("web", web);
  dshUrl = refresh(links, menuDsh);
  push("网页版在线：显示有效入口", !menuDsh.hidden && dshUrl === web.webUrl, null);
  web.open = false;
  dshUrl = refresh(links, menuDsh);
  push("网页版断开而桌面端仍在线：隐藏入口", menuDsh.hidden && !dshUrl, null);
  web.open = true;
  web.webUrl = "";
  dshUrl = refresh(links, menuDsh);
  push("网页服务停止：隐藏入口", menuDsh.hidden && !dshUrl, null);
}

// ---- 四个环节 ----
// 地址来源：webServer 服务，不是网页。
push("插件从 webServer 取地址", /ctx\.inject\(\["webServer"\]/.test(pluginJs), null);
// 必须是 scoped inject，不能写进插件顶层的 inject 数组——写进去就成了硬
// 依赖，headless 之类没有网页服务的组合里整个桌宠插件都不会激活。
{
  const top = /const inject = \[([^\]]*)\]/.exec(pluginJs)?.[1] ?? "";
  push("webServer 不是插件的硬依赖", !top.includes("webServer"), top);
}
// 0.0.0.0 是「监听所有网卡」，拿它当访问地址打不开。
push("0.0.0.0 换成回环地址", /0\.0\.0\.0.*127\.0\.0\.1/.test(pluginJs), null);
// 网页那半不该再有上报——留着就是两条来源，出问题时分不清听了谁的。
push("网页端不再上报地址", !/web-url/.test(clientJs), null);
{
  const at = pluginJs.indexOf("function setWebUrl");
  const body = at < 0 ? "" : pluginJs.slice(at, at + 400);
  push("插件侧校验 http/https", /\^https\?:/.test(body), body.slice(0, 200));
  push("插件侧限制长度", /length\s*>\s*\d+/.test(body), null);
}
{
  const at = mainTs.indexOf('msg.type === "web-url"');
  const body = at < 0 ? "" : mainTs.slice(at, at + 500);
  push("桌宠侧校验 http/https", /\^https\?:/.test(body), body.slice(0, 200));
  push("桌宠侧限制长度", /length\s*<=\s*\d+/.test(body), null);
}
{
  const at = rs.indexOf("fn open_url");
  const body = at < 0 ? "" : rs.slice(at, at + 900);
  push("Rust 侧校验 http/https",
    body.includes('starts_with("http://")') && body.includes('starts_with("https://")'), null);
  push("Rust 侧拒绝控制字符（防止把参数截断成别的东西）",
    /is_control/.test(body), null);
  // ShellExecute 可能要好几秒（浏览器冷启动）。同步命令跑在主线程上，
  // 在那儿等就是让整只桌宠僵住——这个项目已经为这件事付过一次代价。
  push("Rust 侧把 ShellExecute 扔到别的线程", /thread::spawn/.test(body), null);
}

// ---- 反向：不能有别的地方绕过校验直接开 ----
{
  const calls = (mainTs.match(/invoke\("open_url"/g) ?? []).length;
  push("桌宠里只有一处调 open_url", calls === 1, calls);
}
push("Rust 里只有 open_url 一个地方碰 ShellExecute",
  (rs.match(/ShellExecuteW\s*\(/g) ?? []).length === 2, // 一处声明 + 一处调用
  (rs.match(/ShellExecuteW\s*\(/g) ?? []).length);

let ok = true;
for (const [name, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good || detail === null || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: 打开 DSH 的地址校验到位" : "FAIL: 打开 DSH 的地址校验有缺口");
process.exit(ok ? 0 : 1);
