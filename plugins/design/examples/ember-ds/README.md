# Ember

Ember is a small-batch coffee roaster. This is the brand manual: the words, the surface, and the marks that every Ember surface is built from. Read this before touching any Ember design; it is the shortest path to looking like us.

## Content fundamentals

Write like a person behind a counter, not a brand.

- **Sentence case everywhere**, including headings, buttons and menu items. Never Title Case, never ALL CAPS except the small eyebrow labels, which are letter-spaced.
- **Second person for the reader, first person plural for the roastery.** "We roasted it Tuesday" · "You'll want it ground coarse."
- **Numbers are specific and unrounded.** "Rested four days", "6 oz", "roasted on Tuesdays" — never "premium", "artisanal", "carefully curated".
- **Tasting notes are three words or fewer, lower case, separated by a middot.** `jasmine, apricot` · `cocoa, red plum`. Never a sentence, never a score.
- **Never invent a fact.** A price we have not been given is `[PRICE]`; a roast date we do not know is `[ROAST DATE]`. Bracketed placeholders ship as-is rather than being filled with plausible fiction.
- **No exclamation marks.** Enthusiasm comes from specificity.

## Visual foundations

Warm, printed, quiet. The page should read like paper stock, not a screen.

### Surface and ink

- `surface` is the page. Nothing sits directly on white.
- `surface-raised` is for cards and menus only — one step up, never a shadow-first design.
- `line` is a hairline: 1px borders and rules. Dividers are `line`, never grey.
- `ink` is body copy; `ink-muted` is metadata, tasting notes and captions. Do not use `ink-muted` for anything a reader must act on.

### Ember

`ember` is the only accent, and it is rationed.

- One ember element per view: a primary button, a price, or the eyebrow rule — not two of them competing.
- `ember-soft` is a tinted ground for ember text; `on-ember` is the label colour on an ember fill. Never put `ink` on `ember`.
- `leaf` is reserved for availability ("in stock") and nothing else.

### Type

Two families, four steps. Fraunces for display only; Karla for everything else.

- `display` is page titles. One per page.
- `heading` is section headings.
- `body` is all prose, menu items and controls.
- `caption` is labels, metadata and tasting notes; it is the only style that may be letter-spaced.

Never set body copy in the display family, and never set a heading below `heading`.

### Space, radius, elevation

- Spacing is a 4px base. Card padding is `space-4`; the gap between sections is `space-6`.
- Radius is soft but never round: `radius-sm` for badges and inputs, `radius-md` for buttons and cards, `radius-full` only for pills and avatars.
- Two elevations exist. Most things have neither.

## Iconography

Icons are strokes, not fills: 1.5px stroke, round caps and joins, 20px on a 24px box, drawn on the same grid as the type.

- An icon alone is never the only label. Pair it with a `caption`, or give it an accessible name.
- Icons take `currentColor`, so they inherit `ink` or `ember` from their row.

## Marks

The wordmark is set in the display family, sentence case, letter-spacing `-0.01em` — "Ember Coffee", never "EMBER" and never with a registered mark in body copy.

There is no symbol yet. Until there is one, the wordmark carries the identity on its own and the eyebrow rule does the work a symbol would: a 2px ember rule beside a letter-spaced label.

## Consuming this system

`tokens.json` is the source of every value above; the names in this file are the token names. Load the tokens, use the names, and do not hard-code a hex value in a surface built from this system.

## Not synced

Nothing yet — this is the first version and it was written from the design, not imported from a tool.
