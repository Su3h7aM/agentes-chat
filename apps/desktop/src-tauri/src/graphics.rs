//! How this computer draws the app's windows: for the site (`renderer` and `system` in `window.__agentesDesktop`,
//! which calm its styles on the CPU and tag its error reports) and for the person to copy (Preferências ›
//! Atualizações, `app_info`). Anonymous facts only: never a host name, a user or a path.
//!
//! On Linux the person chooses it (Compatibility mode in Preferences › General), and WebKitGTK draws one of three
//! ways (`Draw`): off, on the graphics card with its DMA-BUF buffers; on, still on the graphics card but handing
//! frames over in shared memory (`WEBKIT_DMABUF_RENDERER_FORCE_SHM`); and last, without the graphics card
//! (`WEBKIT_DISABLE_DMABUF_RENDERER`). Until they choose, DMA-BUF is used on a stack known to draw well with it
//! (`good_stack`: Intel's or AMD's cards on their Mesa drivers, from a package) and shared memory anywhere else.
//! Shared memory leaves out the DMA-BUF and GBM buffers that go black with NVIDIA's driver, in virtual machines and
//! in many AppImage setups. Without it, WebKitGTK 2.50 (the AppImage's) paints the same page at 45 frames a second
//! for a whole core where the other two keep 60 at a tenth to a third of one. The choice is read before anything
//! starts (`choose`), since WebKitGTK reads those variables once. An opening whose page arrived from its server and
//! never painted moves the next one a step down, and on stays where it fell (the switch's file says `cpu`), so a
//! black window is never more than one opening away from a window. Without painting anything, `--compatibility-mode`
//! turns it on too (and reopens an app already running). A server older than the site's `page_ready` never clears
//! the opening's marker: every other opening there falls a step.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Manager};

const DMABUF_VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const SHM_VAR: &str = "WEBKIT_DMABUF_RENDERER_FORCE_SHM";
/// Set beside `DMABUF_VAR` or `SHM_VAR` when the app set them: a reopened app inherits them, and its own values are not
/// the person's.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const APP_SET_VAR: &str = "AGENTES_DESKTOP_DMABUF_BY_APP";
/// The Compatibility mode switch, in the app's config folder: "off"; "cpu", on after drawing in shared memory never
/// painted; "on", or anything else (none at all too) for the stack's default.
const COMPAT_FILE: &str = "compatibility-mode";
/// Turns Compatibility mode on from a terminal, for a window too black to reach Preferences.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const COMPAT_ARG: &str = "--compatibility-mode";
/// Set once `COMPAT_ARG` was taken: a reopened app keeps its arguments, and must not undo a later switch off.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const ARG_TAKEN_VAR: &str = "AGENTES_DESKTOP_COMPAT_ARG_TAKEN";
/// The opening's marker (cover.rs `PENDING_FILE`): the way it draws (`Draw::marker`) with this ending until its page
/// arrives from its server, then without: only an opening on the graphics card whose page arrived falls a step when
/// it never painted.
pub const LOADING: &str = "-loading";

/// How WebKitGTK draws this opening.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Draw {
    /// On the graphics card, with DMA-BUF buffers.
    Gpu,
    /// On the graphics card, frames handed over in shared memory.
    Shm,
    /// Without the graphics card.
    Cpu,
}

impl Draw {
    fn marker(self) -> &'static str {
        match self {
            Draw::Gpu => "gpu",
            Draw::Shm => "shm",
            Draw::Cpu => "cpu",
        }
    }
}

/// What the person's Compatibility-mode file chooses. `Cpu` is where an earlier shared-memory fallback stayed.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Choice {
    On,
    Off,
    Cpu,
}

/// Why this opening draws the way it does.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Why {
    /// Compatibility mode, on or off.
    Chosen,
    /// Nobody chose: DMA-BUF on a known-good stack, shared memory anywhere else.
    Default,
    /// The last opening, on the graphics card, never painted.
    Fallback,
    /// The person's own `WEBKIT_DISABLE_DMABUF_RENDERER` or `WEBKIT_DMABUF_RENDERER_FORCE_SHM`.
    Variable,
}

impl Why {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    fn as_str(self) -> &'static str {
        match self {
            Why::Chosen => "chosen",
            Why::Default => "default",
            Why::Fallback => "fallback",
            Why::Variable => "own variable",
        }
    }
}

static WHY: OnceLock<Why> = OnceLock::new();
/// This computer draws well with DMA-BUF (`good_stack`), read once as the app starts.
static GOOD_STACK: OnceLock<bool> = OnceLock::new();
static DRAW: OnceLock<Draw> = OnceLock::new();
/// The fallback is said once, by the first Preferences that asks (`compat_get`).
static FELL_BACK_UNSAID: AtomicBool = AtomicBool::new(false);

fn why() -> Why {
    WHY.get().copied().unwrap_or(Why::Chosen)
}

/// This opening fell a step because its page never painted (`choose`).
pub fn fell_back() -> bool {
    why() == Why::Fallback
}

/// The switch as its file says it: "on" or "off", or nothing chosen (no file, or anything else in it).
fn chosen(text: Option<&str>) -> Option<Choice> {
    match text.map(str::trim) {
        Some("on") => Some(Choice::On),
        Some("off") => Some(Choice::Off),
        Some("cpu") => Some(Choice::Cpu),
        _ => None,
    }
}

/// Whether Compatibility mode is on: as chosen, or, with nothing chosen, unless the stack is a good one.
fn compat_on(text: Option<&str>, good: bool) -> bool {
    match chosen(text) {
        Some(Choice::Off) => false,
        Some(_) => true,
        None => !good,
    }
}

/// Drawing with DMA-BUF is known to work: every graphics card is Intel's or AMD's on its Mesa driver, and the app
/// came in a package. WebKitGTK's DMA-BUF renderer leaves the window blank with NVIDIA's driver and in virtual
/// machines, and an AppImage brings its own copies of libraries that must match the system's Mesa.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn good_stack(drivers: &[String], appimage: bool) -> bool {
    !appimage && !drivers.is_empty() && drivers.iter().all(|d| matches!(d.as_str(), "i915" | "xe" | "amdgpu"))
}

/// How this opening draws, and why. `own_dmabuf`, `own_shm`: the person's own variables, which always win.
/// `chosen`: the switch, when the person set it. `good`: DMA-BUF is known to work on this stack (`good_stack`).
/// `last_unpainted`: what the last opening that never painted wrote in its marker (`marker`): only one whose page
/// arrived on the graphics card counts, never one that was offline, found its server down or quit first.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn decide(
    own_dmabuf: Option<&str>,
    own_shm: Option<&str>,
    chosen: Option<Choice>,
    good: bool,
    last_unpainted: Option<&str>,
) -> (Draw, Why) {
    let on = |v: Option<&str>| v.is_some_and(|v| v != "0");
    if on(own_dmabuf) {
        return (Draw::Cpu, Why::Variable);
    }
    if on(own_shm) {
        return (Draw::Shm, Why::Variable);
    }
    if own_dmabuf.is_some() {
        return (Draw::Gpu, Why::Variable);
    }
    let (draw, why) = match chosen {
        Some(Choice::Cpu) => (Draw::Cpu, Why::Chosen),
        Some(Choice::On) => (Draw::Shm, Why::Chosen),
        Some(Choice::Off) => (Draw::Gpu, Why::Chosen),
        None if good => (Draw::Gpu, Why::Default),
        None => (Draw::Shm, Why::Default),
    };
    let last = last_unpainted.map(str::trim);
    match (draw, last) {
        (Draw::Gpu, last) if last == Some(Draw::Gpu.marker()) => (Draw::Shm, Why::Fallback),
        (Draw::Shm, last) if last == Some(Draw::Shm.marker()) => (Draw::Cpu, Why::Fallback),
        _ => (draw, why),
    }
}

/// The opening's marker as it starts (cover.rs `opening`): "cpu", or the graphics card's way with `LOADING`; empty
/// outside Linux.
pub fn marker() -> String {
    match DRAW.get() {
        _ if !cfg!(target_os = "linux") => String::new(),
        _ if renderer() == "cpu" => Draw::Cpu.marker().into(),
        Some(Draw::Shm) => format!("{}{LOADING}", Draw::Shm.marker()),
        _ => format!("{}{LOADING}", Draw::Gpu.marker()),
    }
}

/// A marker that says its opening's page arrived on the graphics card (cover.rs `unpainted_on_gpu`).
pub fn arrived_on_gpu(marker: &str) -> bool {
    marker == Draw::Gpu.marker() || marker == Draw::Shm.marker()
}

/// The app's config folder as Tauri names it (`app_config_dir`), before Tauri is up.
#[cfg(target_os = "linux")]
fn config_dir() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(base.join(IDENTIFIER))
}

/// tauri.conf.json's `identifier`, the config folder's name.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const IDENTIFIER: &str = "chat.agentes.desktop";

/// Before any thread starts (main.rs): sets or clears the variable WebKitGTK draws by, as decided.
#[cfg(target_os = "linux")]
pub fn choose() {
    let dir = config_dir();
    let read = |name: &str| dir.as_ref().and_then(|d| std::fs::read_to_string(d.join(name)).ok());
    let own = |name: &str| match std::env::var_os(APP_SET_VAR) {
        Some(_) => None,
        None => std::env::var(name).ok(),
    };
    let mut compat = read(COMPAT_FILE);
    let asked = std::env::var_os(ARG_TAKEN_VAR).is_none() && std::env::args().any(|a| a == COMPAT_ARG);
    if asked {
        // On, but never back up from where an opening already fell: whoever reaches for it has a black window.
        if compat.as_deref().map(str::trim) != Some("cpu") {
            compat = Some("on".into());
            if let Some(dir) = &dir {
                let _ = write_compat(dir, "on");
            }
        }
        std::env::set_var(ARG_TAKEN_VAR, "1");
    }
    let last = read(crate::cover::PENDING_FILE);
    let good = good_stack(
        &cards().into_iter().map(|(_, driver)| driver).collect::<Vec<_>>(),
        std::env::var_os("APPIMAGE").is_some(),
    );
    let _ = GOOD_STACK.set(good);
    let choice = if asked { Some(Choice::On) } else { chosen(compat.as_deref()) };
    let (draw, why) = decide(
        own(DMABUF_VAR).as_deref(),
        own(SHM_VAR).as_deref(),
        choice,
        good,
        last.as_deref(),
    );
    if why != Why::Variable {
        let set = |name: &str, on: bool| if on { std::env::set_var(name, "1") } else { std::env::remove_var(name) };
        set(DMABUF_VAR, draw == Draw::Cpu);
        set(SHM_VAR, draw == Draw::Shm);
        set(APP_SET_VAR, draw != Draw::Gpu);
    }
    let _ = WHY.set(why);
    let _ = DRAW.set(draw);
}

#[cfg(not(target_os = "linux"))]
pub fn choose() {}

/// Once the app is up, never in a second launch on its way to the running one: an opening that fell a step stays
/// there (Compatibility mode on, or on without the graphics card), and Preferences says so once. True when it did; a
/// switch that couldn't be written is not claimed to be.
pub fn fall_back(app: &AppHandle) -> bool {
    let text = if DRAW.get() == Some(&Draw::Cpu) { "cpu" } else { "on" };
    let written = fell_back() && app.path().app_config_dir().is_ok_and(|dir| write_compat(&dir, text).is_ok());
    if written {
        FELL_BACK_UNSAID.store(true, Ordering::Relaxed);
    }
    written
}

/// The switch's file: "on", "off", or "cpu" (`fall_back`).
fn write_compat(dir: &Path, text: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(COMPAT_FILE), text)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Compat {
    on: bool,
    /// This opening fell back, not said yet: true for the first ask only.
    fell_back: bool,
    /// `WEBKIT_DISABLE_DMABUF_RENDERER` or `WEBKIT_DMABUF_RENDERER_FORCE_SHM` was the person's when the app started: it
    /// decides, `on` says whether it leaves DMA-BUF buffers out, and the switch can't change it.
    own: bool,
}

/// Preferences › General: Compatibility mode as it will be at the next opening. Async, as every command that reads a
/// file: a sync command runs on the main thread.
#[tauri::command]
pub async fn compat_get(app: AppHandle) -> Result<Compat, String> {
    let fell_back = FELL_BACK_UNSAID.swap(false, Ordering::Relaxed);
    if why() == Why::Variable {
        return Ok(Compat { on: DRAW.get() != Some(&Draw::Gpu), fell_back, own: true });
    }
    let dir = app.path().app_config_dir().ok();
    let text = tauri::async_runtime::spawn_blocking(move || {
        dir.and_then(|d| std::fs::read_to_string(d.join(COMPAT_FILE)).ok())
    })
    .await
    .map_err(|e| e.to_string())?;
    let good = GOOD_STACK.get().copied().unwrap_or(false);
    Ok(Compat { on: compat_on(text.as_deref(), good), fell_back, own: false })
}

/// Preferences › General: Compatibility mode for the next opening (WebKitGTK reads it only when the app starts).
#[tauri::command]
pub async fn compat_set(app: AppHandle, on: bool) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || write_compat(&dir, if on { "on" } else { "off" }).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// The line people copy (Preferences › Updates, the cover's Copy details) on every system: the app's version and
/// the system's, and on Linux how it draws. "agentes.chat 0.8.9 · macOS 15.1".
pub fn details_line(version: &str, os: &str, system_version: Option<&str>, linux: Option<&System>) -> String {
    let name = match os {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    let system = match system_version {
        Some(v) if !v.is_empty() => format!("{name} {v}"),
        _ => name.to_owned(),
    };
    let mut line = format!("agentes.chat {version} · {system}");
    if let Some(linux) = linux.map(System::line).filter(|l| !l.is_empty()) {
        line.push_str(" · ");
        line.push_str(&linux);
    }
    line
}

/// This app's details line, as `details_line` says it.
pub fn details(app: &AppHandle) -> String {
    details_line(
        &app.package_info().version.to_string(),
        std::env::consts::OS,
        crate::prepare::system_version().as_deref(),
        system().as_ref(),
    )
}

/// "cpu" when WebKitGTK paints every frame in software, "gpu" otherwise.
#[cfg(target_os = "linux")]
pub fn renderer() -> &'static str {
    let var = |name: &str| std::env::var(name).ok();
    renderer_for(
        var("WEBKIT_DISABLE_DMABUF_RENDERER").as_deref(),
        var("WEBKIT_DISABLE_COMPOSITING_MODE").as_deref(),
        webkit_version(),
    )
}

#[cfg(not(target_os = "linux"))]
pub fn renderer() -> &'static str {
    "gpu"
}

/// WebKitGTK reads these variables as on for any value but "0". From 2.44 on, without the DMA-BUF renderer there
/// is no other accelerated one left, so it paints on the CPU.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn renderer_for(dmabuf_off: Option<&str>, compositing_off: Option<&str>, webkit: (u32, u32, u32)) -> &'static str {
    let on = |v: Option<&str>| v.is_some_and(|v| v != "0");
    if on(compositing_off) || (on(dmabuf_off) && (webkit.0, webkit.1) >= (2, 44)) {
        "cpu"
    } else {
        "gpu"
    }
}

/// The WebKitGTK the app runs on (webkit2gtk-rs wraps no version call: the C ones return the library's own
/// constants, from any thread).
#[cfg(target_os = "linux")]
fn webkit_version() -> (u32, u32, u32) {
    // SAFETY: plain getters with no arguments and no state.
    unsafe {
        (
            webkit2gtk::ffi::webkit_get_major_version(),
            webkit2gtk::ffi::webkit_get_minor_version(),
            webkit2gtk::ffi::webkit_get_micro_version(),
        )
    }
}

// Capture GDK on the GTK thread, then read only this value from commands and window callbacks.
#[cfg(target_os = "linux")]
static GDK_BACKEND: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

#[cfg(target_os = "linux")]
pub fn capture_backend() {
    use webkit2gtk::glib::object::ObjectExt;
    let backend = gdk::Display::default().map_or("unknown", |display| match display.type_().name() {
        "GdkWaylandDisplay" => "wayland",
        "GdkX11Display" => "x11",
        _ => "unknown",
    });
    let _ = GDK_BACKEND.set(backend);
}

pub fn native_wayland() -> bool {
    #[cfg(target_os = "linux")]
    {
        GDK_BACKEND.get() == Some(&"wayland")
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// What a Linux computer says about how it draws.
#[derive(Serialize)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct System {
    pub distro: String,
    /// "wayland (GNOME)", "x11 (KDE)".
    pub session: String,
    pub gdk_backend: &'static str,
    pub webkit: String,
    /// Each graphics card by maker, with its kernel driver: "Intel (i915)", "AMD (amdgpu) + NVIDIA (nvidia)".
    pub gpu: String,
    pub renderer: &'static str,
    /// Why it draws that way: "chosen", "fallback" or "own variable".
    pub renderer_why: &'static str,
    /// "AppImage", or "package" (a deb, or anything else that put the app on this computer).
    pub bundle: &'static str,
}

impl System {
    /// "Ubuntu 26.04 LTS · wayland (GNOME) · GDK x11 · WebKitGTK 2.50.4 · Intel (i915) · CPU (chosen) · AppImage".
    pub fn line(&self) -> String {
        let gdk = format!("GDK {}", self.gdk_backend);
        let webkit = format!("WebKitGTK {}", self.webkit);
        let renderer = format!("{} ({})", self.renderer.to_uppercase(), self.renderer_why);
        [
            self.distro.as_str(),
            self.session.as_str(),
            gdk.as_str(),
            webkit.as_str(),
            self.gpu.as_str(),
            renderer.as_str(),
            self.bundle,
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
    }
}

#[cfg(target_os = "linux")]
pub fn system() -> Option<System> {
    let var = |name: &str| std::env::var(name).unwrap_or_default();
    let (major, minor, micro) = webkit_version();
    Some(System {
        distro: std::fs::read_to_string("/etc/os-release").map(|t| distro_of(&t)).unwrap_or_default(),
        session: session_of(&var("XDG_SESSION_TYPE"), &var("XDG_CURRENT_DESKTOP")),
        gdk_backend: GDK_BACKEND.get().copied().unwrap_or("unknown"),
        webkit: format!("{major}.{minor}.{micro}"),
        gpu: gpus(),
        renderer: renderer(),
        renderer_why: why().as_str(),
        bundle: if std::env::var_os("APPIMAGE").is_some() { "AppImage" } else { "package" },
    })
}

#[cfg(not(target_os = "linux"))]
pub fn system() -> Option<System> {
    None
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn distro_of(os_release: &str) -> String {
    os_release
        .lines()
        .find_map(|l| l.strip_prefix("PRETTY_NAME="))
        .map(|v| v.trim().trim_matches('"').to_owned())
        .unwrap_or_default()
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn session_of(kind: &str, desktop: &str) -> String {
    match (kind.is_empty(), desktop.is_empty()) {
        (false, false) => format!("{kind} ({desktop})"),
        (false, true) => kind.to_owned(),
        (true, false) => desktop.to_owned(),
        (true, true) => String::new(),
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn gpu_of(vendor: &str, driver: &str) -> String {
    let maker = match vendor.trim() {
        "0x8086" => "Intel",
        "0x1002" => "AMD",
        "0x10de" => "NVIDIA",
        other => other,
    };
    match (maker.is_empty(), driver.is_empty()) {
        (false, false) => format!("{maker} ({driver})"),
        (false, true) => maker.to_owned(),
        _ => driver.to_owned(),
    }
}

/// The graphics cards the kernel shows (`/sys/class/drm/cardN`, never its connectors `cardN-HDMI-A-1`), in order, each
/// as its vendor id and kernel driver.
#[cfg(target_os = "linux")]
fn cards() -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else { return Vec::new() };
    let mut cards: Vec<(String, String, String)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let n = name.strip_prefix("card")?;
            (!n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).then(|| {
                let device = e.path().join("device");
                let vendor = std::fs::read_to_string(device.join("vendor")).unwrap_or_default();
                let driver = std::fs::read_link(device.join("driver"))
                    .ok()
                    .and_then(|p| p.file_name().map(|f| f.to_string_lossy().into_owned()))
                    .unwrap_or_default();
                (name, vendor, driver)
            })
        })
        .collect();
    cards.sort();
    cards.into_iter().map(|(_, vendor, driver)| (vendor, driver)).collect()
}

#[cfg(target_os = "linux")]
fn gpus() -> String {
    cards()
        .into_iter()
        .map(|(vendor, driver)| gpu_of(&vendor, &driver))
        .filter(|g| !g.is_empty())
        .collect::<Vec<_>>()
        .join(" + ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_renderer_webkitgtk_ends_up_with() {
        // The last step of Compatibility mode, on today's WebKitGTK (its default, shared memory, sets neither).
        assert_eq!(renderer_for(Some("1"), None, (2, 50, 4)), "cpu");
        // The person's own "=0" turns the DMA-BUF renderer back on.
        assert_eq!(renderer_for(Some("0"), None, (2, 50, 4)), "gpu");
        assert_eq!(renderer_for(None, None, (2, 50, 4)), "gpu");
        // Before 2.44 the older accelerated path was still there.
        assert_eq!(renderer_for(Some("1"), None, (2, 42, 5)), "gpu");
        assert_eq!(renderer_for(None, Some("1"), (2, 40, 0)), "cpu");
        assert_eq!(renderer_for(Some("0"), Some("0"), (2, 50, 4)), "gpu");
    }

    #[test]
    fn the_line_people_copy() {
        let os_release = "NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 26.04 LTS\"\nID=ubuntu\n";
        let system = System {
            distro: distro_of(os_release),
            session: session_of("wayland", "GNOME"),
            gdk_backend: "x11",
            webkit: "2.50.4".into(),
            gpu: gpu_of("0x8086\n", "i915"),
            renderer: "cpu",
            renderer_why: "chosen",
            bundle: "AppImage",
        };
        assert_eq!(
            system.line(),
            "Ubuntu 26.04 LTS · wayland (GNOME) · GDK x11 · WebKitGTK 2.50.4 · Intel (i915) · CPU (chosen) · AppImage"
        );
        assert_eq!(distro_of("ID=arch\n"), "");
        assert_eq!(session_of("", "Hyprland"), "Hyprland");
        assert_eq!(session_of("", ""), "");
        assert_eq!(gpu_of("0x1af4", ""), "0x1af4");
        assert_eq!(gpu_of("", "virtio-pci"), "virtio-pci");
        let blank = System { distro: String::new(), gpu: String::new(), ..system };
        assert_eq!(blank.line(), "wayland (GNOME) · GDK x11 · WebKitGTK 2.50.4 · CPU (chosen) · AppImage");
        assert_eq!(
            details_line("0.8.9", "linux", None, Some(&blank)),
            "agentes.chat 0.8.9 · Linux · wayland (GNOME) · GDK x11 · WebKitGTK 2.50.4 · CPU (chosen) · AppImage"
        );
        assert_eq!(details_line("0.8.9", "macos", Some("15.1"), None), "agentes.chat 0.8.9 · macOS 15.1");
        assert_eq!(details_line("0.8.9", "windows", None, None), "agentes.chat 0.8.9 · Windows");
    }

    #[test]
    fn how_an_opening_draws_and_why() {
        use Choice::{Cpu as CpuChoice, Off, On};
        use Draw::*;
        let on = Some(On);
        let off = Some(Off);
        let cpu = Some(CpuChoice);
        // The person's own variables win over everything, "0" included.
        assert_eq!(decide(Some("1"), None, off, true, Some("gpu")), (Cpu, Why::Variable));
        assert_eq!(decide(Some("0"), None, on, false, None), (Gpu, Why::Variable));
        assert_eq!(decide(None, Some("1"), off, true, None), (Shm, Why::Variable));
        assert_eq!(decide(Some("1"), Some("1"), on, true, None), (Cpu, Why::Variable));
        // Compatibility mode on: shared memory, and CPU only after that never painted.
        assert_eq!(decide(None, None, on, true, None), (Shm, Why::Chosen));
        assert_eq!(decide(None, None, on, false, Some("gpu")), (Shm, Why::Chosen));
        assert_eq!(decide(None, None, on, true, Some("shm")), (Cpu, Why::Fallback));
        assert_eq!(decide(None, None, cpu, true, None), (Cpu, Why::Chosen));
        // Off: DMA-BUF, and shared memory when that never painted.
        assert_eq!(decide(None, None, off, false, None), (Gpu, Why::Chosen));
        assert_eq!(decide(None, None, off, true, Some("cpu")), (Gpu, Why::Chosen));
        assert_eq!(decide(None, None, off, true, Some("gpu")), (Shm, Why::Fallback));
        // Nothing chosen: DMA-BUF on a known-good stack, shared memory anywhere else, with the same fallbacks.
        assert_eq!(decide(None, None, None, true, None), (Gpu, Why::Default));
        assert_eq!(decide(None, None, None, true, Some("gpu")), (Shm, Why::Fallback));
        assert_eq!(decide(None, None, None, false, None), (Shm, Why::Default));
        assert_eq!(decide(None, None, None, false, Some("shm")), (Cpu, Why::Fallback));
        // A marker from before the mode was written in it says nothing.
        assert_eq!(decide(None, None, off, true, Some("")), (Gpu, Why::Chosen));
        // Nor an opening whose page never arrived from its server (offline, the server down, quit first).
        assert_eq!(decide(None, None, off, true, Some("gpu-loading")), (Gpu, Why::Chosen));
        assert_eq!(decide(None, None, on, false, Some("shm-loading")), (Shm, Why::Chosen));
    }

    #[test]
    fn a_marker_says_its_page_arrived_on_the_graphics_card() {
        assert!(arrived_on_gpu("gpu") && arrived_on_gpu("shm"));
        assert!(!arrived_on_gpu("cpu") && !arrived_on_gpu("gpu-loading") && !arrived_on_gpu(""));
    }

    #[test]
    fn the_switch_as_chosen_and_the_default_by_stack() {
        for good in [true, false] {
            assert!(compat_on(Some("on"), good));
            assert!(compat_on(Some("on\n"), good));
            assert!(compat_on(Some("cpu"), good));
            assert!(!compat_on(Some("off"), good));
            assert!(!compat_on(Some("off\n"), good));
        }
        // Nothing chosen (no file, an empty or a garbled one): off on a good stack, on anywhere else.
        for text in [None, Some(""), Some("\u{0}garbled")] {
            assert!(!compat_on(text, true));
            assert!(compat_on(text, false));
        }
    }

    #[test]
    fn a_good_stack_is_intel_or_amd_on_mesa_from_a_package() {
        let drivers = |list: &[&str]| list.iter().map(|d| d.to_string()).collect::<Vec<_>>();
        assert!(good_stack(&drivers(&["i915"]), false));
        assert!(good_stack(&drivers(&["xe"]), false));
        assert!(good_stack(&drivers(&["amdgpu"]), false));
        assert!(good_stack(&drivers(&["i915", "amdgpu"]), false));
        // NVIDIA's driver, beside Intel's too; nouveau; virtual machines; no card; an AppImage.
        assert!(!good_stack(&drivers(&["i915", "nvidia"]), false));
        assert!(!good_stack(&drivers(&["nouveau"]), false));
        assert!(!good_stack(&drivers(&["virtio-pci"]), false));
        assert!(!good_stack(&drivers(&["vmwgfx"]), false));
        assert!(!good_stack(&drivers(&[]), false));
        assert!(!good_stack(&drivers(&["i915"]), true));
    }

    #[test]
    fn the_switch_lives_where_tauri_keeps_the_app_config() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], IDENTIFIER);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_details_line_names_no_home_folder_or_host() {
        let line = details_line("0.8.9", "linux", None, system().as_ref());
        let home = std::env::var("HOME").unwrap_or_default();
        if home.len() > 1 {
            assert!(!line.contains(&home), "{line}");
        }
        let host = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default();
        let host = host.trim();
        if host.len() > 3 {
            assert!(!line.contains(host), "{line}");
        }
    }
}
