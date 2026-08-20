# dsh-DeepPet

一个 DeepSeek Harness（DSH）桌宠插件。桌宠是一个无边框、透明、置顶的悬浮窗口：

- **拖动**：按下并左右拖动时播放 8 帧跑步动画，水平方向决定朝向（左=原帧朝左，右=水平镜像朝右；纯垂直拖动按朝左），松手停在原地并记住位置。
- **空闲**：显示 `平常.png`（永远朝左，不镜像）。
- **任务完成**：DSH 一次 agent 运行结束（`agent/status` 的 running→idle）时，摆 `比耶.png` + 气泡「{对话名称}」完成 + 播放 `任务完成.wav`，约 5 秒后回到空闲。
- **双击**：气泡显示当前 DeepSeek API 余额（`余额 ¥X.XX`），失败时显示原因。
- **单击**：无操作。
- **尺寸**：窗口高度 = 屏幕短边（宽高中较小者）的 1/10，宽度按立绘宽高比（3:4）等比缩放；初启位于主屏右下角。

## 目录结构

```
dsh-DeepPet/
├─ plugin/          # Cordis host 插件（deep-pet）
│  ├─ package.json  # dsh.bundle.patch → cordis.patch.yml
│  ├─ cordis.patch.yml
│  └─ lib/index.js  # 事件监听 + WS + 余额代理 + 拉起桌宠进程
├─ pet/             # Tauri v2 透明壳 + 前端
│  ├─ src/          # 前端逻辑（动画/拖动/气泡/双击）
│  ├─ public/       # 构建用素材拷贝（立绘/音效）
│  └─ src-tauri/    # Rust 壳
└─ assets/          # 素材主拷（立绘/音效）
```

## 工作原理

1. 插件加载时启动一个本地 WebSocket 服务（`127.0.0.1`，动态空闲端口）。
2. 插件拉起 Tauri 桌宠进程，通过环境变量 `DSH_PET_WS_URL` 传入 WS 地址。
3. 桌宠前端连上 WS：接收 `task-complete` / `balance` / `balance-error` / `bye` 消息；双击时回发 `balance` 请求。
4. 余额由插件（Node 端）用 `ctx.credentials` 里的 key 调 `GET {balanceBaseUrl}/user/balance`，key 不进入桌宠 webview。
5. DSH 退出/插件销毁时，向桌宠广播 `bye`，桌宠自行关闭。

## 构建桌宠二进制（开发机一次性）

需要：Rust（MSVC 工具链）、pnpm、Node ≥ 18、Windows 需已装 WebView2。

```powershell
cd pet
pnpm install
# 生成应用图标（从任意 PNG，会自动裁方）
pnpm tauri icon ..\assets\立绘\表情\平常.png
pnpm build                # 前端构建
pnpm tauri build --no-bundle   # 编译 release 二进制（不打包安装器）
```

产物：`pet/src-tauri/target/release/dsh-deep-pet.exe`

## 安装插件到 DSH

1. 把 `plugin/` 目录安装进你的 profile，并把 `dsh-DeepPet` 加入 profile `package.json` 的 `dsh.profile.bundles`（例如 `dsh plugin --profile web add <本插件>`，或直接把插件目录链接进 `profiles/<name>/node_modules/dsh-DeepPet`）。
2. 在 profile 的 `cordis.patch.yml` 里加一条 id 覆盖，把 `petBinary` 指向已编译的 exe（其余字段由 schema 默认值补齐）：

```yaml
- id: deep-pet
  config:
    petBinary: 'E:\Programming tools\DSH table pet\dsh-DeepPet\pet\src-tauri\target\release\dsh-deep-pet.exe'
```

3. 重启 DSH（`dsh --profile web`）。DSH 加载插件时会自动拉起桌宠窗口。

（正式分发时 `petBinary` 留空，配 `petDownloadUrl` 指向 CI 产出的预编译二进制，插件会下载到 `$DSH_HOME/cache/deep-pet/` 再拉起。）

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否启用 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 余额查询用的 key 环境变量名 |
| `balanceBaseUrl` | `https://api.deepseek.com` | 余额接口 base URL |
| `petBinary` | `""` | 桌宠二进制路径（本地开发用） |
| `petDownloadUrl` | `""` | 桌宠二进制下载地址（分发用） |
| `bubbleMs` | `5000` | 任务完成气泡/表情持续时间（毫秒） |

## 素材说明

- `assets/立绘/跑步/跑步_01~08.png`：8 帧跑步动画（朝左），384×512 RGBA。
- `assets/立绘/表情/*.png`：23 张表情立绘，384×512 RGBA（v1 只用 `平常.png`、`比耶.png`）。
- `assets/立绘/表情.png`、`表情2.png`、`表情3.png`、`跑步.png`：1536×1024 总览大图（参考用，非运行时素材）。
- `assets/音效/任务完成.wav`：任务完成音效。
