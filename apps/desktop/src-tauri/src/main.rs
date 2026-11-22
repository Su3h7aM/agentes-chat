// No console window on Windows release builds (later); macOS ignores it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Inside an AppImage the bundled GTK is the app's own; the host session's GTK_MODULES name modules built
    // for the host's GTK and cannot load here, so every start prints their load failures (KDE's colorreload
    // and window-decorations). Accessibility does not ride on GTK_MODULES: the bundled stack reaches the
    // a11y D-Bus itself, which is why its absence prints its own connection warning either way.
    if std::env::var_os("APPDIR").is_some() {
        std::env::remove_var("GTK_MODULES");
    }
    agentes_desktop_lib::run();
}
