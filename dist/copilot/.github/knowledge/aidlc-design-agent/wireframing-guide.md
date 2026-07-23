# Wireframing Guide

## Purpose
Wireframes are visual blueprints that define layout, hierarchy, and interaction flow before visual design or development begins. They reduce rework by validating structure early and cheaply.

## Fidelity Progression

### Low-Fidelity (Sketches)
- **Tools**: Paper, whiteboard, basic drawing tools
- **When**: Initial ideation, stakeholder alignment, exploring multiple layouts quickly
- **Content**: Boxes and lines, placeholder text ("Lorem ipsum"), no color, no real data
- **Time per screen**: 5-15 minutes
- **Rule**: If you spend more than 15 minutes on a sketch, you are over-investing

### Mid-Fidelity (Structural Wireframes)
- **Tools**: Figma, Balsamiq, Excalidraw
- **When**: Defining content hierarchy, information architecture, navigation flow
- **Content**: Real labels, approximate spacing, grayscale, actual content structure
- **Time per screen**: 30-60 minutes

### High-Fidelity (Interactive Prototypes)
- **Tools**: Figma (prototyping mode), Framer
- **When**: User testing, developer handoff, complex interaction validation
- **Content**: Real copy, accurate spacing, clickable interactions, state transitions
- **Time per screen**: 2-4 hours

### Progression Rule
Start at the lowest fidelity that answers your current question. Do not jump to high-fidelity until low-fidelity concepts are validated.

## Layout Patterns

### F-Pattern (Content-Heavy Pages)
Users scan horizontally across the top, then down the left side, then across again. Use for:
- Article pages, search results, dashboards
- Place critical content in the top-left and along the left edge

### Z-Pattern (Marketing / Landing Pages)
Eye moves: top-left to top-right, diagonally to bottom-left, then to bottom-right. Use for:
- Landing pages, sign-up flows, simple layouts
- Place logo top-left, CTA top-right, key message bottom-right

### Card Layout
Grid of self-contained content units. Use for:
- Product catalogs, dashboards, media galleries
- Each card is independently scannable and actionable

### Split Screen
Two equal or weighted panels side by side. Use for:
- Comparison views, master-detail, editor-preview

## Component Library Basics

### Essential Components to Define Early
- **Navigation**: Top bar, side nav, breadcrumbs, tabs
- **Data display**: Tables, cards, lists, detail panels
- **Input**: Text fields, selects, checkboxes, date pickers, file upload
- **Feedback**: Alerts, toasts, progress bars, empty states
- **Actions**: Buttons (primary, secondary, destructive), links, menus

### Consistency Rules
- One primary action per screen section (single prominent button)
- Consistent placement of navigation and actions across all screens
- Uniform spacing scale (4px, 8px, 16px, 24px, 32px, 48px)

## Screen State Design

Every screen has multiple states. Wireframe ALL of them, not just the happy path.

### The Five States

1. **Empty State**
   - First-time user with no data
   - Include: illustration/icon, explanation of what will appear, clear CTA to create first item
   - Never show a blank table or empty list with no guidance

2. **Loading State**
   - Data is being fetched or processed
   - Use skeleton screens (preferred) or spinners
   - Show loading in context (inline), not as a full-page block

3. **Success / Populated State**
   - Normal operation with real data
   - This is the state most wireframes show — but it is only one of five

4. **Error State**
   - Something went wrong (network error, validation failure, permission denied)
   - Explain what happened in plain language, suggest recovery action
   - Never show raw error codes or stack traces to users

5. **Partial / Edge State**
   - Incomplete data, very long content, single item vs many items, max limits reached
   - Test with: 0 items, 1 item, 5 items, 100 items, 10,000 items
   - Test with: very short text, very long text, special characters, missing optional fields

## Wireframe Review Checklist
- [ ] All five screen states represented (empty, loading, success, error, partial)
- [ ] Navigation is consistent across all screens
- [ ] Content hierarchy is clear — most important information is most prominent
- [ ] Interactive elements are obviously clickable/tappable
- [ ] Mobile and desktop layouts considered (even if only one is wireframed in detail)
- [ ] Accessibility annotations present (tab order, heading levels, alt text notes)
- [ ] Edge cases documented (long names, missing data, permission variations)

## Common Mistakes
- Wireframing only the happy path with perfect data
- Using placeholder text that hides layout problems (real content is longer/shorter)
- Skipping mobile layout until development
- Treating wireframes as final design — they should invite feedback and iteration
- Not annotating interaction behavior (what happens on click, hover, swipe)
