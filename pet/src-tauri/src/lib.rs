use std::fs::{self, File, OpenOptions};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, PhysicalSize, WebviewWindow};

/// 会合目录里插件各自登记端口的子目录，以及单例锁文件名。
const PLUGIN_DIR: &str = "plugins";
const LOCK_FILE: &str = "pet.lock";

/// 单例锁的文件句柄。必须一直活着——句柄一关锁就没了。进程崩溃时
/// 由操作系统释放，所以不需要判断 pid 是否存活那一套。
static LOCK: OnceLock<File> = OnceLock::new();

/// 会合目录（`%LOCALAPPDATA%\com.dsh.deeppet`），插件侧按同样规则拼。
static HOME: OnceLock<PathBuf> = OnceLock::new();

/// 一个已登记的插件。
#[derive(Serialize)]
struct PluginEntry {
    pid: u32,
    url: String,
    label: String,
}

/**
 * 抢占单例：以「不共享」模式独占打开锁文件并把句柄留在静态量里。
 * 第二个桌宠进程打不开这个文件，于是安静退出。用文件锁而不是 pid 文件，
 * 是因为前者在进程被强杀时由操作系统自动释放，不会留下需要判活的陈旧记录。
 */
fn claim_singleton(dir: &Path) -> bool {
    match OpenOptions::new()
        .write(true)
        .create(true)
        .share_mode(0)
        .open(dir.join(LOCK_FILE))
    {
        Ok(f) => LOCK.set(f).is_ok(),
        Err(_) => false,
    }
}

/// 读插件登记目录。连不上的陈旧条目由前端的重连退避消化。
#[tauri::command]
fn list_plugins() -> Vec<PluginEntry> {
    let Some(home) = HOME.get() else { return Vec::new() };
    let Ok(entries) = fs::read_dir(home.join(PLUGIN_DIR)) else { return Vec::new() };
    let mut out = Vec::new();
    for e in entries.flatten() {
        if e.path().extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(e.path()) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let (Some(pid), Some(port)) = (v.get("pid").and_then(|x| x.as_u64()), v.get("port").and_then(|x| x.as_u64()))
        else { continue };
        out.push(PluginEntry {
            pid: pid as u32,
            url: format!("ws://127.0.0.1:{port}"),
            label: v.get("label").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        });
    }
    out
}

/// 前端在恢复完位置后才叫桌宠现身，避免窗口先在默认位置闪一下再跳走。
#[tauri::command]
fn show_pet(win: WebviewWindow) {
    let _ = win.show();
}

// ---- 设置 ----
// 设置属于「桌宠」这个机器级单例，不属于任何一个 DSH profile——一只桌宠
// 服务 N 个插件，存进某个插件的 cordis 配置就说不清谁说了算。所以落在会合
// 目录里的 settings.json，由 Rust 读写：和 pet.lock / plugins/ 同一个家，
// 用户能直接查看编辑，也不会被清 WebView2 数据顺手抹掉。

const SETTINGS_FILE: &str = "settings.json";
/// 用户自定义台词；存在就整体替换内置的那份。
const LINES_FILE: &str = "lines.json";

fn default_style() -> String { "classic".into() }
fn default_bubble_ms() -> u32 { 5000 }
fn default_sound() -> bool { true }
fn default_scale() -> f64 { 1.0 }
fn default_lines() -> bool { true }

#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    #[serde(default = "default_style")]
    bubble_style: String,
    #[serde(default = "default_bubble_ms")]
    bubble_ms: u32,
    #[serde(default = "default_sound")]
    sound: bool,
    /// 桌宠大小倍率，1.0 = 屏幕短边 / 10。
    #[serde(default = "default_scale")]
    pet_scale: f64,
    /// 气泡大小倍率：字号、内边距、圆角、最大宽度一起乘。
    #[serde(default = "default_scale")]
    bubble_scale: f64,
    /// 台词：关掉就回到纯信息播报（「『标题』完成」）。
    #[serde(default = "default_lines")]
    lines: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            bubble_style: default_style(),
            bubble_ms: default_bubble_ms(),
            sound: default_sound(),
            pet_scale: default_scale(),
            bubble_scale: default_scale(),
            lines: default_lines(),
        }
    }
}

fn settings_path() -> Option<PathBuf> {
    HOME.get().map(|h| h.join(SETTINGS_FILE))
}

/// 读不到或读坏了都回默认值：设置文件损坏不该让桌宠起不来。
#[tauri::command]
fn get_settings() -> Settings {
    let Some(path) = settings_path() else { return Settings::default() };
    let Ok(text) = fs::read_to_string(path) else { return Settings::default() };
    serde_json::from_str(&text).unwrap_or_default()
}

/// 写盘并广播。设置窗口和桌宠窗口是两个 webview，靠这个事件同步。
#[tauri::command]
fn set_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path().ok_or("会合目录未就绪")?;
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())?;
    // 倍率变了就得重算窗口。放在广播之前：前端收到 settings-changed 时
    // 布局应当已经就位。
    if let Some(win) = app.get_webview_window("pet") {
        apply_size(&win, &settings);
    }
    let _ = app.emit("settings-changed", &settings);
    Ok(())
}

/// 用户自定义台词。返回会合目录里 lines.json 的原文，没有就返回 None
/// （前端退回内置的那份）。
///
/// 只回原文、不在这里解析：解析规则归前端一处所有，两边各写一遍迟早分家。
/// 读坏了也当作没有——一份手写坏的台词文件不该让桌宠哑巴。
#[tauri::command]
fn get_lines() -> Option<String> {
    let path = HOME.get()?.join(LINES_FILE);
    fs::read_to_string(path).ok()
}

/// 按需创建设置窗口。桌宠窗口那一整套约束（透明、置顶、无边框、大部分穿透、
/// 尺寸绑定立绘）对设置面板全是负担，所以用独立窗口而不是窗口内浮层。
///
/// **必须是 async**：同步命令跑在工作线程上，而 Windows 下 WebView2 的初始化
/// 要走主线程事件循环——同步创建会让窗口框架建出来但 webview 永远初始化不了，
/// 表现为一个纯白的空窗口。这是 Tauri 在 Windows 上的已知陷阱。
#[tauri::command]
async fn open_settings(app: tauri::AppHandle) -> Result<String, String> {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(win.url().map(|u| u.to_string()).unwrap_or_default());
    }
    let win = tauri::WebviewWindowBuilder::new(&app, "settings", tauri::WebviewUrl::App("settings.html".into()))
        .title("dsh-deep-pet 设置")
        .inner_size(440.0, 560.0)
        .min_inner_size(380.0, 420.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    // 返回实际加载的地址，供调试通道回报——release 下这个值能立刻说明
    // 资源协议解析到哪儿去了。
    Ok(win.url().map(|u| u.to_string()).unwrap_or_default())
}

// ---- 测试面板 ----
// 面板只是一排按钮：它不自己渲染桌宠，而是把指令转发给桌宠窗口，由那只真
// 桌宠执行。只有这样看到的才是真实的透明合成、尺寸、镜像和命中区——面板内
// 嵌预览至多能证明视频文件可解码。

/// 按需创建测试窗口。和 open_settings 一样**必须是 async**：同步命令跑在
/// 工作线程上，而 Windows 下 WebView2 的初始化要走主线程事件循环，同步创建
/// 会得到一个纯白的空窗口。
#[tauri::command]
async fn open_test(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("test") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let win = tauri::WebviewWindowBuilder::new(&app, "test", tauri::WebviewUrl::App("test.html".into()))
        .title("dsh-deep-pet 测试面板")
        .inner_size(460.0, 680.0)
        .min_inner_size(400.0, 460.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    // 面板一关就通知桌宠停投脉络，否则关掉面板后桌宠会一直往一个不存在的
    // 窗口发 IPC。开启由面板自己在加载完成时调 set_trace(true)。
    let handle = app.clone();
    win.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Destroyed) {
            if let Some(pet) = handle.get_webview_window("pet") {
                let _ = pet.emit("trace-enabled", false);
            }
        }
    });
    Ok(())
}

/// 面板 → 桌宠。载荷不透明，桌宠侧自己解释。
#[tauri::command]
fn pet_test(app: tauri::AppHandle, payload: serde_json::Value) {
    if let Some(win) = app.get_webview_window("pet") {
        let _ = win.emit("pet-test", payload);
    }
}

/// 桌宠 → 面板。桌宠只在面板开着时才发（靠 trace-enabled 通知），
/// 所以这里不需要再判一次窗口在不在。
#[tauri::command]
fn pet_trace(app: tauri::AppHandle, entry: serde_json::Value) {
    if let Some(win) = app.get_webview_window("test") {
        let _ = win.emit("pet-trace", entry);
    }
}

/// 面板就绪/关闭时开关桌宠侧的脉络投递。关着的时候一次 IPC 都不发。
#[tauri::command]
fn set_trace(app: tauri::AppHandle, on: bool) {
    if let Some(win) = app.get_webview_window("pet") {
        let _ = win.emit("trace-enabled", on);
    }
}

/// 把桌宠挪回默认位置。解决「被拖到已拔掉的显示器上后找不回来」——
/// 在此之前唯一的办法是手工清 localStorage。
#[tauri::command]
fn reset_position(app: tauri::AppHandle) {
    let _ = app.emit("reset-position", ());
}

// ---- 系统级空闲 ----
// 「长时间无操作」用的是**全系统**最后一次输入到现在的时长，而不是「有没有
// 碰过桌宠」——「打瞌睡 / 玩手机」的潜台词是主人不在。只看桌宠的话，你在
// 旁边写一小时代码它也会睡着。

#[repr(C)]
struct LastInputInfo {
    cb_size: u32,
    dw_time: u32,
}

extern "system" {
    fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
    fn GetTickCount() -> u32;
}

/// 全系统空闲毫秒数。取不到就报 0（当作刚有输入），宁可不睡也不误睡。
#[tauri::command]
fn system_idle_ms() -> u32 {
    unsafe {
        let mut lii = LastInputInfo {
            cb_size: std::mem::size_of::<LastInputInfo>() as u32,
            dw_time: 0,
        };
        if GetLastInputInfo(&mut lii) == 0 {
            return 0;
        }
        // GetTickCount 会在约 49.7 天后回绕，wrapping_sub 正好处理。
        GetTickCount().wrapping_sub(lii.dw_time)
    }
}

/// 退出桌宠。在此之前关掉桌宠的唯一方式是关掉 DSH。
#[tauri::command]
fn quit_pet(app: tauri::AppHandle) {
    app.exit(0);
}

// 布局常量（逻辑像素）。
const SPRITE_W: f64 = 384.0;
const SPRITE_H: f64 = 512.0;
const HEADROOM: f64 = 150.0; // 气泡留白区高度
const BUBBLE_MAX_W: f64 = 180.0; // 气泡最大宽度

/// 动作视频的原生高度（`assets/动作清单.json` 那条流水线的产物尺寸）。
/// 桌宠放到比它还大就是在放大视频，边缘会发虚——所以倍率上限按它封顶。
const ACTION_NATIVE_H: f64 = 384.0;
/// 倍率的硬边界。上限还会被 ACTION_NATIVE_H 进一步压低（4K 屏上约 1.78）。
const MIN_SCALE: f64 = 0.5;
const MAX_SCALE: f64 = 2.0;
const MAX_BUBBLE_SCALE: f64 = 2.0;

/// 一次布局解算的全部结果，物理像素。
struct Layout {
    win_w: u32,
    win_h: u32,
    sprite_w: f64,
    sprite_h: f64,
    scale: f64,
}

/// 100% 时的立绘高度（物理像素）。
fn base_sprite_h(monitor_w: u32, monitor_h: u32) -> f64 {
    (monitor_w.min(monitor_h) as f64 / 10.0).round().max(1.0)
}

/// 桌宠倍率的上限：不超过 2.0，也不让立绘高过动作视频的原生高度。
///
/// 只有 4K 以上的屏会真的被这一条压到 2.0 以下（2160/10 = 216，384/216 ≈ 1.78）。
/// 封顶而不是允许放大，是因为超出之后画面会发虚，而那是个用户看得见、
/// 却不知道为什么的退化。
fn max_pet_scale(monitor_w: u32, monitor_h: u32) -> f64 {
    let base = base_sprite_h(monitor_w, monitor_h);
    (ACTION_NATIVE_H / base).min(MAX_SCALE).max(MIN_SCALE)
}

fn solve_layout(monitor_w: u32, monitor_h: u32, scale: f64, settings: &Settings) -> Layout {
    let pet = settings
        .pet_scale
        .clamp(MIN_SCALE, max_pet_scale(monitor_w, monitor_h));
    let bubble = settings.bubble_scale.clamp(MIN_SCALE, MAX_BUBBLE_SCALE);
    let sprite_h = (base_sprite_h(monitor_w, monitor_h) * pet).round().max(1.0);
    let sprite_w = (sprite_h * SPRITE_W / SPRITE_H).round().max(1.0);
    // 气泡留白区和气泡最大宽度都跟着气泡倍率走——否则调大气泡之后，两行的
    // 气泡会顶出窗口上沿被裁掉。
    let headroom = (HEADROOM * bubble * scale).round().max(1.0);
    let bubble_w = (BUBBLE_MAX_W * bubble * scale).round().max(1.0);
    Layout {
        win_w: sprite_w.max(bubble_w) as u32,
        win_h: (sprite_h + headroom) as u32,
        sprite_w,
        sprite_h,
        scale,
    }
}

/// 只重算窗口尺寸、不写盘。
///
/// 拖滑块时要实时看到效果，但一次拖动会产生几十次 input 事件——每次都写一遍
/// settings.json 又蠢又慢。所以拖动中走这个，松手才走 set_settings 落盘。
#[tauri::command]
fn preview_size(app: tauri::AppHandle, settings: Settings) {
    if let Some(win) = app.get_webview_window("pet") {
        apply_size(&win, &settings);
    }
}

/// 桌宠倍率的可用上限，供设置面板把滑块量程调对。
#[tauri::command]
fn size_limits(app: tauri::AppHandle) -> (f64, f64, f64) {
    let cap = app
        .get_webview_window("pet")
        .and_then(|w| w.primary_monitor().ok().flatten())
        .map(|m| max_pet_scale(m.size().width, m.size().height))
        .unwrap_or(MAX_SCALE);
    (MIN_SCALE, cap, MAX_BUBBLE_SCALE)
}

// 鼠标穿透轮询。窗口大部分面积是全透明的留白区，整窗吃点击的话桌宠飘到
// 哪就挡住哪，所以默认让整窗穿透，只在光标落进命中区时切回可交互。
const POLL_MS: u64 = 30;
// 命中区外扩：穿透开着时 webview 收不到任何鼠标事件，光标快速掠到立绘
// 边缘再立刻点击，可能赶在轮询翻开关之前。外扩几像素缓解这个竞态。
const HIT_PADDING: f64 = 4.0;

/// 前端上报的命中区，逻辑像素、相对窗口客户区。
#[derive(Clone, Copy, Deserialize)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// 前端上报的交互状态。`force` 为真时无条件保持可交互，**不做位置判断**：
/// 拖动期间光标会跑出窗口（窗口追不上光标），若还按位置判定就会半途打开
/// 穿透，webview 当场失去鼠标，拖动中断且再也收不到 pointerup。
struct HitState {
    force: bool,
    rects: Vec<Rect>,
}

/// `None` = 前端还没上报过。此时不碰穿透开关，保持整窗可交互——
/// 宁可挡住点击，也不能让桌宠在前端起不来时变得完全点不动。
static HIT: OnceLock<Mutex<Option<HitState>>> = OnceLock::new();

fn hit_state() -> &'static Mutex<Option<HitState>> {
    HIT.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Serialize)]
struct InitInfo {
    ws_url: String,
    /// 桌宠自身版本，连上后报给插件做协议对齐检查。
    version: String,
    /// 由 DSH_PET_DEBUG 开启，仅供测试驱动内部状态；插件从不设置它。
    debug: bool,
    sprite_w: f64,
    sprite_h: f64,
    headroom: f64,
    bubble_max_w: f64,
}

/// 尺寸不再是启动时一次性定死的（设置里可以调倍率），所以这里是 Mutex
/// 而不是 OnceLock——OnceLock 写不了第二次。
static INIT: OnceLock<Mutex<Option<InitInfo>>> = OnceLock::new();

fn init_slot() -> &'static Mutex<Option<InitInfo>> {
    INIT.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
fn get_init() -> Result<InitInfo, String> {
    init_slot()
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .ok_or_else(|| "init info not ready".to_string())
}

/**
 * 按当前设置重算桌宠窗口尺寸，并把新的布局广播给前端。
 *
 * 缩放时**固定脚底和水平中心**：窗口默认是钉住左上角长大的，那会让桌宠往下
 * 沉——本来站在屏幕底部的话直接沉出屏幕。锚在脚底才读作「她长大了」而不是
 * 「她挪位了」。贴边状态下的重新对齐和越界回收交给前端，那边才知道贴的是哪边。
 */
fn apply_size(win: &WebviewWindow, settings: &Settings) {
    let Ok(Some(monitor)) = win.primary_monitor() else { return };
    let scale = monitor.scale_factor();
    let m = monitor.size();
    let layout = solve_layout(m.width, m.height, scale, settings);

    if let (Ok(pos), Ok(old)) = (win.outer_position(), win.outer_size()) {
        let _ = win.set_size(PhysicalSize::new(layout.win_w, layout.win_h));
        let dx = (old.width as f64 - layout.win_w as f64) / 2.0;
        let dy = old.height as f64 - layout.win_h as f64;
        let _ = win.set_position(tauri::PhysicalPosition::new(
            (pos.x as f64 + dx).round() as i32,
            (pos.y as f64 + dy).round() as i32,
        ));
    } else {
        let _ = win.set_size(PhysicalSize::new(layout.win_w, layout.win_h));
    }

    let info = InitInfo {
        ws_url: std::env::var("DSH_PET_WS_URL").unwrap_or_default(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        debug: std::env::var("DSH_PET_DEBUG").is_ok(),
        sprite_w: layout.sprite_w / layout.scale,
        sprite_h: layout.sprite_h / layout.scale,
        headroom: HEADROOM * settings.bubble_scale,
        bubble_max_w: BUBBLE_MAX_W * settings.bubble_scale,
    };
    if let Ok(mut guard) = init_slot().lock() {
        *guard = Some(info.clone());
    }
    let _ = win.emit("layout-changed", info);
}

/// 前端上报交互状态：平时给立绘包围盒，拖动中或菜单打开时 `force = true`。
#[tauri::command]
fn set_hit(force: bool, rects: Vec<Rect>) {
    if let Ok(mut guard) = hit_state().lock() {
        *guard = Some(HitState { force, rects });
    }
}

// 命中测试轮询用的 Win32 直调。
//
// 原来这里用的是 `win.scale_factor()` / `win.inner_position()` /
// `win.cursor_position()`——它们在 Tauri 里全是 `window_getter!` 宏：**往主
// 事件循环投一条消息，然后阻塞等回复**。轮询是 30ms 一次，于是每秒对主线程
// 发起 100 次阻塞往返，而主线程同时还在给 WebView2 合成带 alpha 的视频。
// 一堵，穿透状态就切不回来——那一瞬点下去落到背后的窗口，感觉就是「要点两下」。
//
// 这几个都是纯 Win32 查询，直接调没有任何跨线程代价。
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct WinPoint {
    x: i32,
    y: i32,
}

#[repr(C)]
#[derive(Default)]
struct WinRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

extern "system" {
    fn GetCursorPos(p: *mut WinPoint) -> i32;
    fn GetClientRect(hwnd: isize, r: *mut WinRect) -> i32;
    fn ClientToScreen(hwnd: isize, p: *mut WinPoint) -> i32;
    fn GetDpiForWindow(hwnd: isize) -> u32;
}

/// 客户区左上角的屏幕坐标（物理像素），等价于 `inner_position()`。
/// 用 GetClientRect + ClientToScreen 而不是 GetWindowRect：后者在有非客户区
/// 时会差一圈，虽然本窗口无边框，但这样写不依赖那个前提。
fn client_origin(hwnd: isize) -> Option<(i32, i32)> {
    unsafe {
        let mut rc = WinRect::default();
        if GetClientRect(hwnd, &mut rc) == 0 {
            return None;
        }
        let mut p = WinPoint { x: rc.left, y: rc.top };
        if ClientToScreen(hwnd, &mut p) == 0 {
            return None;
        }
        Some((p.x, p.y))
    }
}

/// 轮询线程最近一次判定的全部输入与结论，仅供调试通道读取。
/// 「翻转有时不发生」这种问题，光看外部现象分不清是判定错了、还是判定对了
/// 但没生效——把中间量摊开才不用猜。
#[derive(Clone, Default, Serialize)]
struct HitDebug {
    cursor_x: f64,
    cursor_y: f64,
    origin_x: i32,
    origin_y: i32,
    scale: f64,
    rects: usize,
    force: bool,
    inside: bool,
    /// 轮询决定的目标状态；`applied` 是应用线程真正设下去的那个。
    want: bool,
    applied: i32,
    ticks: u64,
}

static HIT_DEBUG: OnceLock<Mutex<HitDebug>> = OnceLock::new();

fn hit_debug() -> &'static Mutex<HitDebug> {
    HIT_DEBUG.get_or_init(|| Mutex::new(HitDebug::default()))
}

#[tauri::command]
fn get_hit_debug() -> HitDebug {
    hit_debug().lock().map(|g| g.clone()).unwrap_or_default()
}

/// 光标是否落在命中区外——是则整窗应当穿透。`None` 表示这一轮无法判断。
fn should_ignore(hwnd: isize) -> Option<bool> {
    // 先把要用的东西拷出来，**立刻放锁**。
    //
    // 原来这里是拿着锁一路算到底，而中间那三个 Tauri getter 会阻塞等主线程
    // 回话——于是「持锁 + 等主线程」和「主线程侧的 set_hit 等锁」凑成一个环，
    // 主线程一停就是好几秒（IsHungAppWindow 实测为 true）。
    // 即便现在改成了纯 Win32 查询、不再等主线程，这个锁也不该跨任何可能阻塞的
    // 调用——这是个结构约束，不是当下能不能跑通的问题。
    let (force, rects) = {
        let guard = hit_state().lock().ok()?;
        let state = guard.as_ref()?;
        (state.force, state.rects.clone())
    };
    if force {
        return Some(false); // 拖动/菜单期间无条件可交互
    }
    let rects = &rects;
    // DPI 每次现查：它只是一次 user32 调用，这样跨屏拖到不同缩放的显示器上
    // 也不用额外做什么。
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
    let origin = client_origin(hwnd)?;
    let mut cursor = WinPoint::default();
    if unsafe { GetCursorPos(&mut cursor) } == 0 {
        return None;
    }
    // 光标与窗口原点都是物理像素；命中区是逻辑像素，乘 scale 对齐。
    let rx = cursor.x as f64 - origin.0 as f64;
    let ry = cursor.y as f64 - origin.1 as f64;
    let pad = HIT_PADDING * scale; // 和其余布局常量一样按逻辑像素定义
    let inside = rects.iter().any(|r| {
        let x = r.x * scale - pad;
        let y = r.y * scale - pad;
        let w = r.w * scale + pad * 2.0;
        let h = r.h * scale + pad * 2.0;
        rx >= x && rx <= x + w && ry >= y && ry <= y + h
    });
    if let Ok(mut d) = hit_debug().lock() {
        d.cursor_x = cursor.x as f64;
        d.cursor_y = cursor.y as f64;
        d.origin_x = origin.0;
        d.origin_y = origin.1;
        d.scale = scale;
        d.rects = rects.len();
        d.force = false;
        d.inside = inside;
        d.want = !inside;
        d.ticks += 1;
    }
    Some(!inside)
}

/// 轮询光标位置，只在状态翻转时才调一次 set_ignore_cursor_events。
/// 窗口关闭后 Tauri 会退出进程，这个后台线程随之消失。
fn spawn_hit_test(win: WebviewWindow) {
    // HWND 只取一次。`hwnd()` 本身也是一次事件循环往返，放进循环就前功尽弃了。
    let Ok(hwnd) = win.hwnd() else { return };
    let hwnd = hwnd.0 as isize;

    // 检测和翻转拆成两个线程。
    //
    // 翻转这一步绕不开属主线程：`set_ignore_cursor_events` 是主线程往返，而
    // 绕过 Tauri 直接 `SetWindowLongPtrW` 也一样——那是别的线程拥有的窗口，
    // 改扩展样式仍要和属主线程同步。实测直接写反而更糟：前 3 次翻转正常，
    // 之后轮询线程就卡死在那一句里，窗口永远停在穿透态（12 轮超时 9 轮）。
    //
    // 既然躲不开，就别让它挡住**检测**。轮询线程只负责判断并把结果丢给通道，
    // 一次都不会阻塞；专职线程去做那次可能很慢的翻转。最坏情况是翻转晚到，
    // 而不是整条链路停摆。
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    std::thread::spawn(move || {
        let mut applied: Option<bool> = None;
        while let Ok(mut want) = rx.recv() {
            // 排空积压，只认最新的那个——阻塞期间攒下的中间状态没有意义。
            while let Ok(newer) = rx.try_recv() {
                want = newer;
            }
            if applied != Some(want) && win.set_ignore_cursor_events(want).is_ok() {
                applied = Some(want);
                if let Ok(mut d) = hit_debug().lock() {
                    d.applied = if want { 1 } else { 0 };
                }
            }
        }
    });

    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(POLL_MS));
        // 这个循环里没有一处会等主线程：三个查询都是纯 Win32，send 不阻塞。
        if let Some(want) = should_ignore(hwnd) {
            if tx.send(want).is_err() {
                return; // 应用线程没了，再判也没意义
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 会合目录：单例锁和插件端口登记都放这儿。
            let home = app.path().app_local_data_dir()?;
            let _ = fs::create_dir_all(home.join(PLUGIN_DIR));
            // 已经有桌宠在跑就安静退出。窗口配置成初始隐藏，所以这里
            // 不会有一闪而过的空窗口。
            if !claim_singleton(&home) {
                std::process::exit(0);
            }
            let _ = HOME.set(home);

            // 桌宠高度 = 屏幕短边 / 10 × 倍率；窗口 = 本体 + 上方气泡留白区。
            if let Some(win) = app.get_webview_window("pet") {
                apply_size(&win, &get_settings());
                spawn_hit_test(win);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_init, set_hit, list_plugins, show_pet,
            get_settings, set_settings, open_settings, reset_position, quit_pet,
            system_idle_ms, open_test, pet_test, pet_trace, set_trace, size_limits, preview_size,
            get_hit_debug, get_lines
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
