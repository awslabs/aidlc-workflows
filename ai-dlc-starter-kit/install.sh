#!/usr/bin/env bash
# AI-DLC Starterkit — One-Command Installer
# Usage: curl -fsSL <url>/install.sh | bash
#        or run locally: ./install.sh

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[0;32m"
CYAN="\033[0;36m"
RESET="\033[0m"

STARTERKIT_HOME="${AIDLC_HOME:-$HOME/.aidlc-starterkit}"
BIN_DIR="${AIDLC_BIN_DIR:-/usr/local/bin}"
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "")"

echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${CYAN}║   AI-DLC Starterkit — Installer     ║${RESET}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════╝${RESET}"
echo ""

# --- Check if already installed ---
if [ -d "$STARTERKIT_HOME" ] && [ -f "$STARTERKIT_HOME/bin/aidlc" ]; then
    echo -e "${CYAN}AI-DLC already installed at $STARTERKIT_HOME${RESET}"
    echo ""
    echo "To reinstall: rm -rf $STARTERKIT_HOME && $0"
    echo "To update:    cd $STARTERKIT_HOME && git pull"
    echo ""
    exit 0
fi

# --- Find source (local install) or use embedded ---
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/init.sh" ]; then
    # Running locally from the starterkit repo
    SOURCE="$SCRIPT_DIR"
    echo -e "Source: ${GREEN}$SOURCE${RESET} (local)"
else
    echo "Error: This installer must be run from the AI-DLC starterkit directory."
    echo ""
    echo "  cd /path/to/ai-dlc-starterkit"
    echo "  ./install.sh"
    echo ""
    echo "Or use the one-line remote install (if hosted on GitHub):"
    echo "  curl -fsSL https://raw.githubusercontent.com/<user>/ai-dlc-starterkit/main/install.sh | bash"
    exit 1
fi

# --- Copy to home ---
echo ""
echo "Installing to: $STARTERKIT_HOME"

if [ -d "$STARTERKIT_HOME" ]; then
    rm -rf "$STARTERKIT_HOME"
fi

mkdir -p "$STARTERKIT_HOME"

# Copy essential files
cp -R "$SOURCE/rules" "$STARTERKIT_HOME/rules"
cp -R "$SOURCE/templates" "$STARTERKIT_HOME/templates"
cp -R "$SOURCE/bin" "$STARTERKIT_HOME/bin"
cp "$SOURCE/init.sh" "$STARTERKIT_HOME/init.sh"
cp "$SOURCE/CLAUDE.md" "$STARTERKIT_HOME/CLAUDE.md"

# Make scripts executable
chmod +x "$STARTERKIT_HOME/bin/aidlc"
chmod +x "$STARTERKIT_HOME/bin/aidlcstart"
chmod +x "$STARTERKIT_HOME/init.sh"

# Save install source for future updates
echo "$SOURCE" > "$STARTERKIT_HOME/.install-source"

echo -e "  ${GREEN}✓${RESET} Starterkit files → $STARTERKIT_HOME"

# --- Create symlinks in PATH ---
echo ""
echo "Linking commands to: $BIN_DIR"

create_symlink() {
    local src="$1"
    local dst="$2"

    if [ -L "$dst" ]; then
        rm "$dst"
    fi

    if [ -f "$dst" ] && [ ! -L "$dst" ]; then
        echo -e "  ${CYAN}⚠${RESET}  $dst exists (file, not symlink) — skipping"
        echo "     Run manually: sudo ln -sf $src $dst"
        return
    fi

    if ln -sf "$src" "$dst" 2>/dev/null; then
        echo -e "  ${GREEN}✓${RESET} $dst → $src"
    else
        echo ""
        echo -e "${CYAN}Need sudo to create symlinks in $BIN_DIR${RESET}"
        sudo ln -sf "$src" "$dst"
        echo -e "  ${GREEN}✓${RESET} $dst → $src"
    fi
}

create_symlink "$STARTERKIT_HOME/bin/aidlc" "$BIN_DIR/aidlc"
create_symlink "$STARTERKIT_HOME/bin/aidlcstart" "$BIN_DIR/aidlcstart"

# --- Set environment variable hint ---
SHELL_RC=""
case "$SHELL" in
    */zsh) SHELL_RC="$HOME/.zshrc" ;;
    */bash) SHELL_RC="$HOME/.bashrc" ;;
esac

if [ -n "$SHELL_RC" ] && ! grep -q "AIDLC_STARTERKIT" "$SHELL_RC" 2>/dev/null; then
    echo ""
    echo "To use 'aidlc' and 'aidlcstart' from any directory, add this to your shell config:"
    echo ""
    echo -e "  ${BOLD}export AIDLC_STARTERKIT=\"$STARTERKIT_HOME\"${RESET}"
    echo ""
    echo -n "Add to $SHELL_RC? [Y/n]: "
    read -r add_rc
    if [ "$add_rc" != "n" ] && [ "$add_rc" != "N" ]; then
        echo "" >> "$SHELL_RC"
        echo "# AI-DLC Starterkit" >> "$SHELL_RC"
        echo "export AIDLC_STARTERKIT=\"$STARTERKIT_HOME\"" >> "$SHELL_RC"
        echo -e "  ${GREEN}✓${RESET} Added to $SHELL_RC"
    else
        echo "  Skipped. You can add it manually later."
    fi
fi

# --- Done ---
echo ""
echo -e "${BOLD}${GREEN}Installation complete!${RESET}"
echo ""
echo -e "Commands available:"
echo -e "  ${BOLD}aidlcstart${RESET}    — Start AI-DLC in any project"
echo -e "  ${BOLD}aidlc${RESET}         — AI-DLC lifecycle CLI"
echo ""
echo -e "Get started:"
echo -e "  cd your-project"
echo -e "  aidlcstart                 # Initialize + start working"
echo ""
echo -e "Or try it now:"
echo -e "  aidlcstart ~/my-project    # Initialize in a specific directory"
echo ""
