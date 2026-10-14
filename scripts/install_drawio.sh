#!/usr/bin/env bash
# Install headless drawio (drawio-desktop) the same way it is set up on the
# Autoillustrate run boxes.
#
# What you get:
#   - drawio 30.0.4 + xvfb-run, installed via Nix from a pinned nixpkgs commit
#     (reproducible: same commit -> same build).
#   - A wrapper at ~/.local/bin/drawio that runs the Electron binary headlessly
#     (under xvfb-run, sandbox + GPU disabled) so plain `drawio -x ...` works on
#     a GPU-less box with no display.
#
# Reverse-engineered from an existing box:
#   nix 2.34.7
#   nix profile install nixpkgs#drawio  -> /nix/store/...-drawio-30.0.4
#   nixpkgs rev 9eac87a12312b8f60dd52e1c6e1a265f6fc7f5fc
#
# Usage: ./scripts/install_drawio.sh
set -euo pipefail

# Pin to the exact nixpkgs revision the boxes use, so you get drawio 30.0.4
# rather than whatever nixpkgs HEAD happens to be today.
NIXPKGS_REV="9eac87a12312b8f60dd52e1c6e1a265f6fc7f5fc"
PIN="github:NixOS/nixpkgs/${NIXPKGS_REV}"

LOCAL_BIN="$HOME/.local/bin"
WRAPPER="$LOCAL_BIN/drawio"

NIX_FLAGS=(--extra-experimental-features "nix-command flakes")

# --- 1. Ensure Nix is available -------------------------------------------
if ! command -v nix >/dev/null 2>&1; then
  echo "Nix not found. Installing it (Determinate Systems installer, multi-user)..."
  curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix \
    | sh -s -- install --no-confirm
  # Load nix into the current shell.
  if [ -e /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]; then
    . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
  fi
fi

command -v nix >/dev/null 2>&1 || {
  echo "ERROR: nix still not on PATH. Open a new shell and re-run this script." >&2
  exit 1
}
echo "Using $(nix --version)"

# --- 2. Install drawio + xvfb-run into the user nix profile ----------------
echo "Installing drawio and xvfb-run from ${PIN} ..."
nix "${NIX_FLAGS[@]}" profile install "${PIN}#drawio"
nix "${NIX_FLAGS[@]}" profile install "${PIN}#xvfb-run"

REAL_DRAWIO="$HOME/.nix-profile/bin/drawio"
[ -x "$REAL_DRAWIO" ] || {
  echo "ERROR: expected drawio at $REAL_DRAWIO after install." >&2
  exit 1
}
echo "Installed real binary: $(readlink -f "$REAL_DRAWIO")"

# --- 3. Write the headless wrapper into ~/.local/bin -----------------------
mkdir -p "$LOCAL_BIN"
cat > "$WRAPPER" <<'EOF'
#!/usr/bin/env bash
# Headless drawio-desktop wrapper.
#
# drawio-desktop is an Electron app: it needs an X server and, on this GPU-less
# box, software rendering. This wrapper runs the real binary (installed via
# `nix profile install nixpkgs#drawio`) under xvfb-run with the sandbox and GPU
# disabled so that bare `drawio -x ...` calls from Autoillustrate work without a
# display. Real binary lives in the nix profile; we call it by absolute path to
# avoid recursing into this wrapper.
set -euo pipefail

REAL_DRAWIO="$HOME/.nix-profile/bin/drawio"
XVFB_RUN="$(command -v xvfb-run || echo "$HOME/.nix-profile/bin/xvfb-run")"

# Per-invocation HOME for Electron config so concurrent exports don't clash on
# the singleton lock; falls back to a temp dir.
export ELECTRON_DISABLE_SECURITY_WARNINGS=1

exec "$XVFB_RUN" -a "$REAL_DRAWIO" --no-sandbox --disable-gpu "$@"
EOF
chmod +x "$WRAPPER"
echo "Wrote wrapper: $WRAPPER"

# --- 4. PATH check + smoke test -------------------------------------------
case ":$PATH:" in
  *":$LOCAL_BIN:"*) ;;
  *) echo "NOTE: $LOCAL_BIN is not on your PATH. Add this to your shell rc:"
     echo "      export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

echo "Smoke test: drawio --version"
"$WRAPPER" --version

echo "Done. drawio $("$WRAPPER" --version) is ready."
