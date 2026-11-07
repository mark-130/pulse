# Integrations

## Garmin (through the existing Garmin MCP server)
- MCP client using @modelcontextprotocol/sdk over streamable HTTP. URL from GARMIN_MCP_URL. Prefer the internal Docker network address of the existing garmin-mcp container. Phase 0 discovers it and records it in DECISIONS.md. The public endpoint is garmin-mcp.hurts.cc via Cloudflare Tunnel (a bare curl returning 406 means healthy).
- The Garmin API behind it is unofficial: cache hard, sync every 30 minutes, never fetch live per page view.
- Read tools by feature:
  - Today: get_scheduled_workouts, get_workout_by_id, get_training_readiness, get_morning_training_readiness, get_sleep_summary, get_hrv_data, get_rhr_day, get_body_battery, get_stats
  - Load and trends: get_training_status, get_training_load_balance, get_training_load_trend, get_vo2max_trend, get_running_tolerance_trend, get_endurance_score, get_race_predictions
  - History: get_activities_by_date, get_activity, get_activity_splits, get_activity_hr_in_timezones
  - Races: get_calendar_events
- Write tools, Phase 3 onwards, through proposals only: schedule_workout, reschedule_workout, unschedule_workout.
- Never used in v1: delete_*, upload_*, push_workout_to_device, create_* workouts, nutrition, weigh-ins.
- Phase 0 lists the server's tools and diffs them against this file. Tool names may drift.
- Store raw tool output in garmin_snapshot and validate with zod when reading.

## Google Calendar (personal Google account)
- OAuth 2.0 web client. Publish the consent screen to "In production" (personal use, the unverified warning is expected), because Testing mode refresh tokens expire after 7 days.
- Scopes: Phase 2 calendar.readonly. Phase 3 adds calendar.events and calendar.app.created (verify names against Google docs at build time). Re-consent at Phase 3 is expected.
- Redirect URI, primary: https://<host>.<tailnet>.ts.net:8443/api/auth/google/callback via tailscale serve. Confirm at setup that Google accepts ts.net. Fallback: authorise once from a laptop through an SSH tunnel to localhost:8210 using http://localhost:8210/api/auth/google/callback. The token is stored server side either way.
- Read allowlist (settings): "Running Events" (races) and "Mark Bacon: Home" (busy time). The Man Utd fixtures calendar is excluded by default.
- Writes (proposals only): the @pulse tag line on Running Events, and mirrored planned workouts on a "Pulse Training" calendar the app creates. Garmin owns workout content, the calendar owns date and time. A moved calendar event becomes a reschedule proposal, never an automatic change.

## ntfy
JSON POST to http://192.168.0.10:8090 (root URL), topic homelab-alerts, Bearer token. Notification titles use APP_NAME from packages/shared. Used for: briefing ready, pending proposals, sync failures. Messages link to NGtive Split (code name pulse) and never confirm anything.

## Anthropic API
Official SDK. Models from env, defaults ANTHROPIC_MODEL_SMART=claude-sonnet-5-5 and ANTHROPIC_MODEL_FAST=claude-haiku-5-5 (verify IDs at docs.claude.com before the first call). Dedicated API key with a spend cap.

## Open-Meteo (Phase 4, optional)
No key. Daily and race-week forecast from home coordinates in settings.

## Home Assistant (Phase 5)
WebSocket API with a long-lived token (HA_URL, HA_TOKEN). Read states first. call_service only through proposals, on allowlisted entities.
