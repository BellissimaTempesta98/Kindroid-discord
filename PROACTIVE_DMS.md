# Proactive Kin DMs (feature branch only)

This feature is **OFF by default**. It does not change existing replies to incoming DMs or guild messages.

## Before enabling
1. Test this branch in a separate deployment. Keep the existing Railway deployment on `main` until the feature is verified.
2. Set `PROACTIVE_DM_USER_ID` to the Discord *user ID* of the **one** intended recipient, not a username or bot ID.
3. Set `PROACTIVE_DMS_ENABLED=true` only in the test deployment when ready. Set it to `false` (or remove it) to disable future scheduled messages.
4. Start the service. Each configured Kin schedules its own first DM at a random time between **2 and 6 hours** after becoming ready. Subsequent messages are scheduled in the same range. Every added Kin using the existing consecutive `BOT_TOKEN_N` and `SHARED_AI_CODE_N` settings is included automatically.

The Kin uses its existing Kindroid share code and recent DM history to draft the message, with an internal instruction to initiate a conversation. Its Discord bot account sends the message to the configured user.

## Safety and behavior
- Only one explicit recipient is allowed. No server-wide or member-list messaging.
- Failed or blocked DMs are logged and do not stop the other bots.
- Sending pauses when the opt-in switch is off or the bot disconnects.
- Timers are cleared on normal shutdown.
- Times are per running instance and reset on restart; there is **no persistent scheduling database**.
- This is an initial implementation. Verify compilation, Discord delivery, and Kindroid API behavior in a test deployment before merging or changing the production Railway branch.
- Discord may block unsolicited bot DMs based on a recipient's settings or prior interaction.

**Do not place bot tokens, API keys, or user IDs in GitHub source files.** Keep them in environment variables.
