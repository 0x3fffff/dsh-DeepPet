// 网页端那半的包形状。
//
// DSH 的 client-modules 会扫描声明了 `dsh.client` 的包。声明写错不会静默失效
// ——它在启动时「loud throw」，整个 fiber FAILED。也就是说这类错误的代价是
// **用户装上后 DSH 起不来**，而不是按钮不显示。所以在这里先挡住。
//
// 规则不是我猜的，是照着 @deepseek-ai/dsh-client-modules 里 parseDshClient /
// clientExportOf 的实现写的；下半段反过来盯住那份实现有没有变。
// 用法：node test/client-pkg.mjs
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "client", "package.json"), "utf8"));

const cases = [];
const push = (name, ok, detail) => cases.push([name, ok, detail]);

// ---- 我们的声明 ----
const decl = pkg.dsh?.client;
push("有 dsh.client 声明", typeof decl === "object" && decl !== null, pkg.dsh);
push("platform 是字符串", typeof decl?.platform === "string", decl?.platform);
push("inject 是字符串数组",
  decl?.inject === undefined
    || (Array.isArray(decl.inject) && decl.inject.every((i) => typeof i === "string")),
  decl?.inject);

// exports["./client"] 必须能解析成一个真实存在的文件——loader 读不到就抛
// MissingClientBundle。
const clientExport = pkg.exports?.["./client"];
const rel = typeof clientExport === "string"
  ? clientExport
  : typeof clientExport?.default === "string" ? clientExport.default : undefined;
push('exports["./client"] 可解析', typeof rel === "string", clientExport);
if (rel) {
  push(`bundle 真实存在（${rel}）`, existsSync(resolve(root, "client", rel)), rel);
  // files 圈不中它的话，发到 npm 上就是个缺 bundle 的包——本地怎么测都发现不了。
  const files = pkg.files ?? [];
  const covered = files.some((f) => rel.replace(/^\.\//, "").startsWith(f.replace(/\/$/, "")));
  push(`files 圈得住它（files=${JSON.stringify(files)}）`, covered, files);
}

// react 不该是运行时依赖：client.js 里的 require 是浏览器侧 __ModuleLoader__
// 提供的，和 npm 的依赖图无关。写成 dependencies 会让每个用户（含纯 CLI 的）
// 白装一棵 React 树。
push("react 不在 dependencies 里", pkg.dependencies?.react === undefined, pkg.dependencies);

// ---- 反过来盯住 DSH 那边的规则 ----
let loader;
try {
  loader = readFileSync(
    join(dirname(require.resolve("@deepseek-ai/dsh-client-modules/package.json")), "lib", "index.js"),
    "utf8",
  );
} catch {
  console.log("SKIP: 未安装 @deepseek-ai/dsh-client-modules；跑 pnpm install");
  process.exit(0);
}
push("loader 仍要求 platform 是字符串",
  /dsh\.client\.platform must be a string/.test(loader));
push("loader 仍要求 inject 是字符串数组",
  /dsh\.client\.inject must be a string array/.test(loader));
push('loader 仍接受 exports["./client"] 的对象 default 形式',
  /exports\["\.\/client"\] must be a string or an object with a string default/.test(loader));
// bundle 缺失是「启动即失败」而不是「按钮不显示」——这条决定了上面那些断言
// 值不值得存在。
push("bundle 缺失仍是硬失败", /MissingClientBundle/.test(loader));

let ok = true;
for (const [name, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: 网页端包形状合法" : "FAIL: 网页端包会让 DSH 启动失败");
process.exit(ok ? 0 : 1);
