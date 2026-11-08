# Architecture

## Shape
One container. Hono API plus the built React app. SQLite in /data. Scheduled jobs in-process (croner). Modules register routes, jobs, AI tools and widgets.

## Data model (SQLite via Drizzle)
- garmin_snapshot: kind, date, payload JSON, fetched_at. Unique on (kind, date): one raw snapshot per kind per London day, replaced by later syncs the same day.
- activity: garmin_activity_id, name, type, start_local, date, distance_m, duration_s, avg_hr, max_hr, calories, elevation_gain_m, first_seen, last_seen (from get_activities_by_date, history kept)
- workout: garmin_scheduled_id, garmin_workout_id, date, name, sport, duration_s, completed, first_seen, last_seen
- race (from Garmin get_calendar_events, replaced on each sync by event_uuid): event_uuid, title, date, start_time_local, time_zone, distance_m, goal_time_seconds, is_race, primary_event, subscribed, location, url, first_seen, last_seen
- race_meta (built in Phase 2, D29; owned by NGtive Split, never overwritten by sync): meta_key, priority (A, B, C), type (road, trail), goal_override_s, notes, updated_at. meta_key is event_uuid when present, otherwise the date plus the normalised title (lower case, punctuation removed, spaces collapsed). Edits are local database writes with no confirm tap, because nothing outside NGtive Split changes.
- proposal, audit_log (see below)
- sync_state: job, last_ok, last_attempt, last_error, consecutive_failures, last_alert_at, detail
- briefing: date, text, data JSON, model, tokens
- chat_message: thread, role, content, tool_calls JSON
- ai_usage: ts, feature, model, input_tokens, output_tokens, cost_gbp
- settings: key, value JSON (taper overrides, home coordinates, Phase 5 calendar allowlist)
- secret: name, ciphertext (AES-256-GCM, key from PULSE_SECRET_KEY)

## Races (Phase 2)
- Rules live in apps/api/src/modules/races/logic.ts as pure functions (inference, taper, recovery, flags, warnings), tested against the TRAINING.md fixtures with no race names in production code.
- GET /api/races returns every active race with the effective priority, type, distance and goal, taper and recovery dates, data quality flags and the warnings. It reads the database only.
- PUT /api/races/meta {key, priority, type} writes race_meta for one race (key is race.event_key). null clears a field and both null removes the row. The response carries the previous values so the screen can offer an undo. Session and CSRF are required. No confirm tap, because only our own database changes and Garmin is never written (D29).
- Today reads its next race from the same function, so the chips on the race card match the Races screen.

## Auth
Single user. Password checked against a scrypt hash (salt:hash in hex) in PULSE_PASSWORD_HASH. Signed httpOnly SameSite=Lax session cookie (30 days). CSRF token header on every non-GET. Login rate limit: 5 attempts per 15 minutes per IP. Tailscale identity headers are not trusted, because LAN clients can spoof them.

## Proposal engine (the only write path)
- Creators (UI actions and AI tools) call createProposal(). Nothing else may execute a write.
- proposal fields: id, kind (garmin.schedule, garmin.reschedule, garmin.unschedule, calendar.create, calendar.update, ha.call_service), target_system, payload, before, after, rationale, created_by (user or ai), state_hash, status (pending, applied, rejected, expired, stale, failed), expires_at (24 hours), decided_at, result.
- Executors live one file per system and are importable only from the confirm route (enforce with an ESLint no-restricted-imports rule and a test).
- POST /api/proposals/:id/confirm needs a session and CSRF. It requires status pending and not expired, re-fetches live state, compares state_hash, and if it differs marks the proposal stale and shows the new diff. Otherwise it executes, writes audit_log, updates status.
- AI tool context has no reference to executors or the confirm route. ntfy messages link to the app and never carry confirm actions.
- Idempotency (Phase 5): calendar events carry extendedProperties.private.pulseKey. Garmin operations are keyed by scheduled_workout_id.
- audit_log is append only: ts, actor, action, target, payload_hash, result.
- Allowlists: Google Calendar writes do not exist until Phase 5, which will define a writable calendar allowlist (likely the app-created "Pulse Training"). Garmin write tools limited to schedule_workout, reschedule_workout, unschedule_workout. Home Assistant limited to allowlisted entities, and the domains lock, alarm_control_panel, cover and siren cannot be proposed at all in v1.

## Sync
- Each module job writes snapshots. Garmin every 30 minutes with backoff, covering workouts, metrics and the race calendar. Phase 5 adds Google incremental sync with syncToken, full resync on 410.
- UI reads the database only, never live upstream calls per page view.
- Partial success (D27): every kind is stored on its own and records its own outcome in sync_state under garmin:<task> (last_ok, last_error, consecutive_failures), alongside the raw snapshot with its own fetched_at. A failure in one kind never discards or blocks the others. A run where some kinds fail is partial: the job counts as ok and keeps a note. A run counts as failed only if nothing could be fetched (or Garmin cannot be reached). Only failed runs back off 30, 60, 120 then 240 minutes and count towards the ntfy alert.
- Retry: a timeout-type error (timed out, ETIMEDOUT, ECONNRESET) on one call is retried inside the job, twice, after 10 seconds and then 30 seconds. Other errors are not retried. After two calls in one run have used up their retries, later calls are not retried, so a dead upstream cannot stall the job.
- Freshness groups (GARMIN_GROUPS in packages/shared): plan (scheduled workouts, calendar events), readiness (stats, readiness, sleep, HRV, resting HR, body battery), activities, trends. A group is as old as its oldest kind. Stale means older than 90 minutes, or never fetched.
- The header pill and the full banner use the oldest of plan and readiness. A stale activities or trends group alone never shows the full banner. It shows a quiet inline note on the cards that use it. Cards show the sync time of the groups they use.
- A future workout that Garmin stops returning is removed. Past workouts, activities and raw snapshots are kept as history. Races Garmin stops returning are marked inactive.
- Nightly backup at 03:10 Europe/London: VACUUM INTO /data/backups/pulse-YYYYMMDD-HHmm.db, newest 7 kept.
- Offline: the service worker keeps the last good response of the read endpoints in the pulse-api cache (network first). Sign out deletes that cache.
- ntfy alert after 3 consecutive failures, at most once per day per job.

## Security and ops
- pino logging with token redaction. Secrets only in env or the encrypted secret table.
- Nightly SQLite backup (VACUUM INTO /data/backups, keep 7). Check that existing Restic jobs cover /mnt/data/AppData/pulse.
- Dockerfile: multi-stage on node:22-alpine, non-root, healthcheck on /api/health.
- CI: GitHub Actions on the existing self-hosted runner builds and pushes ghcr.io/mark-130/pulse:latest and :sha. Watchtower pulls updates.
