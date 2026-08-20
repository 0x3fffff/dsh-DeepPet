use std::sync::OnceLock;

use serde::Serialize;
use tauri::{Manager, PhysicalSize};

// 布局常量（逻辑像素）。
const SPRITE_W: f64 = 384.0;
const SPRITE_H: f64 = 512.0;
const HEADROOM: f64 = 150.0; // 气泡留白区高度
const BUBBLE_MAX_W: f64 = 180.0; // 气泡最大宽度

#[derive(Clone, Serialize)]
struct InitInfo {
    ws_url: String,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
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
                        sprite_w: sprite_w / scale,
                        sprite_h: sprite_h / scale,
                        headroom: HEADROOM,
                        bubble_max_w: BUBBLE_MAX_W,
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_init])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
