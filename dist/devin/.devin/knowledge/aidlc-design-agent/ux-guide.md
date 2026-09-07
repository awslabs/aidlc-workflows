# UX Guide

## Nielsen's 10 Usability Heuristics (Applied)

Use these as a review checklist for every user-facing specification:

1. **Visibility of system status**: Show loading indicators, progress bars, success confirmations. Users must always know what is happening.
2. **Match between system and real world**: Use domain language the user understands. Avoid technical jargon in UI labels.
3. **User control and freedom**: Provide undo, cancel, and back. Never trap users in a flow without an exit.
4. **Consistency and standards**: Same action = same label = same position across all screens. Follow platform conventions.
5. **Error prevention**: Disable invalid actions, use type-appropriate inputs (date pickers, dropdowns), confirm destructive operations.
6. **Recognition rather than recall**: Show options, recent items, defaults. Minimize what users must remember between screens.
7. **Flexibility and efficiency of use**: Support keyboard shortcuts, bulk actions, and saved preferences for expert users without cluttering the novice experience.
8. **Aesthetic and minimalist design**: Every element must earn its place. Remove decorative elements that do not aid task completion.
9. **Help users recognize, diagnose, and recover from errors**: Error messages must say what went wrong, why, and what to do next. Never show raw error codes.
10. **Help and documentation**: Provide contextual help (tooltips, inline hints) at the point of need, not in a separate help section.

## WCAG 2.1 AA Key Requirements

### Perceivable
- Text contrast ratio: minimum 4.5:1 for normal text, 3:1 for large text (18px+ bold or 24px+)
- Non-text content has text alternatives (alt text, ARIA labels)
- Content does not rely solely on color to convey meaning (use icons, patterns, or text too)
- Media has captions or transcripts

### Operable
- All functionality available via keyboard (Tab, Enter, Space, Arrow keys, Escape)
- Focus order follows a logical reading sequence
- Focus indicators are visible (never `outline: none` without replacement)
- No content flashes more than 3 times per second
- Touch targets are minimum 44x44 CSS pixels

### Understandable
- Language of page is declared in HTML
- Form inputs have visible labels (not just placeholders)
- Error identification is specific ("Email is invalid" not "Error in field 3")
- Consistent navigation across pages

### Robust
- Valid HTML semantics (headings in order, lists for lists, tables for tabular data)
- ARIA roles used correctly (not overused; native HTML elements preferred)
- Content works across browsers and assistive technologies

## Interaction Patterns Reference

### Forms
- Labels above inputs (not beside, not inside as placeholder-only)
- Inline validation on blur, not on every keystroke
- Submit button disabled until required fields are valid (with visual explanation)
- Group related fields with fieldset/legend
- Mark optional fields, not required ones (most fields should be required)

### Data Tables
- Sortable columns with sort indicator (arrow direction)
- Filterable with clear filter indicators and reset option
- Pagination with page size selector and total count
- Row selection with bulk action toolbar
- Empty state message with guidance ("No results. Try adjusting your filters.")

### Navigation
- Primary navigation: persistent, max 7 items, current page highlighted
- Breadcrumbs for hierarchical content (3+ levels deep)
- Search: globally accessible, auto-suggest after 3 characters, recent searches shown

### Feedback & States
- **Loading**: Skeleton screens for initial load, spinners for actions (with timeout message after 5s)
- **Success**: Inline confirmation near the action, auto-dismiss after 5s, do not redirect immediately
- **Error**: Inline near the cause, red but with icon (not color-only), actionable message
- **Empty**: Illustration + explanation + primary action ("No items yet. Create your first item.")
- **Confirmation**: Required for delete, bulk operations, and irreversible actions. Include what will happen and an undo option if possible.

## User Flow Documentation Format

For each user flow, specify:
```
Flow: [name]
Persona: [who performs this]
Trigger: [what initiates the flow]
Steps:
  1. [Screen/state] -> [user action] -> [system response]
  2. [Screen/state] -> [user action] -> [system response]
  ...
Success outcome: [what the user sees when done]
Error paths:
  - [condition] -> [error screen/message] -> [recovery action]
```

## Information Architecture

### Navigation Hierarchy Principles
- Maximum 3 levels of nesting for primary navigation
- Flat is better than deep — prefer broad categories with fewer sub-levels
- Every page must be reachable within 3 clicks from the home/dashboard
- Use progressive disclosure: show summary first, detail on demand

### Content Grouping Strategies
- Group by user task (what they want to do), not by system structure (how it is built)
- Card sorting reference: use open card sort for new IA, closed card sort to validate existing
- Related actions should be visually proximate (Gestalt principle of proximity)

### Labeling Taxonomy
- Labels must use the user's language, not internal jargon
- Consistent verb forms across navigation (all nouns or all verbs, not mixed)
- Test labels with 5+ representative users before finalizing

### Sitemap Structure Patterns
- Hub-and-spoke: central dashboard with links to feature areas (suits task-based apps)
- Hierarchical: nested tree (suits content-heavy sites, documentation)
- Sequential: linear flow (suits onboarding, checkout, wizards)
- Choose the pattern that matches the primary user workflow

## Responsive and Adaptive Design

### Breakpoint Strategy (Mobile-First)
- Design for smallest screen first, then enhance for larger screens
- Common breakpoints: 320px (mobile), 768px (tablet), 1024px (desktop), 1440px (large desktop)
- Content dictates breakpoints, not device names — add breakpoints where the layout breaks

### Layout Adaptation Patterns
- **Fluid**: Percentage-based widths, content reflows naturally (default approach)
- **Adaptive**: Distinct fixed layouts per breakpoint (use when fluid is insufficient)
- **Responsive**: Combination of fluid grids, flexible images, and media queries (recommended)

### Touch Target Sizing
- Minimum 44x44 CSS pixels for all interactive elements (WCAG 2.1 AA)
- 8px minimum spacing between adjacent touch targets
- Increase to 48x48 px for primary actions on mobile

### Content Priority Shifting
- Stack columns vertically on mobile (most important content first)
- Hide secondary navigation behind a menu icon on small screens
- Collapse data tables into card views on mobile
- Defer non-critical images and media on slow connections

### Performance Considerations for Mobile
- Target < 3s load time on 3G connections
- Lazy-load images and below-the-fold content
- Minimize JavaScript payload (< 200KB compressed for initial load)
- Use responsive images (srcset) to serve appropriately sized assets
