# The build image for the desktop app's Linux AppImage (ADR 0259): Arch with everything the build needs installed and
# pinned, so build-appimage.sh runs in it without root. appimage.sh builds it and runs the build.
ARG BASE_IMAGE=ghcr.io/pkgforge-dev/archlinux:x86_64-v2026.11.20@sha256:b5519591e5231c6d3cbf8f0eaae20dbd37ff299799c1f7952778df5c84dcad35
FROM ${BASE_IMAGE}

# Bun: the version of the root package.json `packageManager` (build-appimage.sh fails if they differ), with the sha256
# of each release zip from the release's SHASUMS256.txt.
ARG BUN_VERSION=1.4.5
ARG BUN_SHA256_X64=94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb
ARG BUN_SHA256_AARCH64=18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84
# pkgforge-dev/Anylinux-AppImages at one commit, never `main`. quick-sharun itself pins sharun, appimagetool and uruntime
# by sha256, so this commit pins those too.
ARG ANYLINUX_COMMIT=88f5e3d58a526a35dea20a551571853dfc755703
ARG QUICK_SHARUN_SHA256=0760970276aa003a658f1658c15f43131943e7e13ada66e04c35abccabc694ee
ARG GET_DEBLOATED_SHA256=d215f7676785f1a1bb8784e69085d66c1df81488ef31f1ba7198325a5be05130
# What get-debloated-pkgs replaces: `--add-common` is GTK3, ICU, libxml2, opus, Qt, GTK4, glycin and Mesa;
# `webkit2gtk-4.1-mini` honours WEBKIT_EXEC_PATH, which an AppImage needs. Its packages carry the headers and .pc
# files, so the app is compiled against the same libraries it ships.
ARG DEBLOAT_ARGS="--add-common --prefer-nano webkit2gtk-4.1-mini"
# GStreamer plugins (`libgst<name>.so`) cut from the image. The app plays voice messages, audio and video through
# WebKitGTK, which needs the playback, demuxer, decoder and sink plugins that stay, and none of these: Vulkan (it drags
# libvulkan and every Vulkan driver in, ~44 MB), capture cards, hardware encoders, speech, ASCII-art sinks, tape and
# broadcast formats, and x265. build-appimage.sh checks they are gone, and that these are still there: the plugins
# playback, demuxing, decoding and the audio and video paths need.
ENV GST_PLUGINS_CUT="vulkan nvcodec decklink festival cacasink aasink jack dvb dv mxf x265"
ENV GST_PLUGINS_REQUIRED="playback coreelements typefindfunctions audioconvert audioresample volume autodetect isomp4 matroska opus ogg vorbis pulseaudio alsa app videoconvertscale"

# Build: rust and the headers Tauri compiles against (webkit2gtk-4.1 and gtk3 are replaced by the debloated builds
# below), xdotool for libxdo. Run: the stream plugins WebKit plays media with, bwrap and xdg-dbus-proxy (WebKit's
# sandbox). And what quick-sharun and its --test need: xvfb, dbus, file, patchelf, binutils and base-devel.
RUN pacman-key --init \
 && pacman -Syu --noconfirm --needed archlinux-keyring \
 && pacman -S --noconfirm --needed \
      base-devel binutils curl dbus file git jq patchelf perl pkgconf unzip wget xdotool xorg-server-xvfb \
      rust openssl librsvg libayatana-appindicator webkit2gtk-4.1 gtk3 \
      gst-plugins-base gst-plugins-good bubblewrap xdg-dbus-proxy

# The metadata-sidecar check reads the small SquashFS image appimagetool puts before the DwarFS payload. Refresh the
# package databases here because the cached layer above can be older than the packages on the current Arch mirrors.
RUN pacman -Syy --noconfirm --needed squashfs-tools

RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) zip=bun-linux-x64.zip; sha=$BUN_SHA256_X64 ;; \
      aarch64) zip=bun-linux-aarch64.zip; sha=$BUN_SHA256_AARCH64 ;; \
      *) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$zip"; \
    echo "$sha  /tmp/bun.zip" | sha256sum -c -; \
    unzip -q /tmp/bun.zip -d /tmp/bun; \
    install -m 755 /tmp/bun/*/bun /usr/local/bin/bun; \
    rm -rf /tmp/bun /tmp/bun.zip

RUN set -eu; \
    raw="https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/$ANYLINUX_COMMIT/useful-tools"; \
    curl -fsSL -o /usr/local/bin/quick-sharun "$raw/quick-sharun.sh"; \
    echo "$QUICK_SHARUN_SHA256  /usr/local/bin/quick-sharun" | sha256sum -c -; \
    curl -fsSL -o /usr/local/bin/get-debloated-pkgs "$raw/get-debloated-pkgs.sh"; \
    echo "$GET_DEBLOATED_SHA256  /usr/local/bin/get-debloated-pkgs" | sha256sum -c -; \
    chmod 755 /usr/local/bin/quick-sharun /usr/local/bin/get-debloated-pkgs

# The debloated packages come from the latest release of pkgforge-dev/archlinux-pkgs-debloated, which can't be pinned
# (it has a single rolling release): they are fixed for as long as this layer is cached.
RUN get-debloated-pkgs $DEBLOAT_ARGS

# quick-sharun deploys whatever plugin files the system's GStreamer folder has, so the cut is made here.
RUN set -eu; \
    test -d /usr/lib/gstreamer-1.0; \
    for name in $GST_PLUGINS_CUT; do rm -f /usr/lib/gstreamer-1.0/libgst"$name".so*; done

# anylinux.so, the library sharun preloads into the app, rebuilt from its own source with one change (ADR 0259, addendum
# of 2026-11-19): it forces glibc's `hosts` lookup to `files dns` and ignores the host's /etc/nsswitch.conf, so names
# resolve differently from how the host resolves them (glibc's own stub applies search domains where systemd-resolved
# doesn't). The source is Anylinux-sharun at the commit of the release quick-sharun downloads (`SHARUN_TAG`, which
# build-appimage.sh checks against quick-sharun), by sha256. Only the `hosts` row of the forced list is removed: every
# other database stays as upstream forces it.
ARG SHARUN_TAG=3.9.0
ARG SHARUN_COMMIT=dbdc13960827776e4758ab39da50767eaf012960
ARG ANYLINUX_C_SHA256=5c81cea1316def271f517bfedc9b82a8190957623d84cc84442c1f6477578464
ENV SHARUN_TAG=$SHARUN_TAG
RUN set -eu; \
    mkdir /tmp/anylinux; cd /tmp/anylinux; \
    curl -fsSL -o anylinux.c "https://raw.githubusercontent.com/pkgforge-dev/Anylinux-sharun/$SHARUN_COMMIT/lib/anylinux.c"; \
    echo "$ANYLINUX_C_SHA256  anylinux.c" | sha256sum -c -; \
    test "$(grep -c '^[[:space:]]*{ "hosts", *"files dns" },$' anylinux.c)" = 1; \
    sed -i '/^[[:space:]]*{ "hosts", *"files dns" },$/d' anylinux.c; \
    ! grep -q '"hosts"' anylinux.c; \
    gcc -shared -fPIC -O2 -Wall -Wextra -s anylinux.c -o /usr/local/lib/anylinux-hosts.so -ldl; \
    cd /; rm -rf /tmp/anylinux

# The build runs as the user who started it, whatever the uid: it needs folders it can write, and the folders the host's
# caches are mounted into (appimage.sh) must already exist as writable parents.
RUN mkdir -m 1777 /build /cache /cache/cargo
