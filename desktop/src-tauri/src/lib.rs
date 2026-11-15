// imnotcc desktop: a window onto a imnotcc server (remote or on this PC), plus a tray that
// keeps the local server running. Remote server pages load as their own origin, so the server's
// cookie and Origin checks work unchanged; only the bundled setup page may call these commands.
mod local;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::window::{Effect, EffectsBuilder};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::DialogExt;

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
    #[serde(default)]
    pub url: Option<String>,
    /// This PC runs the server.
    #[serde(default)]
    pub local: bool,
    /// Build (see `build_stamp`) whose server files are installed locally.
    #[serde(default)]
    pub installed_version: Option<String>,
    /// Port the local server listens on; change it in config.json if 4280 is taken.
    #[serde(default = "default_port")]
    pub port: u16,
    /// Public addresses the server should accept besides its own host (IMNOTCC_ORIGINS),
    /// e.g. a Cloudflare Tunnel hostname.
    #[serde(default)]
    pub origins: Vec<String>,
    /// Last remote server URL configured by the user, kept when switching between local and remote.
    #[serde(default)]
    pub remote_url: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config { url: None, local: false, installed_version: None, port: default_port(), origins: Vec::new(), remote_url: None }
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
    let path = config_path(app);
    let Ok(raw) = fs::read_to_string(&path) else {
        return Config::default();
    };
    match serde_json::from_str::<Config>(raw.trim_start_matches('\u{feff}')) {
        Ok(mut c) => {
            if c.port == 0 {
                c.port = default_port();
            }
            if c.local && c.url.is_none() {
                c.url = Some(format!("http://127.0.0.1:{}", c.port));
            }
            c
        }
        Err(e) => {
            eprintln!("[imnotcc] failed to parse {}: {e}", path.display());
            Config::default()
        }
    }
}

pub fn save_config(app: &AppHandle, c: &Config) -> Result<(), String> {
    let s = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    fs::write(config_path(app), s).map_err(|e| format!("寫入設定失敗：{e}"))
}

/// This build: the version plus the exe's modified time, so reinstalling a rebuilt app with the
/// same version number still refreshes the local server files.
pub fn build_stamp(app: &AppHandle) -> String {
    let version = app.package_info().version.to_string();
    let built = std::env::current_exe().ok()
        .and_then(|p| fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    match built { Some(t) => format!("{version}+{t}"), None => version }
}

pub fn needs_update(app: &AppHandle, c: &Config) -> bool {
    c.local && (c.installed_version.as_deref() != Some(build_stamp(app).as_str()) || !local::server_files_present(app))
}

/// Who is calling a desktop command.
#[derive(Clone, Copy, PartialEq)]
enum Caller {
    /// The bundled setup page: app code, trusted with everything.
    Setup,
    /// The configured imnotcc server's own page. It renders Claude's output and files, so a flaw
    /// there could run script; commands that change the app or reveal secrets ask the user first
    /// through a native dialog, which page script cannot click.
    Web,
}

fn is_loopback(host: Option<&str>) -> bool {
    matches!(host, Some("127.0.0.1" | "localhost"))
}

fn caller(app: &AppHandle, w: &WebviewWindow) -> Result<Caller, String> {
    let url = w.url().map_err(|e| e.to_string())?;
    if matches!(url.scheme(), "tauri") || url.host_str() == Some("tauri.localhost") {
        return Ok(Caller::Setup);
    }
    let cfg = app.state::<AppState>().config.lock().unwrap().clone();
    if cfg.local && url.scheme() == "http" && is_loopback(url.host_str()) && url.port_or_known_default() == Some(cfg.port) {
        return Ok(Caller::Web);
    }
    if let Some(parsed) = cfg.url.as_deref().and_then(|u| u.parse::<tauri::Url>().ok()) {
        let same = url.scheme() == parsed.scheme()
            && url.host_str() == parsed.host_str()
            && url.port_or_known_default() == parsed.port_or_known_default();
        // Plain http to another machine can be rewritten on the way, so it gets no commands at all.
        if same && (url.scheme() == "https" || is_loopback(url.host_str())) {
            return Ok(Caller::Web);
        }
    }
    Err("not allowed from this page".into())
}

fn from_trusted_page(app: &AppHandle, w: &WebviewWindow) -> Result<(), String> {
    caller(app, w).map(|_| ())
}

/// For a Web caller, ask the user natively before going on; the setup page goes straight through.
async fn confirm(app: &AppHandle, who: Caller, message: String) -> Result<(), String> {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
    if who == Caller::Setup {
        return Ok(());
    }
    let app = app.clone();
    // blocking_show must not run on the main thread.
    let ok = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title("imnotcc")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("允許".into(), "取消".into()))
            .blocking_show()
    })
    .await
    .map_err(|e| e.to_string())?;
    if ok { Ok(()) } else { Err("已取消".into()) }
}

/// Where the bundled setup page lives in the webview (Windows serves app files from here).
const SETUP_URL: &str = "http://tauri.localhost/index.html";

const TITLEBAR_SCRIPT: &str = r#"
(() => {
  if (window.__ccrTitlebarInit) return;
  window.__ccrTitlebarInit = true;
  // The imnotcc web app draws its own titlebar and opts out with this meta tag; other pages
  // (setup page, a Cloudflare Access login) get this one.
  const mount = () => {
    if (document.querySelector('meta[name="ccr-titlebar"]')) return;
    if (document.getElementById("ccr-titlebar") || !document.body) return;
    document.documentElement.style.setProperty("--safe-top", "36px");
    const style = document.createElement("style");
    style.textContent = `
      #ccr-titlebar {
        position: fixed; top: 0; left: 0; right: 0; height: 36px; z-index: 2147483647;
        display: flex; align-items: stretch; justify-content: space-between;
        background: #f4f3f1; border-bottom: 1px solid rgba(20, 18, 16, 0.08);
        color: #5c5855; user-select: none; -webkit-user-select: none;
      }
      @media (prefers-color-scheme: dark) {
        #ccr-titlebar {
          background: #0d0c0b; border-bottom-color: rgba(255, 255, 255, 0.09);
          color: #aaa5a1;
        }
      }
      #ccr-drag {
        flex: 1; height: 100%;
        display: flex; align-items: center; gap: 8px; padding-left: 14px;
        font: 600 12px/1 "Segoe UI", "Microsoft JhengHei UI", system-ui, sans-serif;
        letter-spacing: 0.01em;
      }
      .ccr-win-btns { display: flex; align-items: stretch; }
      .ccr-win-btn {
        width: 46px; height: 35px; border: 0; margin: 0; padding: 0;
        background: transparent; color: inherit;
        display: grid; place-items: center; cursor: default;
        transition: background-color 120ms ease, color 120ms ease;
      }
      .ccr-win-btn:hover { background: rgba(128, 128, 128, 0.16); color: #151312; }
      @media (prefers-color-scheme: dark) {
        .ccr-win-btn:hover { color: #f4f2f0; }
      }
      .ccr-win-btn.close:hover { background: #c42b1c; color: #fff; }
      .ccr-win-btn svg { width: 10px; height: 10px; stroke: currentColor; stroke-width: 1.3; fill: none; }
    `;
    document.head.appendChild(style);
    const bar = document.createElement("div");
    bar.id = "ccr-titlebar";
    const win = window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow();
    const drag = document.createElement("div");
    drag.id = "ccr-drag";
    drag.setAttribute("data-tauri-drag-region", "");
    drag.textContent = "imnotcc";
    drag.addEventListener("mousedown", (e) => {
      if (e.button === 0 && win) win.startDragging();
    });
    drag.addEventListener("dblclick", () => {
      if (win) win.toggleMaximize();
    });
    bar.appendChild(drag);

    const btns = document.createElement("div");
    btns.className = "ccr-win-btns";
    const mkBtn = (cls, label, svg, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ccr-win-btn " + cls;
      b.setAttribute("aria-label", label);
      b.innerHTML = svg;
      b.addEventListener("click", onClick);
      return b;
    };
    btns.appendChild(mkBtn("min", "最小化", '<svg viewBox="0 0 10 10"><line x1="1" y1="5.5" x2="9" y2="5.5"/></svg>', () => win && win.minimize()));
    btns.appendChild(mkBtn("max", "最大化", '<svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7"/></svg>', () => win && win.toggleMaximize()));
    btns.appendChild(mkBtn("close", "關閉（程式留在系統匣）", '<svg viewBox="0 0 10 10"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5"/><line x1="8.5" y1="1.5" x2="1.5" y2="8.5"/></svg>', () => {
      if (win) win.close();
    }));
    bar.appendChild(btns);
    document.body.appendChild(bar);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
"#;

/// Show the window on `url`, or on the setup page when None. An existing window is navigated.
/// Closing the window destroys it (freeing the WebView2 processes); the app stays in the tray.
/// A destroyed window's label is freed a little later, so building "main" right after a close
/// can fail with a label conflict: the build is then retried off the main thread.
pub fn open_window(app: &AppHandle, url: Option<String>, show: bool) -> Result<(), String> {
    let parsed: tauri::Url = match &url {
        Some(u) => u.parse().map_err(|_| format!("網址格式不對：{u}"))?,
        None => SETUP_URL.parse().unwrap(),
    };
    if let Some(w) = app.get_webview_window("main") {
        // A window that is mid-destroy can refuse to navigate: fall through and build anew.
        if w.navigate(parsed.clone()).is_ok() {
            if show {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            return Ok(());
        }
    }
    let target = match url {
        Some(_) => WebviewUrl::External(parsed),
        None => WebviewUrl::App("index.html".into()),
    };
    match build_main(app, target.clone(), show) {
        Err(e) if is_label_conflict(&e) => {
            let app = app.clone();
            std::thread::spawn(move || {
                for _ in 0..30 {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    match build_main(&app, target.clone(), show) {
                        Err(e) if is_label_conflict(&e) => continue,
                        Err(e) => {
                            eprintln!("[imnotcc] could not open the window: {e}");
                            return;
                        }
                        Ok(()) => return,
                    }
                }
                eprintln!("[imnotcc] could not open the window: label \"main\" was never freed");
            });
            Ok(())
        }
        r => r.map_err(|e| e.to_string()),
    }
}

fn is_label_conflict(e: &tauri::Error) -> bool {
    matches!(e, tauri::Error::WindowLabelAlreadyExists(_) | tauri::Error::WebviewLabelAlreadyExists(_))
}

fn build_main(app: &AppHandle, target: WebviewUrl, show: bool) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "main", target)
        .title("imnotcc")
        .inner_size(1100.0, 820.0)
        .min_inner_size(360.0, 480.0)
        .decorations(false)
        .transparent(true)
        .effects(EffectsBuilder::new().effect(Effect::Mica).build())
        .initialization_script(TITLEBAR_SCRIPT)
        .visible(show)
        .build()?;
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
    needs_deps_install: bool,
    local_url: String,
    autostart: bool,
    data_dir: String,
    log_dir: String,
    has_password: bool,
    server_running: bool,
    app_version: String,
}

#[tauri::command]
fn get_state(app: AppHandle, window: WebviewWindow) -> Result<StateView, String> {
    from_trusted_page(&app, &window)?;
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap().clone();
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    Ok(StateView {
        needs_update: needs_update(&app, &config),
        needs_deps_install: local::needs_deps_install(&app),
        config,
        node: local::node_version(),
        local_url: local_url(&app),
        autostart,
        data_dir: local::data_dir(&app).display().to_string(),
        log_dir: local::log_dir(&app).display().to_string(),
        has_password: local::read_password(&app).is_some(),
        server_running: state.server.is_running(),
        app_version: app.package_info().version.to_string(),
    })
}

/// Ask `url` whether it is a imnotcc server. A Cloudflare Access login page counts: the real
/// check happens after the user signs in inside the window.
fn probe(url: &str) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).build();
    let resp = agent.get(&format!("{url}/api/me")).call().map_err(|e| format!("連不上 {url}：{e}"))?;
    if resp.get_url().contains("cloudflareaccess.com") {
        return Ok(());
    }
    let body = resp.into_string().map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|_| format!("{url} 不像是 imnotcc server（/api/me 不是 JSON）"))?;
    if v.get("authed").is_some() { Ok(()) } else { Err(format!("{url} 不像是 imnotcc server")) }
}

#[tauri::command]
async fn use_remote(app: AppHandle, window: WebviewWindow, url: String) -> Result<(), String> {
    let who = caller(&app, &window)?;
    let url = url.trim().trim_end_matches('/').to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("網址要以 http:// 或 https:// 開頭".into());
    }
    confirm(&app, who, format!("要把 imnotcc 改連到這個 server 嗎？\n\n{url}\n\n本機 server 會停止。不是你自己按的話請按「取消」。")).await?;
    let u = url.clone();
    tauri::async_runtime::spawn_blocking(move || probe(&u)).await.map_err(|e| e.to_string())??;
    let state = app.state::<AppState>();
    if state.config.lock().unwrap().local {
        state.server.stop();
    }
    let c = { let mut c = state.config.lock().unwrap(); c.url = Some(url.clone()); c.remote_url = Some(url.clone()); c.local = false; c.clone() };
    save_config(&app, &c)?;
    open_window(&app, Some(url), true)
}

#[tauri::command]
async fn install_local(app: AppHandle, window: WebviewWindow, force: Option<bool>) -> Result<(), String> {
    let who = caller(&app, &window)?;
    confirm(&app, who, "要在這台電腦安裝並啟動本機 server 嗎？\n\n不是你自己按的話請按「取消」。".into()).await?;
    local::start_install(app, force.unwrap_or(false));
    Ok(())
}

#[tauri::command]
async fn update_sdk(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let who = caller(&app, &window)?;
    if !app.state::<AppState>().config.lock().unwrap().local {
        return Err("這台電腦目前沒有設成 server。".into());
    }
    confirm(&app, who, "要更新本機 server 的 Claude Agent SDK 嗎？\n\n更新期間執行中的對話會短暫中斷。不是你自己按的話請按「取消」。".into()).await?;
    local::start_sdk_update(app);
    Ok(())
}

#[tauri::command]
fn resume_current(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if caller(&app, &window)? != Caller::Setup {
        return Err("not allowed from this page".into());
    }
    let state = app.state::<AppState>();
    let cfg = state.config.lock().unwrap().clone();
    if cfg.local {
        if needs_update(&app, &cfg) {
            return Err("本機 server 需要先完成更新".into());
        }
        if state.server.is_running() {
            open_window(&app, Some(local_url(&app)), true)?;
        } else {
            local::start_and_open(&app, true);
        }
        return Ok(());
    }
    if let Some(url) = cfg.url {
        return open_window(&app, Some(url), true);
    }
    Err("尚未設定 server".into())
}

#[tauri::command]
fn open_url(app: AppHandle, window: WebviewWindow, url: String) -> Result<(), String> {
    // The server's page may only send the window to the configured server, not to any site.
    if caller(&app, &window)? == Caller::Web {
        let cfg = app.state::<AppState>().config.lock().unwrap().clone();
        let target: tauri::Url = url.parse().map_err(|_| format!("網址格式不對：{url}"))?;
        let ok = cfg.url.as_deref().and_then(|u| u.parse::<tauri::Url>().ok()).is_some_and(|c| c.origin() == target.origin());
        if !ok {
            return Err("只能開啟目前設定的 server".into());
        }
    }
    open_window(&app, Some(url), true)
}

/// Shows the local server's first password in a native dialog, so page script never holds it.
#[tauri::command]
fn show_password(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    from_trusted_page(&app, &window)?;
    let msg = match local::read_password(&app) {
        Some(p) => format!("本機 server 的初始密碼：\n\n{p}\n\n（尚未更改過密碼。建議登入後到「App 設定 → 更改密碼」設定自己的密碼。）"),
        None => "目前沒有初始密碼紀錄（可能已更改過密碼，或本機 server 尚未啟動）。".into(),
    };
    app.dialog().message(msg).title("imnotcc").show(|_| {});
    Ok(())
}

#[tauri::command]
fn open_node_download(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    from_trusted_page(&app, &window)?;
    std::process::Command::new("explorer").arg("https://nodejs.org/en/download").spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Reduce `raw` to a bare origin (`scheme://host[:port]`), or say why it is not one.
fn clean_origin(raw: &str) -> Result<String, String> {
    let raw = raw.trim().trim_end_matches('/');
    let bad = || format!("「{raw}」不是有效的網域，要像 https://cc.example.com 這樣");
    let u: tauri::Url = raw.parse().map_err(|_| bad())?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none() || u.path() != "/" || u.query().is_some() || u.fragment().is_some() || !u.username().is_empty() {
        return Err(bad());
    }
    Ok(u.origin().ascii_serialization())
}

#[tauri::command]
async fn save_local_settings(app: AppHandle, window: WebviewWindow, port: u16, origins: Vec<String>) -> Result<Config, String> {
    let who = caller(&app, &window)?;
    if port == 0 {
        return Err("連接埠不能為 0".into());
    }
    let mut clean: Vec<String> = Vec::new();
    for o in origins.iter().filter(|s| !s.trim().is_empty()) {
        let o = clean_origin(o)?;
        if !clean.contains(&o) {
            clean.push(o);
        }
    }
    let state = app.state::<AppState>();
    let old = state.config.lock().unwrap().clone();
    let port_changed = old.port != port;
    if who == Caller::Setup {
        // Setup saves port & origins before calling install_local, which starts/restarts the server
        // and lets the setup page transition cleanly once ready.
        if (!old.local || port_changed || !state.server.is_running()) && local::port_in_use(port) {
            return Err(format!("連接埠 {port} 已經被別的程式占用，換一個試試。"));
        }
        let mut c = state.config.lock().unwrap();
        c.port = port;
        c.origins = clean;
        if c.local {
            c.url = Some(format!("http://127.0.0.1:{port}"));
        }
        let c = c.clone();
        save_config(&app, &c)?;
        return Ok(c);
    }
    if !port_changed && old.origins == clean {
        return Ok(old);
    }
    let listed = if clean.is_empty() { "（無）".to_string() } else { clean.join("\n") };
    confirm(&app, who, format!("要套用新的本機 server 設定嗎？\n\n連接埠：{port}\n允許的網域：\n{listed}\n\n不是你自己按的話請按「取消」。")).await?;
    if old.local && port_changed && local::port_in_use(port) {
        return Err(format!("連接埠 {port} 已經被別的程式占用，換一個試試。"));
    }
    let apply = |port: u16, origins: Vec<String>| -> Result<Config, String> {
        let mut c = state.config.lock().unwrap();
        c.port = port;
        c.origins = origins;
        if c.local {
            c.url = Some(format!("http://127.0.0.1:{port}"));
        }
        let c = c.clone();
        save_config(&app, &c)?;
        Ok(c)
    };
    let c = apply(port, clean)?;
    if !old.local {
        return Ok(c);
    }
    // Restarting stops the server for a few seconds and waits on it, so keep it off the main thread.
    let app2 = app.clone();
    let ready = tauri::async_runtime::spawn_blocking(move || {
        app2.state::<AppState>().server.restart(&app2);
        local::wait_ready(&app2, Duration::from_secs(20))
    })
    .await
    .map_err(|e| e.to_string())?;
    if !ready {
        // Put the old settings back so the app is not left pointing at a server that never came up.
        apply(old.port, old.origins.clone())?;
        let app3 = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || app3.state::<AppState>().server.restart(&app3)).await;
        return Err("新設定下本機 server 沒有啟動成功，已恢復原本的設定。可以到 Log 資料夾看原因。".into());
    }
    if port_changed {
        open_window(&app, c.url.clone(), true)?;
    }
    Ok(c)
}

#[tauri::command]
fn set_autostart(app: AppHandle, window: WebviewWindow, enabled: bool) -> Result<bool, String> {
    from_trusted_page(&app, &window)?;
    let al = app.autolaunch();
    if enabled {
        al.enable().map_err(|e| format!("設定開機啟動失敗：{e}"))?;
    } else {
        al.disable().map_err(|e| format!("取消開機啟動失敗：{e}"))?;
    }
    Ok(al.is_enabled().unwrap_or(enabled))
}

#[tauri::command]
async fn restart_local(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    from_trusted_page(&app, &window)?;
    if !app.state::<AppState>().config.lock().unwrap().local {
        return Err("這台電腦目前沒有設成 server。".into());
    }
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().server.restart(&app)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn open_data_dir(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    from_trusted_page(&app, &window)?;
    std::process::Command::new("explorer").arg(local::data_dir(&app)).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_log_dir(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    from_trusted_page(&app, &window)?;
    std::process::Command::new("explorer").arg(local::log_dir(&app)).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_file(app: AppHandle, window: WebviewWindow, path: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    from_trusted_page(&app, &window)?;
    if !app.state::<AppState>().config.lock().unwrap().local {
        return Err("只有本機 Server（Host）模式可以在檔案總管顯示".into());
    }
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("缺少檔案路徑".into());
    }
    let win_path = trimmed.replace('/', "\\");
    let target = std::path::Path::new(&win_path);
    if !target.exists() {
        return Err(format!("找不到這個檔案：{win_path}"));
    }
    if target.is_dir() {
        std::process::Command::new("explorer").arg(&win_path).spawn().map(|_| ()).map_err(|e| e.to_string())
    } else {
        let quoted = win_path.replace('"', "");
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{quoted}\""))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// Opens a Claude sign-in link in the system browser; any other address is refused.
#[tauri::command]
fn open_external(app: AppHandle, window: WebviewWindow, url: String) -> Result<(), String> {
    from_trusted_page(&app, &window)?;
    let u: tauri::Url = url.parse().map_err(|_| "網址格式不對".to_string())?;
    let host = u.host_str().unwrap_or("");
    let allowed = ["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"];
    if u.scheme() != "https" || !allowed.contains(&host) {
        return Err("只能開啟 Claude 的登入頁面".into());
    }
    std::process::Command::new("explorer").arg(u.as_str()).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Opens a link from a reply in the system browser. Only http and https: anything else (file:,
/// javascript:, custom protocol handlers) is refused. The address is parsed and written out again,
/// and handed to the shell as one string rather than through explorer's comma-separated arguments.
#[tauri::command]
fn open_link(app: AppHandle, window: WebviewWindow, url: String) -> Result<(), String> {
    from_trusted_page(&app, &window)?;
    let u: tauri::Url = url.parse().map_err(|_| "網址格式不對".to_string())?;
    if u.scheme() != "https" && u.scheme() != "http" {
        return Err("只能開啟 http 或 https 網址".into());
    }
    shell_open(u.as_str())
}

#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (verb, file) = (wide("open"), wide(target));
    // SAFETY: both strings are NUL-terminated and outlive the call; the other pointers may be null.
    let code = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) } as isize;
    // ShellExecuteW reports success with a value above 32.
    if code > 32 { Ok(()) } else { Err(format!("無法開啟瀏覽器（{code}）")) }
}

#[cfg(not(windows))]
fn shell_open(target: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open").arg(target).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_setup(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    from_trusted_page(&app, &window)?;
    open_window(&app, None, true)
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "開啟視窗", true, None::<&str>)?;
    // Kept here as well as in App settings: when the server is down, that page cannot load.
    let restart = MenuItem::with_id(app, "restart", "重新啟動本機 server", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "結束", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep, &restart, &sep2, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("imnotcc")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_window(tray.app_handle());
            }
        })
        .on_menu_event(move |app, e| match e.id.as_ref() {
            "open" => show_window(app),
            "restart" => {
                let st = app.state::<AppState>();
                if st.config.lock().unwrap().local {
                    let app = app.clone();
                    // Stopping waits on the old process; the tray handler runs on the main thread.
                    std::thread::spawn(move || app.state::<AppState>().server.restart(&app));
                } else {
                    app.dialog().message("這台電腦沒有設成 server。").title("imnotcc").show(|_| {});
                }
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

/// The app used to be "cc-remote Desktop" (identifier dev.ccremote.desktop). Move its files
/// (config, server, data, the webview's storage) to the new identifier's folder before anything
/// opens them, and swap its autostart entry for ours. Returns whether autostart was on.
fn migrate_from_cc_remote() -> bool {
    use std::os::windows::process::CommandExt;
    let Some(base) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else { return false };
    let (old, new) = (base.join("dev.ccremote.desktop"), base.join("dev.imnotcc.app"));
    if old.is_dir() {
        if !new.exists() {
            if let Err(e) = std::fs::rename(&old, &new) { eprintln!("[imnotcc] could not move {}: {e}", old.display()); }
        } else if !new.join("config.json").exists() && old.join("config.json").exists() {
            // Migrate saved config/data if dev.imnotcc.app was created beforehand (e.g. WebView2 EBWebView).
            let _ = std::fs::rename(old.join("config.json"), new.join("config.json"));
            for dir in ["data", "server-app", "logs"] {
                let (src, dst) = (old.join(dir), new.join(dir));
                if src.is_dir() && !dst.exists() {
                    let _ = std::fs::rename(&src, &dst);
                }
            }
        }
    }
    let reg = |args: &[&str]| std::process::Command::new("reg").args(args).creation_flags(0x0800_0000).status().map(|s| s.success()).unwrap_or(false);
    const RUN: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    reg(&["query", RUN, "/v", "cc-remote Desktop"]) && reg(&["delete", RUN, "/v", "cc-remote Desktop", "/f"])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let had_autostart = migrate_from_cc_remote();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_state,
            use_remote,
            install_local,
            update_sdk,
            resume_current,
            open_url,
            open_node_download,
            save_local_settings,
            set_autostart,
            restart_local,
            open_data_dir,
            open_log_dir,
            reveal_file,
            open_setup,
            open_external,
            open_link,
            show_password
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            if had_autostart { let _ = handle.autolaunch().enable(); }
            let config = load_config(&handle);
            app.manage(AppState { config: Mutex::new(config.clone()), server: local::Supervisor::default() });
            build_tray(&handle)?;

            let minimized = std::env::args().any(|a| a == "--minimized");
            if needs_update(&handle, &config) {
                if !local::needs_deps_install(&handle) {
                    // Dependencies (including Agent SDK) are unchanged: update bundled files in place.
                    local::update_and_open(&handle, !minimized);
                } else {
                    // New dependencies or missing node_modules: show setup progress UI.
                    open_window(&handle, None, true)?;
                }
            } else if config.local {
                local::start_and_open(&handle, !minimized);
            } else {
                open_window(&handle, config.url.clone(), !minimized)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building imnotcc")
        .run(|app, e| match e {
            // No windows left (open_window swaps the window) is not a reason to quit: the app
            // lives in the tray. Only an explicit exit (the tray's 結束) carries a code.
            tauri::RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            tauri::RunEvent::Exit => app.state::<AppState>().server.stop(),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_partial_and_bom_config() {
        let raw = "\u{feff}{\"port\": 5123, \"origins\": [\"https://cc.example.com\"]}";
        let cfg: Config = serde_json::from_str(raw.trim_start_matches('\u{feff}')).unwrap();
        assert_eq!(cfg.port, 5123);
        assert_eq!(cfg.origins, vec!["https://cc.example.com"]);
        assert!(!cfg.local);
        assert_eq!(cfg.url, None);
    }
}
