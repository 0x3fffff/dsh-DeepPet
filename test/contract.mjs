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

let agentTypes, agentIndex, titleTypes, sessionTypes, sessionIndex, rpcTypes, webServerTypes;
try {
  agentTypes = read("@deepseek-ai/dsh-agent", "lib", "types", "runtime-types.d.ts");
  // 事件定义在 runtime-types，registry（roots/list）在 index——分开读。
  agentIndex = read("@deepseek-ai/dsh-agent", "lib", "types", "index.d.ts");
  titleTypes = read("@deepseek-ai/dsh-session-title", "lib", "types", "index.d.ts");
  // 「终止」的判别器住在 session 日志里，不在 agent 事件里。
  sessionTypes = read("@deepseek-ai/dsh-session", "lib", "types", "types.d.ts");
  sessionIndex = read("@deepseek-ai/dsh-session", "lib", "types", "index.d.ts");
  // 网页端「启动桌宠」按钮走 connection 的 RPC 通道。通道形状变了不会报错，
  // 只会让按钮静默失灵——所以也钉住。
  rpcTypes = read("@deepseek-ai/dsh-client-connection", "lib", "types", "rpc.d.ts");
  // 右键「打开 DSH」的地址取自 webServer 服务自己报的绑定地址。这两个
  // getter 没了或改名，菜单项就永远不亮——而那看起来像功能没做，不像坏了。
  webServerTypes = read("@deepseek-ai/dsh-host-webserver", "lib", "types", "index.d.ts");
} catch (err) {
  console.log(`SKIP: 未安装契约包（${err.message.split("\n")[0]}）；跑 pnpm install`);
  process.exit(0);
}

const checks = [
  // host 侧注册通道的签名。少一个 options 参数就注册不上，而那时按钮只是
  // 「点了没反应」。
  ["connection.rpc.handle 仍是 (channel, handler, options)",
    /handle\(channel: string, handler: ConnectionRpcHandler, options: ConnectionRpcHandlerOptions\)/.test(rpcTypes)],
  // 我们把 /pet 限定成 loopback：只信本机浏览器。这个取值没了就得重新选。
  ["ConnectionRpcAuthority 仍含 'loopback'",
    /export type ConnectionRpcAuthority = 'trusted-host' \| 'loopback';/.test(rpcTypes)],
  // handler 的入参顺序：第一个必须是 endpoint，我们靠它分辨 launch。
  ["ConnectionRpcHandler 仍是 (endpoint, payload, signal)",
    /ConnectionRpcHandler = \(endpoint: string, payload: unknown, signal: AbortSignal\)/.test(rpcTypes)],
  // 客户端那半的调用签名，client.js 里按它写的。
  ["client 侧 rpc.call 仍是 (channel, endpoint, payload, signal?)",
    /call\(channel: string, endpoint: string, payload: unknown, signal\?: AbortSignal\)/.test(rpcTypes)],
  // 「打开 DSH」靠这两个 getter 拼出地址。
  ["webServer.port 仍是 number getter", /get port\(\): number;/.test(webServerTypes)],
  // host 的取值范围决定了我们要不要把 0.0.0.0 换成回环——多一个取值（比如
  // 具体网卡 IP）就得重新想怎么算访问地址。
  ["webServer.host 仍只有回环和全网卡两种取值",
    /host: '127\.0\.0\.1' \| '0\.0\.0\.0';/.test(webServerTypes)],
  ["webServer 仍然挂在 ctx.webServer 上", /webServer: WebServer;/.test(webServerTypes)],
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
  // 取消**不发 agent/error**（已在真实 DSH 上实测）：用户点「终止对话」时
  // turn 以 kind:'aborted' 收尾。这三条断言撑着整个「已终止」的判别。
  ["session/event 仍是观察 session 日志的入口",
    /'session\/event'\(this: Scoped<Session>, session: Session, event: SessionEvent\): void;/.test(sessionIndex)],
  ["turn/end 仍带 reason",
    /'turn\/end': \{\s*turn: number;\s*reason: TurnEndReason;\s*\}/.test(sessionTypes)],
  ["TurnEndReason 仍有 aborted / error 两个 kind",
    /aborted: \{\s*kind: 'aborted';\s*reason: TurnEndCancelCause;/.test(sessionTypes)
      && /error: \{\s*kind: 'error';/.test(sessionTypes)],
  ["取消原因仍区分 user / parent / hook / disposed",
    ["user", "parent", "hook", "disposed"].every((k) =>
      new RegExp(`readonly kind: '${k}';`).test(sessionTypes))],
  // 工作态直接查 Agent.status，比自己维护计数可靠。
  ["Agent.status 仍可读",
    /readonly status: AgentStatus;/.test(agentTypes)],
  // 进度气泡的两个数据源。没有它们就只能编轮播文案。
  ["tool/call 仍带 name + arguments",
    /'tool\/call': \{[^}]*name: string;[^}]*arguments: string;/s.test(sessionTypes)],
  ["todo/write 仍带 todos，TodoItem 仍有 content + status",
    /'todo\/write': \{\s*todos: TodoItem\[\];/.test(sessionTypes)
      && /content: string;/.test(sessionTypes)
      && /status: 'pending' \| 'in_progress' \| 'completed';/.test(sessionTypes)],
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
