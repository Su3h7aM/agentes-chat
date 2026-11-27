#!/bin/bash
# Builds the desktop app's Linux AppImage. It runs inside the build image (Dockerfile), as the user who started it and
# without root: appimage.sh builds the image and starts this; ADR 0253 says why the AppImage is made this way.
#
# The repo is mounted read-only at $REPO_MOUNT and copied to $WORK, so a build never writes into the checkout. The
# caches are the host's own, mounted read-write under $CACHE: Cargo's registry and git checkouts, Bun's install cache
# and the Rust target folder. Output: $OUT (Tauri's own bundle folder for an AppImage) gets the AppImage, its `.sha256`
# and, when TAURI_SIGNING_PRIVATE_KEY is set, the updater's `.sig`.
set -euo pipefail

REPO_MOUNT=${REPO_MOUNT:-/repo}
WORK=${WORK:-/build}
CACHE=${CACHE:-/cache}
OUT=${OUT:-/out}
SRC=$WORK/src

# Knobs, all optional (appimage.sh passes them through): TAURI_SIGNING_PRIVATE_KEY and its _PASSWORD, which sign the
# AppImage for the updater.

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)
    TRIPLE=x86_64-unknown-linux-gnu
    # The baseline build: some x64 CPUs lack AVX2.
    BUN_TARGET=bun-linux-x64-baseline
    BROWSER=linux-x64
    PKG=amd64
    ;;
  aarch64)
    TRIPLE=aarch64-unknown-linux-gnu
    BUN_TARGET=bun-linux-arm64
    BROWSER=linux-arm64
    PKG=arm64
    ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

# The file's name is the release's: agentes_<version>_<arch>.AppImage. A build that isn't exactly the tagged release (HEAD
# isn't at desktop-v<version>, or the tree has uncommitted changes) says so with the commit: <version>+<commit>.
VERSION=$(jq -r .version "$REPO_MOUNT/apps/desktop/src-tauri/tauri.conf.json")
repo_git() { git -C "$REPO_MOUNT" -c safe.directory="$REPO_MOUNT" --no-optional-locks "$@"; }
tags=$(repo_git tag --points-at HEAD)
if printf '%s\n' "$tags" | grep -qx "desktop-v$VERSION" && [ -z "$(repo_git status --porcelain)" ]; then
  OUTNAME=agentes_${VERSION}_$PKG.AppImage
else
  OUTNAME=agentes_${VERSION}+$(repo_git rev-parse --short=9 HEAD)_$PKG.AppImage
fi

# The binary is the Cargo package's; the app's identity is `APP_ID` in the app's code, which GTK sends as the window's
# class (Wayland's `app_id`, X11's WM_CLASS), so it is also the desktop entry's file name, its `StartupWMClass` and its
# `Icon=` (ADR 0253, addendum of 2026-11-19).
APP=$(sed -n '/^\[package\]/,/^\[/s/^name = "\(.*\)"$/\1/p' "$REPO_MOUNT/apps/desktop/src-tauri/Cargo.toml")
APP_ID=$(sed -n 's/^pub const APP_ID: &str = "\(.*\)";$/\1/p' "$REPO_MOUNT/apps/desktop/src-tauri/src/lib.rs")
if [ -z "$APP" ] || [ -z "$APP_ID" ]; then
  echo "No package name in apps/desktop/src-tauri/Cargo.toml or no APP_ID in apps/desktop/src-tauri/src/lib.rs" >&2
  exit 1
fi

BIN_DIR=$SRC/apps/desktop/src-tauri/binaries
NATIVE_DIR=$SRC/apps/desktop/src-tauri/native
RUNNER=$BIN_DIR/agentes-runner-$TRIPLE
BROWSER_BIN=$BIN_DIR/agent-browser-$TRIPLE
DESKTOP_BIN=$BIN_DIR/agent-desktop-$TRIPLE

# Cargo's registry and git checkouts and Bun's install cache are the host's own, shared with a native build. The target
# folder is the image's own (`<host target>/anylinux`): Arch's rustc and the host's would otherwise invalidate each
# other's build scripts and proc-macros.
export HOME=$WORK/home
export CARGO_HOME=$CACHE/cargo
export CARGO_TARGET_DIR=$CACHE/target
export BUN_INSTALL_CACHE_DIR=$CACHE/bun
APP_BIN=$CARGO_TARGET_DIR/release/$APP
mkdir -p "$HOME" "$CARGO_HOME/registry" "$CARGO_HOME/git" "$CARGO_TARGET_DIR" "$BUN_INSTALL_CACHE_DIR"

say() { printf '\n==> %s\n' "$*"; }

# The image's anylinux.so is built from the sharun release quick-sharun downloads (Dockerfile): if quick-sharun moves to
# another release, the image's source pin must move with it.
quick_sharun_tag=$(sed -n 's|^SHARUN_LINK=.*Anylinux-sharun/releases/download/\([^/]*\)/.*|\1|p' "$(command -v quick-sharun)")
if [ "$quick_sharun_tag" != "$SHARUN_TAG" ]; then
  echo "quick-sharun uses sharun ${quick_sharun_tag:-?}, the image's anylinux.so is built from $SHARUN_TAG: update the Dockerfile's SHARUN_TAG, SHARUN_COMMIT and ANYLINUX_C_SHA256" >&2
  exit 1
fi

# The image pins Bun; the repo pins it too, and they must agree.
BUN_VERSION=$(sed -n 's/.*"packageManager": *"bun@\([^"]*\)".*/\1/p' "$REPO_MOUNT/package.json")
if [ "$(bun --version)" != "$BUN_VERSION" ]; then
  echo "The image has Bun $(bun --version), package.json pins $BUN_VERSION: update the Dockerfile's BUN_VERSION and checksums" >&2
  exit 1
fi

# ---- 1. A private copy of the repo ------------------------------------------------------------------------------
say "Copying the repo"
rm -rf "$SRC"
mkdir -p "$SRC"
# What the repo has: tracked files plus new ones that aren't ignored, so uncommitted work builds and nothing a
# contributor happens to have locally (node_modules, build output, other checkouts) comes along. A tracked file deleted
# from the working tree is skipped. Modification times survive the copy. `safe.directory` is for this one call: the
# mount's owner needn't be the user running the build.
git -C "$REPO_MOUNT" -c safe.directory="$REPO_MOUNT" ls-files -z --cached --others --exclude-standard \
  | while IFS= read -r -d '' file; do
      if [ -e "$REPO_MOUNT/$file" ] || [ -L "$REPO_MOUNT/$file" ]; then printf '%s\0' "$file"; fi
    done \
  | tar -C "$REPO_MOUNT" --null -T - -cf - | tar -C "$SRC" -xf -
cd "$SRC"
mkdir -p "$BIN_DIR"

# ---- 2. Dependencies, the server's files and the sidecars -------------------------------------------------------
say "bun install"
bun install --frozen-lockfile

say "The server's files"
# The same command as desktop.yml's `server` job.
bun scripts/native-package.ts folders --out "$WORK/native"
mkdir -p "$NATIVE_DIR"
# <out>/agentes/<version>/: the one version folder holds server/, web/ and licenses/.
mv "$WORK"/native/agentes/*/* "$NATIVE_DIR"
test -s "$NATIVE_DIR/server/native.js"
test -s "$NATIVE_DIR/web/index.html"
test -d "$NATIVE_DIR/licenses/npm"

# The web build writes a Brotli and a gzip copy beside each large script and stylesheet
# (apps/web/scripts/compress-dist.ts) for a server with nothing in front of it. The AppImage is already one
# compressed payload (DwarFS), so those copies would only duplicate the originals inside it. Removed here, for the
# desktop app alone: its server sends the originals with identity encoding when the copies are absent. Native
# packages and the container keep them (scripts/native-package.ts).
find "$NATIVE_DIR/web" -type f \( -name '*.br' -o -name '*.gz' \) -delete
test -n "$(find "$NATIVE_DIR/web" -name '*.js' -print -quit)"
test -n "$(find "$NATIVE_DIR/web" -name '*.css' -print -quit)"

say "The runner"
bun build --compile --target="$BUN_TARGET" apps/server/runner/main.ts --outfile "$RUNNER"
chmod +x "$RUNNER"

# The version, file and checksum are the ones the server hands to computers (machine-protocol.ts).
read -r AB_VERSION AB_ASSET AB_SHA < <(BROWSER_KEY=$BROWSER bun -e '
  import { AGENT_BROWSER_SHA256, AGENT_BROWSER_VERSION, agentBrowserAsset } from "./packages/adapters/src/machine-protocol.ts";
  const key = process.env.BROWSER_KEY;
  console.log([AGENT_BROWSER_VERSION, agentBrowserAsset(key), AGENT_BROWSER_SHA256[key]].join(" "));
')
say "agent-browser $AB_VERSION"
curl -fsSL -o "$BROWSER_BIN" "https://github.com/vercel-labs/agent-browser/releases/download/v$AB_VERSION/$AB_ASSET"
echo "$AB_SHA  $BROWSER_BIN" | sha256sum -c -
chmod +x "$BROWSER_BIN"

say "agent-desktop"
bun apps/desktop/scripts/fetch-agent-desktop.ts "$BIN_DIR" "$TRIPLE"
test -x "$DESKTOP_BIN"
"$DESKTOP_BIN" --version

say "The server here once"
bun apps/desktop/scripts/server-smoke.ts "$RUNNER" "$NATIVE_DIR"

# ---- 3. The app's binary ----------------------------------------------------------------------------------------
say "Icons"
(cd apps/desktop && bun scripts/icons.ts && bun run tauri icon app-icon-tile.png)

say "tauri build --no-bundle"
# No bundle: the AppImage is made below, and the Linux config (tauri.linux.conf.json) makes no updater artifacts.
(cd apps/desktop && bun run tauri build --no-bundle --config src-tauri/tauri.native.conf.json)
test -x "$APP_BIN"

# ---- 4. What goes into the AppDir -------------------------------------------------------------------------------

# Data folders quick-sharun copies that the app never reads.
cut_data_dirs() {
  local appdir=$1 dir keep lang
  # Terminal databases and Tcl's time zones: this is a GUI app, and the runner's terminals are the host's.
  rm -rf "$appdir/share/terminfo" "$appdir/share/tc"
  # Translations of GTK, GLib and friends: only the app's languages (packages/i18n), by language, so `pt_BR` and `pt`
  # both stay for Portuguese, and `zh_CN` for Chinese. English is the default and has no catalog.
  keep=$(cd "$SRC" && bun -e 'import { LOCALE_CODES } from "./packages/i18n/src/locale.ts"; console.log(LOCALE_CODES.map((c) => c.split("-")[0]).join(" "))')
  test -d "$appdir/share/locale"
  for dir in "$appdir"/share/locale/*/; do
    lang=$(basename "$dir")
    lang=${lang%%[_.@]*}
    case " $keep en " in *" $lang "*) ;; *) rm -rf "$dir" ;; esac
  done
}

# What must and must not be in the AppDir, checked before it becomes an image.
verify_appdir() {
  local appdir=$1 name stray
  # The app's own binary, as deployed (bin/$APP is a link to sharun): it must still say it is an AppImage,
  # or the update server turns the app away.
  if ! grep -q __TAURI_BUNDLE_TYPE_VAR_APP "$appdir/shared/bin/$APP"; then
    echo "The deployed binary has no AppImage bundle type marker" >&2
    exit 1
  fi
  # The anylinux.so that is in the AppDir is the image's (the one that doesn't force `hosts`), and the NSS modules a host's
  # `hosts:` line can name that are built for the bundled glibc are there.
  if ! cmp -s /usr/local/lib/anylinux-hosts.so "$appdir/lib/sharun-preload/anylinux.so"; then
    echo "The AppDir's anylinux.so is not the image's build" >&2
    exit 1
  fi
  for name in dns files resolve myhostname; do
    if [ ! -f "$appdir/lib/libnss_$name.so.2" ]; then
      echo "libnss_$name.so.2 is missing from the AppDir" >&2
      exit 1
    fi
  done
  # The window's class is the app's identity, which is also the one desktop entry's file name, its `StartupWMClass` and
  # its icon: on Wayland the compositor finds the title bar's and the taskbar's icon by matching the window's `app_id` to
  # the entry's file name.
  if [ ! -f "$appdir/$APP_ID.desktop" ] || [ "$(find "$appdir" -maxdepth 1 -name '*.desktop' | wc -l)" != 1 ]; then
    echo "The AppDir's one desktop entry is not $APP_ID.desktop" >&2
    exit 1
  fi
  if ! grep -qx "StartupWMClass=$APP_ID" "$appdir/$APP_ID.desktop" || ! grep -qx "Icon=$APP_ID" "$appdir/$APP_ID.desktop" \
    || [ ! -f "$appdir/$APP_ID.png" ] || ! cmp -s "$appdir/$APP_ID.png" "$appdir/.DirIcon"; then
    echo "$APP_ID.desktop doesn't carry StartupWMClass=$APP_ID and Icon=$APP_ID, or its icon is missing from the AppDir" >&2
    exit 1
  fi
  stray=$(find "$appdir" \( -name 'libvulkan*' -o -name '*.icd.json' \) | head -5)
  if [ -n "$stray" ]; then
    echo "Vulkan is in the AppDir (something still links it):" >&2
    echo "$stray" >&2
    exit 1
  fi
  for name in $GST_PLUGINS_CUT; do
    if [ -n "$(find "$appdir" -name "libgst$name.so*" | head -1)" ]; then
      echo "The GStreamer plugin $name is in the AppDir" >&2
      exit 1
    fi
  done
  for name in $GST_PLUGINS_REQUIRED; do
    if [ -z "$(find "$appdir" -name "libgst$name.so*" | head -1)" ]; then
      echo "The GStreamer plugin $name is missing from the AppDir" >&2
      exit 1
    fi
  done
  # The web build's precompressed copies are for a server of its own (native packages, the container); the
  # AppImage is compressed as a whole, so stage_appdir removes them from web/. Its scripts and stylesheets must
  # still be there, original and uncompressed.
  if [ -n "$(find "$appdir/lib/agentes.chat/web" \( -name '*.br' -o -name '*.gz' \) -print -quit)" ]; then
    echo "The AppDir carries precompressed web assets (its payload is already compressed)" >&2
    exit 1
  fi
  if [ -z "$(find "$appdir/lib/agentes.chat/web" -name '*.js' -print -quit)" ] \
    || [ -z "$(find "$appdir/lib/agentes.chat/web" -name '*.css' -print -quit)" ]; then
    echo "The AppDir's web assets are missing their original scripts or stylesheets" >&2
    exit 1
  fi
}

# KDE and other desktops read an AppImage's icon through libappimage, which only understands SquashFS. appimagetool
# 0.7.1 can keep the DwarFS payload and put .DirIcon, the desktop entry and a stub AppRun in a 128 KiB SquashFS sidecar
# between the runtime and the payload. Check that sidecar before the image leaves the build.
verify_appimage() {
  local image=$1 offset sidecar=$WORK/appimage-metadata.squashfs desktop=$WORK/appimage.desktop
  offset=$(readelf -h "$image" | awk '
    /Start of section headers:/ {start=$5}
    /Number of section headers:/ {count=$5}
    /Size of section headers:/ {size=$5}
    END {print start + count * size}
  ')
  if [ "$(dd if="$image" bs=1 skip="$offset" count=4 status=none)" != hsqs ]; then
    echo "The AppImage has no SquashFS metadata sidecar for its icon" >&2
    exit 1
  fi
  dd if="$image" of="$sidecar" bs=1 skip="$offset" count=131072 status=none
  unsquashfs -cat "$sidecar" .DirIcon > "$WORK/appimage-icon.png"
  if ! cmp -s "$WORK/appimage-icon.png" "$WORK/stage/AppDir/.DirIcon"; then
    echo "The AppImage metadata sidecar doesn't carry the app's icon" >&2
    exit 1
  fi
  unsquashfs -cat "$sidecar" "$APP_ID.desktop" > "$desktop"
  if ! grep -qx "StartupWMClass=$APP_ID" "$desktop" || ! grep -qx "Icon=$APP_ID" "$desktop"; then
    echo "The AppImage metadata sidecar doesn't carry the app's desktop identity" >&2
    exit 1
  fi
}

# The one place that decides the AppImage's contents. quick-sharun deploys the binary's libraries and WebKit's helper
# programs (it finds WebKitGTK itself); everything below it is copied by hand and is data or self-contained.
stage_appdir() {
  local stage=$WORK/stage appdir=$WORK/stage/AppDir
  rm -rf "$stage"
  mkdir -p "$stage/usr/bin" "$stage/usr/share/applications"
  cd "$stage"

  # Tauri's bundler writes this value into the binary: it is how the app knows it is an AppImage, and the update
  # server answers only an app that says so (`bundle=appimage`). Tauri has no option to set it without bundling, and
  # bundling would make the AppImage this build replaces. This mirrors `patch_binary` of tauri-bundler 2.10.6 (the
  # token `__TAURI_BUNDLE_TYPE_VAR_UNK` becomes `…_APP`, same length); verify_appdir checks the result.
  install -m 755 "$APP_BIN" usr/bin/"$APP"
  perl -0777 -pi -e 's/__TAURI_BUNDLE_TYPE_VAR_UNK/__TAURI_BUNDLE_TYPE_VAR_APP/g' usr/bin/"$APP"
  if ! grep -q __TAURI_BUNDLE_TYPE_VAR_APP usr/bin/"$APP" || grep -q __TAURI_BUNDLE_TYPE_VAR_UNK usr/bin/"$APP"; then
    echo "The binary doesn't carry Tauri's bundle type marker: the Tauri version changed how it is written" >&2
    exit 1
  fi

  # Named after the app's identity, as a desktop entry's file is (the desktop file ID): a Wayland compositor takes a
  # window's title bar and taskbar icon from the entry named by the window's `app_id`, which the app sets to `APP_ID`,
  # and an AppImage manager that installs the entry keeps its `StartupWMClass`, which X11 and some shells match instead.
  cat > "usr/share/applications/$APP_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=agentes.chat
Comment=agentes.chat
Exec=$APP %u
Icon=$APP_ID
Terminal=false
Categories=Office;
StartupWMClass=$APP_ID
MimeType=x-scheme-handler/agenteschat;
EOF
  # quick-sharun names the icon after the file it is given: it must be the desktop entry's `Icon=`.
  cp "$SRC/apps/desktop/src-tauri/icons/icon.png" "$stage/$APP_ID.png"

  # DEPLOY_VULKAN=0: no Vulkan loader or driver, which WebKitGTK's GL path doesn't use. libayatana-appindicator is
  # dlopened by the tray, so the binary doesn't list it: it is named here. So are systemd's resolver and hostname NSS
  # modules: glibc dlopens them by name from the host's nsswitch.conf (ADR 0253, addendum of 2026-11-19), and they
  # have to be the ones built for the glibc the AppImage carries.
  DEPLOY_VULKAN=0 DESKTOP=$stage/usr/share/applications/$APP_ID.desktop ICON=$stage/$APP_ID.png \
    quick-sharun ./usr/bin/"$APP" /usr/lib/libayatana-appindicator3.so.1 \
      /usr/lib/libnss_resolve.so.2 /usr/lib/libnss_myhostname.so.2
  cut_data_dirs "$appdir"

  # sharun preloads every library of lib/sharun-preload: its anylinux.so is replaced by the image's build of the same
  # source (Dockerfile), which leaves the `hosts` lookup to the host's nsswitch.conf.
  test -f "$appdir/lib/sharun-preload/anylinux.so"
  install -m 755 /usr/local/lib/anylinux-hosts.so "$appdir/lib/sharun-preload/anylinux.so"

  # Resources: Tauri looks for `<folder of the executable>/../lib/<product name>` first. Under sharun the executable
  # is `AppDir/bin/$APP`, so that is AppDir/lib/agentes.chat (see ADR 0253). The list is the one
  # tauri.conf.json and tauri.native.conf.json give the bundler.
  bun "$SRC/apps/desktop/linux/stage-resources.ts" "$SRC/apps/desktop/src-tauri" "$appdir/lib/agentes.chat" \
    "$SRC/apps/desktop/src-tauri/tauri.conf.json" "$SRC/apps/desktop/src-tauri/tauri.native.conf.json"

  # The sidecars sit beside the executable (the runner is found as `current_exe().parent()/agentes-runner`): all three are
  # self-contained, and none is passed to quick-sharun, which would rewrite them.
  install -m 755 "$RUNNER" "$appdir/bin/agentes-runner"
  install -m 755 "$BROWSER_BIN" "$appdir/bin/agent-browser"
  install -m 755 "$DESKTOP_BIN" "$appdir/bin/agent-desktop"
  for name in agentes-runner agent-browser agent-desktop; do
    test -x "$appdir/bin/$name"
  done

  test -s "$appdir/lib/agentes.chat/server/native.js"
  test -s "$appdir/lib/agentes.chat/web/index.html"
  test -s "$appdir/lib/agentes.chat/LICENSE"
  verify_appdir "$appdir"
  cd "$SRC"
}
say "The AppDir"
stage_appdir

# ---- 5. The AppImage --------------------------------------------------------------------------------------------
say "AppImage"
cd "$WORK/stage"
export OUTPATH=$WORK/image OUTNAME ARCH
# Updates are Tauri's own (the signed AppImage, `.sig`): no zsync information goes in, and none is guessed from CI's
# repository variable.
unset UPINFO GITHUB_REPOSITORY
rm -rf "$OUTPATH"
SQUASHFS_METADATA_SIDECAR=1 quick-sharun --make-appimage
IMAGE=$OUTPATH/$OUTNAME
test -s "$IMAGE"
verify_appimage "$IMAGE"

# Runs the AppImage for 10 s on a virtual screen inside this container (extracted, no FUSE): never on a real display.
export APPIMAGE_EXTRACT_AND_RUN=1
unset DISPLAY WAYLAND_DISPLAY
quick-sharun --test "$IMAGE"

# ---- 6. Output: the file, its updater signature and checksum ----------------------------------------------------
say "Output"
# The folder holds build output only, as Tauri's own bundle folder does: an older build's files go.
rm -f "$OUT"/*.AppImage "$OUT"/*.AppImage.sig "$OUT"/*.AppImage.sha256
cp "$IMAGE" "$OUT/$OUTNAME"
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  # The version goes into the signature, as `tauri build` does when it signs.
  (cd "$SRC/apps/desktop" && bun run tauri signer sign --app-version "$VERSION" "$OUT/$OUTNAME")
  test -s "$OUT/$OUTNAME.sig"
else
  echo "TAURI_SIGNING_PRIVATE_KEY is not set: no updater signature (a local build isn't offered to updating apps)."
fi
(cd "$OUT" && sha256sum "$OUTNAME" > "$OUTNAME.sha256")
ls -l "$OUT"
