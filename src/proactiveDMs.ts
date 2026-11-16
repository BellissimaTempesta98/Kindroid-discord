import type { Client, DMChannel } from "discord.js";
import type { BotConfig } from "./types";
import { callKindroidAI } from "./kindroidAPI";
import { ephemeralFetchConversation } from "./messageFetch";

// Explicit opt-in: nothing runs unless PROACTIVE_DMS_ENABLED=true.
// Only the configured user receives messages, never server members.
const DEFAULT_MIN_MINUTES = 120;
const DEFAULT_MAX_MINUTES = 360;

function intervalMinutes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 1440
    ? parsed
    : fallback;
}
interface Schedule {
  timer?: ReturnType<typeof setTimeout>;
}
// Keep the schedule registered while a request is in flight.
const schedules = new Map<string, Schedule>();

function enabled(): boolean {
  return process.env.PROACTIVE_DMS_ENABLED?.toLowerCase() === "true";
}

function delayMs(): number {
  const min = intervalMinutes("PROACTIVE_DM_MIN_MINUTES", DEFAULT_MIN_MINUTES);
  const max = Math.max(min, intervalMinutes("PROACTIVE_DM_MAX_MINUTES", DEFAULT_MAX_MINUTES));
  return (min + Math.random() * (max - min)) * 60_000;
}

function targetUserId(): string | null {
  const id = process.env.PROACTIVE_DM_USER_ID?.trim() || "";
  return /^\d{17,20}$/.test(id) ? id : null;
}

async function sendProactiveDM(
  client: Client, botConfig: BotConfig, active: () => boolean
): Promise<void> {
  const userId = targetUserId();
  if (!active() || !userId) return;

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
    if (aiResult.type === "rate_limited" || !active() || targetUserId() !== userId) return;
    const reply = aiResult.reply.trim();
    if (!reply) return;
    await channel.send({ content: reply.slice(0, 2000), allowedMentions: { parse: [] } });
    console.log(`[Bot ${botConfig.id}] Sent opt-in proactive DM`);
  } catch (error) {
    // Closed DMs, permissions, failed Kindroid calls and transient outages
    // should never interfere with normal incoming-message handling.
    console.error(`[Bot ${botConfig.id}] Proactive DM skipped:`,
      error instanceof Error ? error.message : "Unknown error");
  }
}

export function startProactiveDMs(client: Client, botConfig: BotConfig): void {
  if (!enabled()) return;
  if (!targetUserId()) {
    console.warn("Proactive DMs disabled: PROACTIVE_DM_USER_ID must be a Discord user ID.");
    return;
  }
  if (schedules.has(botConfig.id)) return;
  const schedule: Schedule = {};
  schedules.set(botConfig.id, schedule);
  const active = (): boolean => schedules.get(botConfig.id) === schedule
    && enabled() && client.isReady();

  const scheduleNext = (): void => {
    if (schedules.get(botConfig.id) !== schedule || !enabled()) {
      if (schedules.get(botConfig.id) === schedule) schedules.delete(botConfig.id);
      return;
    }
    // Retain the timer through temporary disconnects and try next interval.
    schedule.timer = setTimeout(async () => {
      try {
        await sendProactiveDM(client, botConfig, active);
      } finally {
        scheduleNext();
      }
    }, delayMs());
  };

  scheduleNext();
  console.log(`[Bot ${botConfig.id}] Opt-in proactive DMs scheduled`);
}

export function stopProactiveDMs(): void {
  for (const schedule of schedules.values()) {
    if (schedule.timer) clearTimeout(schedule.timer);
  }
  // In-flight requests can finish, but their active check prevents delivery/rescheduling.
  schedules.clear();
}
