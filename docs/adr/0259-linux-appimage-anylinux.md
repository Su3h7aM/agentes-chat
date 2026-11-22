# 0259. The Linux AppImage is built once, in a pinned Arch image

- Status: Accepted (built)
- Date: 2026-11-18
- Extends: 0036 (the desktop app), 0066 (one desktop app)
- Amends: 0066 §Builds (the Linux job built the AppImage and the deb together on Ubuntu 22.04)
- Code: `apps/desktop/linux/Dockerfile`, `build-appimage.sh` (runs in the image), `appimage.sh` (the command a person
  runs; `bun run desktop:appimage`), `stage-resources.ts`, `apps/desktop/src-tauri/tauri.linux.conf.json`, the `linux`
  job of `.github/workflows/desktop.yml`

## Context

The AppImage was made by Tauri's bundler on an Ubuntu 22.04 runner, from that system's WebKitGTK and with linuxdeploy,
which needed a wrapper to leave the two sidecars alone. The WebKitGTK an AppImage carries was the one an old Ubuntu
ships, and the graphics problems of ADR 0066 depend on it. A deb links the system's own libraries, so it is built on
the oldest system it should install on; an AppImage links nothing from the system, so it should be built from the
newest libraries, with every one of them inside.

## Decision

### 1. One build, in an image anyone can run

`apps/desktop/linux/Dockerfile` is Arch (`ghcr.io/pkgforge-dev/archlinux`, by tag and digest, with a pinned
x86_64 or aarch64 base chosen from the host architecture) with the build's packages,
Bun and the packaging tools installed and pinned. `bun run desktop:appimage` (`appimage.sh`) builds it with `docker` (podman's
emulation works: it adds `--userns=keep-id` when `docker` is podman and you aren't root; cached, so only the first run is slow) and runs `build-appimage.sh` in it as the user, without root. CI runs the
same command on the Ubuntu runners, both architectures, and keeps the release names, the updater signature, the checksum,
the runner's `--version` and the virtual-screen look test of ADR 0066.

Everything that needs root is in the Dockerfile: the packages, `get-debloated-pkgs` and the GStreamer cut below.
`quick-sharun` itself needs none to deploy, pack and test (its `sudo`/`pkexec` code is in the hooks that run inside the
AppImage). The script copies the repo, builds the server's files, the runner and agent-browser, compiles the app with
`tauri build --no-bundle` against the same debloated libraries it ships, stages the AppDir, runs `quick-sharun`, makes
the image, runs it 10 seconds on a virtual screen, signs it and writes the checksum. The architecture decides the Rust
triple, the Bun target, agent-browser's file and the `amd64`/`arm64` of the name.

The libraries are Arch's newest: `get-debloated-pkgs --add-common --prefer-nano webkit2gtk-4.1-mini` replaces GTK, ICU,
libxml2, Mesa and WebKitGTK with trimmed builds (`webkit2gtk-4.1-mini` honours `WEBKIT_EXEC_PATH`, which an AppImage
needs, and ships its headers), and `quick-sharun` (sharun) carries them with WebKitGTK's helpers, bubblewrap,
xdg-dbus-proxy and its own C library, so the file does not depend on the system's. `anylinux.so`, which starts the app's
children without the AppImage's library variables, is left on.

### 2. What is cut

The Dockerfile removes GStreamer plugins that pull heavy libraries or that a chat app never uses (`GST_PLUGINS_CUT`:
Vulkan, which would bring libvulkan and every driver, NVIDIA codecs, capture cards, speech, ASCII-art sinks, JACK, DVB,
DV, MXF, x265), and the build deploys with `DEPLOY_VULKAN=0`. The script removes `share/terminfo`, `share/tc` and the
translations of every language the app doesn't have (`packages/i18n`). Before the image is made it fails if a
`libvulkan*` or `*.icd.json`, a cut plugin, or a plugin that playback needs is in the wrong place.

### 3. The deb stays on Ubuntu 22.04

`tauri.linux.conf.json` lists only the deb and turns the updater artifacts off. The `linux` job builds the deb with
Tauri on 22.04 (`tauri build --bundles deb`), because a deb must link the libraries of the system that installs it. The
AppImage comes only from the image: there is one AppImage build. The release names are unchanged
(`apps/server/src/routes/desktop.ts` reads them).

The deb requires `libwebkit2gtk-4.1-0 (>= 2.42)`: Wry links cookie manager functions introduced in 2.42. The 0.8.13
deb installed with 2.40.5 but could not start; it started and loaded the chat with 2.42.5 and 2.50.4. Tauri also adds an
unversioned WebKitGTK dependency; both requirements must be satisfied. The AppImage carries its own WebKitGTK.

### 4. Where the app's files sit, and the updater

Under sharun the executable is `AppDir/bin/<name>`, and Tauri's resource folder is `<executable's folder>/../lib/<product
name>` first (`tauri-utils` `resource_dir`), so the resources are `AppDir/lib/agentes.chat/`, staged from the lists in
`tauri.conf.json` and `tauri.native.conf.json` (one list), and the sidecars are `AppDir/bin/agentes-runner` and
`agent-browser`, where `current_exe().parent()` finds them. Each exists once, and the sidecars are copied as built, after
`quick-sharun`, which would rewrite them.

The updater needs two things the Tauri bundler normally gives. The binary carries a marker for the kind of package it is
in (`__TAURI_BUNDLE_TYPE_VAR_UNK`, which the bundler's private `patch_binary` in `tauri-bundler` `src/bundle.rs` rewrites
to `…_APP` or `…_DEB`); without it the app asks the update server for `bundle=unknown`, which gets "nothing to install"
(`routes/desktop.ts`). Tauri has no option to set it without bundling, so the build writes `…_APP` itself, the same
length, and stops if the marker isn't there, which is how a Tauri release that changes it is noticed. And
`updater_builder()` takes the file to replace from `APPIMAGE` (`tauri-plugin-updater`), a restart runs `APPIMAGE` too
(`tauri::process::current_binary`), and `graphics.rs` reads it as well, so an update replaces the AppImage, not the
mounted copy.

### 5. Pinning

The image's base (tag and digest), `quick-sharun.sh` and `get-debloated-pkgs.sh` (one commit of Anylinux-AppImages, never
`main`, each with its sha256; `quick-sharun` pins sharun, appimagetool and uruntime by sha256 itself), Bun (the version of
`package.json`, which the script checks against the image's, with the release zips' sha256) and agent-browser (the
version and sha256 of `machine-protocol.ts`) are pinned. Not pinned: Arch's packages and the debloated set, which has one
rolling release; both are whatever was newest when the image layer was built, and `docker rmi` of the image refreshes them.

### 6. Caches: the host's own

The build keeps no cache of its own. It mounts, read-write, the caches a native build uses: Cargo's `registry` and `git`
under `${CARGO_HOME:-$HOME/.cargo}` and Bun's install cache (`bun pm cache`). They are always mounted, and a missing
folder is created only where it is the tool's own default. The build runs as the user (`--user`; podman adds
`--userns=keep-id`), so nothing it writes is root-owned. The repo is mounted read-only and copied inside.

The Rust target folder is the image's own, `anylinux` inside the native one, never the native folder itself: build
scripts and proc-macros are built into `<target>/release/{build,deps}` (even for a build with `--target`), where Arch's
rustc and the host's would keep invalidating each other's artifacts (and a native `cargo` running at the same time would fight them),
and Cargo doesn't track the system libraries a build script found. The app crate is built from a copy at another path, so
it is compiled every time. In CI, rust-cache keeps the whole target folder, `anylinux` included, and one step caches
Bun's.

### 7. Signing

With `TAURI_SIGNING_PRIVATE_KEY` set the script runs `tauri signer sign --app-version <version>` (the key and the
version-bound signature `tauri build` makes), producing `<name>.AppImage.sig`; the updater checks it against the key in
the app. Without it (a local build) there is no `.sig`, and such a build is not offered to updating apps. The file is
written to Tauri's own bundle folder for an AppImage (`apps/desktop/src-tauri/target/release/bundle/appimage`) and
named as a release is, `agentes_<version>_<arch>.AppImage` with its `.sig` and `.sha256`, when HEAD is at
`desktop-v<version>` and the tree is clean; any other build is `agentes_<version>+<commit>_<arch>.AppImage`, so a local or
untagged build never passes for the release (CI fetches the tag first, since it checks out a commit). No zsync
information goes in: updates are Tauri's own.

## Consequences

- The AppImage carries WebKitGTK and its C library; the debloated packages, DwarFS and the cuts keep it down.
- The first build compiles Tauri's Rust again in the image (the deb job compiles it on the host); after it, only what
  changed. CI builds the image each run.
- Two builds of one commit can differ with Arch's rolling packages; the look test of ADR 0066 is the gate.
- Contributors need `docker` (or podman's), and nothing else, to build the Linux AppImage.
- The `PATCHELF` wrapper that kept the sidecars unrewritten in linuxdeploy is gone with linuxdeploy.
- A native `cargo` and the image working at the same moment on the same registry don't share Cargo's package lock.
- The build's only setting is the signing key; it belongs to the build scripts, not to the server's configuration, so it is
  not in `packages/config/src/schema.ts`.

## Addendum 2026-11-19: host names resolve as the host resolves them

On a host whose DNS search domain has a wildcard record, the app could resolve a server's multi-label name to the
wildcard's address instead of the server's, and every new connection (each POST; a GET reused a connection opened at
start) failed its TLS handshake, while every other program on that host resolved the name correctly. The cause is not the app: `anylinux.so`, the library sharun preloads, forces glibc's
NSS to `hosts: files dns` and ignores the host's `/etc/nsswitch.conf` (`init_nssfix` in `lib/anylinux.c` of
Anylinux-sharun, added by Anylinux-AppImages PR 682 so that glibc doesn't dlopen modules the AppImage lacks; it has no
switch, and `ANYLINUX_LIB=0` would drop the whole library, including the clean environment it gives the app's
children). The bundled glibc therefore used its own stub resolver instead of the host's, which on a systemd-resolved
host is `nss-resolve`: for an AAAA query answered with no data the stub tries the name again under each search domain
(`name.<search domain>`), where resolved never appends a search domain to a name with a dot in it.

The decision: the `hosts` database is left to the host's `nsswitch.conf`; every other database stays as upstream forces
it. The Dockerfile builds `anylinux.so` from the source of the Anylinux-sharun release quick-sharun downloads (commit and
sha256 pinned, `SHARUN_TAG` checked against quick-sharun by `build-appimage.sh`) without the `hosts` row of the forced
list, and the script puts it in `lib/sharun-preload/` in place of the release's. The AppDir also carries
`libnss_resolve.so.2` and `libnss_myhostname.so.2`, named to quick-sharun so a change of its defaults can't drop them
(`verify_appdir` fails without them): they come from the same image as the bundled glibc, which an NSS module has to
match, and sharun puts the AppDir's libraries first, so a host's own copy is never preferred.

What the host lists and the AppImage doesn't have is skipped by glibc as an unavailable service, and the lookup goes
on to the next one: `mdns4_minimal` is taken from the host's libraries when they are compatible (sharun's library path
ends with the host's `ld.so.cache` folders) and skipped when they aren't; a `resolve` that can't reach resolved is
unavailable, and `files`, `myhostname` and `dns` answer, as on any host without systemd-resolved. Passwd, group and the
other databases keep upstream's forced `files`: the fault was name resolution, and those are where an incompatible host
module could cost the most for the least.

## Addendum 2026-11-19: the window's class is the app's identity

On Wayland a window's title bar and taskbar icon are not the window's own: the compositor reads the toplevel's `app_id`
and takes the icon of the desktop entry it names (the desktop file ID, `<app_id>.desktop`, or an entry whose
`StartupWMClass` is that id), and a window with no entry gets the compositor's own mark. GTK 3 has no way to hand an
icon over (`gtk_window_set_icon` does nothing on Wayland, and GTK 3 doesn't speak `xdg-toplevel-icon-v1`), so the app
can't fix this from inside the window. Unless told otherwise, GTK sets the `app_id` (and X11's `WM_CLASS`) to the
program's name, the binary's. The binary was `agentes-desktop` while the AppImage's entry was `agentes.chat.desktop`:
nothing was named for what the window said, and with nothing installed there was no entry to find at all.

The decision: the app has one identity for every name a system needs without a dot, `agentes-chat` (`APP_ID` in
`apps/desktop/src-tauri/src/lib.rs`), apart from the binary, which keeps `agentes-desktop` so that it stays told apart
from the runner and the sidecars that ship beside it. On Linux the app gives it to GTK with `g_set_prgname` before the
first window, GTK's own call for the application's name, so the window reports it: no preload, no environment variable,
no patched binary. Visible names (`productName`, window titles) stay `agentes.chat`, and the reverse-DNS identifier
(`chat.agentes.desktop`), which the data folders and existing installs hang on, is not touched. The AppImage's one
desktop entry is `agentes-chat.desktop` with `StartupWMClass=agentes-chat` and `Icon=agentes-chat` (the icon file is
`agentes-chat.png`); `build-appimage.sh` reads the binary from `Cargo.toml` and the identity from `APP_ID`, and
`verify_appdir` checks the entry, its fields and the icon.

The icon a person picks in the app (ADR 0179) is a picture the windows show, which on Wayland can't be a window's: on
Linux `app_icon.rs` keeps it as a hidden desktop entry named for the identity in the user's applications folder
(`agentes-chat.desktop`, `NoDisplay=true`, `Exec` the AppImage or the binary, `Icon=` the picture beside it in the app's
data folder, a new file for each pick because a compositor caches an icon by path), rewritten only when it changes. So
an AppImage that nothing has integrated, and the `.deb`, whose entry Tauri's bundler names and fills from the binary,
still get the icon in the title bar and the taskbar, and a new pick shows the next time a window opens.

Not done: Tauri's `enableGTKAppId`, which makes the GTK application register on the session bus under the identifier
(its own documentation says it prevents a second instance), and an `xdg-toplevel-icon-v1` client, which would need a
Wayland client written beside GTK 3 for a protocol only some compositors have.
