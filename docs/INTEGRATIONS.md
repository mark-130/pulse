# Integrations

## Garmin (through the existing Garmin MCP server)
- MCP client using @modelcontextprotocol/sdk over streamable HTTP. URL from GARMIN_MCP_URL. Prefer the internal Docker network address of the existing garmin-mcp container. Phase 0 discovers it and records it in DECISIONS.md. The public endpoint is garmin-mcp.hurts.cc via Cloudflare Tunnel (a bare curl returning 406 means healthy).
- The Garmin API behind it is unofficial: cache hard, sync every 30 minutes, never fetch live per page view.
- Read tools by feature:
  - Today: get_scheduled_workouts, get_workout_by_id, get_training_readiness, get_morning_training_readiness, get_sleep_summary, get_hrv_data, get_rhr_day, get_body_battery, get_stats
  - Load and trends: get_training_status, get_training_load_balance, get_training_load_trend, get_vo2max_trend, get_running_tolerance_trend, get_endurance_score, get_race_predictions
  - History: get_activities_by_date, get_activity, get_activity_splits, get_activity_hr_in_timezones
  - Races: get_calendar_events (synced by the Phase 1 Garmin job into the race table: title, date, start_time_local, time_zone, distance_m, goal_time_seconds, is_race, primary_event, subscribed, location, url, event_uuid). The Garmin calendar is read only for NGtive Split.
- Write tools, through proposals only, called only from the Garmin executor (D32). Phase 3 allows reschedule_workout (scheduled_workout_id, calendar_date) and unschedule_workout (scheduled_workout_id). The id is the calendar entry id from get_scheduled_workouts. schedule_workout is not built. Writes are off by default: PULSE_GARMIN_WRITES=on is needed before any call is made, and with it off the confirm flow records a dry run.
- Never used in v1 (not on any allowlist): delete_*, upload_*, push_workout_to_device, create_* workouts, nutrition, weigh-ins.
- Phase 0 lists the server's tools and diffs them against this file. Tool names may drift.
- Verified against the live server on 07/11/2026 (Phase 1): the server returns some upstream failures as plain text, not as a tool error, for example "Error retrieving training load data for ...: Read timed out". Text starting with "No" (no data found) is an empty result. Any other plain text is treated as a failure.
- get_training_load_trend makes one upstream request per day and times out on long ranges, so the sync asks for 42 days. Ranged tools reject more than 90 days. The calendar accepts a two year range. The first sync backfills 180 days of activities (about one minute), later syncs fetch 14 days.
- Store raw tool output in garmin_snapshot and validate with zod when reading.

## Google Calendar (Phase 5, scope to be agreed)
Not used in v1. Races come from the Garmin calendar (D22). Notes kept for when Phase 5 is scoped:
- OAuth 2.0 web client. Publish the consent screen to "In production" (personal use, the unverified warning is expected), because Testing mode refresh tokens expire after 7 days.
- Likely uses: busy time from a personal calendar for the readiness verdict, and mirrored planned workouts on an app-created "Pulse Training" calendar (proposals only, confirm tap). Scopes and calendars to be agreed.
- Redirect URI, primary: https://<host>.<tailnet>.ts.net:8443/api/auth/google/callback via tailscale serve. Confirm at setup that Google accepts ts.net. Fallback: authorise once from a laptop through an SSH tunnel to localhost:8210 using http://localhost:8210/api/auth/google/callback. The token is stored server side either way.

## ntfy (optional)
Off unless NTFY_TOKEN is set (D28). With no token the app never calls ntfy, logs one info line at boot ("ntfy alerts off") and nothing per skipped alert. A failed send (401, 403, network error, 5 second timeout) is caught, logged as one warning without the token or URL, and never fails, delays or backs off a sync. The sync sheet then says "Failure alerts are off. This screen is the only place failures show."
JSON POST to http://192.168.0.10:8090 (root URL), topic homelab-alerts, Bearer token. Notification titles use APP_NAME from packages/shared. Used for: briefing ready, pending proposals, sync failures. Messages link to NGtive Split (code name pulse) and never confirm anything.

## Anthropic API (Phase 4a)
- Official SDK (@anthropic-ai/sdk), used only in apps/api/src/modules/ai/anthropic.ts. Never in the browser.
- Env: ANTHROPIC_API_KEY (empty means AI is off), ANTHROPIC_MODEL_SMART=claude-sonnet-5-5 (Ask), ANTHROPIC_MODEL_FAST=claude-haiku-5-5 (briefing), AI_MONTHLY_CAP_GBP=5, AI_USD_TO_GBP=0.78. All are in deploy/docker-compose.yml with safe defaults. Use a dedicated key with its own spend limit in the Anthropic console as a second guard.
- Prices checked 08/11/2026 at https://platform.claude.com/docs/en/about-claude/pricing, USD per million tokens: Sonnet 5.5 input 2, output 10, 5 minute cache write 2.50, cache read 0.10. Haiku 5.5 (prompts up to 100,000 tokens) input 0.10, output 0.50, cache write 0.125, cache read 0.01. The table and its date are in apps/api/src/modules/ai/pricing.ts and shown on Settings. Recheck them when the page changes.
- Retries once, 60 second timeout. A failed call is logged as one sanitised line and never contains the key.

## Updating the app (Watchtower HTTP API, D39)
NGtive Split asks Watchtower to update only itself: GET WATCHTOWER_URL/v1/update?image=ghcr.io/mark-130/pulse with Authorization: Bearer WATCHTOWER_TOKEN. The image is fixed in code. Without WATCHTOWER_TOKEN the Settings card still shows the build and the check, and Update now says "Updating from the app is off. Set WATCHTOWER_TOKEN to turn it on."

Add these variables to the Watchtower container or stack (not done by this repo, and the first two are required together):
- WATCHTOWER_HTTP_API_UPDATE=true
- WATCHTOWER_HTTP_API_TOKEN=<a long random value>. Put the same value in this app's stack as WATCHTOWER_TOKEN.
- WATCHTOWER_HTTP_API_PERIODIC_POLLS=true

**Warning: without WATCHTOWER_HTTP_API_PERIODIC_POLLS=true, switching the HTTP API on turns off Watchtower's own schedule, so the nightly 04:00 updates stop.** Set it in the same change and check the next morning that the schedule still runs.

Network (checked 08/11/2026): the Watchtower container is on watchtower_default only, not on homelab, so http://watchtower:8080 does not resolve from this app today. Either attach Watchtower to homelab as well (it then resolves as watchtower on port 8080), or add watchtower_default as an external network to this app's compose service (it fails to deploy if that network is ever removed), or point WATCHTOWER_URL at an address that works. Watchtower publishes no port, so no host port is exposed.

The package must be public (D13) for both the anonymous update check and Watchtower's own pulls. The update check reads the image labels from GHCR without credentials, so a private package shows "Could not check" with the reason under Details.

## Open-Meteo (Phase 4, optional)
No key. Daily and race-week forecast from home coordinates in settings.

## Home Assistant (Phase 6)
WebSocket API with a long-lived token (HA_URL, HA_TOKEN). Read states first. call_service only through proposals, on allowlisted entities.
