//! WebKitGTK leaves microphone permission to the app. Only the bundled confirmation can answer its request.

use std::sync::Mutex;
use tauri::{async_runtime::Sender, WebviewWindow};

pub const LABEL: &str = "microphone";

#[derive(Default)]
pub struct Decision(Mutex<Option<Sender<bool>>>);

#[tauri::command]
pub fn microphone_decide(window: WebviewWindow, pending: tauri::State<Decision>, allow: bool) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("only the microphone prompt answers this".into());
    }
    let decision = pending
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("no microphone request")?;
    decision.try_send(allow).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{Decision, LABEL};
    use crate::main_window;
    use gtk::glib::{self, translate::ToGlibPtr, Cast, ObjectExt};
    use gtk::prelude::GtkWindowExt;
    use tauri::{async_runtime::channel, AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
    use webkit2gtk::{
        LoadEvent, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt,
        WebView, WebViewExt,
    };

    pub fn install(app: &AppHandle, view: &WebView) {
        let on_load = app.clone();
        view.connect_load_changed(move |_, event| {
            if event == LoadEvent::Started {
                cancel(&on_load);
            }
        });
        let on_route = app.clone();
        view.connect_uri_notify(move |_| cancel(&on_route));
        let app = app.clone();
        view.connect_permission_request(move |view, request| {
            let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                return false;
            };
            // SAFETY: the binding lacks the display getter. This live request is valid for the duration of the call.
            let display = unsafe {
                webkit2gtk::ffi::webkit_user_media_permission_is_for_display_device(media.to_glib_none().0) != 0
            };
            if media.is_for_audio_device() && !media.is_for_video_device() && !display {
                let app = app.clone();
                let view = view.downgrade();
                let request = request.clone();
                glib::MainContext::default().spawn_local(async move {
                    let allowed = if let Some(view) = view.upgrade() {
                        ask(&app, &view).await.unwrap_or(false)
                    } else {
                        false
                    };
                    if allowed {
                        request.allow()
                    } else {
                        request.deny()
                    }
                });
            } else {
                request.deny();
            }
            true
        });
        if let Some(settings) = WebViewExt::settings(view) {
            settings.set_enable_media_stream(true);
        }
    }

    fn cancel(app: &AppHandle) {
        let pending = app.state::<Decision>();
        let decision = pending.0.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(decision) = decision {
            let _ = decision.try_send(false);
        }
    }

    fn server_of(app: &AppHandle, view: &WebView) -> Option<Url> {
        let page = view.uri()?.parse::<Url>().ok()?;
        main_window::site(app).filter(|site| main_window::same_site(&page, site))
    }

    async fn ask(app: &AppHandle, view: &WebView) -> Option<bool> {
        let server = server_of(app, view)?;
        let page = view.uri()?;
        let parent = app.get_webview_window(main_window::LABEL)?;
        let server_text = serde_json::to_string(&server.origin().ascii_serialization()).ok()?;
        let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("microphone.html".into()))
            .parent(&parent)
            .ok()?
            .title("agentes.chat")
            .inner_size(480.0, 256.0)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .skip_taskbar(true)
            .visible(false)
            .initialization_script(format!("window.__agentesMicrophoneServer = {server_text};"))
            .build()
            .ok()?;
        let (tx, mut rx) = channel(1);
        let pending = app.state::<Decision>();
        *pending.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx.clone());
        let on_close = tx.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                let _ = on_close.try_send(false);
            }
        });
        let on_error = tx.clone();
        let watching = window.with_webview(move |webview| {
            let webview = webview.inner();
            let on_crash = on_error.clone();
            webview.connect_web_process_terminated(move |_, _| {
                let _ = on_crash.try_send(false);
            });
            webview.connect_load_failed(move |_, _, _, _| {
                let _ = on_error.try_send(false);
                false
            });
        });
        if let Ok(gtk) = window.gtk_window() {
            gtk.set_modal(true);
            gtk.set_destroy_with_parent(true);
        }
        let timeout = glib::timeout_source_new(
            std::time::Duration::from_secs(60),
            None,
            glib::Priority::DEFAULT,
            move || {
                let _ = tx.try_send(false);
                glib::ControlFlow::Break
            },
        );
        timeout.attach(None);
        let allowed = watching.is_ok() && window.show().is_ok() && rx.recv().await == Some(true);
        timeout.destroy();
        pending.0.lock().unwrap_or_else(|e| e.into_inner()).take();
        let _ = window.destroy();
        Some(allowed && view.uri().as_ref() == Some(&page) && server_of(app, view).as_ref() == Some(&server))
    }
}

#[cfg(target_os = "linux")]
pub use linux::install;
