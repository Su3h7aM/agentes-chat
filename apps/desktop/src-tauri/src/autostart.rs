//! Start at login with a quoted Desktop Entry command on Linux.

#[cfg(target_os = "linux")]
fn exec_arg(value: &str) -> String {
    let mut quoted = String::from("\"");
    for character in value.chars() {
        match character {
            '%' => quoted.push_str("%%"),
            '\\' => quoted.push_str("\\\\\\\\"),
            '"' | '$' | '`' => {
                quoted.push_str("\\\\");
                quoted.push(character);
            }
            _ => quoted.push(character),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(target_os = "linux")]
fn exec_line(path: &str) -> Result<String, String> {
    if path.contains(['\n', '\r', '\0']) {
        return Err("autostart executable path contains a newline or NUL".into());
    }
    Ok(format!(
        "/bin/sh -c {} {} {}",
        exec_arg(r#"exec "$0" "$@""#),
        exec_arg(path),
        crate::AUTOSTART_ARG
    ))
}

#[cfg(target_os = "linux")]
pub fn enable(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let executable = match app.env().appimage {
        Some(path) => std::path::PathBuf::from(path),
        None => tauri::utils::platform::current_exe()
            .map_err(|err| format!("cannot find autostart executable: {err}"))?,
    };
    let executable = executable
        .to_str()
        .ok_or("autostart executable path is not UTF-8")?;
    let exec = exec_line(executable)?;
    // auto-launch uses ~/.config/autostart, even when XDG_CONFIG_HOME is set.
    let dir = app
        .path()
        .home_dir()
        .map_err(|e| format!("cannot find home directory: {e}"))?
        .join(".config/autostart");
    let name = &app.package_info().name;
    let contents = format!("[Desktop Entry]\nType=Application\nName={name}\nExec={exec}\nStartupNotify=false\nTerminal=false\n");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{name}.desktop"));
    if std::fs::read(&path).ok().as_deref() == Some(contents.as_bytes()) {
        return Ok(());
    }
    webkit2gtk::glib::file_set_contents(&path, contents.as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", path.display()))
}

#[cfg(not(target_os = "linux"))]
pub fn enable(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().enable().map_err(|e| e.to_string())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use webkit2gtk::{
        gio::{self, prelude::*},
        glib,
    };

    #[test]
    fn exec_round_trips_through_gio() {
        let dir = glib::mkdtemp(std::env::temp_dir().join("agentes-exec-XXXXXX")).unwrap();
        let executable = dir.join("app space percent% quote\" dollar$ tick` slash\\");
        let marker = dir.join("result");
        std::fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s' \"$1\" > \"${0%/*}/result\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let desktop = dir.join("test.desktop");
        std::fs::write(
            &desktop,
            format!(
                "[Desktop Entry]\nType=Application\nName=Test\nExec={}\n",
                exec_line(executable.to_str().unwrap()).unwrap()
            ),
        )
        .unwrap();
        let app = gio::DesktopAppInfo::from_filename(&desktop).expect("GIO parses the entry");
        app.launch(&[], None::<&gio::AppLaunchContext>).unwrap();
        let value = (0..100).find_map(|_| {
            std::thread::sleep(std::time::Duration::from_millis(20));
            std::fs::read_to_string(&marker)
                .ok()
                .filter(|value| !value.is_empty())
        });
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(value.as_deref(), Some(crate::AUTOSTART_ARG));
    }
}
