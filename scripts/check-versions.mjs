// 版本一致性守卫。
// 插件与桌宠二进制靠 npm 的精确 pin 锁死，运行时又靠 hello 握手比对
// 版本号——所以下面这些地方必须永远相等，任一处漂移都会让用户收到
// 假的「版本不一致」警告，或让 npm 解析不到二进制包。
// 用法：node scripts/check-versions.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (...p) => JSON.parse(readFileSync(join(root, ...p), "utf8"));

const plugin = json("plugin", "package.json");
const platform = json("packages", "win32-x64", "package.json");
const petPkg = json("pet", "package.json");
const tauriConf = json("pet", "src-tauri", "tauri.conf.json");
const cargo = readFileSync(join(root, "pet", "src-tauri", "Cargo.toml"), "utf8");
const cargoVersion = cargo.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];

const expected = plugin.version;
const checks = [
  ["plugin/package.json version", expected],
  [`plugin/package.json optionalDependencies.${platform.name}`, plugin.optionalDependencies?.[platform.name]],
  ["packages/win32-x64/package.json version", platform.version],
  ["pet/package.json version", petPkg.version],
  ["pet/src-tauri/tauri.conf.json version", tauriConf.version],
  ["pet/src-tauri/Cargo.toml version（决定握手上报的版本）", cargoVersion],
];

// 会合目录路径由两侧各自拼出来：插件用 PET_IDENTIFIER，桌宠用 Tauri 的
// app_local_data_dir()（即 %LOCALAPPDATA%\<identifier>）。两者一旦不一致，
// 插件登记到 A 目录、桌宠去 B 目录找，多 profile 会合会静默失效。
const pluginSrc = readFileSync(join(root, "plugin", "lib", "index.js"), "utf8");
const pluginIdent = pluginSrc.match(/PET_IDENTIFIER\s*=\s*"([^"]+)"/)?.[1];
const identOk = pluginIdent === tauriConf.identifier;
if (!identOk) {
  console.log(`BAD  会合目录标识符: 插件 ${pluginIdent ?? "(缺失)"} != tauri.conf ${tauriConf.identifier}`);
} else {
  console.log(`OK   会合目录标识符: ${pluginIdent}`);
}

let ok = identOk;
for (const [label, got] of checks) {
  const good = got === expected;
  if (!good) ok = false;
  console.log(`${good ? "OK  " : "BAD "} ${label}: ${got ?? "(缺失)"}`);
}
console.log(ok ? `PASS: 版本全部一致于 ${expected}` : `FAIL: 版本应全部等于 ${expected}`);
process.exit(ok ? 0 : 1);
