# Eagle Eye visual system

<!-- impeccable:design-schema 1 -->

## Visual Authority

The Arkitect design system governs the look. Its tokens and stylesheet are loaded globally as `plugin/web/arkitect-tokens.css` and `plugin/web/arkitect.css`.

## Direction

Operational Command Deck: an information-dense, ruled monitoring workspace. A floating navigation pill establishes global orientation; the dashboard leads with attention requiring a human, then active work and live evidence. The chat preserves its group-conversation behavior while making ownership and message state legible at a glance.

## Mode

Operate

## System Invariants

- Dark is the default theme; light is available from the global navigation and persisted locally.
- Bebas Neue is reserved for uppercase display headings; Hanken Grotesk serves interface and prose; Fragment Mono serves data, labels, controls, tags, and timestamps.
- Hairlines and the ruled grid provide depth. Shadows are reserved for genuinely floating layers.
- Corners are square except for the floating navigation pill.
- Status is written in `.tag` chips. Accent means “needs me” or blocked; destructive means a real error. No other status hues are introduced.
