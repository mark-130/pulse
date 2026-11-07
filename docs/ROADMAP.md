# Roadmap
Each phase ends with a demo checklist, a test summary, DECISIONS.md updates, then a stop for sign-off.

## Phase 0: Foundation
Scope: repo and pnpm workspace, API skeleton with /api/health, login, session, CSRF, SQLite and Drizzle migrations, Module interface and empty registry, web shell (tabs, theme, PWA manifest), Dockerfile, CI workflow, deploy/docker-compose.yml, deploy/homer-entry.yml. Discovery: internal Garmin MCP URL and tool list (diffed against INTEGRATIONS.md), how Watchtower is configured (needed if the GHCR package is private), Homer config file location and the right group for the tile.
Acceptance: container healthy on the homelab network. http://192.168.0.10:8200 shows login then an empty Today. The tailscale serve URL works. Watchtower label present. CI builds the image. Typecheck, lint and tests pass. Homer tile ready to paste. Discovery results recorded.

## Phase 1: Garmin read
Scope: Garmin sync job, snapshots, Today and Week views, Trends, stale banner.
Acceptance: the 08/11 long run shows. No write code exists anywhere.

## Phase 2: Races and calendar read
Scope: Google OAuth read-only, race table, Google to Garmin matching, classification and inference, taper status, cluster warnings, Races screen.
Acceptance: all events on Running Events appear with sensible inferred distance and priority. Garmin gaps listed. Fixtures in TRAINING.md produce the expected flags.

## Phase 3: Proposal engine and writes
Scope: engine, audit log, Proposals screen, @pulse tag write-back, Pulse Training mirror, Garmin reschedule, sync-conflict probe.
Acceptance: a test proves no write path exists outside the engine. Stale-hash test passes. Probe result recorded in DECISIONS.md.

## Phase 4: AI
Scope: briefing, Ask, taper planner, weekly review, post-run debrief, budget caps, evals, optional forecast.
Acceptance: briefing arrives by ntfy. Every figure traceable to data. Cap enforced in a test.

## Phase 5: Home Assistant
Scope: read-only states and cards first, then proposals for allowlisted services.
Acceptance: allowlist and denylist tests pass. No call_service without a confirmed proposal.

## Backlog
Nutrition log view from Garmin, weight trend, Paperless recent documents card, ntfy history, recreated apps where an API exists (candidates to be agreed).
