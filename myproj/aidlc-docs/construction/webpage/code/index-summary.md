# Code Summary — webpage

## Generated Files

| File | Location | Description |
|------|----------|-------------|
| `index.html` | `M:\aidlc-workflows\myproj\index.html` | Self-contained webpage with CSS 3D rotating cube and title "Dupa" |

## Implementation Notes

- **3D Engine**: Pure CSS — `transform-style: preserve-3d`, `perspective: 600px`
- **Animation**: `@keyframes rotateCube` — simultaneous X+Y axis rotation, 8s loop
- **Cube faces**: 6 `<div>` elements with distinct colours (indigo, pink, green, amber, blue, red)
- **No external dependencies**: single file, works offline
