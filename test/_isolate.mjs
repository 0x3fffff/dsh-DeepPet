// 测试隔离：把会合目录指到一个一次性临时目录。
//
// 插件在**模块加载时**读 `process.env.LOCALAPPDATA` 拼出
// `%LOCALAPPDATA%\com.dsh.deeppet\plugins`，并把本次 WS 端口登记进去。
// 不隔离的话，用户机器上**正在运行的真机桌宠**会轮询到这个登记、连上测试
// 起的 WS 服务器，把自己的 hello 发进来——handshake 的三个用例于是全部
// 收到同一个真机版本号，判定全乱（本地 `npm test` 会假失败；CI 没有桌宠
// 在跑，所以一直没暴露）。
//
// 必须在 `../plugin/lib/index.js` **之前** import：ESM 按声明顺序求值。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LOCALAPPDATA = mkdtempSync(join(tmpdir(), "dsh-pet-test-"));
