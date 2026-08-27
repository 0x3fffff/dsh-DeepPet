// 余额提醒的迟滞状态机。
//
// 单独成文件是因为这台机器决定了「这功能吵不吵」，而它是纯算术，不碰 DOM、
// 不碰时间、不碰网络——可以直接单测，也可以做反向对照（把迟滞删掉，断言
// test/balance-alert.mjs 真的会红）。桌宠那边只负责喂数字和放动画。
//
// 为什么需要迟滞：余额跌破阈值之后，**之后每一次查询都仍然低于阈值**。
// 不加迟滞就是每 10 分钟一次 8 秒动画加音效，一整天。这个功能会因为这一点
// 被人关掉，而关掉之后它就等于不存在。
//
// 三条规则：
//   1. 跌破阈值报一次（first），然后锁住。
//   2. 回升到阈值 × 1.2 以上才重新武装。乘 1.2 而不是刚好回到阈值，是防止
//      余额在阈值线上下抖动时反复报——用一次 API 就掉回线下，再充一点又上来。
//   3. 锁定期内如果继续烧到阈值 × 0.4（默认阈值 5 元时就是 2 元），允许再报
//      最后一次（second）。理由：忽略了第一次提醒之后一路烧到 0 却全程静默，
//      正好错过最该知道的那一刻。之后彻底闭嘴，直到规则 2 重新武装。

/** 回升到阈值的多少倍才重新武装。 */
export const REARM_FACTOR = 1.2;
/** 锁定期内跌到阈值的多少倍时允许补报第二次。 */
export const SECOND_FACTOR = 0.4;

/** 初始状态：还没报过，随时可以报第一次。 */
export function initialState() {
  return { armed: true, secondArmed: false };
}

/**
 * 喂一个余额读数，返回新状态和这一次该不该报警。
 *
 * @param {{armed: boolean, secondArmed: boolean}} state 上一次的状态
 * @param {number} amount 查到的余额
 * @param {number} threshold 用户设的阈值
 * @returns {{state: {armed: boolean, secondArmed: boolean}, alert: null | "first" | "second"}}
 */
export function step(state, amount, threshold) {
  // 阈值非正数等于关掉：余额永远不会低于 0 以下，硬算下去只会在 threshold=0
  // 时把「余额恰好为 0」报成低余额，而那时候该说的是「没钱了」不是「快没了」。
  if (!(threshold > 0) || !Number.isFinite(amount)) return { state, alert: null };

  if (state.armed) {
    if (amount < threshold) {
      return { state: { armed: false, secondArmed: true }, alert: "first" };
    }
    return { state, alert: null };
  }

  // 已锁定。先看有没有充值——回升的判定要排在补报前面，否则「充值到刚好
  // 1.2 倍以上」和「继续下跌」这两件事同时成立时会先补报一次假警。
  if (amount >= threshold * REARM_FACTOR) {
    return { state: { armed: true, secondArmed: false }, alert: null };
  }
  if (state.secondArmed && amount < threshold * SECOND_FACTOR) {
    return { state: { armed: false, secondArmed: false }, alert: "second" };
  }
  return { state, alert: null };
}
