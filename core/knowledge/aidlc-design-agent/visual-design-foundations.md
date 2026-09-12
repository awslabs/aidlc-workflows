# Visual Design Foundations

The wireframing and UX guides settle structure: screens, states, flows, and
accessibility. This guide settles the visual layer the developer builds from.
Its output is two things: a stated visual direction, and a foundation token
table inside `design-system-mapping.md`. Without both, every visual decision is
made silently at code generation, outside the mockup approval gate.

## The Design Read

State the visual direction in one line before designing any screen, and put
that line at the top of `design-system-mapping.md`:

> Reading this as: `<product kind>` for `<audience>`, with a `<visual language>`
> language, built on `<existing design system | aesthetic family>`.

Derive it from evidence, in this order:

1. **Existing assets win.** A logo, palette, type choice, or component library
   already in use is the starting material, not an option. Map to it; do not
   restyle it.
2. **The audience picks the look, not the designer.** A procurement panel, a
   clinician, a consumer on a phone, and an operator on a wall display want
   different densities, contrasts, and tones.
3. **Quiet constraints override preference.** Public-sector, regulated,
   safety-critical, accessibility-first, and children's products constrain
   colour, motion, density, and tone before any aesthetic choice is made.
4. **References from the stories and Q&A.** Products the stakeholders named,
   competitors mentioned, screenshots attached.

If the read cannot be settled from evidence, it is a clarifying question for
the stage's question file, not a guess.

## Defaults to Reach Past

When nothing constrains the look, generated designs converge on the same
choices. Treat each as a signal that the design read was skipped:

- A gradient hero over a dark background with a single centred headline
- Three equal feature cards in a row, each with an icon, title, and sentence
- Translucent blur applied as decoration rather than to indicate a dismissable layer
- One generic sans-serif at one weight for every role
- Purple or violet as the primary colour with no brand reason
- Looping motion on elements that carry no state change
- Emoji used as icons

Any of these may still be the right call for a specific product. The
requirement is that it follows from the design read, not from its absence.

## Foundation Token Table

`design-system-mapping.md` carries a token table for every group below. When
an existing design system supplies a group, map to its names; when none exists,
define the group here so the developer never invents a value.

### Type

- **Scale**: a fixed set of sizes (for example 12, 14, 16, 18, 24, 32) named by
  role (caption, body, lead, title, headline, display), never ad-hoc pixels
- **Line height**: 1.5-1.75 for body text; tighter only for display sizes
- **Measure**: 45-75 characters per line for reading text
- **Weight hierarchy**: headings 600-700, body 400, labels 500; weight and
  size together carry hierarchy, colour alone never does
- **Pairing**: at most two families, one for headings and one for body, chosen
  for the same personality; confirm the families cover every script the
  product's locales require (diacritics, CJK, RTL)
- **Numbers**: tabular figures wherever digits align in columns, prices, or
  timers, so values do not shift width as they change

### Colour

- **Semantic tokens, not raw values**: `primary`, `on-primary`, `surface`,
  `on-surface`, `surface-variant`, `outline`, `error`, `on-error`, `success`,
  `warning`, `info`; components reference tokens only
- **Contrast pairs**: every foreground/background pair in the table states its
  ratio; 4.5:1 for body text, 3:1 for large text and UI boundaries
- **Light and dark together**: define both themes in the same table; dark
  values are desaturated, lifted tonal variants, not inverted light values, and
  their contrast is verified separately
- **Meaning is never colour-only**: an error, success, or warning token is
  always paired with an icon or text

### Space, Shape, and Depth

- **Spacing scale**: one base unit and its multiples (for example 4, 8, 12, 16,
  24, 32, 48, 64); every margin, padding, and gap resolves to a step
- **Radius scale**: a small set (for example none, 4, 8, 16, full) applied
  consistently by component role
- **Elevation scale**: a fixed set of shadow or border treatments by layer
  (flat, raised, overlay, modal); no per-component shadow values
- **Whitespace groups**: related items sit closer than unrelated items; the
  spacing scale, not dividers, does most grouping

### Motion

- **Durations**: a short set by purpose (micro feedback ~100-150 ms,
  transitions ~200-300 ms, large layout changes ~300-400 ms)
- **Easing**: enter decelerates, exit accelerates, movement uses a standard curve
- **Reduced motion**: every animation names its reduced-motion behaviour
  (crossfade, instant, or none); a loop that conveys no state is removed
  outright

### Iconography

- One icon set with one stroke weight and one corner treatment across the
  product; icons carry an accessible name or are marked decorative

## Per-Screen Visual Rules

- One primary action per screen; secondary actions are visually subordinate
  in weight, fill, or position
- Hover, focus, pressed, and disabled states are visibly distinct and on-style
  for every interactive element
- Prefer wrapping to truncation; when text must truncate, use an ellipsis and
  expose the full value on focus, hover, or expand
- Platform idioms hold: navigation, controls, and type follow the target
  platform's conventions unless the design read gives a reason not to

## Handoff Checklist

- [ ] The design read is stated at the top of `design-system-mapping.md`
- [ ] Every token group above is present, either mapped to the existing design system or defined
- [ ] Every colour pair states its contrast ratio and both themes are covered
- [ ] Every value in the mockups resolves to a named token; none are ad-hoc
- [ ] Every animation names its duration, easing, and reduced-motion behaviour
- [ ] None of the defaults above appear without a reason traceable to the design read
