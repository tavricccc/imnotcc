// Running cc-remote's server on this PC: install it from the bundled files with the system's
// Node.js, keep it running (restart when it dies), and stop exactly the process tree we started.
use crate::{base_dir, local_url, needs_update, open_window, save_config, AppState, LOCAL_PORT};
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MIN_NODE_MAJOR: u32 = 20;

pub fn app_dir(app: &AppHandle) -> PathBuf {
    base_dir(app).join("server-app")
}
pub fn data_dir(app: &AppHandle) -> PathBuf {
    base_dir(app).join("data")
}
pub fn log_dir(app: &AppHandle) -> PathBuf {
    let d = base_dir(app).join("logs");
    let _ = fs::create_dir_all(&d);
    d
}

pub fn read_password(app: &AppHandle) -> Option<String> {
    fs::read_to_string(data_dir(app).join("password.txt")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn hidden(cmd: &str) -> Command {
    let mut c = Command::new(cmd);
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// "v24.1.0" when Node.js 20+ is on PATH, otherwise a message saying what is missing.
pub fn node_version() -> Result<String, String> {
    let out = hidden("node").arg("--version").output().map_err(|_| "找不到 Node.js（node 不在 PATH 上）".to_string())?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let major: u32 = v.trim_start_matches('v').split('.').next().and_then(|m| m.parse().ok()).ok_or(format!("看不懂 node --version 的輸出：{v}"))?;
    if major < MIN_NODE_MAJOR {
        return Err(format!("Node.js 版本是 {v}，需要 {MIN_NODE_MAJOR} 以上"));
    }
    Ok(v)
}

fn port_in_use() -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], LOCAL_PORT).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Wait until the server answers /api/me.
pub fn wait_ready(timeout: Duration) -> bool {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(2)).build();
    let end = Instant::now() + timeout;
    while Instant::now() < end {
        if agent.get(&format!("{}/api/me", local_url())).call().is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(300));
    }
    false
}

#[derive(Default)]
struct Inner {
    want: bool,
    generation: u64,
    pid: Option<u32>,
}

#[derive(Default, Clone)]
pub struct Supervisor(Arc<Mutex<Inner>>);

impl Supervisor {
    pub fn start(&self, app: &AppHandle) {
        let gen = {
            let mut s = self.0.lock().unwrap();
            if s.want {
                return;
            }
            if port_in_use() {
                drop(s);
                app.dialog()
                    .message(format!("連接埠 {LOCAL_PORT} 已經被別的程式占用（可能是另一個 cc-remote），本機 server 沒有啟動。"))
                    .title("cc-remote")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
                return;
            }
            s.want = true;
            s.generation += 1;
            s.generation
        };
        let me = self.clone();
        let app = app.clone();
        thread::spawn(move || me.run(&app, gen));
    }

    fn current(&self, gen: u64) -> bool {
        let s = self.0.lock().unwrap();
        s.want && s.generation == gen
    }

    fn run(&self, app: &AppHandle, gen: u64) {
        let mut backoff = Duration::from_secs(1);
        while self.current(gen) {
            let log_path = log_dir(app).join("server.log");
            let _ = fs::create_dir_all(data_dir(app));
            let log = OpenOptions::new().create(true).append(true).open(&log_path);
            let (out, err) = match log.and_then(|f| Ok((f.try_clone()?, f))) {
                Ok((a, b)) => (Stdio::from(a), Stdio::from(b)),
                Err(_) => (Stdio::null(), Stdio::null()),
            };
            let started = Instant::now();
            let child = hidden("node")
                .arg(app_dir(app).join("server").join("index.js"))
                .current_dir(app_dir(app))
                .env("CC_REMOTE_DATA_DIR", data_dir(app))
                .env("CC_REMOTE_PORT", LOCAL_PORT.to_string())
                .stdin(Stdio::null())
                .stdout(out)
                .stderr(err)
                .spawn();
            match child {
                Ok(mut c) => {
                    self.0.lock().unwrap().pid = Some(c.id());
                    let status = c.wait();
                    self.0.lock().unwrap().pid = None;
                    note(&log_path, &format!("[cc-remote desktop] server exited: {status:?}"));
                }
                Err(e) => note(&log_path, &format!("[cc-remote desktop] could not start node: {e}")),
            }
            if !self.current(gen) {
                break;
            }
            // Ran a while: a fresh failure. Died at once: back off up to 30 s.
            backoff = if started.elapsed() > Duration::from_secs(60) { Duration::from_secs(1) } else { (backoff * 2).min(Duration::from_secs(30)) };
            thread::sleep(backoff);
        }
    }

    /// Stop the server and every process it started (Claude Code runs as its children).
    pub fn stop(&self) {
        let pid = {
            let mut s = self.0.lock().unwrap();
            s.want = false;
            s.pid
        };
        if let Some(pid) = pid {
            let _ = hidden("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
            let end = Instant::now() + Duration::from_secs(5);
            while self.0.lock().unwrap().pid.is_some() && Instant::now() < end {
                thread::sleep(Duration::from_millis(100));
            }
        }
    }

    pub fn restart(&self, app: &AppHandle) {
        self.stop();
        self.start(app);
    }
}

fn note(path: &Path, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

#[derive(Serialize, Clone)]
struct Done {
    ok: bool,
    error: Option<String>,
    password: Option<String>,
    url: String,
    log: String,
}

static INSTALLING: AtomicBool = AtomicBool::new(false);

/// Install (or reinstall after an app update) the server on this PC. Progress goes out as
/// `install-log` events and the outcome as one `install-done` event.
pub fn start_install(app: AppHandle) {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        let log_path = log_dir(&app).join("install.log");
        let result = install(&app, &log_path);
        if let Err(e) = &result {
            note(&log_path, &format!("FAILED: {e}"));
        }
        let done = Done {
            ok: result.is_ok(),
            error: result.err(),
            password: read_password(&app),
            url: local_url(),
            log: log_path.display().to_string(),
        };
        INSTALLING.store(false, Ordering::SeqCst);
        let _ = app.emit("install-done", done);
    });
}

fn install(app: &AppHandle, log_path: &Path) -> Result<(), String> {
    let log = Arc::new(Mutex::new(File::create(log_path).map_err(|e| format!("無法寫入 {}：{e}", log_path.display()))?));
    let say = |line: &str| {
        let _ = writeln!(log.lock().unwrap(), "{line}");
        let _ = app.emit("install-log", line.to_string());
    };

    say("檢查 Node.js…");
    let v = node_version()?;
    say(&format!("Node.js {v}"));

    let state = app.state::<AppState>();
    state.server.stop();

    let src = app.path().resource_dir().map_err(|e| e.to_string())?.join("server-app");
    let dest = app_dir(app);
    say(&format!("複製 server 檔案到 {}…", dest.display()));
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| format!("無法清掉舊的 server 檔案（還有程式在用嗎？）：{e}"))?;
    }
    copy_dir(&src, &dest).map_err(|e| format!("複製 server 檔案失敗：{e}"))?;

    say("下載相依套件（npm ci --omit=dev），第一次會花一點時間…");
    let mut child = hidden("cmd")
        .args(["/C", "npm", "ci", "--omit=dev", "--no-audit", "--no-fund"])
        .current_dir(&dest)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("無法執行 npm：{e}"))?;
    let pipes: Vec<Box<dyn std::io::Read + Send>> = vec![Box::new(child.stdout.take().unwrap()), Box::new(child.stderr.take().unwrap())];
    let readers: Vec<_> = pipes
        .into_iter()
        .map(|p| {
            let (log, app) = (log.clone(), app.clone());
            thread::spawn(move || {
                for line in BufReader::new(p).lines().map_while(Result::ok) {
                    let _ = writeln!(log.lock().unwrap(), "{line}");
                    let _ = app.emit("install-log", line);
                }
            })
        })
        .collect();
    let status = child.wait().map_err(|e| e.to_string())?;
    for r in readers {
        let _ = r.join();
    }
    if !status.success() {
        return Err(format!("npm ci 失敗（{status}）。常見原因：沒有網路、公司代理擋住 npm registry。"));
    }

    let c = {
        let mut c = state.config.lock().unwrap();
        c.local = true;
        c.url = Some(local_url());
        c.installed_version = Some(app.package_info().version.to_string());
        c.clone()
    };
    save_config(app, &c)?;
    debug_assert!(!needs_update(app, &c));

    say("啟動本機 server…");
    state.server.start(app);
    if !wait_ready(Duration::from_secs(30)) {
        return Err(format!("server 30 秒內沒有回應，請看 {}", log_dir(app).join("server.log").display()));
    }
    say("完成。");
    Ok(())
}

/// Start the installed server and open the window once it answers.
pub fn start_and_open(app: &AppHandle, show: bool) {
    app.state::<AppState>().server.start(app);
    let app = app.clone();
    thread::spawn(move || {
        let ready = wait_ready(Duration::from_secs(30));
        let url = app.state::<AppState>().config.lock().unwrap().url.clone();
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = open_window(&a, url, show);
            if !ready {
                a.dialog()
                    .message(format!("本機 server 30 秒內沒有回應，請看 {}", log_dir(&a).join("server.log").display()))
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        });
    });
}
