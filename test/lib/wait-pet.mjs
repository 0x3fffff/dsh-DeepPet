// 等桌宠连上来，并把「连不上」的常见原因说清楚。
//
// 起因：本机已经有一只桌宠在跑（比如 DSH 正开着）时，测试拉起的那只会因为
// 抢不到单例锁而**立刻自杀**——于是测试要么挂到超时，要么报一句含糊的
// 「桌宠未连上」。两次排查都在这上面浪费了时间，而真正的原因一句话就能说清。
//
// 单例本身是对的（多 profile 只该有一只桌宠），所以这里不去动它，只是把
// 「已经有一只在跑」这个事实检测出来、当作 SKIP 报告。
import { execFileSync } from "node:child_process";

/**
 * 本机是不是已经有一只桌宠占着单例锁。
 *
 * 判据是**桌宠进程在不在**，不是会合目录里有没有插件登记——后者说明的是
 * 「DSH 在跑」，那时桌宠可能已经自我了断了，两回事。锁文件也不能直接看：
 * 它常驻磁盘，存在与否说明不了死活（这正是当初选文件锁而不是 pid 文件的理由）。
 */
export function petAlreadyRunning() {
  if (process.platform !== "win32") return false;
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq dsh-deep-pet.exe", "/NH"], {
      encoding: "latin1",
      windowsHide: true,
    });
    return /dsh-deep-pet\.exe/i.test(out);
  } catch {
    return false; // 查不出来就别拦着，waitForPet 那层还有兜底
  }
}

/**
 * 竞速：连上 / 子进程提前退出 / 超时。
 *
 * 子进程提前退出几乎总是单例锁——桌宠抢不到就 `exit(0)`，没有任何输出。
 * 单独把这条拎出来报，比等 15 秒再说「没连上」有用得多。
 */
export function waitForPet(pet, connected, ms = 15000) {
  const died = new Promise((_, reject) => {
    pet.once("exit", (code) => {
      reject(new Error(
        `桌宠进程启动后立刻退出（code=${code}）。`
        + "几乎总是因为本机已经有一只桌宠在跑，抢不到单例锁——"
        + "关掉 DSH（或那只桌宠）再跑。",
      ));
    });
  });
  const late = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`桌宠 ${ms}ms 内没连上来`)), ms).unref?.();
  });
  return Promise.race([connected, died, late]);
}

/** 在测试开头调用：已有桌宠在跑就直接 SKIP，别留下一个看不懂的失败。 */
export function skipIfPetRunning() {
  if (petAlreadyRunning()) {
    console.log("SKIP: 本机已有桌宠在运行（单例锁被占），关掉 DSH 后再跑");
    process.exit(0);
  }
}
