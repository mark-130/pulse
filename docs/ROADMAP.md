# Roadmap
Each phase ends with a demo checklist, a test summary, DECISIONS.md updates, then a stop for sign-off. Every phase also ends with a design review of the real screens against docs/DESIGN.md before sign-off.

## Phase 0: Foundation
Scope: repo and pnpm workspace, API skeleton with /api/health, login, session, CSRF, SQLite and Drizzle migrations, Module interface and empty registry, web shell (tabs, theme, PWA manifest), Dockerfile, CI workflow, deploy/docker-compose.yml. Discovery: internal Garmin MCP URL and tool list (diffed against INTEGRATIONS.md), how Watchtower is configured (needed if the GHCR package is private).
Acceptance: container healthy on the homelab network. http://192.168.0.10:8210 shows login then an empty Today. The tailscale serve URL works. Watchtower label present. CI builds the image. Typecheck, lint and tests pass. Discovery results recorded.

## Phase 1: Garmin read
Scope: Garmin sync job, snapshots, race sync from get_calendar_events into the race table, Today and Week views, Trends, stale banner.
Acceptance: the 08/11 long run shows. Races from the Garmin calendar are stored with all fields listed in docs/INTEGRATIONS.md. No write code exists anywhere.

## Phase 2: Races, priorities and cluster warnings from Garmin data
Scope: race_meta table and editing, classification and inference, data quality flags, Unclassified card, cluster and clash warnings, Races screen. (The taper status line shown in Phase 2 was removed in 4b by D42.) No OAuth.
Acceptance: all Garmin calendar races appear in their own time zone with distance and inferred priority. Unclassified until set. Antwerp (01:30 Europe/Paris) is flagged unverified and races without a goal time are flagged. Fixtures in TRAINING.md produce the expected flags.

## Phase 3: Proposal engine and writes (signed off 08/11/2026, D40)
Scope: engine, audit log, Proposals screen, Garmin reschedule, sync-conflict probe.
Acceptance: a test proves no write path exists outside the engine. Stale-hash test passes. Probe result recorded in DECISIONS.md.
Status: signed off by Mark after the dry-run checks all passed. The live probe (a real move of one test workout, D34) is still open, so PULSE_GARMIN_WRITES and AI_PROPOSALS both stay off until the result is recorded as a decision.

## Phase 4: AI (split in two, D36)
### Phase 4a: AI foundation
Scope: Anthropic client (API only), usage logging and monthly cap with a hard stop, readiness verdict in code, daily briefing (06:30 job plus on-demand), Ask with read tools only, orb thinking state, AI off state, `pnpm eval` for manual runs.
Acceptance: with no key every AI surface says "AI is off" and the rest of the app is unchanged. The verdict fixtures pass. The cap stops AI at the monthly limit and nothing else changes. The tool loop is capped at 8. The key never appears in logs, responses or prompts. No ntfy yet.
### Phase 4b: built, waiting for Mark's testing (D42, D43)
Scope as built: race lead-up on the race detail screen (facts from the cache, no AI), weekly review (Sunday 19:00 and on demand, cached per week, on Week), post-run debrief (after the sync that brings a run in, cached per activity, on the activity), and propose_reschedule and propose_unschedule through the engine only, for dates only, behind AI_PROPOSALS and PULSE_GARMIN_WRITES, both default off. Ruled by D42: the app and the AI report what is in Garmin and never give training advice.
Deferred: briefing by ntfy (ntfy is off), optional forecast.
Acceptance: every figure traceable to data. No suggested numbers or advice anywhere. Write-shaped tools only insert a proposal, and with either flag off no proposal is created. The lead-up and every non-AI feature work with AI off and at the cap. Sign-off waits for Mark to test. The two flags stay off until the live probe result is recorded as a decision (D34).

### Tooling between phases: heart rate zones and VO2 max (D46)
Built: the Today cards (Kotcha zones copy with Garmin's zones and the change warning, VO2 max), the Trends VO2 max chart, the read tools and the sync kinds. Phase 4c (history import: older VO2 max in windows of 30 days and more history) is not built.

## Phase 5: Google Calendar, scope to be agreed
Scope and acceptance to be agreed before this phase starts. Candidates: busy time for the readiness verdict, mirrored planned workouts on a "Pulse Training" calendar (proposals only). See docs/INTEGRATIONS.md.

## Phase 6: Home Assistant
Scope: read-only states and cards first, then proposals for allowlisted services.
Acceptance: allowlist and denylist tests pass. No call_service without a confirmed proposal.

## Backlog
Nutrition log view from Garmin, weight trend, Paperless recent documents card, ntfy history, recreated apps where an API exists (candidates to be agreed).
