// 插件 bundle 里的 cordis.patch.yml 引用的包名必须真实存在。
//
// 这条守卫是拿事故换来的：改成作用域包名时漏了 cordis.patch.yml 里那一处
// —— 它写的是单引号的 'dsh-deep-pet'，而我那次 grep 找的是 "dsh-deep-pet"
// （双引号）、`add dsh-deep-pet` 之类的形状，一个都没匹配上。
//
// 后果不是「插件不生效」：cordis loader import 不到那个包，整棵插件树加载
// 失败，用户的 DSH **直接起不来**。装了插件的人得手工去 profile 的
// package.json 里删掉那一行才能恢复。
//
// 所以这里不认任何模式匹配，只做一件事：把 patch 里每个 name 拿去和本仓库
// 三个包的真实 name 对账，对不上就红。
// 用法：node test/patch.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const pkg = (...p) => JSON.parse(read(...p));

const cases = [];
const push = (name, ok, detail) => cases.push([name, ok, detail]);

const plugin = pkg("plugin", "package.json");
const client = pkg("client", "package.json");
const platform = pkg("packages", "win32-x64", "package.json");
const known = new Set([plugin.name, client.name, platform.name]);

const patch = read("plugin", "cordis.patch.yml");
// 单引号、双引号、裸值三种写法都要认——漏掉一种就等于这条守卫没写。
const names = [...patch.matchAll(/^\s*name:\s*(?:'([^']*)'|"([^"]*)"|([^\s#]+))\s*$/gm)]
  .map((m) => m[1] ?? m[2] ?? m[3]);

push("patch 里至少引用了一个包", names.length > 0, names);
for (const n of names) {
  push(`patch 引用的 ${n} 是本仓库真实的包名`, known.has(n), [...known]);
}
// 插件本体必须在其中，否则装了等于没装。
push(`patch 插入了插件本体（${plugin.name}）`, names.includes(plugin.name), names);
// 网页那半也要有自己的加载项：它的 apply 是空的，存在只为让 cordis 建 fiber，
// 没有 fiber 就不会被扫进浏览器 roster，侧栏按钮永远不出现。
push(`patch 插入了网页端（${client.name}）`, names.includes(client.name), names);

// patch 会随包发布，files 圈不中就等于没有——而 DSH 靠 dsh.bundle.patch 找它。
const rel = plugin.dsh?.bundle?.patch;
push("package.json 声明了 dsh.bundle.patch", typeof rel === "string", plugin.dsh);
if (typeof rel === "string") {
  const bare = rel.replace(/^\.\//, "");
  push(`files 圈得住 ${bare}`, (plugin.files ?? []).includes(bare), plugin.files);
}

let ok = true;
for (const [name, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: bundle patch 引用的包名都对得上" : "FAIL: bundle patch 会让用户的 DSH 起不来");
process.exit(ok ? 0 : 1);
