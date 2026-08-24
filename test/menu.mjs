// 右键菜单里的开发入口不能发给用户。
//
// 「测试面板」是开发用的，社区版本的右键菜单不该有它。要藏住它需要**三个条件
// 同时成立**，缺一个就会静悄悄地发出去：
//
//   1. index.html 里那一项带 hidden 属性；
//   2. CSS 里有显式的 .menu-item[hidden] { display: none } —— 类选择器的优先级
//      高于浏览器默认的 [hidden] { display: none }，光加属性是藏不住的。
//      这条实际踩过：加完 hidden 以为好了，按钮照常显示；
//   3. main.ts 只在 debugMode 下把它放出来。
//
// 三条都是纯文本条件，静态查就够，不用拉起桌宠。实际表现由截图验证过：
// 非调试版菜单只有「设置」，调试版才多一项。
// 用法：node test/menu.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const html = read("pet", "index.html");
const css = read("pet", "src", "styles.css");
const ts = read("pet", "src", "main.ts");

const cases = [];
const push = (name, ok, detail) => cases.push([name, ok, detail]);

// 1. 默认藏起来
const item = /<div class="menu-item" id="menu-test"([^>]*)>/.exec(html);
push("index.html 里有 menu-test 这一项", !!item, item);
push("它默认带 hidden 属性", !!item && /\bhidden\b/.test(item[1]), item?.[1]);

// 2. hidden 真的能藏住（优先级）
push(".menu-item[hidden] 显式置 display:none",
  /\.menu-item\[hidden\]\s*\{[^}]*display:\s*none/.test(css),
  css.includes(".menu-item[hidden]") ? "有选择器但没写 display:none" : "没有这条规则");

// 3. 只有调试模式放出来
const unhide = /menuTest\.hidden\s*=\s*false/.exec(ts);
push("main.ts 里会把它放出来", !!unhide, unhide);
if (unhide) {
  // 取那一行往前一小段，确认放出来这件事挂在 debugMode 上。
  const before = ts.slice(Math.max(0, unhide.index - 200), unhide.index);
  push("放出来这件事挂在 debugMode 上", /if\s*\(debugMode\)\s*$/.test(before.trimEnd())
    || /debugMode/.test(before.split("\n").slice(-2).join("\n")), before.split("\n").slice(-2));
}
// 除了这一处，不该有别的地方把它放出来。
push("没有第二处放出它的代码", (ts.match(/menuTest\.hidden\s*=\s*false/g) ?? []).length === 1);

// 菜单定位不能写死高度：项数会变，写死会让菜单在屏幕下沿被摆到错的位置。
push("菜单定位用实测尺寸而不是写死常量",
  /menu\.offsetWidth/.test(ts) && /menu\.offsetHeight/.test(ts) && !/const MENU_H\s*=/.test(ts));

let ok = true;
for (const [name, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: 开发入口不会发给用户" : "FAIL: 开发入口可能会显示给用户");
process.exit(ok ? 0 : 1);
