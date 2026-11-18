//! The main window's cover: a page of the app itself (`cover.html`, local) over the server's page, so the
//! window is never blank. It shows when the app opens (at least 1 s), whenever the page loads whole again
//! (⌘R, macOS ending the page, switching servers) and while the server can't be reached; it goes when the
//! page says it painted (`page_ready`). The cover only asks the server open now whether it answers, to tell
//! offline from down, and may only ask to load the page again or to step aside (capabilities/cover.json).
//!
//! Not as a child web view on Linux: Tauri packs one into the window's vertical box, so the cover and the site
//! split the window instead of the cover lying over the page. There the window starts on `cover.html` in its only
//! web view and navigates to the site once the server answers; the page's own boot splash then takes over. The
//! cover page goes with that navigation, so its never-painted checks are kept here (`to_site`): the site loads
//! again, and then the window goes back to the cover, which says the page didn't open.
//!
//! A page that never paints while its server answers (seen on macOS: the web view's own HTTP cache left it stuck,
//! and only clearing it brought the site back) is never left as a blank window: the cover loads it again, then
//! again with that cache cleared (cookies and the site's storage stay: no one is signed out, nothing typed is
//! lost), and then says it didn't open. An opening that never painted clears that cache on the next one, and
//! each step is written to the window's log (`window.log` in the app's log folder).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use std::io::Write;
use std::path::PathBuf;

use tauri::window::Color;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder, WebviewUrl};

use crate::main_window;

pub const LABEL: &str = "main-cover";

/// Linux: how long the site may take to paint after leaving the cover page, before it loads again, and again before
/// the cover comes back (the cover's own first two steps are 12 s apart, stuck.ts).
const STUCK_AFTER: Duration = Duration::from_secs(12);
/// The splash when the app opens stays at least this long, even when the site is ready sooner.
pub const OPENING: Duration = Duration::from_secs(1);
/// The cover fades out (cover.css) before it is hidden.
const FADE: Duration = Duration::from_millis(260);
/// The sky's deepest tone (packages/ui sky SKY_TONES[0]), before the cover's page paints.
const SKY: Color = Color(10, 63, 156, 255);
/// Written when the window opens, removed when the site paints: still there at the next opening, the last one
/// never painted. It holds how that opening drew (graphics.rs `marker`), and whether its page arrived.
pub const PENDING_FILE: &str = "page-pending";
/// The marker is removed (`page_ready`) and moved on (`site_loaded`) from different threads.
static MARKER: Mutex<()> = Mutex::new(());

#[derive(Default)]
pub struct Cover(Mutex<Shown>);

#[derive(Default)]
struct Shown {
    /// Since when it covers the site, and for how long at least; `None` when hidden.
    since: Option<(Instant, Duration)>,
    /// Each showing gets a new one: a late hide meant for an earlier showing does nothing.
    generation: u64,
    /// Linux: each trip from the cover page to the site gets a new one, so only the last one's watch acts.
    watch: u64,
    /// Whether the site has painted since this window opened, cover or no cover.
    load: Load,
}

/// Whether the site has painted. The cover hides on the same signal, but the retry when the server here comes up
/// must not depend on the cover existing: Linux has none.
#[derive(Default)]
struct Load {
    painted: bool,
}

impl Load {
    fn opening(&mut self) {
        self.painted = false;
    }

    fn painted(&mut self) {
        self.painted = true;
    }

    fn needs_reload(&self) -> bool {
        !self.painted
    }
}

/// The window's inner size in points, for the cover's own. In points, never pixels: a web view's size, and the
/// share of the window it keeps as the window resizes, are worked out in points with the window's scale at the
/// moment it is made or resized. A size read in pixels is right only while that scale is the one it was read
/// with; when it isn't, the cover is twice the window on a 2× screen, its message off in a corner.
fn window_points(window: &tauri::Window) -> tauri::Result<LogicalSize<f64>> {
    Ok(window.inner_size()?.to_logical(window.scale_factor()?))
}

/// Linux starts the main window on the cover page instead of adding a child web view (Tauri puts a child web view
/// in the window's vertical box there, where it shares the height with the site instead of covering it).
pub fn opens_in_page() -> bool {
    cfg!(target_os = "linux")
}

fn separate_cover() -> bool {
    !opens_in_page()
}

/// Whether `url` is the app's cover page (Linux opens the main window on it).
pub fn on_cover_page(url: &Url) -> bool {
    url.path().ends_with("/cover.html")
}

/// Linux's cover: the main window's only web view while it shows the cover page. Every command the cover may call
/// takes it beside the separate cover's label.
pub fn main_on_cover(webview: &tauri::Webview) -> bool {
    opens_in_page() && webview.label() == main_window::LABEL && webview.url().is_ok_and(|u| on_cover_page(&u))
}

/// Adds the cover to the freshly made main window, showing (the splash). Nothing on Linux.
pub fn attach(app: &AppHandle, window: &tauri::Window) -> tauri::Result<()> {
    if !separate_cover() {
        return Ok(());
    }
    let size = window_points(window)?;
    let cover = WebviewBuilder::new(LABEL, WebviewUrl::App("cover.html".into()))
        // Transparent only where the site shows through it as it fades: a transparent WebView2 shows black, not
        // the web view under it, and drops the color.
        .transparent(!cfg!(target_os = "windows"))
        .background_color(SKY)
        .auto_resize();
    window.add_child(cover, LogicalPosition::new(0.0, 0.0), size)?;
    let mut shown = lock(app);
    shown.since = Some((Instant::now(), OPENING));
    shown.generation += 1;
    Ok(())
}

fn lock(app: &AppHandle) -> std::sync::MutexGuard<'_, Shown> {
    app.state::<Cover>().inner().0.lock().unwrap_or_else(|e| e.into_inner())
}

/// Covers the site now (it is loading a whole page again), for at least `min`. Already covering (the
/// splash, when the first load starts), it keeps whatever minimum is left.
pub fn show(app: &AppHandle, min: Duration) {
    // A whole page is loading again: the site has not painted this one yet, cover or no cover.
    lock(app).load.opening();
    let Some(cover) = app.get_webview(LABEL) else { return };
    let was_shown = {
        let mut shown = lock(app);
        let now = Instant::now();
        let left = shown
            .since
            .map(|(since, before)| before.saturating_sub(since.elapsed()))
            .unwrap_or_default();
        let was_shown = shown.since.is_some();
        shown.generation += 1;
        shown.since = Some((now, min.max(left)));
        was_shown
    };
    if !was_shown {
        let _ = cover.eval("window.__coverShown?.()");
    }
    // Whatever became of its size while it was hidden, it shows as large as the window.
    if let Some(Ok(size)) = app.get_window(main_window::LABEL).map(|w| window_points(&w)) {
        let _ = cover.set_size(size);
    }
    let _ = cover.show();
    main_window::keep_lights(app);
    // Typing goes to what shows, not to the page loading behind it.
    if window_is_key(app) {
        let _ = cover.set_focus();
    }
}

/// The main window is the one in front (focus moves only inside it, never brings it forward).
fn window_is_key(app: &AppHandle) -> bool {
    app.get_window(main_window::LABEL)
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false)
}

/// The site painted: the cover fades and steps aside (after its minimum, when it has one).
pub fn hide(app: &AppHandle) {
    let (wait, generation) = {
        let shown = lock(app);
        let Some((since, min)) = shown.since else { return };
        (min.saturating_sub(since.elapsed()), shown.generation)
    };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(wait);
        let current = |app: &AppHandle| lock(app).generation == generation;
        let cover = app.get_webview(LABEL);
        if !current(&app) {
            return;
        }
        if let Some(cover) = &cover {
            let _ = cover.eval("window.__coverFade?.()");
            std::thread::sleep(FADE);
        }
        {
            let mut shown = lock(&app);
            if shown.generation != generation {
                return; // shown again meanwhile
            }
            shown.since = None;
        }
        let Some(cover) = cover else { return };
        let _ = cover.hide();
        // Hiding a web view lays the window out anew, the buttons back at the title bar's top.
        main_window::keep_lights(&app);
        if window_is_key(&app) {
            if let Some(site) = app.get_webview(main_window::LABEL) {
                let _ = site.set_focus();
            }
        }
    });
}

/// The server here answers now at the address the window opens (local_server.rs: it came up, or Tailscale
/// shares it again). The window opens with the app, before that server is up: its first load was refused and
/// left nothing to reload, and the cover's own checks then find the server up and wait for a page that never
/// comes, so while the site hasn't painted, the window asks for it again.
pub fn server_here_ready(app: &AppHandle) {
    if !lock(app).load.needs_reload() {
        return; // the site painted already
    }
    let Some(site) = main_window::site(app) else { return };
    let origin = site.origin().ascii_serialization();
    if !crate::local_server::is_here(app, &origin) || !crate::local_server::answers_within(app, &origin, Duration::ZERO)
    {
        return;
    }
    if let Some(page) = app.get_webview(main_window::LABEL) {
        let _ = to_site(app, &page);
    }
}

/// The server here can't start while a page of it is on screen: the cover comes back over it (Try again, Copy
/// details), and loads the page again once it answers.
pub fn over_server_here(app: &AppHandle) {
    let Some(site) = main_window::site(app) else { return };
    if crate::local_server::is_here(app, &site.origin().ascii_serialization()) {
        show(app, Duration::ZERO);
    }
}

/// The site, once it painted its first screen (apps/web `pageReady`).
#[tauri::command]
pub fn page_ready(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    if webview.label() != main_window::LABEL {
        return Err("only the site says it painted".into());
    }
    lock(&app).load.painted();
    if let Some(path) = pending_path(&app).filter(|p| p.exists()) {
        let _marker = MARKER.lock();
        let _ = std::fs::remove_file(path);
    }
    hide(&app);
    Ok(())
}

/// The site's page finished loading (on Linux, on the graphics card, before it painted): when WebKit's own answer for
/// it is the page, the opening's marker says it arrived, so a window that then stays black falls back at the next
/// opening (graphics.rs `decide`). A load that failed (offline, the server down, a proxy's error page) leaves it as it
/// was.
pub fn site_loaded(app: &AppHandle, page: &tauri::WebviewWindow) {
    #[cfg(target_os = "linux")]
    {
        fn loading(path: &std::path::Path) -> bool {
            std::fs::read_to_string(path).is_ok_and(|m| m == crate::graphics::GPU_LOADING)
        }
        // Linux opens on the app's own cover page, which answers 200 from the app itself: only the site arriving counts.
        if page.url().is_ok_and(|u| on_cover_page(&u)) {
            return;
        }
        let Some(path) = pending_path(app).filter(|p| loading(p)) else { return };
        let _ = page.with_webview(move |view| {
            use webkit2gtk::{URIResponseExt, WebResourceExt, WebViewExt};
            let status = view.inner().main_resource().and_then(|r| r.response()).map(|r| r.status_code());
            let _marker = MARKER.lock();
            if arrived(status) && loading(&path) {
                let _ = std::fs::write(&path, crate::graphics::GPU_LOADED);
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (app, page);
}

/// The page's HTTP status as WebKit received it says the site's page arrived: an error status is a page too (a
/// proxy's 502 for a server that is down), but never the site's, so it never paints.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn arrived(status: Option<u32>) -> bool {
    status.is_some_and(|s| (200..=399).contains(&s))
}

/// This opening's page arrived on the graphics card and never painted: its window may be black.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn unpainted_on_gpu(app: &AppHandle) -> bool {
    pending_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .is_some_and(|m| m == crate::graphics::GPU_LOADED)
}

fn pending_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(PENDING_FILE))
}

/// The main window was just made: when the last opening never painted, its web cache goes first (the site is
/// asked for again once it is gone), and this opening is marked until the site paints.
pub fn opening(app: &AppHandle) {
    {
        let mut shown = lock(app);
        shown.load.opening();
        shown.watch += 1;
    }
    let Some(path) = pending_path(app) else { return };
    // Linux's window opens on the cover page, which goes to the site itself once its server answers (there is no
    // HTTP cache to clear there): loading the site now would put WebKit's error page where the cover was.
    if path.exists() && separate_cover() {
        note(app, "the last opening never painted: clearing the web cache");
        let handle = app.clone();
        clear_http_cache(app, move || load_again(&handle));
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, crate::graphics::marker());
}

/// The site, from its server again (a first load that never arrived leaves nothing to reload).
fn load_again(app: &AppHandle) {
    if let (Some(page), Some(site)) = (app.get_webview(main_window::LABEL), main_window::site(app)) {
        let _ = page.navigate(site);
    }
}

/// Linux: the main window leaves the cover page for the site. Still not painted after `STUCK_AFTER`, the site loads
/// again; after another, the window goes back to the cover with `?stuck` (cover/main.ts: Try again, Copy details,
/// Show anyway). Never left on a blank page.
fn to_site(app: &AppHandle, page: &tauri::Webview) -> Result<(), String> {
    let site = main_window::site(app).ok_or("no server chosen")?;
    let cover = page.url().ok().filter(on_cover_page);
    page.navigate(site).map_err(|e| e.to_string())?;
    let Some(mut cover) = cover else { return Ok(()) };
    cover.set_query(Some("stuck"));
    let watch = {
        let mut shown = lock(app);
        shown.watch += 1;
        shown.watch
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let waiting = |app: &AppHandle| {
            let shown = lock(app);
            shown.watch == watch && shown.load.needs_reload()
        };
        std::thread::sleep(STUCK_AFTER);
        if !waiting(&app) {
            return;
        }
        note(&app, "not painted after 12 s: loading again");
        load_again(&app);
        std::thread::sleep(STUCK_AFTER);
        if !waiting(&app) {
            return;
        }
        note(&app, "not painted after 24 s: the cover again");
        if let Some(page) = app.get_webview(main_window::LABEL) {
            let _ = page.navigate(cover);
        }
    });
    Ok(())
}

/// One line in the window's log: what the cover did to bring a stuck page back, to learn why it got stuck.
fn note(app: &AppHandle, what: &str) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("window.log")) {
        let _ = writeln!(file, "{at} {} {what}", app.package_info().version);
    }
}

/// Empties the web views' HTTP caches (on disk and in memory), never their cookies or the sites' storage, then
/// runs `then`. On macOS that is the default website data store's, which every web view of the app uses.
#[cfg(target_os = "macos")]
fn clear_http_cache(app: &AppHandle, then: impl FnOnce() + Send + 'static) {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::sync::Mutex;

    let then = Mutex::new(Some(then));
    let _ = app.run_on_main_thread(move || {
        // SAFETY: WebKit's data store, on the main thread; the strings, set and date are autoreleased objects
        // used right here, and the block is copied by WebKit and called once on the main thread.
        unsafe {
            let store: *mut AnyObject = msg_send![class!(WKWebsiteDataStore), defaultDataStore];
            let kinds: [*mut AnyObject; 2] = [
                msg_send![class!(NSString), stringWithUTF8String: c"WKWebsiteDataTypeDiskCache".as_ptr()],
                msg_send![class!(NSString), stringWithUTF8String: c"WKWebsiteDataTypeMemoryCache".as_ptr()],
            ];
            let since: *mut AnyObject = msg_send![class!(NSDate), distantPast];
            if store.is_null() || kinds.iter().any(|k| k.is_null()) || since.is_null() {
                if let Some(then) = then.lock().ok().and_then(|mut t| t.take()) {
                    then();
                }
                return;
            }
            let set: *mut AnyObject = msg_send![class!(NSSet), setWithObjects: kinds.as_ptr(), count: kinds.len()];
            let done = RcBlock::new(move || {
                if let Some(then) = then.lock().ok().and_then(|mut t| t.take()) {
                    then();
                }
            });
            let _: () = msg_send![store, removeDataOfTypes: set, modifiedSince: since, completionHandler: &*done];
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn clear_http_cache(_app: &AppHandle, then: impl FnOnce() + Send + 'static) {
    then();
}

/// The cover: load the site again (the cover stays until it paints): the server is reachable again after it
/// wasn't, or it answers and the page never painted. `fresh`: with the web cache cleared first.
#[tauri::command]
pub fn cover_retry(
    app: AppHandle,
    webview: tauri::Webview,
    fresh: Option<bool>,
    why: Option<String>,
) -> Result<(), String> {
    if webview.label() != LABEL && !main_on_cover(&webview) {
        return Err("only the cover asks this".into());
    }
    let page = app.get_webview(main_window::LABEL).ok_or("no site")?;
    // A first load that never arrived leaves nothing to reload: go to the server again.
    let site = main_window::site(&app).ok_or("no server chosen")?;
    if let Some(why) = why.as_deref().filter(|w| w.len() <= 80) {
        let how = if fresh == Some(true) { " with the web cache cleared" } else { "" };
        note(&app, &format!("{why}: loading again{how}"));
    }
    if webview.label() == main_window::LABEL {
        return to_site(&app, &page); // Linux: no HTTP cache to clear
    }
    if fresh == Some(true) {
        let handle = app.clone();
        clear_http_cache(&app, move || load_again(&handle));
        return Ok(());
    }
    page.navigate(site).map_err(|e| e.to_string())
}

/// Linux's cover is the window's only page: once the server answers, go to the site. The separate cover of
/// macOS and Windows leaves the site to load behind it, so it gets `false` and the site stays where it is.
#[tauri::command]
pub fn cover_reveal(app: AppHandle, webview: tauri::Webview) -> Result<bool, String> {
    if webview.label() != LABEL && !main_on_cover(&webview) {
        return Err("only the cover asks this".into());
    }
    if webview.label() == LABEL {
        return Ok(false);
    }
    to_site(&app, &webview)?;
    Ok(true)
}

/// The cover: which server the window opens, to ask whether it answers and to name it when it doesn't.
#[tauri::command]
pub fn cover_server(app: AppHandle, webview: tauri::Webview) -> Result<Option<String>, String> {
    if webview.label() != LABEL && !main_on_cover(&webview) {
        return Err("only the cover asks this".into());
    }
    Ok(main_window::site(&app).map(|s| s.origin().ascii_serialization()))
}

/// The cover's Copy details over a server other than the one here: the window's own story (the app's version, the
/// server it opens, what the cover did, from `window.log`), never the server here's.
#[tauri::command]
pub fn cover_details(app: AppHandle, webview: tauri::Webview) -> Result<String, String> {
    if webview.label() != LABEL && !main_on_cover(&webview) {
        return Err("only the cover asks this".into());
    }
    let server = main_window::site(&app).map(|s| s.origin().ascii_serialization()).unwrap_or_default();
    let log = app
        .path()
        .app_log_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("window.log")).ok())
        .unwrap_or_default();
    Ok(window_details(&crate::graphics::details(&app), &server, &log))
}

/// What the window's Copy details says: the system details line, the server, the last lines of `window.log`.
pub fn window_details(details: &str, server: &str, log: &str) -> String {
    let lines: Vec<&str> = log.lines().collect();
    let tail = lines[lines.len().saturating_sub(40)..].join("\n");
    format!("{details}\nserver: {server}\n\nwindow.log:\n{tail}\n")
}

/// The cover: the person chose to see the page as it is ("Mostrar assim mesmo"), after it didn't open.
#[tauri::command]
pub fn cover_hide(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    if webview.label() != LABEL && !main_on_cover(&webview) {
        return Err("only the cover asks this".into());
    }
    note(&app, "the page never painted: shown as it is, by hand");
    if webview.label() == main_window::LABEL {
        let page = app.get_webview(main_window::LABEL).ok_or("no site")?;
        let site = main_window::site(&app).ok_or("no server chosen")?;
        return page.navigate(site).map_err(|e| e.to_string());
    }
    hide(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_site_needs_a_reload_until_it_paints_once() {
        let mut load = Load::default();
        assert!(load.needs_reload());
        load.opening();
        assert!(load.needs_reload());
        load.painted();
        assert!(!load.needs_reload());
        load.opening();
        assert!(load.needs_reload());
    }

    #[test]
    fn the_windows_own_details() {
        let log: String = (1..=50).map(|n| format!("{n} 0.6.0 step {n}\n")).collect();
        let text = window_details("agentes.chat 0.6.0 · macOS 15.1", "https://chat.example.com", &log);
        assert!(text.starts_with("agentes.chat 0.6.0 · macOS 15.1\nserver: https://chat.example.com\n"));
        // The last 40 lines only.
        assert!(text.contains("11 0.6.0 step 11") && !text.contains("\n10 0.6.0 step 10"));
        assert!(window_details("agentes.chat 0.6.0 · macOS 15.1", "", "").ends_with("window.log:\n\n"));
    }

    #[test]
    fn only_the_sites_own_answer_says_the_page_arrived() {
        assert!(!arrived(None));
        assert!(!arrived(Some(0)));
        assert!(arrived(Some(200)));
        assert!(arrived(Some(304)));
        assert!(!arrived(Some(404)));
        assert!(!arrived(Some(502)));
    }
}
