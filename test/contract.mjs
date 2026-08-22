// DSH 契约守卫。
// 插件监听 DSH 的事件、调用 DSH 的服务，而这些定义不在本仓库里。之前的
// plugin-smoke 用自己造的 mock 触发事件——那测的是「代码和自己一致」，
// DSH 那边一旦改了形状，测试照样全绿。这个文件读真实包的 .d.ts，
// 把我们实际依赖的那几条断言死。
// 用法：node test/contract.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

// 这些包的 exports 不放行任意子路径，但放行了 ./package.json——
// 用它定位包根，再按相对路径读 .d.ts。
function read(pkg, ...rel) {
  const root = dirname(require.resolve(`${pkg}/package.json`));
  return readFileSync(join(root, ...rel), "utf8");
}

let agentTypes, agentIndex, titleTypes;
try {
  agentTypes = read("@deepseek-ai/dsh-agent", "lib", "types", "runtime-types.d.ts");
  // 事件定义在 runtime-types，registry（roots/list）在 index——分开读。
  agentIndex = read("@deepseek-ai/dsh-agent", "lib", "types", "index.d.ts");
  titleTypes = read("@deepseek-ai/dsh-session-title", "lib", "types", "index.d.ts");
} catch (err) {
  console.log(`SKIP: 未安装契约包（${err.message.split("\n")[0]}）；跑 pnpm install`);
  process.exit(0);
}

const checks = [
  // agent/status 只有两个值，这正是它分不出成败、必须靠 agent/error 判别的原因。
  // 若这里多出第三个值，整个 running->idle 边沿检测的语义都要重估。
  ["AgentStatus 仍是 'idle' | 'running'",
    /export type AgentStatus = 'idle' \| 'running';/.test(agentTypes)],
  ["agent/status 载荷仍是 { agent, status }",
    /'agent\/status'\(this: Scoped<Agent>, payload: \{\s*agent: Agent;\s*status: AgentStatus;\s*\}\)/.test(agentTypes)],
  // 成败判别器。
  ["agent/error 存在且带 agent",
    /'agent\/error'\(this: Scoped<Agent>, payload: \{\s*agent: Agent;/.test(agentTypes)],
  // prevStatus / failed 的清理点，没有它这两个容器会无界增长。
  ["agent/disposed 存在且带 agent",
    /'agent\/disposed'\(this: Scoped<Agent>, payload: \{\s*agent: Agent;/.test(agentTypes)],
  // 「只庆祝顶层 agent」整个建立在 roots() 上：子 agent 同样会发 agent/status。
  ["agents.roots() 仍返回顶层 agent",
    /roots\(\): Agent\[\];/.test(agentIndex)],
  // 我们用 agent.id 做键，靠的是它与 session 同一身份。
  ["Agent.id 仍是 SessionId",
    /readonly id: SessionId;/.test(agentTypes)],
  // 标题可能不存在——插件据此走「任务完成」而不是静默跳过。
  ["sessionTitle.get 仍可能返回 undefined",
    /get\(session: Session\): SessionTitleSnapshot \| undefined;/.test(titleTypes)],
  ["标题快照仍有 title 字段",
    /readonly title: string;/.test(titleTypes)],
];

let ok = true;
for (const [label, good] of checks) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${label}`);
}
console.log(ok ? "PASS: DSH 契约与插件假设一致" : "FAIL: DSH 契约已变，插件假设需要重估");
process.exit(ok ? 0 : 1);
