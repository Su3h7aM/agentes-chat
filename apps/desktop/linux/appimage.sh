#!/bin/sh
# Builds the desktop app's Linux AppImage in a container, with `docker` (podman's works) (ADR 0202):
#
#   bun run desktop:appimage            (or: sh apps/desktop/linux/appimage.sh)
#
# It builds the image of ./Dockerfile (cached by Docker, so only the first run is slow) and runs build-appimage.sh in
# it as you, without root. Result, in Tauri's own bundle folder (apps/desktop/src-tauri/target/release/bundle/appimage):
# agentes_<version>_<amd64|arm64>.AppImage with its `.sha256` (and `.sig` when TAURI_SIGNING_PRIVATE_KEY is set). A
# build that isn't exactly the tagged release is named agentes_<version>+<commit>_<arch>.AppImage.
#
# The build shares the caches a native build uses, mounted read-write: Cargo's registry and git checkouts
# (${CARGO_HOME:-$HOME/.cargo}) and Bun's install cache (`bun pm cache`). Its Rust target folder is its own, `anylinux`
# in the native one (${CARGO_TARGET_DIR:-apps/desktop/src-tauri/target}), so the two compilers never meet in it. A
# missing cache folder is created only where it is the tool's own default. The image's own packages are whatever was
# newest when its layer was built: `docker rmi` the image to refresh them.
#
# Settings (all optional): TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD, for the updater signature.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
target=${CARGO_TARGET_DIR:-$root/apps/desktop/src-tauri/target}
out=$target/release/bundle/appimage

# One image per Dockerfile: a change to it is a new image, an unchanged one is a cache hit.
image=agentes-chat-appimage:$(sha256sum "$here/Dockerfile" | cut -c1-12)
docker build -t "$image" "$here"

mkdir -p "$out"
out=$(cd "$out" && pwd)

set -- run --rm --init --security-opt label=disable --user "$(id -u):$(id -g)" -v "$root:/repo:ro" -v "$out:/out"
# `docker` may be podman: rootless, it maps your uid to another one inside unless told to keep it, and then the mounted
# folders aren't yours.
if docker --version | grep -qi podman && [ "$(id -u)" != 0 ]; then
  set -- "$@" --userns=keep-id
fi
cargo_home=${CARGO_HOME:-$HOME/.cargo}
if command -v bun > /dev/null 2>&1; then
  bun_cache=$(cd "$root" && bun pm cache)
else
  bun_cache=${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install/cache}
fi
mkdir -p "$cargo_home/registry" "$cargo_home/git" "$bun_cache" "$target/anylinux"
# Absolute paths: a relative one isn't a mount source.
cargo_home=$(cd "$cargo_home" && pwd)
bun_cache=$(cd "$bun_cache" && pwd)
target=$(cd "$target/anylinux" && pwd)
set -- "$@" -v "$cargo_home/registry:/cache/cargo/registry" -v "$cargo_home/git:/cache/cargo/git" \
  -v "$bun_cache:/cache/bun" -v "$target:/cache/target"
# Settings the build reads, passed only when set.
for name in TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; do
  [ -z "$(printenv "$name")" ] || set -- "$@" -e "$name"
done

echo "Building in $image"
# label=disable: the mounts need no relabeling on SELinux hosts. --init reaps the virtual screen's processes.
exec docker "$@" "$image" bash /repo/apps/desktop/linux/build-appimage.sh
