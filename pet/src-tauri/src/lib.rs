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

fn default_style() -> String { "classic".into() }
fn default_bubble_ms() -> u32 { 5000 }
fn default_sound() -> bool { true }

#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    #[serde(default = "default_style")]
    bubble_style: String,
    #[serde(default = "default_bubble_ms")]
    bubble_ms: u32,
    #[serde(default = "default_sound")]
    sound: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            bubble_style: default_style(),
            bubble_ms: default_bubble_ms(),
            sound: default_sound(),
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
    let _ = app.emit("settings-changed", &settings);
    Ok(())
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

/// 把桌宠挪回默认位置。解决「被拖到已拔掉的显示器上后找不回来」——
/// 在此之前唯一的办法是手工清 localStorage。
#[tauri::command]
fn reset_position(app: tauri::AppHandle) {
    let _ = app.emit("reset-position", ());
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

static INIT: OnceLock<InitInfo> = OnceLock::new();

#[tauri::command]
fn get_init() -> Result<InitInfo, String> {
    INIT.get().cloned().ok_or_else(|| "init info not ready".to_string())
}

/// 前端上报交互状态：平时给立绘包围盒，拖动中或菜单打开时 `force = true`。
#[tauri::command]
fn set_hit(force: bool, rects: Vec<Rect>) {
    if let Ok(mut guard) = hit_state().lock() {
        *guard = Some(HitState { force, rects });
    }
}

/// 光标是否落在命中区外——是则整窗应当穿透。`None` 表示这一轮无法判断。
fn should_ignore(win: &WebviewWindow) -> Option<bool> {
    let guard = hit_state().lock().ok()?;
    let state = guard.as_ref()?;
    if state.force {
        return Some(false); // 拖动/菜单期间无条件可交互
    }
    let rects = &state.rects;
    let scale = win.scale_factor().ok()?;
    let origin = win.inner_position().ok()?;
    let cursor = win.cursor_position().ok()?;
    // 光标与窗口原点都是物理像素；命中区是逻辑像素，乘 scale 对齐。
    let rx = cursor.x - origin.x as f64;
    let ry = cursor.y - origin.y as f64;
    let pad = HIT_PADDING * scale; // 和其余布局常量一样按逻辑像素定义
    let inside = rects.iter().any(|r| {
        let x = r.x * scale - pad;
        let y = r.y * scale - pad;
        let w = r.w * scale + pad * 2.0;
        let h = r.h * scale + pad * 2.0;
        rx >= x && rx <= x + w && ry >= y && ry <= y + h
    });
    Some(!inside)
}

/// 轮询光标位置，只在状态翻转时才调一次 set_ignore_cursor_events。
/// 窗口关闭后 Tauri 会退出进程，这个后台线程随之消失。
fn spawn_hit_test(win: WebviewWindow) {
    std::thread::spawn(move || {
        let mut current: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(POLL_MS));
            let Some(want) = should_ignore(&win) else { continue };
            if current != Some(want) && win.set_ignore_cursor_events(want).is_ok() {
                current = Some(want);
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

            // 桌宠高度 = 屏幕短边 / 10；窗口 = 本体 + 上方气泡留白区。
            if let Some(win) = app.get_webview_window("pet") {
                if let Ok(Some(monitor)) = win.primary_monitor() {
                    let scale = monitor.scale_factor();
                    let size = monitor.size();
                    let short = size.width.min(size.height) as f64;
                    let sprite_h = (short / 10.0).round().max(1.0);
                    let sprite_w = (sprite_h * SPRITE_W / SPRITE_H).round().max(1.0);
                    let headroom = (HEADROOM * scale).round().max(1.0);
                    let bubble_w = (BUBBLE_MAX_W * scale).round().max(1.0);
                    let win_w = sprite_w.max(bubble_w) as u32;
                    let win_h = (sprite_h + headroom) as u32;
                    let _ = win.set_size(PhysicalSize::new(win_w, win_h));
                    let _ = INIT.set(InitInfo {
                        ws_url: std::env::var("DSH_PET_WS_URL").unwrap_or_default(),
                        version: env!("CARGO_PKG_VERSION").to_string(),
                        debug: std::env::var("DSH_PET_DEBUG").is_ok(),
                        sprite_w: sprite_w / scale,
                        sprite_h: sprite_h / scale,
                        headroom: HEADROOM,
                        bubble_max_w: BUBBLE_MAX_W,
                    });
                }
                spawn_hit_test(win);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_init, set_hit, list_plugins, show_pet,
            get_settings, set_settings, open_settings, reset_position, quit_pet
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
