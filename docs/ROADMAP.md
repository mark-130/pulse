# Roadmap
Each phase ends with a demo checklist, a test summary, DECISIONS.md updates, then a stop for sign-off.

## Phase 0: Foundation
Scope: repo and pnpm workspace, API skeleton with /api/health, login, session, CSRF, SQLite and Drizzle migrations, Module interface and empty registry, web shell (tabs, theme, PWA manifest), Dockerfile, CI workflow, deploy/docker-compose.yml. Discovery: internal Garmin MCP URL and tool list (diffed against INTEGRATIONS.md), how Watchtower is configured (needed if the GHCR package is private).
Acceptance: container healthy on the homelab network. http://192.168.0.10:8210 shows login then an empty Today. The tailscale serve URL works. Watchtower label present. CI builds the image. Typecheck, lint and tests pass. Discovery results recorded.

## Phase 1: Garmin read
Scope: Garmin sync job, snapshots, race sync from get_calendar_events into the race table, Today and Week views, Trends, stale banner.
Acceptance: the 08/11 long run shows. Races from the Garmin calendar are stored with all fields listed in docs/INTEGRATIONS.md. No write code exists anywhere.

## Phase 2: Races, taper status and cluster warnings from Garmin data
Scope: race_meta table and editing, classification and inference, data quality flags, Unclassified card, taper status, cluster warnings, Races screen. No OAuth.
Acceptance: all Garmin calendar races appear in their own time zone with distance and inferred priority. Unclassified until set. Antwerp (01:30 Europe/Paris) is flagged unverified and races without a goal time are flagged. Fixtures in TRAINING.md produce the expected flags.

## Phase 3: Proposal engine and writes
Scope: engine, audit log, Proposals screen, Garmin reschedule, sync-conflict probe.
Acceptance: a test proves no write path exists outside the engine. Stale-hash test passes. Probe result recorded in DECISIONS.md.

## Phase 4: AI
Scope: briefing, Ask, taper planner, weekly review, post-run debrief, budget caps, evals, optional forecast.
Acceptance: briefing arrives by ntfy. Every figure traceable to data. Cap enforced in a test.

## Phase 5: Google Calendar, scope to be agreed
Scope and acceptance to be agreed before this phase starts. Candidates: busy time for the readiness verdict, mirrored planned workouts on a "Pulse Training" calendar (proposals only). See docs/INTEGRATIONS.md.

## Phase 6: Home Assistant
Scope: read-only states and cards first, then proposals for allowlisted services.
Acceptance: allowlist and denylist tests pass. No call_service without a confirmed proposal.

## Backlog
Nutrition log view from Garmin, weight trend, Paperless recent documents card, ntfy history, recreated apps where an API exists (candidates to be agreed).
