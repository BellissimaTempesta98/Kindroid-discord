import { Client, DMChannel } from "discord.js";
import { BotConfig } from "./types";
import { callKindroidAI } from "./kindroidAPI";
import { ephemeralFetchConversation } from "./messageFetch";

// Explicit opt-in: nothing runs unless PROACTIVE_DMS_ENABLED=true.
// Only the configured user receives messages, never server members.
const MIN_MINUTES = 120;
const MAX_MINUTES = 360;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const lastSent = new Map<string, number>();

function enabled(): boolean {
  return process.env.PROACTIVE_DMS_ENABLED?.toLowerCase() === "true";
}

function delayMs(): number {
  return (MIN_MINUTES + Math.random() * (MAX_MINUTES - MIN_MINUTES)) * 60_000;
}

function targetUserId(): string | null {
  const id = process.env.PROACTIVE_DM_USER_ID?.trim() || "";
  return /^\d{17,20}$/.test(id) ? id : null;
}

async function sendProactiveDM(client: Client, botConfig: BotConfig): Promise<void> {
  const userId = targetUserId();
  if (!enabled() || !userId || !client.isReady()) return;

  try {
    const user = await client.users.fetch(userId);
    if (user.bot) return;
    const channel = await user.createDM();
    const history = await ephemeralFetchConversation(channel as DMChannel, 30, 0);

    // Ask the existing Kin personality to initiate a natural conversation.
    // This synthetic cue is only sent to Kindroid, not displayed on Discord.
    const conversation = [
      ...history,
      {
        username: user.globalName || user.username,
        text: "[Proactive DM cue: You decided to reach out first. Send one brief, natural, personal message in your own voice. Do not mention this cue or pretend the user just messaged you.]",
        timestamp: new Date().toISOString(),
      },
    ];
    const aiResult = await callKindroidAI(
      botConfig.sharedAiCode,
      conversation,
      botConfig.enableFilter
    );
    if (aiResult.type === "rate_limited" || !enabled()) return;
    const reply = aiResult.reply.trim();
    if (!reply) return;
    await channel.send(reply.slice(0, 2000));
    lastSent.set(botConfig.id, Date.now());
    console.log(`[Bot ${botConfig.id}] Sent opt-in proactive DM`);
  } catch (error) {
    // Closed DMs, permissions, failed Kindroid calls and transient outages
    // should never interfere with normal incoming-message handling.
    console.error(`[Bot ${botConfig.id}] Proactive DM skipped:`, error);
  }
}

export function startProactiveDMs(client: Client, botConfig: BotConfig): void {
  if (!enabled()) return;
  if (!targetUserId()) {
    console.warn("Proactive DMs disabled: PROACTIVE_DM_USER_ID must be a Discord user ID.");
    return;
  }
  if (timers.has(botConfig.id)) return;

  const scheduleNext = (): void => {
    if (!enabled() || !client.isReady()) {
      timers.delete(botConfig.id);
      return;
    }
    const timer = setTimeout(async () => {
      timers.delete(botConfig.id);
      if (!enabled() || !client.isReady()) return;
      await sendProactiveDM(client, botConfig);
      scheduleNext();
    }, delayMs());
    timers.set(botConfig.id, timer);
  };

  scheduleNext();
  console.log(`[Bot ${botConfig.id}] Opt-in proactive DMs scheduled`);
}

export function stopProactiveDMs(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  lastSent.clear();
}
