# Code Generation Plan — webpage

## Unit Context
- **Unit Name**: webpage
- **Workspace Root**: M:\aidlc-workflows\myproj
- **Project Type**: Greenfield
- **Deliverable**: Single self-contained HTML file

## Generation Steps

- [x] **Step 1 — Create `index.html`**
  - Location: `M:\aidlc-workflows\myproj\index.html` (workspace root)
  - Content:
    - `<!DOCTYPE html>` page structure
    - `<title>Dupa</title>` in `<head>`
    - Visible "Dupa" heading on page
    - CSS `perspective` container for 3D context
    - `.cube` wrapper with `transform-style: preserve-3d` and `@keyframes` rotation on X and Y axes
    - Six `.face` divs (front, back, left, right, top, bottom) positioned with CSS `translateZ`, `rotateY`, `rotateX`
    - Distinct background color per face for visual clarity
    - Centered layout, dark background for contrast

- [x] **Step 2 — Create `aidlc-docs/construction/webpage/code/index-summary.md`**
  - Document generated file path and description

## Success Criteria
- `index.html` opens in browser
- Title "Dupa" visible on page
- Cube rotates continuously on both axes
- All six faces visible during rotation
- No external dependencies
