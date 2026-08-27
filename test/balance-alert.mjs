// 余额提醒迟滞状态机的回归。
//
// 这台机器唯一的职责是「别吵」。它坏掉的表现不是报错，是每 10 分钟弹一次
// 8 秒动画加音效——那种东西跑测试的人看不见，只有装了的用户会看见，然后
// 把功能关掉。所以把三条规则逐条钉死。
//
// 反向对照：把 pet/src/balance-alert.js 里 state.armed 的分支删掉（永远报），
// 下面「锁定后不再重复报」那几条必须变红。改完记得改回来。
// 用法：node test/balance-alert.mjs
import { REARM_FACTOR, SECOND_FACTOR, initialState, step } from "../pet/src/balance-alert.js";

const cases = [];
const push = (name, ok, detail) => cases.push([name, ok, detail]);

/** 把 alerts 数组压成一行好读的字符串，断言写起来才不至于绕。 */
const seq = (alerts) => alerts.map((a) => a ?? "-").join(",");

/** 按顺序喂一串读数，收集每一步报了什么。 */
function run(amounts, threshold = 5) {
  let s = initialState();
  const alerts = [];
  for (const a of amounts) {
    const r = step(s, a, threshold);
    s = r.state;
    alerts.push(r.alert);
  }
  return { alerts, state: s };
}

// ---- 规则 1：跌破报一次 ----
push("余额充足时不报", run([50, 20, 6, 5.01]).alerts.every((a) => a === null));
push("跌破阈值报 first", run([10, 4.9]).alerts.at(-1) === "first");
// 边界：等于阈值不算跌破。用 < 而不是 <=，否则设 5 元的人在余额恰好 5.00
// 时就被报警，而他还一分钱没花。
push("恰好等于阈值不报", run([5]).alerts.at(-1) === null);

// ---- 规则 2：锁定，回升到 1.2 倍才重新武装 ----
{
  // 这是整个功能最要命的一条：不加锁就是每轮查询都报。
  const { alerts } = run([4, 3.9, 3.8, 3.7, 3.6, 3.5]);
  push("跌破后连续查询只报第一次", alerts.filter((a) => a !== null).length === 1, alerts);
}
push("回升到阈值以上但不足 1.2 倍：不重新武装",
  run([4, 5.5, 4]).alerts.filter(Boolean).length === 1, run([4, 5.5, 4]).alerts);
push("回升到 1.2 倍后重新武装，再跌破可以再报",
  seq(run([4, 6, 4]).alerts) === "first,-,first", run([4, 6, 4]).alerts);
// 抖动：4 → 5.5 → 4 → 5.5 → 4 …… 全程只能有第一次那一声。
{
  const seq = [];
  for (let i = 0; i < 10; i++) seq.push(i % 2 ? 5.5 : 4);
  push("在阈值线上抖动 10 轮仍只报一次",
    run(seq).alerts.filter(Boolean).length === 1, run(seq).alerts);
}

// ---- 规则 3：锁定期内继续下跌到 0.4 倍补报一次 ----
push("锁定期内跌到 0.4 倍补报 second", run([4, 1.9]).alerts.at(-1) === "second");
push("补报后彻底闭嘴", run([4, 1.9, 1.5, 1, 0.5, 0]).alerts.filter(Boolean).length === 2,
  run([4, 1.9, 1.5, 1, 0.5, 0]).alerts);
// 顺序陷阱：如果补报的判定写在回升前面，「一口气充到 1.2 倍以上」这一次
// 查询会先被补报规则吃掉，变成充完钱反而挨一顿报警。
push("充值直达 1.2 倍以上时不补报", run([4, 6]).alerts.at(-1) === null);
// 补报之后再充值，仍然要能重新武装走完整轮。
push("补报后充值可重新武装",
  seq(run([4, 1.9, 6, 4]).alerts) === "first,second,-,first", run([4, 1.9, 6, 4]).alerts);

// ---- 关闭与脏数据 ----
push("阈值为 0 时永不报警", run([0, 0, 0], 0).alerts.every((a) => a === null));
push("阈值为负时永不报警", run([1, -1], -5).alerts.every((a) => a === null));
push("余额是 NaN 时不报也不改状态", (() => {
  const s0 = initialState();
  const r = step(s0, Number.NaN, 5);
  return r.alert === null && r.state === s0;
})());
push("余额是字符串/undefined 时不报", (() => {
  for (const bad of [undefined, null, "3", {}, Number.POSITIVE_INFINITY]) {
    if (step(initialState(), bad, 5).alert !== null) return false;
  }
  return true;
})());

// ---- 系数本身 ----
// 这两个数字直接决定「多久才肯再响一次」，写死在这里是为了改动时必须
// 有意识地也改测试，而不是悄悄从 1.2 滑到 1.01。
push("重新武装系数是 1.2", REARM_FACTOR === 1.2, REARM_FACTOR);
push("补报系数是 0.4", SECOND_FACTOR === 0.4, SECOND_FACTOR);

// step 不能就地改上一次的状态——桌宠把状态存在模块变量里，就地改会让
// 「回滚到上一次」这种调试手段失效，也让上面的 NaN 用例名存实亡。
push("step 不修改传入的状态", (() => {
  const s0 = initialState();
  const before = JSON.stringify(s0);
  step(s0, 1, 5);
  return JSON.stringify(s0) === before;
})());

let ok = true;
for (const [name, good, detail] of cases) {
  if (!good) ok = false;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
console.log(ok ? "PASS: 余额提醒迟滞规则成立" : "FAIL: 余额提醒会重复打扰");
process.exit(ok ? 0 : 1);
