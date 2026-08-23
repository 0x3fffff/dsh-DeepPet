// 进度气泡的脱敏回归。这个气泡是置顶的，会进截屏、录屏和屏幕共享——
// 所以「只显示文件名」和「只显示程序名」是安全属性，不是排版偏好。
// 用法：node test/redact.mjs
import { baseName, programName, progressFromToolCall } from "../plugin/lib/index.js";

// 反斜杠用 fromCharCode 构造，不写字面量。这段代码经过多层转义传递时
// `\` 会被折叠成 `\`，随后 JS 把 `\P` `\s` 当转义符吃掉，测试输入里的
// 反斜杠会**凭空消失**——那样测的就不是实现而是转义了（已踩过一次）。
const B = String.fromCharCode(92);
const win = (...parts) => parts.join(B);

const cases = [];
const eq = (label, got, want) => cases.push([label, got === want, `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`]);
const no = (label, got, forbidden) =>
  cases.push([label, !got.includes(forbidden), `「${got}」里不该出现 ${JSON.stringify(forbidden)}`]);

// Windows 路径必须切干净——这是最容易因转义被折叠而失效的一条
eq("Windows 反斜杠路径", baseName(win("E:", "Programming tools", "proj", "src", "main.ts")), "main.ts");
eq("POSIX 斜杠路径", baseName("/home/me/proj/src/main.ts"), "main.ts");
eq("混合分隔符", baseName(win("E:", "proj") + "/src" + B + "main.ts"), "main.ts");
eq("本来就是文件名", baseName("main.ts"), "main.ts");
eq("空值", baseName(undefined), "");

// 命令行只留程序名——完整命令行正是密钥出没的地方
eq("带参数的命令", programName("npm run build -- --verbose"), "npm");
// 带引号的程序路径是 Windows 上的常态，必须解析准确
eq("带引号的程序路径",
  programName('"' + win("C:", "Program Files", "Git", "bin", "git.exe") + '" status'), "git");
// 不带引号又含空格的路径本身歧义。精度可以退化，但**安全不能**：
// 命令行其余部分绝不能出现。
no("无引号含空格路径不泄露其余命令行",
  programName(win("C:", "Program Files", "Git", "bin", "git.exe") + " push --force origin main"),
  "origin");
eq("去掉 .exe", programName("node.exe test.mjs"), "node");

const leaky = 'curl -H "Authorization: Bearer sk-abc123" https://api.example.com';
no("密钥不泄露", progressFromToolCall("bash", JSON.stringify({ command: leaky })), "sk-abc123");
no("URL 不泄露", progressFromToolCall("bash", JSON.stringify({ command: leaky })), "api.example.com");
no("完整路径不泄露",
  progressFromToolCall("edit", JSON.stringify({ file_path: win("E:", "secret-project", "src", "main.ts") })),
  "secret-project");

// 正常文案
eq("修改文件", progressFromToolCall("edit", JSON.stringify({ file_path: "src/main.ts" })), "🧑‍💻 正在修改 main.ts");
eq("执行命令", progressFromToolCall("bash", JSON.stringify({ command: "npm test" })), "🔧 正在执行 npm 命令");
eq("未知工具", progressFromToolCall("grep_files", "{}"), "⚙️ 正在使用 grep_files");
eq("参数不是 JSON 也不崩", progressFromToolCall("bash", "not json"), "🔧 正在执行命令");

let ok = true;
for (const [label, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${label}${good ? "" : ` — ${detail}`}`);
}
console.log(ok ? "PASS: 脱敏回归通过" : "FAIL: 脱敏回归未通过");
process.exit(ok ? 0 : 1);
