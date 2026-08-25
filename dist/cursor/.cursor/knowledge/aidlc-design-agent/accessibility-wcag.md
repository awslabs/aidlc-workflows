# Accessibility: WCAG 2.1 AA Guide

## Purpose
Ensure digital products are usable by people with diverse abilities. WCAG 2.1 Level AA is the standard target for most applications and is legally required in many jurisdictions.

## Four Principles (POUR)

### 1. Perceivable
Information and UI components must be presentable in ways users can perceive.

**Text Alternatives**
- All non-decorative images must have descriptive `alt` text
- Complex images (charts, diagrams) need long descriptions
- Decorative images use `alt=""` (empty) to be ignored by screen readers

**Color Contrast**
- Normal text (< 18px): minimum 4.5:1 contrast ratio against background
- Large text (>= 18px bold or >= 24px regular): minimum 3:1 contrast ratio
- UI components and graphical objects: minimum 3:1 contrast ratio
- Never use color alone to convey meaning (add icons, text labels, or patterns)

**Media**
- Video must have captions (synchronized with audio)
- Audio-only content needs text transcripts
- No content that flashes more than 3 times per second

### 2. Operable
UI components and navigation must be operable by all users.

**Keyboard Navigation**
- All functionality must be accessible via keyboard alone
- Visible focus indicator on every interactive element (minimum 2px outline, 3:1 contrast)
- Logical tab order following visual layout (left-to-right, top-to-bottom)
- No keyboard traps — users must be able to navigate away from any component
- Skip-to-content link as the first focusable element on each page

**Keyboard Patterns by Component**
| Component | Keys |
|-----------|------|
| Buttons | Enter or Space to activate |
| Links | Enter to follow |
| Checkboxes | Space to toggle |
| Radio buttons | Arrow keys to move between options |
| Tabs | Arrow keys to switch, Tab to enter/exit tab panel |
| Modals | Escape to close, trap focus within modal |
| Dropdowns | Arrow keys to navigate, Enter to select, Escape to close |

**Timing**
- No time limits on interactions, or provide option to extend/disable
- Auto-updating content can be paused, stopped, or hidden

### 3. Understandable
Information and UI operation must be understandable.

**Readability**
- Page language declared in HTML (`lang` attribute)
- Consistent navigation across pages
- Consistent identification of repeated components

**Predictability**
- No unexpected context changes on focus or input
- Form submissions require explicit user action (button click, not auto-submit)
- Navigation order is consistent across pages

**Error Handling**
- Input errors are identified and described in text (not just red borders)
- Labels and instructions are provided before input fields
- Error suggestions offer specific correction guidance
- Important submissions (financial, legal) are reversible, verified, or confirmed

### 4. Robust
Content must be robust enough for diverse user agents and assistive technologies.

**Markup**
- Valid, well-structured HTML with proper nesting
- Unique IDs throughout the page
- Complete start and end tags

## ARIA (Accessible Rich Internet Applications)

### When to Use ARIA
- **First rule**: Use native HTML elements whenever possible. A `<button>` is always better than `<div role="button">`
- Use ARIA only when native HTML cannot express the semantics

### Essential ARIA Attributes
- `role` — Defines what the element is (e.g., `dialog`, `alert`, `tabpanel`, `navigation`)
- `aria-label` — Provides accessible name when visible text is insufficient
- `aria-labelledby` — Points to another element that labels this one
- `aria-describedby` — Points to element providing additional description
- `aria-expanded` — Indicates if a collapsible section is open (true/false)
- `aria-hidden="true"` — Hides decorative elements from screen readers
- `aria-live="polite"` — Announces dynamic content changes (toast messages, status updates)
- `aria-required="true"` — Marks required form fields

### ARIA Landmarks
- `role="banner"` or `<header>` — Site-wide header
- `role="navigation"` or `<nav>` — Navigation blocks
- `role="main"` or `<main>` — Primary content area
- `role="complementary"` or `<aside>` — Supporting content
- `role="contentinfo"` or `<footer>` — Site-wide footer

## Common Failures and Fixes

| Failure | Impact | Fix |
|---------|--------|-----|
| Missing alt text on images | Screen readers say "image" with no context | Add descriptive alt text or `alt=""` for decorative |
| Low color contrast | Unreadable for low vision users | Use contrast checker, meet 4.5:1 minimum |
| No focus indicators | Keyboard users cannot see where they are | Add visible `:focus` styles, never use `outline: none` |
| Form fields without labels | Screen readers cannot identify inputs | Associate `<label>` with every `<input>` via `for`/`id` |
| Auto-playing media | Disorienting, interferes with screen readers | Require user action to play, provide pause/stop |
| Mouse-only interactions | Keyboard/switch users cannot operate | Add keyboard event handlers for all mouse interactions |
| Missing heading hierarchy | Navigation by headings fails | Use h1-h6 in logical order, never skip levels |
| Dynamic content without announcements | Screen readers miss updates | Use `aria-live` regions for status messages |

## Testing Approach
1. **Automated scan**: axe DevTools, Lighthouse accessibility audit (catches ~30% of issues)
2. **Keyboard testing**: Unplug the mouse and navigate the entire application
3. **Screen reader testing**: Test with VoiceOver (macOS), NVDA (Windows), or TalkBack (Android)
4. **Zoom testing**: Verify layout at 200% and 400% browser zoom
5. **Color testing**: Verify with simulated color blindness (protanopia, deuteranopia, tritanopia)
