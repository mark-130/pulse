# Design: "Orb"

Source of truth for the look of NGtive Split (code name pulse). Tokens live in apps/web/src/styles/tokens.css and the exported constants in packages/shared/src/brand.ts. Fonts are self-hosted.

## Principles
- Mobile first installable PWA. Dark by default, follows system, light available.
- Calm, conversational, AI-first. One accent.
- The orb appears only where AI is acting: the Today hero, the morning briefing, Ask and AI proposals. It is never decoration elsewhere.
- Nothing animates except the orb glow, and not when prefers-reduced-motion is set.
- Copy: UK English, short, numbers with units, no dashes, no hype.

## Dark tokens (default)
- bg #0A1113, with a soft blue glow at the top: radial-gradient(90% 30% at 50% 6%, rgba(59,130,246,0.22), transparent 70%)
- surface #121C1F, border rgba(255,255,255,0.07), border-strong rgba(255,255,255,0.14)
- text #EAF4F3, muted #9DB3B2
- accent #5EEAD4, on-accent #0A1113
- ai-gradient: linear-gradient(90deg, #5EEAD4, #3B82F6, #8B5CF6)
- orb: radial-gradient(circle at 32% 28%, #C9FFF5 0%, #2DD4BF 26%, #3B82F6 60%, #7C3AED 100%), outer glow rgba(94,234,212,0.34) blurred 10px, soft white highlight ellipse top left
- briefing surface: linear-gradient(160deg, rgba(94,234,212,0.12), rgba(139,92,246,0.12)), border rgba(255,255,255,0.1)
- proposals surface: rgba(94,234,212,0.06), border rgba(94,234,212,0.3)
- chips: race priority B rgba(139,92,246,0.22) with text #CDB9FF; taper rgba(94,234,212,0.14) with accent text; neutral rgba(255,255,255,0.08) with text #DCEBE9

## Light tokens
Same layout. bg #F4F8F8, surface #FFFFFF, border rgba(10,17,19,0.08), text #0A1113, muted #4B6161, accent #0F766E, on-accent #FFFFFF. The orb is unchanged with a softer glow. Chip, briefing and proposal tints use the darker accent and violet so text keeps at least 4.5:1 contrast. Contrast is checked when tokens change.

## Verdict states
Always icon plus text, never colour alone.
- Go as planned: accent, check icon.
- Go but easier: amber, #FBBF24 dark, #B45309 light.
- Swap for recovery: orange, #FB923C dark, #C2410C light.
- Rest: rose, #FB7185 dark, #BE123C light.

## Type
Sora 600 and 700 for headings and big numbers. DM Sans 400 to 700 for body. Self-hosted through @fontsource, no Google Fonts or CDN requests, so the PWA works offline.
- Page greeting 28, hero number 52, countdown 46, card title 18, body 15, secondary 13, label 12, overline 11 uppercase with 0.08em tracking.
- Letter spacing -0.02em on 28 and above.
- Numbers use tabular figures where they line up.

## Shape and space
- Page padding 20, card padding 16, gap 12.
- Card radius 24. Briefing bubble radius 8 24 24 24. Chips and buttons fully round.
- Progress bars 4px (metrics) and 10px (readiness).
- Tap targets at least 44px.

## Screens and navigation
- Tabs: Today, Week, Ask, Races, Trends. Ask is the raised 58px orb in the centre. The active tab uses the accent.
- Desktop: side rail with the same five destinations. Today is a bento grid up to 1120px wide.
- Proposals is reached from the Today proposals card. Settings is reached from the sync status sheet. Both keep their routes.

## Components
- Sport icons: runs and planned runs use the runner icon (Tabler "run", MIT, inline SVG in components/SportIcon.tsx, 2px round stroke like the lucide icons). It is used on the Week day cards, the Today session row and any run list. Footprints stay as the fallback for non-running activity types. The icon is aria-hidden because the RECORDED, SCHEDULED or PLANNED label carries the meaning. Tile, size (20px in a 44px tile) and colour are unchanged.
- Header: split-bar logo mark plus "NGtive Split" in Sora 600 17, and a sync pill ("Synced 07:30"). Tapping the pill opens a sync status sheet with a link to Settings.
- Orb hero: 96px orb, greeting "Morning, Mark" (by time of day), date line.
- Briefing bubble: sparkle, "Morning briefing", time, AI chip, text 15 with 1.6 line height.
- Prompt chips under the briefing: three suggested questions, wrapping to rows.
- Verdict card: verdict chip, big readiness number over 100, gradient gauge with a marker, one line of reasons, Garmin sync time.
- Session row: icon tile, overline, title, estimated duration, source, View button.
- Race card: name, date and start time in the race's own time zone, countdown, a seven day row of circles (today outlined, taper days tinted, race day filled accent), chips for priority, goal and taper start, then a line for the following race.
- Metric tiles, two columns: label, value, 4px gradient bar, status line.
- Proposals card: count, "Nothing is applied until you confirm.", Review button.

## Races screen (Phase 2)
- Order: warnings (action first, then info), the Unclassified card, "Upcoming, next first", then "Recent" for races in the last 14 days.
- Race card: name, date and start time in the race's own zone, location, countdown (or Done), chips (priority, type, distance, goal, taper start), the taper status line, a "Taper advice" disclosure (advice only, not medical guidance), the recovery line, data quality flags with a warning icon and text, and the priority (A, B, C) and type (Road, Trail) controls.
- Priority chips: A is the accent fill, B the violet chip, C the neutral chip. The letter is always in the text. Values that are only inferred say "suggested". Controls are 44px pill buttons using aria-pressed, so the state is not colour alone.
- Unclassified card: races whose priority or type is still inferred, each with a "Use B, road" button that accepts the suggestion.
- Undo: after every change a toast above the tab bar says what was saved, with a 44px Undo button for 12 seconds.
- Cluster warning with an undecided A race: a full width button per race, "Make X the A race".
- The Today race card shows the priority, distance, goal and taper chips, the taper status line, tinted taper days in the seven day row, and an "All races" link.

## Proposals and the confirm dialog (Phase 3)
- Proposals screen: "Waiting for you (n)" then History. Each row has the kind, a Garmin chip, a status chip, a one line summary (dates, or removal in red), the expiry or decision time, and a Review or Details button. A line at the top says whether Garmin writes are on or off.
- History status chips: Applied, Applied as a dry run, Rejected, Expired, Out of date (stale), Failed. Applied live changes also show the plan app check: "Checking: n of 2 syncs confirmed", "Verified" or "Reverted by the plan app".
- Confirm dialog (native modal, bottom sheet on narrow screens): overline "Change to Garmin", the kind as title, then the exact before and after for each field that changes, who proposed it and when it expires. One primary Confirm button, a Reject button and a "Not now" button, all 44px tall. Focus starts on the dialog itself, so nothing is pre-selected and Enter confirms nothing. Destructive changes (Remove from schedule) use the rose Confirm button and show the after text in rose, with words as well as colour. No orb, no humour.
- Dry run: while writes are off a notice at the top of the dialog says "Dry run: nothing will be sent to Garmin", with a warning icon.
- Stale: the dialog explains that the workout changed in Garmin since the proposal, that nothing was sent, what Garmin has now, and to make the change again from Week.
- The Move note "The plan app may revert this." appears in the Move dialog and the confirm dialog until the sync conflict probe result is recorded in DECISIONS.md (PROBE_RESULT_RECORDED in packages/shared).
- Week: each planned, not completed workout from today on has Move (opens a date picker dialog) and Remove from schedule. Both only create a proposal, then a toast links to Proposals.
- The Today proposals card shows the real pending count.

## Today order
Orb hero, briefing, prompt chips, verdict, session, race, metrics, proposals. Module widgets register a card (1x1 or 2x1) into the grid after these. Reordering is a later feature.

## Brand
- Split-bar mark: a short dim bar above a longer gradient bar (a negative split).
- App icon: the orb on #0A1113, with a maskable version (orb inside the 80 percent safe zone). Generated by pnpm icons from apps/web/public/icon.svg.
- theme-color #0A1113 dark and #F4F8F8 light. Manifest name and short_name "NGtive Split".

## Behaviour rules
- Confirm dialog: names the target system (Garmin, Google Calendar, Home Assistant), shows exact before and after, one primary Confirm button, a Reject button, no auto-confirm, no pre-selected default, destructive changes in red. No orb, no humour.
- Every data card shows the last sync time of the groups it uses. Offline shows the last cached snapshot.
- Stale banner (D27): shown on every screen only when the plan or readiness data is stale (older than 90 minutes), or when the device is offline. Amber border, warning icon, then: a bold one line reason in plain words ("Garmin Connect timed out. Retrying automatically."), a line naming what is behind and what is current ("Readiness is 95 minutes old. The plan, activities and trends are current."), and "Last synced dd/mm/yyyy hh:mm.".
- Details disclosure: the raw error is hidden behind "Details" (a 44px summary), in a monospace block with overflow-wrap: anywhere, max height 12rem with its own scroll, and a Copy button. Nothing overflows the card at 320px.
- Sync now sits on its own full width row under the text below 640px, at least 44px tall, and reads a disabled "Syncing" while running.
- Sync sheet, when ntfy is not configured: a plain line "Failure alerts are off. This screen is the only place failures show."
- Partial state: when only activities or trends are behind there is no banner. The cards that use them show a quiet inline note with an info icon ("Activities are 95 minutes old. Retrying automatically."). The sync sheet lists each group with its age and marks the ones that are behind.
- At 320px the header pill drops the word "synced" ("Stale, 07:49") so the wordmark is not truncated.
- Loading skeletons (static, no shimmer), plain error messages with Retry.
- Charts: Recharts, pace as min/km, labelled axes, table fallback for accessibility.
- Every AI-written block carries the sparkle icon and an "AI" chip (see docs/AI.md).
