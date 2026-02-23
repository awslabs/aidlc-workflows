# Build Instructions

## Prerequisites
- **Build Tool**: None required — static HTML file
- **Dependencies**: None
- **System Requirements**: Any modern web browser (Chrome, Firefox, Edge, Safari)

## Build Steps

### 1. No Build Step Required
`index.html` is a self-contained static file. There is no compilation, bundling, or package installation needed.

### 2. Open in Browser

**Option A — File Explorer / Finder:**
Double-click `index.html` in your file manager.

**Option B — Command Line:**
```bash
# Windows
start index.html

# macOS
open index.html

# Linux
xdg-open index.html
```

**Option C — VS Code:**
Right-click `index.html` → **Open with Live Server** (if Live Server extension installed)
or right-click → **Reveal in File Explorer** → double-click.

### 3. Verify Build Success
- **Expected Output**: Browser opens showing a dark navy page with the heading "Dupa" and a 3D rotating cube below it
- **Build Artifacts**: `index.html` (workspace root) — no additional artifacts

## Troubleshooting

### Page appears blank
- Ensure you are opening `index.html` directly (not a directory)
- Try a different browser

### Cube not rotating
- Check browser supports CSS `transform-style: preserve-3d` (all modern browsers do)
- Disable any browser extensions that block CSS animations
