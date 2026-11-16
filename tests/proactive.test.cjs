const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { EventEmitter } = require('node:events');

async function harness(envOverrides = {}) {
  const env = { PROACTIVE_DMS_ENABLED: 'true', PROACTIVE_DM_USER_ID: '123456789012345678', PROACTIVE_DM_GUILD_ID: '987654321098765432', ...envOverrides };
  const pending = new Map();
  const calls = [], deliveries = [];
  let seq = 0, ready = true, bot = false, blocked = false;
  let result = { type: 'success', reply: 'Hello from your Kin!' };
  let membership = true, membershipError = false, fetchHook;
  const guildFetches = [];
  const guilds = new Map([[env.PROACTIVE_DM_GUILD_ID, { id: env.PROACTIVE_DM_GUILD_ID, available: true }]]);
  const context = vm.createContext({
    process: { env }, console: { log() {}, warn() {}, error() {} },
    setTimeout(fn, delay) { const id = ++seq; pending.set(id, { fn, delay }); return id; },
    clearTimeout(id) { pending.delete(id); },
  });
  const ai = new vm.SyntheticModule(['callKindroidAI'], function () {
    this.setExport('callKindroidAI', async (...args) => { calls.push(args); return typeof result === 'function' ? result() : result; });
  }, { context });
  const history = new vm.SyntheticModule(['ephemeralFetchConversation'], function () {
    this.setExport('ephemeralFetchConversation', async () => [{ username: '{{ai}}', text: 'Earlier message' }]);
  }, { context });
  const module = new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync('src/proactiveDMs.ts', 'utf8')), { context });
  await module.link(specifier => {
    if (specifier === './kindroidAPI') return ai;
    if (specifier === './messageFetch') return history;
    throw new Error('Unexpected runtime dependency: ' + specifier);
  });
  await module.evaluate();
  const client = Object.assign(new EventEmitter(), {
    guilds: {
      cache: guilds,
      async fetch(options) {
        guildFetches.push(options);
        if (fetchHook) await fetchHook(guildFetches.length);
        if (membershipError || !membership) throw new Error('Missing Access');
        return { id: options.guild };
      },
    },
    isReady: () => ready,
    users: { async fetch(id) {
      assert.equal(id, env.PROACTIVE_DM_USER_ID);
      return { bot, username: 'Bellissima', globalName: 'Bellissima', async createDM() {
        if (blocked) throw new Error('DMs closed');
        return { async send(message) { deliveries.push(message); } };
      } };
    } },
  });
  return {
    env, pending, calls, deliveries, client, guildFetches,
    setMembership(v, emit = true, keepCache = false) {
      membership = v;
      if (v) guilds.set(env.PROACTIVE_DM_GUILD_ID, { id: env.PROACTIVE_DM_GUILD_ID, available: true });
      else {
        if (!keepCache) guilds.delete(env.PROACTIVE_DM_GUILD_ID);
        if (emit) client.emit('guildDelete', { id: env.PROACTIVE_DM_GUILD_ID });
      }
    },
    setUnavailable(v) { const guild = guilds.get(env.PROACTIVE_DM_GUILD_ID); if (guild) guild.available = !v; },
    setMembershipError(v) { membershipError = v; },
    setFetchHook(v) { fetchHook = v; },
    start(id = 'bot1') { module.namespace.startProactiveDMs(client, { id, sharedAiCode: id + '-code', enableFilter: false }); },
    stop() { module.namespace.stopProactiveDMs(); },
    setReady(v) { ready = v; }, setBot(v) { bot = v; }, setBlocked(v) { blocked = v; }, setResult(v) { result = v; },
    async tick() { const [id, task] = pending.entries().next().value; pending.delete(id); await task.fn(); },
  };
}

test('disabled, missing, and invalid recipients never schedule', async () => {
  for (const override of [{ PROACTIVE_DMS_ENABLED: 'false' }, { PROACTIVE_DM_USER_ID: '' }, { PROACTIVE_DM_USER_ID: 'username' }]) {
    const h = await harness(override); h.start(); assert.equal(h.pending.size, 0);
  }
});
test('each Kin has one independent timer, code, history, and recipient', async () => {
  const h = await harness();
  h.start('bot1'); h.start('bot2'); h.start('bot1');
  assert.equal(h.pending.size, 2);
  for (const { delay } of h.pending.values()) assert.ok(delay >= 7200000 && delay <= 21600000);
  await h.tick(); await h.tick();
  assert.deepEqual(h.calls.map(c => c[0]), ['bot1-code', 'bot2-code']);
  assert.equal(h.calls[0][1][0].text, 'Earlier message');
  assert.equal(h.deliveries.length, 2);
  assert.equal(h.pending.size, 2);
  assert.equal(h.deliveries[0].allowedMentions.parse.length, 0);
});
test('blocked DMs, rate limits, blank replies, and bot recipients do not send or kill scheduling', async () => {
  for (const mode of ['blocked', 'rate', 'blank', 'bot', 'error']) {
    const h = await harness();
    if (mode === 'blocked') h.setBlocked(true);
    if (mode === 'rate') h.setResult({ type: 'rate_limited' });
    if (mode === 'blank') h.setResult({ type: 'success', reply: ' ' });
    if (mode === 'bot') h.setBot(true);
    if (mode === 'error') h.setResult(() => { throw new Error('API down'); });
    h.start(); await h.tick();
    assert.equal(h.deliveries.length, 0, mode); assert.equal(h.pending.size, 1, mode);
  }
});
test('disconnect skips sending and resumes after reconnect', async () => {
  const h = await harness(); h.start(); h.setReady(false); await h.tick();
  assert.equal(h.deliveries.length, 0); assert.equal(h.pending.size, 1);
  h.setReady(true); await h.tick(); assert.equal(h.deliveries.length, 1);
});
test('shutdown during generation prevents sending and rescheduling; duplicate start is ignored in flight', async () => {
  const h = await harness(); let resolve;
  h.setResult(() => new Promise(r => { resolve = r; })); h.start();
  const tick = h.tick();
  while (!resolve) await Promise.resolve();
  h.start(); assert.equal(h.pending.size, 0);
  h.stop(); resolve({ type: 'success', reply: 'Should never send' }); await tick;
  assert.equal(h.deliveries.length, 0); assert.equal(h.pending.size, 0);
});
test('disable, recipient change, and disconnect during generation prevent delivery', async () => {
  for (const mode of ['disable', 'recipient', 'disconnect']) {
    const h = await harness(); let resolve;
    h.setResult(() => new Promise(r => { resolve = r; })); h.start(); const tick = h.tick();
    while (!resolve) await Promise.resolve();
    if (mode === 'disable') h.env.PROACTIVE_DMS_ENABLED = 'false';
    if (mode === 'recipient') h.env.PROACTIVE_DM_USER_ID = '999999999999999999';
    if (mode === 'disconnect') h.setReady(false);
    resolve({ type: 'success', reply: 'No delivery' }); await tick;
    assert.equal(h.deliveries.length, 0, mode); h.stop(); assert.equal(h.pending.size, 0);
  }
});
test('minute test overrides and invalid timing defaults', async () => {
  const h = await harness({ PROACTIVE_DM_MIN_MINUTES: '1', PROACTIVE_DM_MAX_MINUTES: '1' });
  h.start(); assert.equal([...h.pending.values()][0].delay, 60000); h.stop();
  const invalid = await harness({ PROACTIVE_DM_MIN_MINUTES: 'NaN', PROACTIVE_DM_MAX_MINUTES: '-1' });
  invalid.start(); assert.ok([...invalid.pending.values()][0].delay >= 7200000);
});
test('long generated replies respect Discord message limit', async () => {
  const h = await harness(); h.setResult({ type: 'success', reply: 'x'.repeat(3000) }); h.start(); await h.tick();
  assert.equal(h.deliveries[0].content.length, 2000);
});

test('companion mode logs in all Kins without incoming handlers and destroys every client on shutdown', async () => {
  for (const only of ['true', 'false']) {
    const clients = [], started = []; let stopped = false;
    class Client {
      constructor() { this.handlers = {}; this.user = { tag: 'Kin' }; clients.push(this); }
      once(name, fn) { this.handlers[name] = fn; }
      on(name, fn) { this.handlers[name] = fn; }
      async login(token) { this.token = token; this.handlers.ready(); }
      async destroy() { this.destroyed = true; }
    }
    const context = vm.createContext({ process: { env: { PROACTIVE_DMS_ONLY: only } }, console: { log() {}, error() {} } });
    const exports = { Client, GatewayIntentBits: {}, Partials: {}, ChannelType: {}, PermissionFlagsBits: {}, Message: class {}, TextChannel: class {}, DMChannel: class {}, BaseGuildTextChannel: class {} };
    const discord = new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
    const proactive = new vm.SyntheticModule(['startProactiveDMs', 'stopProactiveDMs'], function () {
      this.setExport('startProactiveDMs', (_, config) => started.push(config.id));
      this.setExport('stopProactiveDMs', () => { stopped = true; });
    }, { context });
    const history = new vm.SyntheticModule(['ephemeralFetchConversation'], function () { this.setExport('ephemeralFetchConversation', async () => []); }, { context });
    const ai = new vm.SyntheticModule(['callKindroidAI'], function () { this.setExport('callKindroidAI', async () => ({ type: 'rate_limited' })); }, { context });
    // Explicit type imports avoid a runtime dependency on interfaces.
    const module = new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync('src/discordManager.ts', 'utf8')), { context });
    await module.link(specifier => ({ 'discord.js': discord, './proactiveDMs': proactive, './messageFetch': history, './kindroidAPI': ai })[specifier]);
    await module.evaluate();
    await module.namespace.initializeAllBots([{ id: 'bot1', discordBotToken: 'fake1' }, { id: 'bot2', discordBotToken: 'fake2' }]);
    assert.deepEqual(started, ['bot1', 'bot2']);
    for (const client of clients) {
      assert.equal(typeof client.handlers.error, 'function');
      assert.equal(typeof client.handlers.messageCreate, only === 'true' ? 'undefined' : 'function');
    }
    await module.namespace.shutdownAllBots();
    assert.ok(stopped); assert.ok(clients.every(c => c.destroyed));
  }
});

test('a valid explicit server ID is required; no fallback to any shared server', async () => {
  for (const id of ['', 'server-name']) {
    const h = await harness({ PROACTIVE_DM_GUILD_ID: id });
    h.start(); assert.equal(h.pending.size, 0); assert.equal(h.client.listenerCount('guildDelete'), 0);
  }
});
test('membership uses the configured server and fresh REST checks before generation and dispatch', async () => {
  const h = await harness(); h.start(); await h.tick();
  assert.equal(h.deliveries.length, 1); assert.equal(h.guildFetches.length, 2);
  for (const options of h.guildFetches) {
    assert.equal(options.guild, h.env.PROACTIVE_DM_GUILD_ID);
    assert.equal(options.force, true); assert.equal(options.cache, false);
  }
});
test('nonmember bot cannot generate or DM even with an existing DM and another server', async () => {
  const h = await harness(); h.setMembership(false, false);
  h.client.guilds.cache.set('111111111111111111', { id: '111111111111111111', available: true });
  h.start(); await h.tick();
  assert.equal(h.calls.length, 0); assert.equal(h.deliveries.length, 0);
  assert.equal(h.pending.size, 1);
});
test('stale cached membership cannot authorize generation or delivery', async () => {
  const h = await harness(); h.setMembership(false, false, true); h.start(); await h.tick();
  assert.equal(h.guildFetches.length, 1); assert.equal(h.calls.length, 0); assert.equal(h.deliveries.length, 0);
});
test('unavailable server and failed membership verification fail closed and recover on a later interval', async () => {
  for (const mode of ['unavailable', 'REST error']) {
    const h = await harness();
    if (mode === 'unavailable') h.setUnavailable(true); else h.setMembershipError(true);
    h.start(); await h.tick();
    assert.equal(h.calls.length, 0); assert.equal(h.deliveries.length, 0); assert.equal(h.pending.size, 1);
    h.setUnavailable(false); h.setMembershipError(false); await h.tick();
    assert.equal(h.deliveries.length, 1);
  }
});
test('removing a bot after one proactive DM prevents all following scheduled DMs', async () => {
  const h = await harness(); h.start(); await h.tick(); assert.equal(h.deliveries.length, 1);
  h.setMembership(false); await h.tick(); await h.tick();
  assert.equal(h.deliveries.length, 1); assert.equal(h.calls.length, 1);
});
test('removal during generation cancels the pending DM, including remove-and-readd', async () => {
  for (const readd of [false, true]) {
    const h = await harness(); let resolve;
    h.setResult(() => new Promise(r => { resolve = r; })); h.start(); const tick = h.tick();
    while (!resolve) await Promise.resolve();
    h.setMembership(false); if (readd) h.setMembership(true);
    resolve({ type: 'success', reply: 'Must be suppressed' }); await tick;
    assert.equal(h.deliveries.length, 0); assert.equal(h.pending.size, 1);
  }
});
test('removal that is missed by the gateway is caught by the final REST check', async () => {
  const h = await harness();
  h.setFetchHook(count => { if (count === 2) h.setMembership(false, false, true); });
  h.start(); await h.tick();
  assert.equal(h.calls.length, 1); assert.equal(h.deliveries.length, 0); assert.equal(h.guildFetches.length, 2);
});
test('a removal event during final verification invalidates the send even if REST returns success', async () => {
  const h = await harness();
  h.setFetchHook(count => {
    if (count === 2) { h.setMembership(false); h.setMembership(true); }
  });
  h.start(); await h.tick(); assert.equal(h.deliveries.length, 0);
});
test('a server ID change during generation suppresses the old-server message', async () => {
  const h = await harness(); let resolve;
  h.setResult(() => new Promise(r => { resolve = r; })); h.start(); const tick = h.tick();
  while (!resolve) await Promise.resolve();
  h.env.PROACTIVE_DM_GUILD_ID = '222222222222222222';
  resolve({ type: 'success', reply: 'Must be suppressed' }); await tick;
  assert.equal(h.deliveries.length, 0);
});
test('another server removal does not affect this server and shutdown removes all listeners', async () => {
  const h = await harness(); h.start(); h.start(); assert.equal(h.client.listenerCount('guildDelete'), 1);
  h.client.emit('guildDelete', { id: '111111111111111111' }); await h.tick();
  assert.equal(h.deliveries.length, 1); h.stop();
  assert.equal(h.client.listenerCount('guildDelete'), 0); assert.equal(h.pending.size, 0);
});
test('removing one Kin leaves another Kin eligible; readding waits for its next normal interval', async () => {
  const removed = await harness(), eligible = await harness();
  removed.start('bot1'); eligible.start('bot2'); removed.setMembership(false);
  await removed.tick(); await eligible.tick();
  assert.equal(removed.deliveries.length, 0); assert.equal(eligible.deliveries.length, 1);
  removed.setMembership(true); assert.equal(removed.deliveries.length, 0);
  const delay = [...removed.pending.values()][0].delay;
  assert.ok(delay >= 7200000 && delay <= 21600000);
  await removed.tick(); assert.equal(removed.deliveries.length, 1);
});
