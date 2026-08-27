// 「打开 DSH」这条链路的协议校验。
//
// 这个菜单项最终把一个字符串交给 Windows 的 ShellExecute，而那个字符串
// **不是我们造的**：DSH 网页报 location.origin → 插件 RPC → 桌宠 → Rust。
// ShellExecute 的语义是「按注册表决定用什么打开」，所以喂进去的东西决定了
// 它启动什么程序。协议卡不住就不是「打不开网页」，是「点一下菜单启动了
// 别的东西」。
//
// 链路上有四个环节，其中三个各卡一道：插件的 setWebUrl、桌宠的 web-url
// 处理、Rust 的 open_url。多重校验不是冗余——中间任何一环被绕过（比如
// 有人直接往桌宠的 WS 上发一条 web-url），后面那道还在。
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
push("只有收到合法地址才放出来",
  /menuDsh\.hidden\s*=\s*false/.test(mainTs)
  && (mainTs.match(/menuDsh\.hidden\s*=\s*false/g) ?? []).length === 1, null);

// ---- 四个环节 ----
push("网页端报的是 location.origin（而不是拼出来的串）",
  /rpc\.call\(\s*"\/pet",\s*"web-url"/.test(clientJs)
  && /window\.location\.origin/.test(clientJs), null);

push("插件的 web-url 端点存在", /"web-url"/.test(pluginJs), null);
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
