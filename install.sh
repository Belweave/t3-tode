#!/usr/bin/env bash
# t3-tode user-local installer. No changes to T3 Code data or provider credentials.
set -euo pipefail
VERSION="${T3_TODE_VERSION:-v0.1.0}"
NODE_VERSION="v24.21.0"
REPOSITORY="Belweave/t3-tode"
fail() { printf 't3-tode: %s\n' "$*" >&2; exit 1; }
case "$VERSION" in v[0-9]*.[0-9]*.[0-9]*) ;; *) fail 'Invalid T3_TODE_VERSION' ;; esac
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]] || fail 'Invalid release version'
case "$(uname -s)" in Darwin) PLATFORM=darwin ;; Linux) PLATFORM=linux ;; *) fail 'Use macOS/Linux, or install.ps1 for Windows (WSL).' ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; *) fail 'Supported architectures: arm64 and x64' ;; esac
[[ "$(id -u)" != 0 ]] || fail 'Run as your normal user, without sudo. The Chromium sandbox cannot run as root.'
for tool in curl tar; do command -v "$tool" >/dev/null || fail "Install $tool first"; done
if command -v sha256sum >/dev/null; then HASH=sha256sum; elif command -v shasum >/dev/null; then HASH=shasum; else fail 'Install sha256sum or shasum'; fi
checksum() { if [[ "$HASH" == sha256sum ]]; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
fetch() { curl --fail --location --silent --show-error --retry 3 --proto '=https' --proto-redir '=https' --tlsv1.2 "$1" -o "$2"; }
apt_install() {
  command -v apt-get >/dev/null || fail "Install these system packages with your package manager: $*; then rerun the installer."
  command -v sudo >/dev/null || fail "Install these system packages as an administrator: $*; then rerun the installer."
  printf 'Installing required Linux system libraries (sudo may ask for your password)…\n'
  sudo apt-get update -qq
  sudo apt-get install -y "$@"
}
if ! command -v unzip >/dev/null; then
  if [[ "$PLATFORM" == linux ]]; then apt_install unzip; else fail 'Install unzip first'; fi
fi
INSTALL_ROOT="${T3_TODE_INSTALL_DIR:-$HOME/.local/share/t3-tode/app}"
BIN_DIR="${T3_TODE_BIN_DIR:-$HOME/.local/bin}"
[[ "$INSTALL_ROOT" == /* && "$BIN_DIR" == /* ]] || fail 'Install and bin directories must be absolute paths'
mkdir -p "$INSTALL_ROOT/releases" "$BIN_DIR"
WORK=$(mktemp -d "$INSTALL_ROOT/releases/.install-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
ASSET="t3-tode-${VERSION}.tar.gz"
RELEASE_URL="https://github.com/$REPOSITORY/releases/download/$VERSION"
printf 'Installing t3-tode %s for %s-%s…\n' "$VERSION" "$PLATFORM" "$ARCH"
fetch "$RELEASE_URL/$ASSET" "$WORK/$ASSET"
fetch "$RELEASE_URL/SHA256SUMS" "$WORK/SHA256SUMS"
EXPECTED=$(awk -v name="$ASSET" '$2 == name || $2 == "*"name {print $1}' "$WORK/SHA256SUMS")
[[ "$EXPECTED" =~ ^[a-f0-9]{64}$ && "$(checksum "$WORK/$ASSET")" == "$EXPECTED" ]] || fail 'Release checksum verification failed'
mkdir "$WORK/app"
tar -xzf "$WORK/$ASSET" -C "$WORK/app" --strip-components=1
mkdir -p "$WORK/app/runtime/bin"
NODE=$(command -v node || true)
if [[ "${T3_TODE_NODE_DOWNLOAD:-0}" != 1 && -n "$NODE" ]] && "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===22&&b>=16)||(a===23&&b>=11)||(a===24&&b>=10)||a>=25 ? 0 : 1)'; then
  printf 'Reusing Node %s (%s)\n' "$("$NODE" --version)" "$NODE"
  ln -s "$NODE" "$WORK/app/runtime/bin/node"
else
  printf 'No compatible Node runtime found; installing private Node %s…\n' "$NODE_VERSION"
  NODE_ASSET="node-${NODE_VERSION}-${PLATFORM}-${ARCH}.tar.gz"
  fetch "https://nodejs.org/dist/$NODE_VERSION/$NODE_ASSET" "$WORK/$NODE_ASSET"
  fetch "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" "$WORK/NODE-SHASUMS"
  EXPECTED=$(awk -v name="$NODE_ASSET" '$2 == name {print $1}' "$WORK/NODE-SHASUMS")
  [[ "$EXPECTED" =~ ^[a-f0-9]{64}$ && "$(checksum "$WORK/$NODE_ASSET")" == "$EXPECTED" ]] || fail 'Node checksum verification failed'
  tar -xzf "$WORK/$NODE_ASSET" -C "$WORK/app/runtime" --strip-components=1
fi
MANAGER="${T3_TODE_PACKAGE_MANAGER:-auto}"
if [[ "$MANAGER" == auto ]]; then
  MANAGER=''
  for CANDIDATE in npm pnpm bun; do
    if command -v "$CANDIDATE" >/dev/null; then MANAGER="$CANDIDATE"; break; fi
  done
  # Downloaded Node includes npm when the machine had no package manager.
  if [[ -z "$MANAGER" && -x "$WORK/app/runtime/bin/npm" ]]; then MANAGER=npm; fi
fi
case "$MANAGER" in npm|pnpm|bun) ;; *) fail 'Set T3_TODE_PACKAGE_MANAGER to npm, pnpm, or bun' ;; esac
# Keep an existing manager on PATH; downloaded npm is available only as a fallback.
MANAGER_BIN=$(command -v "$MANAGER" || true)
if [[ -z "$MANAGER_BIN" && "$MANAGER" == npm && -x "$WORK/app/runtime/bin/npm" ]]; then MANAGER_BIN="$WORK/app/runtime/bin/npm"; fi
[[ -n "$MANAGER_BIN" ]] || fail "Requested package manager $MANAGER is not installed"
export PATH="$WORK/app/runtime/bin:$PATH"
printf 'Installing locked dependencies with %s…\n' "$MANAGER"
(
  cd "$WORK/app"
  case "$MANAGER" in
    npm) "$MANAGER_BIN" ci --ignore-scripts --omit=dev --no-audit --no-fund ;;
    pnpm) "$MANAGER_BIN" import && "$MANAGER_BIN" install --frozen-lockfile --prod --ignore-scripts ;;
    bun) "$MANAGER_BIN" install --frozen-lockfile --production --ignore-scripts ;;
  esac
  # Run only the required, pinned Pixel runtime setup regardless of manager policy.
  node node_modules/@zenbu-labs/pixel/scripts/postinstall.mjs
)
if [[ "$PLATFORM" == linux ]]; then
  ELECTRON="$WORK/app/node_modules/@zenbu-labs/pixel/electron/dist/pixel"
  command -v ldd >/dev/null || fail 'Install libc-bin (ldd) and rerun the installer'
  if ldd "$ELECTRON" 2>&1 | grep -q 'not found'; then
    AUDIO=libasound2
    if command -v apt-cache >/dev/null && apt-cache show libasound2t64 >/dev/null 2>&1; then AUDIO=libasound2t64; fi
    apt_install libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 "$AUDIO" libpango-1.0-0 libcairo2 libgtk-3-0 libx11-xcb1 libxshmfence1
    if ldd "$ELECTRON" 2>&1 | grep -q 'not found'; then ldd "$ELECTRON" >&2; fail 'Required Chromium libraries are still missing'; fi
  fi
fi
# Never replace an existing installation until downloads and dependency setup succeed.
DEST="$INSTALL_ROOT/releases/${VERSION}-$(date +%s)-$$"
mv "$WORK/app" "$DEST"
ln -s "$DEST" "$INSTALL_ROOT/.current-$$"
"$DEST/runtime/bin/node" -e 'require("node:fs").renameSync(process.argv[1],process.argv[2])' "$INSTALL_ROOT/.current-$$" "$INSTALL_ROOT/current"
# Quote arbitrary installation paths without evaluating them in the generated launcher.
printf -v QUOTED_ROOT '%q' "$INSTALL_ROOT"
LAUNCHER="$WORK/t3-tode"
# Generate a script with runtime variable expansion.
# shellcheck disable=SC2016
printf '#!/usr/bin/env bash\nset -e\nAPP=%s/current\nexport PATH="$APP/runtime/bin:$PATH"\nexec "$APP/runtime/bin/node" "$APP/bin/t3-tode.mjs" "$@"\n' "$QUOTED_ROOT" > "$LAUNCHER"
chmod 755 "$LAUNCHER"
mv -f "$LAUNCHER" "$BIN_DIR/t3-tode"
"$BIN_DIR/t3-tode" --doctor
# Persist PATH for common login and interactive shells, without duplicating entries.
# PATH expands when the shell sources this file.
# shellcheck disable=SC2016
printf 'export PATH=%q:"$PATH"\n' "$BIN_DIR" > "$INSTALL_ROOT/env"
printf -v SOURCE_LINE '. %q/env # t3-tode PATH' "$INSTALL_ROOT"
if [[ "${T3_TODE_NO_MODIFY_PATH:-0}" != 1 ]]; then
  for PROFILE in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
    if ! grep -Fq "$SOURCE_LINE" "$PROFILE" 2>/dev/null; then printf '\n%s\n' "$SOURCE_LINE" >> "$PROFILE"; fi
  done
fi
printf '\nInstalled. Start with: %s/t3-tode\n' "$BIN_DIR"
# Print a literal PATH instruction.
# shellcheck disable=SC2016
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) printf 'Add this to your shell profile, then open a new terminal:\n  export PATH="%s:$PATH"\n' "$BIN_DIR" ;; esac
printf 'Use Ghostty, Kitty, or cmux. Ctrl+Q quits. Run the same installer to update.\n'
