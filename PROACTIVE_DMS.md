# Proactive Kin DMs — separate companion deployment

The feature stays off until explicitly enabled. Each configured Kin has its own random 2–6 hour timer, its own Kindroid share code and its own recent Discord DM history. Messages go only to the single configured human recipient. Additional consecutively numbered Kins are included on service restart.

## Protect the working deployment

Keep **Determined Purpose** and its `main` branch deployment unchanged. Deploy this repository's `proactive-dms` branch to a separate Railway service/project. Set `PROACTIVE_DMS_ONLY=true` there: this service sends proactive DMs and registers no incoming-message handler, while the original service continues handling replies. Never run multiple proactive replicas or another proactive service using the same bot accounts. Use one replica, no overlapping deployments, and disable Railway app sleeping for this background worker.

## Companion configuration

Use Node.js 22.13+ and the existing `npm start` command. Supply the existing `KINDROID_INFER_URL`, `KINDROID_API_KEY`, and every consecutive `BOT_TOKEN_N` / `SHARED_AI_CODE_N` pair beginning at 1, including optional `ENABLE_FILTER_N`. Keep secrets exclusively in Railway variables. A separate project's variable copies do not automatically follow later changes to the original: add new Kins to the companion too.

Set:

- `PROACTIVE_DMS_ONLY=true`
- `PROACTIVE_DMS_ENABLED=false` until the configuration is verified
- `PROACTIVE_DM_USER_ID` to the verified Discord user ID of Bellissima, never a guessed username, server ID or bot ID
- `PROACTIVE_DM_MIN_MINUTES=120`
- `PROACTIVE_DM_MAX_MINUTES=360`

After the build succeeds and all expected bot accounts report ready, enable `PROACTIVE_DMS_ENABLED=true`. Each bot logs when scheduling starts and when a proactive DM is sent. For a short delivery test only, use both interval variables set to `1`, observe delivery from each Kin, then restore `120` and `360`. Confirm a reply is answered once by the original deployment. Discord privacy settings or missing mutual server access can prevent delivery.

## Behavior and rollback

- No server-member discovery, group sends or messages to other users.
- Blocked DMs, Kindroid errors and rate limits skip that attempt and retry at the next randomized interval; they do not stop other Kins.
- Temporary disconnects skip delivery and retain a future attempt.
- Shutdown clears timers and prevents an in-flight generation from subsequently sending or recreating its timer. A send already accepted by Discord cannot be retracted by shutdown.
- Timers reset on restart; scheduling is in memory, with no database or cross-instance deduplication.
- Disable or stop only the companion to roll back. Determined Purpose remains available.
- Generation uses a private instruction appended to recent history. The model is asked to initiate naturally in the Kin's voice; wording still depends on Kindroid's response.

## Verification

`npm test` runs isolated tests of the actual TypeScript modules using fake Discord/Kindroid clients and controlled timers, without credentials or outgoing messages. GitHub Actions additionally installs locked dependencies and runs `npm run build` before the same tests. These checks do not establish that real credentials, Kindroid API access or Discord delivery work; that requires the separate Railway delivery test.
