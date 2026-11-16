// Running imnotcc's server on this PC: install it from the bundled files with the system's
// Node.js, keep it running (restart when it dies), and stop exactly the process tree we started.
use crate::{base_dir, local_url, needs_update, open_window, save_config, local_port, AppState};
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

pub fn has_custom_password(app: &AppHandle) -> bool {
    let Ok(raw) = fs::read_to_string(data_dir(app).join("state.json")) else {
        return false;
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(raw.trim_start_matches('\u{feff}')) else {
        return false;
    };
    val.get("auth").and_then(|a| a.get("changed")).and_then(|c| c.as_bool()) == Some(true)
}

pub fn read_password(app: &AppHandle) -> Option<String> {
    if has_custom_password(app) {
        return None;
    }
    fs::read_to_string(data_dir(app).join("password.txt")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn bundled_src_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().resource_dir().map_err(|e| e.to_string())?.join("server-app"))
}

pub fn server_files_present(app: &AppHandle) -> bool {
    let dest = app_dir(app);
    dest.join("server").join("index.js").is_file()
        && dest.join("dist").join("index.html").is_file()
        && dest.join("package.json").is_file()
}

fn prod_deps_spec(lock_path: &Path) -> Option<(serde_json::Value, serde_json::Map<String, serde_json::Value>)> {
    let raw = fs::read_to_string(lock_path).ok()?;
    let val: serde_json::Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()?;
    let pkgs = val.get("packages")?.as_object()?;
    let root_deps = pkgs.get("")?.get("dependencies").cloned().unwrap_or(serde_json::Value::Null);
    let mut prod = serde_json::Map::new();
    for (k, v) in pkgs {
        if k.is_empty() {
            continue;
        }
        if v.get("dev").and_then(|d| d.as_bool()) == Some(true) {
            continue;
        }
        prod.insert(k.clone(), v.clone());
    }
    Some((root_deps, prod))
}

fn dep_package_json(node_modules: &Path, name: &str) -> PathBuf {
    let mut p = node_modules.to_path_buf();
    for part in name.split('/') {
        p = p.join(part);
    }
    p.join("package.json")
}

/// True when `dest/node_modules` is intact and matches the production dependency graph in `src/package-lock.json`.
/// App version bumps (e.g. 0.3.1 -> 0.3.2) and devDependencies changes do not invalidate this.
pub fn deps_up_to_date(src: &Path, dest: &Path) -> bool {
    if dest.join(".deps-failed").exists() {
        return false;
    }
    let nm = dest.join("node_modules");
    if !nm.join(".package-lock.json").is_file() {
        return false;
    }
    let Some((src_deps, src_pkgs)) = prod_deps_spec(&src.join("package-lock.json")) else {
        return false;
    };
    let Some((dest_deps, dest_pkgs)) = prod_deps_spec(&dest.join("package-lock.json")) else {
        return false;
    };
    if src_deps != dest_deps || src_pkgs != dest_pkgs {
        return false;
    }
    if let Some(obj) = src_deps.as_object() {
        for name in obj.keys() {
            if !dep_package_json(&nm, name).is_file() {
                return false;
            }
        }
    }
    true
}

pub fn needs_deps_install(app: &AppHandle) -> bool {
    let Ok(src) = bundled_src_dir(app) else {
        return true;
    };
    !deps_up_to_date(&src, &app_dir(app))
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

/// One job object for the app's lifetime, set to kill everything in it when its last handle
/// closes. The server and the Claude Code processes it starts join it, so they die with the app
/// even when the app is killed or crashes, and never linger holding the port.
fn job() -> Option<usize> {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::*;
    static JOB: OnceLock<Option<usize>> = OnceLock::new();
    *JOB.get_or_init(|| unsafe {
        let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if h.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            h,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 { None } else { Some(h as usize) }
    })
}

fn join_job(child: &std::process::Child) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    match job() {
        Some(j) => unsafe { AssignProcessToJobObject(j as _, child.as_raw_handle() as _) != 0 },
        None => false,
    }
}

pub fn port_in_use(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Wait until the server answers /api/me.
pub fn wait_ready(app: &AppHandle, timeout: Duration) -> bool {
    let url = format!("{}/api/me", local_url(app));
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(2)).build();
    let end = Instant::now() + timeout;
    while Instant::now() < end {
        if agent.get(&url).call().is_ok() {
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
    pub fn is_running(&self) -> bool {
        self.0.lock().unwrap().pid.is_some()
    }

    pub fn start(&self, app: &AppHandle) {
        let gen = {
            let mut s = self.0.lock().unwrap();
            if s.want {
                return;
            }
            let port = local_port(app);
            if port_in_use(port) {
                drop(s);
                app.dialog()
                    .message(format!("連接埠 {port} 已經被別的程式占用（可能是另一個 imnotcc），本機 server 沒有啟動。\n可以在 {} 的 config.json 改 port。", base_dir(app).display()))
                    .title("imnotcc")
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
            let origins = app.state::<AppState>().config.lock().unwrap().origins.join(",");
            let child = hidden("node")
                .arg(app_dir(app).join("server").join("index.js"))
                .current_dir(app_dir(app))
                .env("IMNOTCC_DATA_DIR", data_dir(app))
                .env("IMNOTCC_PORT", local_port(app).to_string())
                .env("IMNOTCC_ORIGINS", origins)
                .stdin(Stdio::null())
                .stdout(out)
                .stderr(err)
                .spawn();
            match child {
                Ok(mut c) => {
                    if !join_job(&c) {
                        note(&log_path, "[imnotcc desktop] could not tie the server to the app; it may outlive a crash");
                    }
                    self.0.lock().unwrap().pid = Some(c.id());
                    let status = c.wait();
                    self.0.lock().unwrap().pid = None;
                    note(&log_path, &format!("[imnotcc desktop] server exited: {status:?}"));
                }
                Err(e) => note(&log_path, &format!("[imnotcc desktop] could not start node: {e}")),
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

fn copy_bundled_files(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("建立 server 目錄失敗：{e}"))?;
    for dir in ["server", "dist"] {
        let d = dest.join(dir);
        if d.exists() {
            fs::remove_dir_all(&d).map_err(|e| format!("無法清掉舊的 {dir} 檔案（還有程式在用嗎？）：{e}"))?;
        }
        copy_dir(&src.join(dir), &d).map_err(|e| format!("複製 {dir} 檔案失敗：{e}"))?;
    }
    for file in ["package.json", "package-lock.json"] {
        fs::copy(src.join(file), dest.join(file)).map_err(|e| format!("複製 {file} 失敗：{e}"))?;
    }
    Ok(())
}

fn package_version(dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(dir.join("package.json")).ok()?;
    serde_json::from_str::<serde_json::Value>(&raw).ok()?["version"].as_str().map(str::to_string)
}

/// Installs the Linux build of Claude Code at the SDK's version into `dest/linux`, so WSL sessions
/// run the same Claude Code as Windows ones. It lives in its own folder because npm removes
/// packages that do not match this OS from `node_modules`. Skipped without WSL; a failure only
/// leaves WSL on its own `claude`.
fn ensure_linux_claude(app: &AppHandle, log: &Arc<Mutex<File>>, dest: &Path) {
    let say = |line: &str| {
        let _ = writeln!(log.lock().unwrap(), "{line}");
        let _ = app.emit("install-log", line.to_string());
    };
    if !hidden("wsl.exe").args(["-l", "-q"]).output().map(|o| o.status.success()).unwrap_or(false) {
        return;
    }
    let Some(sdk) = package_version(&dest.join("node_modules").join("@anthropic-ai").join("claude-agent-sdk")) else {
        return;
    };
    let linux = dest.join("linux");
    let pkg = linux.join("node_modules").join("@anthropic-ai").join("claude-agent-sdk-linux-x64");
    if package_version(&pkg).as_deref() == Some(sdk.as_str()) {
        return;
    }
    say(&format!("下載 WSL 用的 Claude Code {sdk}（Linux 版，約 170 MB）…"));
    let spec = format!("@anthropic-ai/claude-agent-sdk-linux-x64@{sdk}");
    let result = fs::create_dir_all(&linux)
        .map_err(|e| e.to_string())
        .and_then(|_| {
            let manifest = linux.join("package.json");
            if manifest.exists() { Ok(()) } else { fs::write(manifest, r#"{"name":"imnotcc-linux-claude","private":true}"#).map_err(|e| e.to_string()) }
        })
        .and_then(|_| run_npm(app, log, &linux, &["install", "--force", "--os=linux", "--cpu=x64", "--libc=glibc", "--omit=dev", "--no-audit", "--no-fund", &spec]));
    if let Err(e) = result {
        say(&format!("WSL 用的 Claude Code 沒裝成功，WSL 會改用它自己安裝的 claude：{e}"));
    }
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

fn run_npm(app: &AppHandle, log: &Arc<Mutex<File>>, dest: &Path, args: &[&str]) -> Result<(), String> {
    let mut full_args = vec!["/C", "npm"];
    full_args.extend_from_slice(args);
    let mut child = hidden("cmd")
        .args(&full_args)
        .current_dir(dest)
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
        return Err(format!("npm 執行失敗（{status}）。常見原因：沒有網路、公司代理擋住 npm registry。"));
    }
    Ok(())
}

fn spawn_task<F>(app: AppHandle, task: F)
where
    F: FnOnce(&AppHandle, &Path) -> Result<(), String> + Send + 'static,
{
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        let log_path = log_dir(&app).join("install.log");
        let result = task(&app, &log_path);
        if let Err(e) = &result {
            note(&log_path, &format!("FAILED: {e}"));
        }
        let done = Done {
            ok: result.is_ok(),
            error: result.err(),
            password: read_password(&app),
            url: local_url(&app),
            log: log_path.display().to_string(),
        };
        INSTALLING.store(false, Ordering::SeqCst);
        let _ = app.emit("install-done", done);
    });
}

/// Install (or update/reinstall) the server on this PC. Progress goes out as
/// `install-log` events and the outcome as one `install-done` event.
pub fn start_install(app: AppHandle, force: bool) {
    spawn_task(app, move |a, log_path| install(a, log_path, force));
}

/// Update `@anthropic-ai/claude-agent-sdk` in place inside `server-app` without modifying
/// `package.json` or `package-lock.json`, stopping and restarting the local server cleanly.
pub fn start_sdk_update(app: AppHandle) {
    spawn_task(app, sdk_update);
}

fn install(app: &AppHandle, log_path: &Path, force: bool) -> Result<(), String> {
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

    let src = bundled_src_dir(app)?;
    let dest = app_dir(app);
    // Check before overwriting dest/package-lock.json so we compare against what is actually installed.
    let skip_npm = !force && deps_up_to_date(&src, &dest);

    if !skip_npm {
        fs::create_dir_all(&dest).map_err(|e| format!("建立 server 目錄失敗：{e}"))?;
        let _ = fs::write(dest.join(".deps-failed"), b"pending");
    }

    say(&format!("更新 server 檔案到 {}…", dest.display()));
    copy_bundled_files(&src, &dest)?;

    if skip_npm {
        say("相依套件版本未變更，沿用現有的 Claude Agent SDK 與套件（跳過下載）。");
    } else {
        say("下載相依套件（npm ci --omit=dev），第一次會花一點時間…");
        run_npm(app, &log, &dest, &["ci", "--omit=dev", "--no-audit", "--no-fund"])?;
        let _ = fs::remove_file(dest.join(".deps-failed"));
    }
    ensure_linux_claude(app, &log, &dest);

    let c = {
        let mut c = state.config.lock().unwrap();
        c.local = true;
        c.url = Some(format!("http://127.0.0.1:{}", c.port));
        c.installed_version = Some(crate::build_stamp(app));
        c.clone()
    };
    save_config(app, &c)?;
    debug_assert!(!needs_update(app, &c));

    say("啟動本機 server…");
    state.server.start(app);
    if !wait_ready(app, Duration::from_secs(30)) {
        return Err(format!("server 30 秒內沒有回應，請看 {}", log_dir(app).join("server.log").display()));
    }
    say("完成。");
    Ok(())
}

fn sdk_update(app: &AppHandle, log_path: &Path) -> Result<(), String> {
    let log = Arc::new(Mutex::new(File::create(log_path).map_err(|e| format!("無法寫入 {}：{e}", log_path.display()))?));
    let say = |line: &str| {
        let _ = writeln!(log.lock().unwrap(), "{line}");
        let _ = app.emit("install-log", line.to_string());
    };

    let dest = app_dir(app);
    if !server_files_present(app) {
        return Err("本機 server 尚未安裝。".into());
    }

    say("檢查 Node.js…");
    let v = node_version()?;
    say(&format!("Node.js {v}"));

    let state = app.state::<AppState>();
    say("暫停本機 server 以更新 Claude Agent SDK…");
    state.server.stop();

    let _ = fs::write(dest.join(".deps-failed"), b"pending");
    say("正在下載最新版 @anthropic-ai/claude-agent-sdk…");
    let npm_res = run_npm(app, &log, &dest, &["install", "--no-save", "--omit=dev", "--no-audit", "--no-fund", "@anthropic-ai/claude-agent-sdk@latest"]);
    if let Err(e) = npm_res {
        // Bring the previous server back up so the desktop UI keeps working after a network failure.
        state.server.start(app);
        return Err(e);
    }
    let _ = fs::remove_file(dest.join(".deps-failed"));
    ensure_linux_claude(app, &log, &dest);

    say("重新啟動本機 server…");
    state.server.start(app);
    if !wait_ready(app, Duration::from_secs(30)) {
        return Err(format!("server 30 秒內沒有回應，請看 {}", log_dir(app).join("server.log").display()));
    }
    say("完成。");
    Ok(())
}

/// Update bundled server/web files in place when dependencies did not change, then start and open.
/// Falls back to the setup page if anything fails or dependencies need reinstalling.
pub fn update_and_open(app: &AppHandle, show: bool) {
    let app = app.clone();
    thread::spawn(move || {
        let res: Result<(), String> = (|| {
            let src = bundled_src_dir(&app)?;
            let dest = app_dir(&app);
            if !deps_up_to_date(&src, &dest) {
                return Err("needs npm ci".into());
            }
            let state = app.state::<AppState>();
            state.server.stop();
            copy_bundled_files(&src, &dest)?;
            let c = {
                let mut c = state.config.lock().unwrap();
                c.local = true;
                c.url = Some(format!("http://127.0.0.1:{}", c.port));
                c.installed_version = Some(crate::build_stamp(&app));
                c.clone()
            };
            save_config(&app, &c)
        })();
        if res.is_ok() {
            start_and_open(&app, show);
        } else {
            let a = app.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = open_window(&a, None, true);
            });
        }
    });
}

/// Start the installed server and open the window once it answers.
pub fn start_and_open(app: &AppHandle, show: bool) {
    app.state::<AppState>().server.start(app);
    let app = app.clone();
    thread::spawn(move || {
        let ready = wait_ready(&app, Duration::from_secs(30));
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("imnotcc-test-{tag}-{nanos}"));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_lock(dir: &Path, app_ver: &str, sdk_ver: &str, dev_ver: &str) {
        let json = format!(
            r#"{{
              "name": "imnotcc",
              "version": "{app_ver}",
              "lockfileVersion": 3,
              "packages": {{
                "": {{
                  "name": "imnotcc",
                  "version": "{app_ver}",
                  "dependencies": {{ "@anthropic-ai/claude-agent-sdk": "^{sdk_ver}", "express": "^5.3.0" }},
                  "devDependencies": {{ "vite": "^{dev_ver}" }}
                }},
                "node_modules/@anthropic-ai/claude-agent-sdk": {{ "version": "{sdk_ver}" }},
                "node_modules/express": {{ "version": "5.3.0" }},
                "node_modules/vite": {{ "version": "{dev_ver}", "dev": true }}
              }}
            }}"#
        );
        fs::write(dir.join("package-lock.json"), json).unwrap();
    }

    fn seed_node_modules(dest: &Path) {
        let nm = dest.join("node_modules");
        fs::create_dir_all(nm.join("@anthropic-ai").join("claude-agent-sdk")).unwrap();
        fs::create_dir_all(nm.join("express")).unwrap();
        fs::write(nm.join(".package-lock.json"), "{}").unwrap();
        fs::write(nm.join("@anthropic-ai").join("claude-agent-sdk").join("package.json"), "{}").unwrap();
        fs::write(nm.join("express").join("package.json"), "{}").unwrap();
    }

    #[test]
    fn deps_stay_valid_across_app_and_dev_bumps() {
        let root = temp_dir("deps");
        let src = root.join("src");
        let dest = root.join("dest");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dest).unwrap();

        write_lock(&dest, "0.3.1", "0.3.325", "8.3.8");
        seed_node_modules(&dest);
        write_lock(&src, "0.3.2", "0.3.325", "8.4.0");
        assert!(deps_up_to_date(&src, &dest));

        // Bumping a production dependency invalidates deps_up_to_date.
        write_lock(&src, "0.3.2", "0.3.326", "8.4.0");
        assert!(!deps_up_to_date(&src, &dest));

        // Restoring matching lockfile passes unless .deps-failed exists.
        write_lock(&src, "0.3.2", "0.3.325", "8.4.0");
        assert!(deps_up_to_date(&src, &dest));
        fs::write(dest.join(".deps-failed"), b"pending").unwrap();
        assert!(!deps_up_to_date(&src, &dest));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn copy_bundled_files_preserves_node_modules() {
        let root = temp_dir("copy");
        let src = root.join("src");
        let dest = root.join("dest");
        fs::create_dir_all(src.join("server")).unwrap();
        fs::create_dir_all(src.join("dist")).unwrap();
        fs::write(src.join("server").join("index.js"), "new-server").unwrap();
        fs::write(src.join("dist").join("index.html"), "new-dist").unwrap();
        fs::write(src.join("package.json"), "{}").unwrap();
        fs::write(src.join("package-lock.json"), "{}").unwrap();

        seed_node_modules(&dest);
        fs::create_dir_all(dest.join("server")).unwrap();
        fs::write(dest.join("server").join("stale.js"), "old").unwrap();

        copy_bundled_files(&src, &dest).unwrap();
        assert_eq!(fs::read_to_string(dest.join("server").join("index.js")).unwrap(), "new-server");
        assert!(!dest.join("server").join("stale.js").exists());
        assert!(dest.join("node_modules").join("@anthropic-ai").join("claude-agent-sdk").join("package.json").is_file());

        let _ = fs::remove_dir_all(root);
    }
}
