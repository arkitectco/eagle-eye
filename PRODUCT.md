# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People running Claude Code sessions with one or more agents or subagents. They use Eagle Eye while they work to understand active work, ownership, changes, and questions that need their intervention.

## Product Purpose

Eagle Eye provides a live deck in the Claude Desktop side pane, terminal, or browser tab. It turns Claude Code's session events and git state into an understandable view without taking control of the session.

## Positioning

Eagle Eye is an observational layer over Claude Code: it presents the existing session state and routes user actions through Claude Code's own channels and permission checks.

## Operating Context

Users monitor active agent work, respond to questions and permission requests, inspect changes, and intervene when necessary. The dashboard, group chat, organization, changes, inspection, and settings views share a live web session model.

## Capabilities and Constraints

- The web deck is a dependency-free browser application rendered from a keyed virtual DOM.
- It receives live state over SSE and must preserve functional controls, keyboard interaction, and real-time updates.
- The dashboard needs immediate situational awareness, actionability, and trust at working density.
- Existing product copy and functionality remain truthful; the information architecture may improve.

## Brand Commitments

- The product is named Eagle Eye.
- The Arkitect design system (`plugin/web/arkitect-tokens.css` and `plugin/web/arkitect.css`) is the primary visual authority for this redesign.
- The default presentation is dark, with a persistent user-controlled light theme.

## Evidence on Hand

- README.md describes the product and supported workflows.
- The existing web interface is implemented in plugin/web/.
- `plugin/web/arkitect-tokens.css` and `plugin/web/arkitect.css` supply the tokens and component styles.

## Product Principles

- Make what needs a human unmistakable.
- Preserve the boundary between observing and operating Claude Code.
- Keep dense session data readable under live change.
- Let states be explicit in language, not implied by color.
