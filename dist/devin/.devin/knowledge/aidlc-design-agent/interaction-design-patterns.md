# Interaction Design Patterns

## Purpose
Reusable solutions to common UI interaction problems. Applying established patterns reduces user learning curve and development effort.

## Navigation Patterns

### Top Navigation Bar
- Best for: Applications with 3-7 top-level sections
- Include: Logo (home link), primary nav items, user menu, search
- On mobile: Collapse to hamburger menu or bottom tab bar

### Side Navigation
- Best for: Applications with many sections, deep hierarchies, or admin interfaces
- Collapsible to icons-only for more content space
- Active section should be visually highlighted
- Support nested items with expand/collapse

### Breadcrumbs
- Best for: Deep hierarchies (e-commerce, file systems, documentation)
- Show the path from root to current page
- Each segment is a clickable link except the current page
- Do not use breadcrumbs as the only navigation method

### Bottom Tab Bar (Mobile)
- Best for: Mobile apps with 3-5 primary sections
- Maximum 5 tabs; more than 5 requires a "More" overflow
- Active tab uses filled icon and label; inactive tabs use outlined icons

## Form Patterns

### Inline Validation
- Validate on blur (when the user leaves the field), not on every keystroke
- Show success state for valid fields to build confidence
- Place error messages directly below the relevant field
- Use specific error messages: "Password must be at least 8 characters" not "Invalid input"

### Multi-Step Forms (Wizards)
- Show progress indicator (step 1 of 4) with step labels
- Allow backward navigation to review previous steps
- Save progress between steps (do not lose data on back-navigation)
- Final step shows a summary for review before submission
- Keep each step focused on one logical group of inputs

### Autosave
- Save drafts automatically at intervals or on field change
- Show save status clearly: "Saved", "Saving...", "Unsaved changes"
- Provide explicit save/discard actions for critical data

## Modal and Dialog Patterns

### When to Use Modals
- Confirming destructive actions ("Delete this item?")
- Collecting small amounts of focused input (rename, quick settings)
- Displaying critical alerts that require acknowledgment

### When NOT to Use Modals
- Displaying large amounts of content (use a new page instead)
- Nested modals (modal opening another modal — always avoid)
- Optional information (use inline expansion or tooltips)

### Modal Implementation Rules
- Trap keyboard focus inside the modal while open
- Close on Escape key press
- Close on overlay/backdrop click (except for critical confirmations)
- Return focus to the trigger element when closed
- Prevent background scrolling while modal is open

## Progressive Disclosure

### Pattern
Show only essential information initially; reveal detail on demand.

### Applications
- **Accordion sections**: Collapse secondary content; expand on click
- **"Show more" links**: Truncate long lists/text with option to expand
- **Advanced settings**: Hide behind a "Show advanced options" toggle
- **Contextual help**: Show tips/explanations via info icons or tooltips, not inline clutter

### Rule
Every screen should have a clear primary action. If users are overwhelmed, you are showing too much at once.

## Infinite Scroll vs Pagination

### Infinite Scroll
- Best for: Social feeds, media galleries, content discovery
- Show loading indicator at bottom when fetching more
- Provide "Back to top" button after scrolling
- Caution: Breaks browser back button, makes footer unreachable, loses scroll position

### Pagination
- Best for: Search results, data tables, e-commerce listings
- Show total count and current position ("Showing 1-20 of 347")
- Include: Previous, Next, first/last page, and 2-3 surrounding page numbers
- Preserve filter/sort state across page changes

## Drag and Drop

### When Appropriate
- Reordering lists, kanban boards, file uploads, layout builders
- Always provide a non-drag alternative (move up/down buttons, keyboard shortcuts)

### Implementation
- Show a grab cursor on hover of draggable items
- Provide a clear visual drop target (highlighted zone, insertion line)
- Show a ghost/preview of the dragged item
- Support undo immediately after drop (Ctrl+Z or undo toast)

## Micro-Interactions

### Definition
Small, single-purpose animations or feedback moments that make the interface feel responsive.

### Key Micro-Interactions
- **Button feedback**: Subtle press/depress animation on click
- **Toggle transitions**: Smooth state change (on/off) with color shift
- **Success confirmation**: Brief checkmark animation after form submission
- **Skeleton loading**: Content-shaped placeholders that pulse while loading
- **Pull to refresh**: Resistance and spinner animation (mobile)

### Rules
- Keep animations under 300ms — longer feels sluggish
- Use easing (ease-out for entrances, ease-in for exits) — linear motion feels robotic
- Respect `prefers-reduced-motion` media query — disable animations for users who request it

## Error Prevention Patterns

- **Confirmation dialogs** for destructive actions (delete, overwrite, send)
- **Undo** instead of confirmation when possible (Gmail's "Undo send" is superior to "Are you sure?")
- **Constraints**: Disable invalid options rather than showing errors after selection
- **Defaults**: Pre-fill with sensible defaults to reduce input errors
- **Format hints**: Show expected format inline ("DD/MM/YYYY") not just in error messages

## Responsive Breakpoint Strategy

### Standard Breakpoints
- **Mobile**: 320px - 767px (single column, stacked layout)
- **Tablet**: 768px - 1023px (two columns, collapsible side nav)
- **Desktop**: 1024px - 1439px (full layout, side nav expanded)
- **Large desktop**: 1440px+ (max-width container, avoid stretching content beyond ~1200px)

### Design Approach
- Design mobile-first: start with the smallest screen, add complexity as space allows
- Use fluid grids and relative units (%, rem) not fixed pixels
- Test at breakpoint boundaries AND mid-points (avoid layout breaking at 900px between 768 and 1024)
- Touch targets: minimum 44x44px on mobile (Apple HIG), 48x48px (Material Design)
