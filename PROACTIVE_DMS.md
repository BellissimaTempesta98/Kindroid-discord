# Proactive Kin DMs — guarded live rollout

Deployment requires Bellissima's explicit approval. Use the existing Determined Purpose service and credentials. Do not change main or create another project. The reviewed release is deployed by an exact commit pin after approval.

## Required configuration

- `PROACTIVE_DMS_ONLY=false`: keep ordinary incoming DM/server replies enabled in the combined service.
- `PROACTIVE_DMS_ENABLED=false` for the initial installation and reconnect checks; enable only after separate activation approval.
- `PROACTIVE_DM_USER_ID`: the one verified human recipient's Discord user ID.
- `PROACTIVE_DM_GUILD_ID`: the exact verified Discord server ID. This is required; missing or invalid IDs disable proactive scheduling.
- `PROACTIVE_DM_MIN_MINUTES=120`, `PROACTIVE_DM_MAX_MINUTES=360`: independent random 2–6 hour timers per Kin. No quiet hours.

Keep existing Kindroid API credentials, consecutively numbered bot tokens/share codes, and filter settings unchanged. Each bot retains its own share code and recent DM history. Additional configured Kins are loaded on service restart.

## Server membership enforcement

Every attempt requires the bot's connected Discord client to have the configured server available. Before contacting Kindroid, the bot requests that server from Discord with `force: true, cache: false`. It performs another fresh REST check after generation, immediately before sending. Cached membership, an existing DM, or membership in another server never authorizes delivery.

A `guildDelete` event for the configured server invalidates in-flight generation, including when the bot is removed and re-added during the same generation. A removed bot automatically skips later proactive attempts even if its token remains configured. Other Kins keep their own timers. Re-adding a bot makes it eligible on a later scheduled attempt; it does not trigger an immediate DM.

Missing access, failed membership verification, server unavailability or a disconnected client suppress proactive messages. Membership errors never terminate ordinary reply handling. A Discord outage may therefore delay proactive delivery. No privileged server-member-list intent or member enumeration is added; this checks the bot's own server access using its existing Guilds intent.

Discord membership checks and DM dispatch are separate operations: no implementation can recall a DM already dispatched/accepted by Discord, or atomically prevent a removal that happens after the final check and during dispatch. Removal events and a final fresh check minimize this boundary; do not promise retroactive cancellation.

## Limits and rollback

Use one replica, no deployment overlap, and no sleeping. Timers are in memory, reset on restart, and provide no cross-instance deduplication. No quiet hours, idle check or global daily cap is implemented. There can be bursts and API rate limits. The existing inference helper has a 60-second timeout.

Failed/blocked DMs and generation failures skip the attempt and retain the next timer. Shutdown clears timers/listeners and invalidates pending generation before dispatch. Rollback disables proactive messaging and restores the preserved baseline deployment/source/settings; it does not change credentials or delete prior Discord messages.

## Verification

`npm test` executes actual TypeScript modules with fake Discord/Kindroid clients and controlled timers, without credentials or outgoing messages. Membership tests include removal before a tick, stale cache/missed gateway events, removal during generation/final verification, leave-and-rejoin, wrong server, outages, other-Kin independence and listener cleanup. The full TypeScript build must also pass.

These checks do not verify real logins, actual server identity or Discord delivery. During the approved rollout, verify all configured Kins reconnect with ordinary replies preserved. After separately approved activation, require membership checks against the verified server and inspect actual delivery/skip results. Keep the original deployment and exact source commit available for rollback.
