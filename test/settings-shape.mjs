// 设置结构的三方一致性。
//
// 同一份 Settings 被抄了三遍：Rust 的 struct（存盘和默认值）、main.ts 的
// interface（桌宠用）、settings.ts 的 interface + 面板控件（用户改）。
// 漏抄一处不会报错，只会静静地坏掉，而且三种坏法各不相同：
//   Rust 有、面板没有  → 设置项存在但没人能改到它；
//   面板有、Rust 没有  → 保存时被 serde 丢掉，下次打开又变回去；
//   main.ts 没有       → 用户改了，桌宠读不到，看起来就是「设置不生效」。
// 三种都是「功能看着在，其实不在」，正是最难从现象倒推回原因的那一类。
// 用法：node test/settings-shape.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rs = readFileSync(join(root, "pet", "src-tauri", "src", "lib.rs"), "utf8");
const mainTs = readFileSync(join(root, "pet", "src", "main.ts"), "utf8");
const settingsTs = readFileSync(join(root, "pet", "src", "settings.ts"), "utf8");
const settingsHtml = readFileSync(join(root, "pet", "settings.html"), "utf8");

const cases = [];
const push = (name, ok, detail) => cases.push([name, ok, detail]);

/** 截出 `头 { ... }` 到第一处顶格 `}` 为止的块体。 */
function block(src, head) {
  const at = src.indexOf(head);
  if (at < 0) return null;
  const end = src.indexOf("\n}", at);
  return end < 0 ? null : src.slice(at + head.length, end);
}

/** 取块体里缩进为 indent 个空格的字段名。 */
function fieldsOf(body, indent) {
  if (body === null) return null;
  const pad = " ".repeat(indent);
  const out = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith(pad) || line[indent] === " ") continue;
    const m = /^(\w+):\s/.exec(line.slice(indent));
    if (m) out.push(m[1]);
  }
  return out;
}

const rustBody = block(rs, "struct Settings {");
const rust = fieldsOf(rustBody, 4);
const main = fieldsOf(block(mainTs, "interface Settings {"), 2);
const panel = fieldsOf(block(settingsTs, "interface Settings {"), 2);

push("能在 lib.rs 里找到 struct Settings", !!rust && rust.length > 0, rust);
push("能在 main.ts 里找到 interface Settings", !!main && main.length > 0, main);
push("能在 settings.ts 里找到 interface Settings", !!panel && panel.length > 0, panel);

if (rust && main && panel) {
  const diff = (a, b) => a.filter((k) => !b.includes(k));
  push(`Rust 与 main.ts 字段一致（${rust.length} 个）`,
    diff(rust, main).length === 0 && diff(main, rust).length === 0,
    { "Rust 独有": diff(rust, main), "main.ts 独有": diff(main, rust) });
  push("Rust 与 settings.ts 字段一致",
    diff(rust, panel).length === 0 && diff(panel, rust).length === 0,
    { "Rust 独有": diff(rust, panel), "settings.ts 独有": diff(panel, rust) });

  // 每个字段都要有 serde 默认值。少一个的话，用户升级时旧的 settings.json
  // 里没有这个键，反序列化直接失败——**整份设置退回默认**，他调过的大小、
  // 样式全没了，而那看起来像是「这次更新把我的设置清空了」。
  // 用切片而不是正则：要匹配的东西里 [ ( ) ] 全是正则元字符。
  const noDefault = rust.filter((f) => {
    const at = rustBody.indexOf(`\n    ${f}: `);
    if (at < 0) return true;
    return !rustBody.slice(Math.max(0, at - 160), at).includes("serde(default =");
  });
  push("每个字段都带 serde default（否则旧配置会让整份设置退回默认）",
    noDefault.length === 0, noDefault);

  // Default 实现里也要逐个列全。
  const defBody = block(rs, "impl Default for Settings {") ?? "";
  const missingInDefault = rust.filter((f) => !defBody.includes(`${f}:`));
  push("Default 实现里每个字段都列了", missingInDefault.length === 0, missingInDefault);

  // 面板里得真有控件能改到它。只有 interface 而没有控件 = 用户够不着。
  const unreachable = panel.filter((f) => {
    const camel = f.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    return !settingsHtml.includes(`id="${camel}"`) && !settingsTs.includes(`settings.${f} =`);
  });
  push("每个设置项在面板里都有对应控件", unreachable.length === 0, unreachable);
}

let ok = true;
for (const [name, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: 设置结构三方一致" : "FAIL: 设置结构对不上，会静默失效");
process.exit(ok ? 0 : 1);
