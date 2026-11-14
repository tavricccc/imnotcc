// cc-remote desktop: a window onto a cc-remote server (remote or on this PC), plus a tray that
// keeps the local server running. Remote server pages load as their own origin, so the server's
// cookie and Origin checks work unchanged; only the bundled setup page may call these commands.
mod local;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

fn default_port() -> u16 {
    4280
}

/// Port of the local server, from config.json (default 4280).
pub fn local_port(app: &AppHandle) -> u16 {
    app.state::<AppState>().config.lock().unwrap().port
}
pub fn local_url(app: &AppHandle) -> String {
    format!("http://127.0.0.1:{}", local_port(app))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Config {
    /// Server the window opens. None means show the setup page.
    pub url: Option<String>,
    /// This PC runs the server.
    pub local: bool,
    /// App version whose server files are installed locally.
    pub installed_version: Option<String>,
    /// Port the local server listens on; change it in config.json if 4280 is taken.
    #[serde(default = "default_port")]
    pub port: u16,
    /// Public addresses the server should accept besides its own host (CC_REMOTE_ORIGINS),
    /// e.g. a Cloudflare Tunnel hostname.
    #[serde(default)]
    pub origins: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config { url: None, local: false, installed_version: None, port: default_port(), origins: Vec::new() }
    }
}

pub struct AppState {
    pub config: Mutex<Config>,
    pub server: local::Supervisor,
}

pub fn base_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_local_data_dir().expect("no local data dir");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn config_path(app: &AppHandle) -> PathBuf {
    base_dir(app).join("config.json")
}

fn load_config(app: &AppHandle) -> Config {
    fs::read_to_string(config_path(app)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save_config(app: &AppHandle, c: &Config) -> Result<(), String> {
    let s = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    fs::write(config_path(app), s).map_err(|e| format!("寫入設定失敗：{e}"))
}

pub fn needs_update(app: &AppHandle, c: &Config) -> bool {
    c.local && c.installed_version.as_deref() != Some(&app.package_info().version.to_string())
}

/// The setup page is the only page allowed to drive the app.
fn from_setup_page(w: &WebviewWindow) -> Result<(), String> {
    let url = w.url().map_err(|e| e.to_string())?;
    let ok = matches!(url.scheme(), "tauri") || url.host_str() == Some("tauri.localhost");
    if ok { Ok(()) } else { Err("not allowed from this page".into()) }
}

/// Where the bundled setup page lives in the webview (Windows serves app files from here).
const SETUP_URL: &str = "http://tauri.localhost/index.html";

/// Show the window on `url`, or on the setup page when None. An existing window is navigated:
/// destroying it and building a new "main" right away fails, as the label is freed later.
pub fn open_window(app: &AppHandle, url: Option<String>, show: bool) -> Result<(), String> {
    let parsed: tauri::Url = match &url {
        Some(u) => u.parse().map_err(|_| format!("網址格式不對：{u}"))?,
        None => SETUP_URL.parse().unwrap(),
    };
    if let Some(w) = app.get_webview_window("main") {
        w.navigate(parsed).map_err(|e| e.to_string())?;
        if show {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        return Ok(());
    }
    let target = match url {
        Some(_) => WebviewUrl::External(parsed),
        None => WebviewUrl::App("index.html".into()),
    };
    let w = WebviewWindowBuilder::new(app, "main", target)
        .title("cc-remote")
        .inner_size(1100.0, 820.0)
        .min_inner_size(360.0, 480.0)
        .visible(show)
        .build()
        .map_err(|e| e.to_string())?;
    let w2 = w.clone();
    w.on_window_event(move |e| {
        // Closing the window keeps the app (and the local server) in the tray.
        if let WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            let _ = w2.hide();
        }
    });
    Ok(())
}

fn show_window(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        None => {
            let url = app.state::<AppState>().config.lock().unwrap().url.clone();
            let _ = open_window(app, url, true);
        }
    }
}

#[derive(Serialize)]
struct StateView {
    config: Config,
    node: Result<String, String>,
    needs_update: bool,
    local_url: String,
}

#[tauri::command]
fn get_state(app: AppHandle, window: WebviewWindow) -> Result<StateView, String> {
    from_setup_page(&window)?;
    let config = app.state::<AppState>().config.lock().unwrap().clone();
    Ok(StateView { needs_update: needs_update(&app, &config), config, node: local::node_version(), local_url: local_url(&app) })
}

/// Ask `url` whether it is a cc-remote server. A Cloudflare Access login page counts: the real
/// check happens after the user signs in inside the window.
fn probe(url: &str) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).build();
    let resp = agent.get(&format!("{url}/api/me")).call().map_err(|e| format!("連不上 {url}：{e}"))?;
    if resp.get_url().contains("cloudflareaccess.com") {
        return Ok(());
    }
    let body = resp.into_string().map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|_| format!("{url} 不像是 cc-remote server（/api/me 不是 JSON）"))?;
    if v.get("authed").is_some() { Ok(()) } else { Err(format!("{url} 不像是 cc-remote server")) }
}

#[tauri::command]
async fn use_remote(app: AppHandle, window: WebviewWindow, url: String) -> Result<(), String> {
    from_setup_page(&window)?;
    let url = url.trim().trim_end_matches('/').to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("網址要以 http:// 或 https:// 開頭".into());
    }
    let u = url.clone();
    tauri::async_runtime::spawn_blocking(move || probe(&u)).await.map_err(|e| e.to_string())??;
    let state = app.state::<AppState>();
    if state.config.lock().unwrap().local {
        state.server.stop();
    }
    let c = { let mut c = state.config.lock().unwrap(); c.url = Some(url.clone()); c.local = false; c.clone() };
    save_config(&app, &c)?;
    open_window(&app, Some(url), true)
}

#[tauri::command]
fn install_local(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    from_setup_page(&window)?;
    local::start_install(app);
    Ok(())
}

#[tauri::command]
fn open_url(app: AppHandle, window: WebviewWindow, url: String) -> Result<(), String> {
    from_setup_page(&window)?;
    open_window(&app, Some(url), true)
}

#[tauri::command]
fn open_node_download(window: WebviewWindow) -> Result<(), String> {
    from_setup_page(&window)?;
    std::process::Command::new("explorer").arg("https://nodejs.org/en/download").spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let open = MenuItem::with_id(app, "open", "開啟 cc-remote", true, None::<&str>)?;
    let password = MenuItem::with_id(app, "password", "顯示本機 server 密碼", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重新啟動本機 server", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "開啟 log 資料夾", true, None::<&str>)?;
    let change = MenuItem::with_id(app, "change", "更換 server…", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "登入 Windows 時啟動", true, autostart_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "結束", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&open, &sep()?, &password, &restart, &logs, &sep()?, &change, &autostart, &sep()?, &quit])?;
    let autostart2 = autostart.clone();

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("cc-remote")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_window(tray.app_handle());
            }
        })
        .on_menu_event(move |app, e| match e.id.as_ref() {
            "open" => show_window(app),
            "password" => {
                let msg = match local::read_password(app) {
                    Some(p) => format!("本機 server 密碼：\n\n{p}\n\n（在網頁的設定裡改過密碼的話，這裡顯示的是最初的密碼）"),
                    None => "這台電腦沒有設成 server，或 server 還沒啟動過。".into(),
                };
                app.dialog().message(msg).title("cc-remote").kind(MessageDialogKind::Info).show(|_| {});
            }
            "restart" => {
                let st = app.state::<AppState>();
                if st.config.lock().unwrap().local {
                    st.server.restart(app);
                } else {
                    app.dialog().message("這台電腦沒有設成 server。").title("cc-remote").show(|_| {});
                }
            }
            "logs" => {
                let _ = std::process::Command::new("explorer").arg(local::log_dir(app)).spawn();
            }
            "change" => {
                let _ = open_window(app, None, true);
            }
            "autostart" => {
                let al = app.autolaunch();
                let want = !al.is_enabled().unwrap_or(false);
                let r = if want { al.enable() } else { al.disable() };
                if let Err(err) = r {
                    app.dialog().message(format!("設定開機啟動失敗：{err}")).kind(MessageDialogKind::Error).show(|_| {});
                }
                let _ = autostart2.set_checked(al.is_enabled().unwrap_or(false));
            }
            "quit" => {
                app.state::<AppState>().server.stop();
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_state, use_remote, install_local, open_url, open_node_download])
        .setup(|app| {
            let handle = app.handle().clone();
            let config = load_config(&handle);
            app.manage(AppState { config: Mutex::new(config.clone()), server: local::Supervisor::default() });
            build_tray(&handle)?;

            let minimized = std::env::args().any(|a| a == "--minimized");
            if needs_update(&handle, &config) {
                // New app version: the setup page reinstalls the server files, then opens it.
                open_window(&handle, None, true)?;
            } else if config.local {
                local::start_and_open(&handle, !minimized);
            } else {
                open_window(&handle, config.url.clone(), !minimized)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building cc-remote")
        .run(|app, e| match e {
            // No windows left (open_window swaps the window) is not a reason to quit: the app
            // lives in the tray. Only an explicit exit (the tray's 結束) carries a code.
            tauri::RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            tauri::RunEvent::Exit => app.state::<AppState>().server.stop(),
            _ => {}
        });
}
