# dsh-deep-pet

一个 DeepSeek Harness（DSH）桌宠插件。桌宠是一个无边框、透明、置顶的悬浮窗口：

- **拖动**：按下并左右拖动时播放 8 帧跑步动画，水平方向决定朝向（左=原帧朝左，右=水平镜像朝右；纯垂直拖动按朝左），松手停在原地并记住位置。
- **空闲**：显示 `平常.webp`（永远朝左，不镜像）。
- **任务完成**：DSH 一次**顶层** agent 运行结束时，播一段 78 帧的完成动画 + 气泡「{对话名称}」完成 + 播放 `任务完成.mp3`，随后回到空闲。会话还没生成标题时气泡退化成「任务完成」。
- **任务出错**：该轮运行期间出过 `agent/error` 时，中断完成动画、改摆 `晕.webp` + 气泡「{对话名称}」出错了，**不播音效**（只有一个「任务完成」音效，失败时放它是错的）。
- **双击**：气泡显示当前 DeepSeek API 余额（`余额 ¥X.XX`），失败时显示原因。
- **右键**：弹出菜单，「设置」打开独立的设置窗口（气泡样式 / 气泡时长 / 音效 / 重置位置 / 退出桌宠）。
- **单击**：无操作。
- **断连**：与 DSH 断开时空闲态换成 `寻找.webp` 并每 1.5 秒重连一次；DSH 重启能在 30 秒内回来就继续陪你，超过 30 秒则自行关窗（见下）。
- **穿透**：只有立绘本身吃鼠标事件，窗口其余部分（气泡留白区）的点击直接穿到背后的窗口（见下）。
- **尺寸**：窗口高度 = 屏幕短边（宽高中较小者）的 1/10，宽度按立绘宽高比（3:4）等比缩放；初启位于主屏右下角。

## 目录结构

```
dsh-DeepPet/
├─ plugin/                 # npm 包 dsh-deep-pet —— Cordis host 插件
│  ├─ package.json         # dsh.bundle.patch → cordis.patch.yml
│  ├─ cordis.patch.yml
│  └─ lib/index.js         # 事件监听 + WS + 余额代理 + 拉起桌宠进程
├─ packages/               # 各平台桌宠二进制的发布包
│  └─ win32-x64/           # npm 包 dsh-deep-pet-win32-x64
├─ pet/                    # Tauri v2 透明壳 + 前端（编译出二进制）
│  ├─ index.html           # 桌宠窗口
│  ├─ settings.html        # 设置窗口（第二个 Vite 入口）
│  ├─ src/                 # 前端逻辑（动画/拖动/气泡/双击/右键菜单/设置）
│  ├─ public/              # 【产物】由 build-assets.mjs 装配，已 gitignore
│  └─ src-tauri/           # Rust 壳
├─ scripts/                # 素材流水线、二进制入包、版本一致性检查
├─ test/                   # 冒烟与回归测试
└─ assets/                 # 素材唯一真源（立绘/音效/完成动画帧/参考图）
```

## 工作原理

1. 插件加载时启动一个本地 WebSocket 服务（`127.0.0.1`，动态空闲端口）。
2. 插件解析出当前平台的桌宠二进制并拉起进程，通过环境变量 `DSH_PET_WS_URL` 传入 WS 地址。
3. 桌宠连上后先发 `hello`（带自身版本）做协议对齐；随后接收 `task-complete` / `balance` / `balance-error` / `bye`，双击时回发 `balance` 请求。
4. 余额由插件（Node 端）用 `ctx.credentials` 里的 key 调 `GET {balanceBaseUrl}/user/balance`，key 不进入桌宠 webview。
5. DSH 退出/插件销毁时，插件注销自己的登记并广播 `bye`。

### 一只桌宠，多个 DSH profile

多开 profile 时每个插件都会拉起桌宠，而它们共用 `%LOCALAPPDATA%\com.dsh.deeppet`
下的 WebView2 数据目录、也就共用 localStorage，于是**落在像素级相同的位置上**
（实测两只都在 `1424,99`）——屏幕上看着只有一只，实际叠着两只，拖走上面那只
才会露出下面的。

做法是会合目录 `%LOCALAPPDATA%\com.dsh.deeppet\`：

- **单例**：桌宠启动时以「不共享」模式独占打开 `pet.lock` 并把句柄留住。第二个
  桌宠进程打不开这个文件，于是在显示窗口**之前**安静退出（窗口配置成初始隐藏，
  所以看不到闪烁）。用文件锁而不是 pid 文件，是因为前者在进程被强杀时由操作
  系统自动释放，不会留下需要判活的陈旧记录。
- **登记**：每个插件把自己的端口写进 `plugins/<pid>.json`，启动时顺手清掉 pid
  已死的陈旧登记。桌宠轮询这个目录，**主动连出去**连上每一个插件。
- **方向**为什么是「桌宠当客户端」：webview 里的 `WebSocket` 只能连不能听，
  让桌宠当服务端就得在 Rust 里再塞一个 WS 服务器加一层桥接；连出去则两侧现有
  代码几乎不动。
- **`bye` 的含义变了**：它表示「这个插件要走了」，不再表示「关闭桌宠」。关窗
  的判定改成——**登记目录空了 = 干净退出 = 立刻关窗**（实测 1.5 秒），
  **目录非空却连不上 = 崩溃 = 走 30 秒预算**。
- **插件不再 kill 桌宠进程**：先退出的那个 profile 会把别人还在用的桌宠杀掉。

`node test/rendezvous.mjs` 用真实二进制验证这三条：单例、一只桌宠连两个插件、
登记清空后立刻关窗。

### 怎么分辨任务是成了还是砸了

`AgentStatus` 只有 `idle` 和 `running` 两个值，所以 running→idle 这条边**在原理上
就分不出**「正常完成」「报错」「用户取消」——单看它，Ctrl+C 打断也会让桌宠比耶。

判别器是另一个事件：插件按 agent id 记录本轮有没有收到过 `agent/error`，
在 running→idle 时据此发 `outcome: "success" | "error"`。`running` 到来时清掉
上一轮的标记，`agent/disposed` 时连同 `prevStatus` 一起删除（否则这两个容器
会随会话数无界增长）。

### 只庆祝顶层 agent

`ctx.agents` 上有 `list()`（所有存活 agent）和 `roots()`（顶层 agent——
"created without an owning agent context"）。**子 agent 同样会发 `agent/status`**，
所以一个任务内部派三个子 agent，原来会庆祝四次、放四遍音效。现在在 running→idle
时用 `roots()` 判定归属，只有顶层才播报。取不到 `agents` 服务时宁可多报也不漏报。

### 并发完成：合并而不是排队

排队会让桌宠播报几十秒前的状态，而桌宠的价值恰恰是「一眼看过去知道现在怎么样」。
所以同一轮爆发内的完成会合并：多个成功折叠成「「X」等 N 个任务完成」，**出错
优先占据气泡**（那才是你需要立刻看到的，另有几个成功会附在后面），音效每轮
最多响一次。

顺带修掉一个时序 bug：原来每次完成都排一个「回空闲」定时器，两次完成相隔 1 秒
时，旧的那个会在新气泡还挂着的时候触发，**立绘提前变回平常而文字还在**。现在
用自增的播报代次号，只有最新一次排的定时器生效。

**一处尚未验证的假设**：用户主动取消（Ctrl+C）时 DSH 到底发不发 `agent/error`。
`Agent.cancel()` 的类型定义里没有提对应事件——若它其实什么都不发，取消仍会被
当成成功。代码里在判别处标注了这个假设。确认方法：把 `logEvents` 打开跑一次
DSH，按 Ctrl+C 打断一个任务，看日志里 running→idle 之间有没有 `agent/error`。

### 我们依赖的 DSH 契约，谁来盯

插件监听 DSH 的事件、调用 `ctx.sessionTitle`，而这些定义**不在本仓库里**。
`test/plugin-smoke.mjs` 的 mock 是照着代码的期望造的，只能证明代码自洽——
DSH 那边改了形状，它照样全绿。

所以 `@deepseek-ai/dsh-agent` 和 `@deepseek-ai/dsh-session-title` 既进了
`peerDependencies`（声明真实依赖），也进了本仓库的 `devDependencies`，
由 `test/contract.mjs` 读它们的 `.d.ts`，把我们实际依赖的那几条断言死：
`AgentStatus` 的取值、三个事件的载荷形状、`Agent.id` 的身份、
`sessionTitle.get` 可能返回 `undefined`。契约一变，测试就红。

注意这些包的 npm `latest` 标签是**陈旧的**（指向 `0.0.1-rc.1`，而实际已到
`0.1.1-rc.2`），且 npm 的 prerelease 语义要求版本范围与目标版本
`[major,minor,patch]` 同元组才匹配——所以 peer 范围必须写成
`^0.1.0-rc.6 || ^0.1.1-rc.1` 这种逐条列举的形式，`^0.1.0-rc.6` 是匹配不到
`0.1.1-rc.2` 的。

### 桌宠不会变成孤儿

上面第 5 步只覆盖「DSH 正常退出」。DSH 崩溃或被强杀时插件的 cleanup 压根不会
执行，没人来杀桌宠——而一个置顶、无边框、又 `skipTaskbar` 的窗口一旦赖在桌面
上，用户连去哪找它都不知道。

所以"该死"的责任在桌宠自己，不依赖父进程做任何配合：断连后每
`RECONNECT_INTERVAL_MS`（1.5 秒）重连一次，累计断连超过 `RECONNECT_BUDGET_MS`
（30 秒）就 `appWindow.close()`。预算取 30 秒是为了让 DSH 正常重启（改配置、
HMR）期间桌宠能活下来——重连成功即清零。从未连上过的情况从进程启动时刻起算。

`node test/orphan.mjs` 用真实二进制验证这两条：短暂断连必须存活并重连，长断连
必须自我了断。

### 鼠标穿透

窗口尺寸是 `max(立绘宽, 气泡最大宽) × (立绘高 + 留白高)`——**宽度由气泡决定，
不由桌宠决定**，所以立绘只占窗口一小块。以 2560×1440 @150% 为例，窗口 270×369
物理像素而立绘只有 108×144，**84% 的面积是全透明却照样吃点击的死区**。一个置顶
窗口带着这么大一块看不见的死区，桌宠飘到哪就挡住哪。

做法：默认整窗 `set_ignore_cursor_events(true)`，Rust 侧每 30ms 轮询全局光标
位置，落进命中区才切回可交互。命中区由前端用 `set_hit` 上报——平时是立绘的
布局盒，**拖动中和右键菜单打开时置 `force`**（穿透一开 webview 就收不到任何
鼠标事件，快速拖动会中断；菜单则需要窗口内任意一点都能点掉它）。

只加 CSS `pointer-events: none` 是不够的：那只让页面不响应，点击照样被这个窗口
吞掉，背后的窗口依然收不到。

拖动期间用的是 `force`（无条件可交互）而**不是「整窗矩形」**——这个区别很要命：
命中判定用的是光标**相对窗口**的坐标，而拖动时窗口是追着光标跑的，追不上时
光标就在窗口外面。若还按矩形判定，就会在拖动半途打开穿透，webview 当场失去
鼠标，拖动中断且再也收不到 `pointerup`，跑动动画卡死在那里。

### 快速拖动为什么会把桌宠卡在跑动状态

拖得快时窗口跟不上光标，光标跑出窗口，于是 `pointerup` 落到了别的窗口上——
`img` 的 `pointerup` / `lostpointercapture` 一个都不触发，`window.blur` 也不会
（这个窗口 `skipTaskbar` + 无边框，压根没拿到过焦点），`dragging` 就永远是
`true`。慢慢拖时光标始终在立绘上，所以没事。

四处一起治：

- **抢指针捕获提前到 `await` 之前**。原来它排在 `await appWindow.outerPosition()`
  之后，而那是一次到 Rust 的 IPC 往返——快速拖动时光标在这几毫秒里就能跑出
  立绘范围，等 `await` 回来再抢已经晚了。
- **位置更新合帧**。`pointermove` 在高回报率鼠标上能到几百 Hz，而每次
  `setPosition` 都是一次 IPC 往返；不合帧就会堆出一串过期指令，窗口越追越落后
  ——这正是光标跑出窗口的根源。现在每个动画帧只发最新的一次。
- **`pointerup` / `pointercancel` 同时挂到 `window` 上**，捕获万一没抢到，落在
  窗口内任意位置的抬起仍能收尾。
- **`pointermove` 里看到 `e.buttons === 0` 就收尾**——最后一道兜底：即使那次
  `pointerup` 彻底丢了，光标一回到立绘上就能把卡住的状态收回来。

另外抓取偏移在算出来之前不允许移动窗口（`grabReady`），否则第一帧会拿上一次
拖动残留的偏移把窗口甩出去。

#### 那个左上角 0,0 的 22×22 窗口不用管

枚举桌宠进程的窗口会看到第二个「可见」的顶层窗口：类名 **Tao Thread Event
Target**，位于屏幕 `0,0`，22×22 物理像素。它是 Tao（Tauri 底层的窗口库）用来
收线程级消息的内部窗口，不是 UI。已实测确认无害：

- **不画任何东西**：屏幕左上角 48×48 区域在桌宠运行前 / 运行中 / 退出后三次
  抓取的哈希完全一致（前后两次静态抓取相同，说明该区域本身稳定，对比才成立）。
  它是 LAYERED 窗口但从未被 `SetLayeredWindowAttributes` / `UpdateLayeredWindow`
  定义过内容，而未定义内容的分层窗口不显示。
- **不吃点击**：它带 `WS_EX_TRANSPARENT`；在它矩形内取三个点做
  `WindowFromPoint`，返回的都是别的进程的窗口。
- **不进任务栏和 Alt+Tab**：带 `WS_EX_TOOLWINDOW`。

会引起注意只是因为 `IsWindowVisible` 对它返回 true——那个 API 只反映
`WS_VISIBLE` 样式位，**和「屏幕上有没有画出东西」无关**。仓库里按窗口取样的
脚本都取面积最大的那个，所以不会误选到它。

`node test/clickthrough.mjs` 用 Win32 `WindowFromPoint` 在操作系统层面验证，并
回读 `WS_EX_TRANSPARENT` 位以区分「开关没翻」和「探测点不对」。注意分层窗口会按
**逐像素 alpha** 命中测试，所以立绘包围盒内的全透明像素本来就会穿透——探测点要
打在立绘中心，不能打在边缘。

### 素材流水线

素材有两条硬约束：`frontendDist` 会把整个 dist **嵌进 exe**，所以进 `pet/public`
的每个字节都会变成二进制字节、再变成每个用户要下的 npm 包字节；而立绘实际只
显示约 **108×144 物理像素**。改造前 `assets/` 和 `pet/public/` 是两份**字节级
相同**的手工拷贝（各 18.7 MB，都在 git 里），其中 9.6 MB 是 README 自己标注为
「参考用、非运行时素材」的 1536×1024 总览大图——它们一直在随包分发。

现在 `assets/` 是唯一真源，`pet/public/` 由 `scripts/build-assets.mjs` 按一份
**显式清单**装配，并已 gitignore。清单里没有那几张总览图，所以它们从结构上
不可能再进二进制；双份不同步这类 bug 也一并消失，因为第二份不再由人维护。

同时立绘转成 WebP（q95）——PNG 对平涂动漫图效率很低：

| | 改造前 | 改造后 |
|---|---|---|
| 运行时素材 | 18.7 MB | **3.7 MB** |
| exe | 27.7 MB | **11 MB** |
| npm 包 | 21.7 MB | **6 MB** |

q95 是看过 3 倍放大对比后选的：q95/q90/q80 在实际显示尺寸下都看不出差别，
q95 相对 q90 只多约 350 KB，留作将来「桌宠尺寸」设置的余量。动画帧用 q80——
运动中的 78 张，压缩痕迹不可见。

`node scripts/build-assets.mjs` 已挂在 `pnpm build` / `pnpm dev` 前面，正常开发
不用手动跑。

### 完成动画

母版是 576×736、30fps、5.17 秒的 **qtrle（`argb`）** `.mov`，95 MB，**不进 git**，
留在仓库外。`scripts/build-animation.mjs` 从它生成 78 帧 WebP（288×384 @15fps
q80，约 1.6 MB）到 `assets/立绘/完成任务/`，**这些帧提交进 git**——于是 CI 和
新克隆都不需要母版，母版换了重跑一次脚本即可。

几个不显然的决定：

- **`.mov` 不能当运行时素材**。WebView2 不解码 qtrle，容器也不支持。同一份
  母版另外导出的 h264 和 hevc 版本 `pix_fmt` 都是 `yuv420p`——**没有 alpha**
  （H.264/HEVC 本身不携带透明度；HEVC-with-alpha 是苹果生态专有的）。它们的
  背景被压平成纯黑，而角色最暗处（鞋子）亮度只有 8/255，和背景差 8 级——
  在有损 4:2:0 编码里没有任何安全的抠黑阈值。只有 qtrle 那版能用。
- **为什么是帧序列而不是 WebM**。WebM VP9-alpha 只要 533 KB，比帧序列小 1.1 MB。
  但 Windows 上 Chromium 会把视频提升到 DirectComposition 覆盖平面、**绕过页面
  合成**，而桌宠窗口恰好是透明 + 置顶 + 大部分穿透——这是最容易让视频变成不透明
  黑块的配置。这条风险**未经验证**，选帧序列是为了不去赌它；而同一次改动里
  省下的 9.6 MB 让那 1.1 MB 不值得冒险。帧序列还能直接复用现有的
  `RUN_FRAMES` 机制。
- **为什么压成 3:4**。母版 576×736（0.7826）比立绘 384×512（0.75）宽 4.3%。
  实测第 0 帧的内容框与 `平常.png` 在归一化坐标下几乎重合（占宽 0.951 vs 0.956，
  占高 0.932 vs 0.936，中心 x 0.501 vs 0.500），说明角色本身也宽了这 4.3%。
  压成 3:4 既让动画与立绘对齐不跳变，也让动画能**复用同一个 `<img>` 和同一套
  尺寸计算**，不需要任何新的元素或布局代码。
- **`bubbleMs` 说了算，但不砍动画**。预算短于原生时长（5.2 秒）时按比例加速，
  让动画完整播完；长于时按原速播完并**定格在最后一帧**（双手合十，本来就是
  个完整姿势）。硬切会把一次性动画停在中间姿势再跳回平常，那看起来就是坏了。
- **合并时不重播**。后续完成并入同一轮爆发只更新气泡文字；播到一半重头来会
  明显卡顿。只有「出错抢占成功」才中断动画。

### 气泡样式

5 种手工精调的样式：**经典**（白底圆角）、**暗色**（深色半透明）、**玻璃**
（半透明 + 斜向高光）、**便签**（暖色纸感、方角、微倾）、**像素**（硬边、粗描边、
阶梯状尖角）。用固定样式类而非参数化主题——玻璃要高光和渐变、像素要硬边和
阶梯尖角、便签要纸感和微倾，这些差异在同一组参数里表达不出来。

外观规则单独放在 `src/bubble.css`，定位规则留在 `styles.css` 的 `#bubble` 上。
拆开是为了让**设置窗口用同一份 CSS 渲染样式预览**——预览和真实气泡必须是同一套
规则，否则「所见」和「所得」会慢慢分家。

两个容易踩的点：

- **真正的毛玻璃做不到。** `backdrop-filter` 只能模糊页面内它下面的东西，而桌宠
  窗口是透明的、气泡下面什么都没有——桌面像素属于操作系统合成层，渲染进程拿不到。
  OS 级的 acrylic/mica 又只能作用于**整个窗口**，会把立绘周围那一大片留白也变成
  磨砂玻璃板。所以「玻璃」是半透明底色 + 高光 + 亮描边仿出来的。
- **小尖角必须跟着底色走。** 它是 `::after` 画的，写死白色的话换成暗色样式就会
  露出一个白尖角。现在跟 `--bg` / `--border` 走；像素样式则用 `clip-path` 切出
  阶梯状尖角，因为旋转 45° 的菱形在硬边风格里会露出斜边。

### 设置面板

独立窗口，不是桌宠窗口内的浮层——桌宠窗口的每一条属性（透明、置顶、无边框、
大部分穿透、尺寸绑定立绘）对设置面板都是负担，硬塞进去等于让它继承一整套不需要
的约束再逐条对抗；而且窗口只有 180×246 逻辑像素，面板宽度会被立绘尺寸绑架。

设置存 `%LOCALAPPDATA%\com.dsh.deeppet\settings.json`，由 Rust 读写。**归属是
关键**：一只桌宠服务 N 个插件，设置存进某个 profile 的 cordis 配置就说不清谁
说了算。所以 `bubbleMs` 也从插件配置搬到了这里；`label` 留在插件侧，因为它本来
就是每 profile 一份。设置文件读坏了一律回默认值——它不该让桌宠起不来。

设置窗口和桌宠窗口是两个 webview，靠 Rust 转发的 `settings-changed` 事件同步，
改了立刻生效。

**`open_settings` 必须是 `async`。** 同步命令跑在工作线程上，而 Windows 下
WebView2 的初始化要走主线程事件循环——同步创建的结果是窗口框架建出来了、webview
永远初始化不了，表现为一个纯白空窗口，而且后续 `win.url()` 会直接把调用方卡死
（既不 resolve 也不 reject）。这是 Tauri 在 Windows 上的已知陷阱，改成 `async`
即可。

### 桌宠二进制怎么来的

二进制**不**在运行时下载，而是随插件一起由 npm 解析：插件把各平台二进制声明为
`optionalDependencies`（如 `dsh-deep-pet-win32-x64`），包内的 `os` / `cpu` 字段让
npm/pnpm 只安装匹配当前平台的那一个，版本对插件是**精确 pin**。

这样一来插件与二进制永远同版本，完整性由 npm 自己的 integrity hash 保证，
既不存在缓存陈旧，也不需要额外的校验逻辑。运行时若因为某种原因版本仍然对不上
（例如手工指定了 `petBinary`），`hello` 握手会在 DSH 日志里给出警告。

## 安装

```bash
dsh plugin --profile web add dsh-deep-pet
```

安装时**不要**跳过 optional 依赖（`--no-optional` / `--omit=optional` 会让桌宠
二进制装不上，插件启动时会在日志里明说）。装好后重启 DSH（`dsh --profile web`），
加载插件时会自动拉起桌宠窗口。

当前只提供 **Windows x64** 二进制。其他平台需自行编译，再用 `petBinary` 指过去。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否启用 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 余额查询用的 key 环境变量名 |
| `balanceBaseUrl` | `https://api.deepseek.com` | 余额接口 base URL |
| `petBinary` | `""` | 桌宠二进制路径；留空则从 optionalDependencies 解析。仅本地开发或自行编译时才需要设置 |
| `bubbleMs` | `5000` | 任务完成气泡/表情持续时间（毫秒） |
| `label` | `""` | 本 profile 的标识，非空时气泡前缀 `[label]`。一只桌宠服务多个 profile 时用来区分来源；DSH 没有暴露 CLI profile 名，无法自动检测，所以要手填 |

气泡时长、气泡样式、音效开关**不在这里**——它们是桌宠的显示行为，归桌宠自己的
设置面板管（见上「设置面板」）。
| `logEvents` | `false` | 把收到的每个 `agent/status` / `agent/error` / `agent/disposed` 打进 DSH 日志，用于排查成败判别（见下） |

## 本地开发

需要：Rust（MSVC 工具链）、pnpm、Node ≥ 18、Windows 需已装 WebView2。

```powershell
cd pet
pnpm install
pnpm tauri icon ..\assets\立绘\表情\平常.png   # 生成应用图标（一次性）
pnpm tauri build --no-bundle                   # 编译 release 二进制
cd ..
node scripts/stage-binary.mjs                  # 把二进制放进当前平台的发布包
```

跑测试：

```bash
npm test                   # 版本一致性 + DSH 契约 + 插件冒烟 + 握手回归（秒级）
npm run test:integration   # 真的拉起 exe，验证连上并完成握手（约 7 秒）
npm run test:clickthrough  # 鼠标穿透 + 拖动 force 路径（会短暂移动鼠标指针，测完复位）
npm run test:rendezvous    # 单例 / 一只桌宠连多个插件 / 干净退出（约 40 秒）
npm run test:orphan        # 断连兜底：短暂断连存活 / 长断连自尽（约 50 秒）
```

在 profile 的 `cordis.patch.yml` 里可以用 id 覆盖指向自编译的二进制：

```yaml
- id: deep-pet
  config:
    petBinary: 'E:\path\to\dsh-DeepPet\pet\src-tauri\target\release\dsh-deep-pet.exe'
```

## 发版

打一个 `v<版本>` 的 tag 即可，`.github/workflows/release.yml` 会编译各平台二进制、
校验版本一致性、先发平台包再发插件包（顺序不能反：插件对平台包是精确 pin）。

改版本号时下面这些地方必须一起改，`node scripts/check-versions.mjs` 会把关：
`plugin/package.json`（含 optionalDependencies 的 pin）、`packages/*/package.json`、
`pet/package.json`、`pet/src-tauri/tauri.conf.json`、`pet/src-tauri/Cargo.toml`。

## 素材说明

- `assets/立绘/跑步/跑步_01~08.png`：8 帧跑步动画（朝左），384×512 RGBA。
- `assets/立绘/表情/*.png`：23 张表情立绘，384×512 RGBA（v1 用 `平常` 空闲、`晕` 出错、`寻找` 断连；完成改用动画）。
- `assets/立绘/完成任务/f_001~078.webp`：完成动画帧，由 `build-animation.mjs` 从仓库外的 qtrle 母版生成。
- `assets/立绘/表情.png`、`表情2.png`、`表情3.png`、`跑步.png`：1536×1024 总览大图。**参考用，不在运行时清单里**，不会进二进制。
- `assets/音效/任务完成.mp3`：任务完成音效（2.4 秒）。`任务完成.wav`（1.5 秒）是上一版，保留但不再随包分发。

以上都是**作者态**素材。运行时用的是 `pet/public/` 里由 `build-assets.mjs`
装配出的 WebP 版本，不要手工编辑那个目录。
