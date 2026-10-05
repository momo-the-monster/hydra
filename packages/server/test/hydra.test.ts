import { HydraClientError, type GameEvent, type HydraClient, type Removed } from '@hydra/client';
import { io as connect } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HydraError, defineGame, eventTypes } from '../src/index.js';
import { memoryStorage, sleep, startServer } from './helpers.js';

const counter = defineGame({
  name: 'counter',
  maxPlayers: 3,
  events: eventTypes<{ bumped: { by: string; count: number } }>(),
  setup: () => ({ count: 0, secret: 'only the host sees this', log: [] as string[] }),
  view: (state, viewer) => ({
    count: state.count,
    log: state.log,
    secret: viewer.role === 'host' ? state.secret : null,
  }),
  canJoin: (_ctx, attempt) => (attempt.name === 'Mallory' ? 'No Mallorys allowed' : true),
  onJoin(ctx, member) {
    ctx.state.log.push(`join:${member.name}`);
  },
  onLeave(ctx, member, reason) {
    ctx.state.log.push(`leave:${member.name}:${reason}`);
  },
  actions: {
    bump(ctx) {
      ctx.state.count++;
      ctx.broadcast('bumped', { by: ctx.sender.name, count: ctx.state.count });
      return ctx.state.count;
    },
    add: {
      input: (raw) => {
        if (!Number.isInteger(raw)) throw new Error('add needs an integer');
        return raw as number;
      },
      run(ctx, amount: number) {
        ctx.state.count += amount;
      },
    },
    slowIncrement: async (ctx, ms: number) => {
      const before = ctx.state.count;
      await sleep(ms);
      ctx.state.count = before + 1;
    },
    reset: {
      roles: ['host'],
      run(ctx) {
        ctx.state.count = 0;
      },
    },
    refuse() {
      throw new HydraError('not_now', 'Not now');
    },
    crash() {
      throw new Error('boom');
    },
    kick: {
      roles: ['host'],
      input: (raw) => String(raw),
      run(ctx, memberId: string) {
        ctx.kick(memberId, 'bye');
      },
    },
    end: {
      roles: ['host'],
      run(ctx) {
        ctx.close('game over');
      },
    },
    later(ctx) {
      ctx.setTimeout((timerCtx) => {
        timerCtx.state.count = 100;
      }, 20);
    },
    whisper: {
      input: (raw) => String(raw),
      run(ctx, to: string) {
        ctx.send(to, 'bumped', { by: ctx.sender.name, count: -1 });
      },
    },
  },
});

type Counter = typeof counter;

const pixel = defineGame({
  name: 'pixel',
  customCodes: true,
  closeWhenHostLeaves: false,
  setup: ({ code }) => ({ code }),
  actions: {},
});

let server: Awaited<ReturnType<typeof startServer>>;

afterEach(async () => {
  await server?.close();
});

async function hostAndPlayer() {
  const host = server.client<Counter>();
  const { room } = await host.create({ name: 'Screen' });
  const player = server.client<Counter>();
  await player.join(room.code.toLowerCase(), { name: 'Ada' });
  return { host, player, code: room.code };
}

describe('rooms', () => {
  it('creates a room with a vowel-free four-letter code and seats the host', async () => {
    server = await startServer([counter]);
    const host = server.client<Counter>();
    const joined = await host.create({ name: 'Screen' });

    expect(joined.room).toEqual({ code: expect.stringMatching(/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/), game: 'counter' });
    expect(joined.you).toMatchObject({ name: 'Screen', role: 'host', connected: true });
    expect(joined.state).toEqual({ count: 0, log: ['join:Screen'], secret: 'only the host sees this' });
    expect(host.status).toBe('joined');
    expect(server.hydra.rooms()).toHaveLength(1);
  });

  it('lets players join by code (any case) and tells everyone', async () => {
    server = await startServer([counter]);
    const { host, player } = await hostAndPlayer();

    expect(player.me).toMatchObject({ name: 'Ada', role: 'player' });
    expect(player.state).toEqual({ count: 0, log: ['join:Screen', 'join:Ada'], secret: null });
    await vi.waitFor(() => expect(host.members.map((m) => m.name)).toEqual(['Screen', 'Ada']));
    await vi.waitFor(() => expect(host.state?.log).toEqual(['join:Screen', 'join:Ada']));
  });

  it('rejects unknown rooms, taken names, full rooms and refused joins', async () => {
    server = await startServer([counter]);
    const { code } = await hostAndPlayer();
    const join = (name: string, room = code) => server.client<Counter>().join(room, { name });

    await expect(join('Bob', 'ZZZZ')).rejects.toMatchObject({ code: 'room_not_found' });
    await expect(join('ada')).rejects.toMatchObject({ code: 'name_taken' });
    await expect(join('Mallory')).rejects.toMatchObject({ code: 'join_refused', message: 'No Mallorys allowed' });
    await join('Bob');
    await join('Cy');
    await expect(join('Dee')).rejects.toMatchObject({ code: 'room_full' });
    // Viewers don't count towards maxPlayers.
    await expect(server.client<Counter>().join(code, { name: 'Wall', role: 'viewer' })).resolves.toBeTruthy();
  });

  it('cleans up names', async () => {
    server = await startServer([counter]);
    const host = server.client<Counter>();
    const { room } = await host.create();
    const player = server.client<Counter>();
    await player.join(room.code, { name: '  Ada\u0000​   Lovelace with a very long surname indeed ' });

    expect(player.me?.name).toBe('Ada Lovelace with a very');
    expect(host.me?.name).toBe('Host');
    await expect(server.client().join(room.code, { name: ' \t ' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('supports custom room codes when the game allows them', async () => {
    server = await startServer([counter, pixel]);
    const first = server.client();
    const joined = await first.create({ game: 'pixel', code: 'pixel' });
    expect(joined.room.code).toBe('PIXEL');

    await expect(server.client().create({ game: 'pixel', code: 'Pixel' })).rejects.toMatchObject({ code: 'code_taken' });
    await expect(server.client().create({ game: 'pixel', code: 'no spaces' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(server.client().create({ game: 'counter', code: 'MINE' })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('requires a game name when several games are registered', async () => {
    server = await startServer([counter, pixel]);
    await expect(server.client().create()).rejects.toMatchObject({ code: 'bad_request' });
    await expect(server.client().create({ game: 'chess' })).rejects.toMatchObject({ code: 'unknown_game' });
    await expect(server.client().create({ game: 'counter' })).resolves.toBeTruthy();
  });
});

describe('actions', () => {
  it('runs actions, returns their result and syncs state before delivering events', async () => {
    server = await startServer([counter]);
    const { host, player } = await hostAndPlayer();
    const seenByHost: Array<{ event: GameEvent; count: number | undefined }> = [];
    host.on('event', (event) => seenByHost.push({ event, count: host.state?.count }));
    const bumpedPayloads: Array<{ by: string; count: number }> = [];
    player.onEvent('bumped', (payload) => bumpedPayloads.push(payload));

    const result = await player.send('bump');

    expect(result).toBe(1);
    expect(player.state?.count).toBe(1);
    expect(bumpedPayloads).toEqual([{ by: 'Ada', count: 1 }]);
    await vi.waitFor(() => expect(seenByHost).toHaveLength(1));
    // The host's state was already updated when the event arrived.
    expect(seenByHost[0]).toEqual({ event: { type: 'bumped', payload: { by: 'Ada', count: 1 } }, count: 1 });
  });

  it('validates payloads with input()', async () => {
    server = await startServer([counter]);
    const { player } = await hostAndPlayer();

    await expect(player.send('add', 'lots' as never)).rejects.toMatchObject({
      code: 'invalid_payload',
      message: 'add needs an integer',
    });
    await player.send('add', 5);
    expect(player.state?.count).toBe(5);
  });

  it('enforces roles', async () => {
    server = await startServer([counter]);
    const { host, player, code } = await hostAndPlayer();
    const viewer = server.client<Counter>();
    await viewer.join(code, { name: 'Wall', role: 'viewer' });

    await expect(player.send('reset')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(viewer.send('bump')).rejects.toMatchObject({ code: 'forbidden' });
    await player.send('bump');
    await host.send('reset');
    expect(host.state?.count).toBe(0);
  });

  it('reports game errors and hides internal ones', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    server = await startServer([counter], { logger });
    const { player } = await hostAndPlayer();

    const refused = await player.send('refuse').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HydraClientError);
    expect(refused).toMatchObject({ code: 'not_now', message: 'Not now' });
    await expect(player.send('crash')).rejects.toMatchObject({ code: 'internal_error' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[1]).toMatchObject({ message: 'boom' });
    const untyped = player as unknown as HydraClient;
    await expect(untyped.send('nope')).rejects.toMatchObject({ code: 'unknown_action' });
    await expect(untyped.send('toString')).rejects.toMatchObject({ code: 'unknown_action' });
  });

  it('runs one action at a time per room, even async ones', async () => {
    server = await startServer([counter]);
    const { host, player } = await hostAndPlayer();

    await Promise.all([player.send('slowIncrement', 30), host.send('slowIncrement', 10), player.send('bump')]);
    // Interleaved, the slow increments would overwrite each other and the count would end below 3.
    await vi.waitFor(() => expect(player.state?.count).toBe(3));
    await sleep(20);
    expect(player.state?.count).toBe(3);
  });

  it('sends direct messages to one member only', async () => {
    server = await startServer([counter]);
    const { host, player, code } = await hostAndPlayer();
    const other = server.client<Counter>();
    await other.join(code, { name: 'Bob' });
    const received = { host: 0, player: 0, other: 0 };
    host.onEvent('bumped', () => received.host++);
    player.onEvent('bumped', () => received.player++);
    other.onEvent('bumped', () => received.other++);

    await host.send('whisper', other.me!.id);
    await vi.waitFor(() => expect(received.other).toBe(1));
    await sleep(20);
    expect(received).toEqual({ host: 0, player: 0, other: 1 });
  });

  it('runs room timers and syncs their changes', async () => {
    server = await startServer([counter]);
    const { player } = await hostAndPlayer();
    await player.send('later');
    await vi.waitFor(() => expect(player.state?.count).toBe(100));
  });

  it('requires joining before acting', async () => {
    server = await startServer([counter]);
    await expect(server.client<Counter>().send('bump')).rejects.toMatchObject({ code: 'not_in_room' });
  });
});

describe('leaving and closing', () => {
  it('handles a player leaving', async () => {
    server = await startServer([counter]);
    const { host, player } = await hostAndPlayer();

    await player.leave();
    expect(player.status).toBe('idle');
    expect(player.storedRoom).toBeUndefined();
    await vi.waitFor(() => expect(host.members.map((m) => m.name)).toEqual(['Screen']));
    await vi.waitFor(() => expect(host.state?.log.at(-1)).toBe('leave:Ada:left'));
  });

  it('closes the room when the host leaves', async () => {
    server = await startServer([counter]);
    const { host, player } = await hostAndPlayer();
    const removed: Removed[] = [];
    player.on('removed', (info) => removed.push(info));

    await host.leave();
    await vi.waitFor(() => expect(removed).toEqual([{ reason: 'host_left', message: 'The host left the room' }]));
    expect(player.status).toBe('idle');
    expect(server.hydra.rooms()).toEqual([]);
  });

  it('keeps host-optional rooms open until the last member leaves', async () => {
    server = await startServer([pixel]);
    const host = server.client();
    const { room } = await host.create({ code: 'PIXEL' });
    const player = server.client();
    await player.join(room.code, { name: 'Ada' });

    await host.leave();
    await sleep(20);
    expect(player.status).toBe('joined');
    expect(server.hydra.rooms()).toHaveLength(1);
    await player.leave();
    await vi.waitFor(() => expect(server.hydra.rooms()).toEqual([]));
  });

  it('lets the game kick a member, which ends their session', async () => {
    server = await startServer([counter]);
    const storage = memoryStorage();
    const host = server.client<Counter>();
    const { room } = await host.create();
    const player = server.client<Counter>(storage);
    await player.join(room.code, { name: 'Ada' });
    const removed: Removed[] = [];
    player.on('removed', (info) => removed.push(info));

    await host.send('kick', player.me!.id);
    await vi.waitFor(() => expect(removed).toEqual([{ reason: 'kicked', message: 'bye' }]));
    await vi.waitFor(() => expect(host.state?.log.at(-1)).toBe('leave:Ada:kicked'));
    await expect(server.client<Counter>(storage).resume()).resolves.toBeUndefined();
  });

  it('lets the game close the room', async () => {
    server = await startServer([counter]);
    const { host, player } = await hostAndPlayer();
    const removed: Removed[] = [];
    player.on('removed', (info) => removed.push(info));
    host.on('removed', (info) => removed.push(info));

    await host.send('end');
    await vi.waitFor(() => expect(removed).toHaveLength(2));
    expect(removed).toEqual([
      { reason: 'closed', message: 'game over' },
      { reason: 'closed', message: 'game over' },
    ]);
    expect(server.hydra.rooms()).toEqual([]);
  });
});

describe('reconnecting', () => {
  it('rejoins automatically after the connection drops', async () => {
    server = await startServer([counter]);
    const { host, player } = await hostAndPlayer();
    const statuses: string[] = [];
    player.on('status', (status) => statuses.push(status));

    player.socket.disconnect();
    await vi.waitFor(() => expect(host.members.find((m) => m.name === 'Ada')?.connected).toBe(false));
    await host.send('add', 7);

    player.socket.connect();
    await vi.waitFor(() => expect(player.status).toBe('joined'));
    expect(statuses).toEqual(['reconnecting', 'joined']);
    expect(player.state?.count).toBe(7);
    await vi.waitFor(() => expect(host.members.find((m) => m.name === 'Ada')?.connected).toBe(true));
  });

  it('queues actions sent while reconnecting', async () => {
    server = await startServer([counter]);
    const { player } = await hostAndPlayer();

    player.socket.disconnect();
    const pending = player.send('bump');
    player.socket.connect();
    await expect(pending).resolves.toBe(1);
  });

  it('resumes the same seat after a page reload', async () => {
    server = await startServer([counter]);
    const storage = memoryStorage();
    const host = server.client<Counter>();
    const { room } = await host.create();
    const before = server.client<Counter>(storage);
    const { you } = await before.join(room.code, { name: 'Ada' });
    before.close();

    const after = server.client<Counter>(storage);
    expect(after.storedRoom).toBe(room.code);
    const resumed = await after.resume();
    expect(resumed?.you.id).toBe(you.id);
    expect(after.status).toBe('joined');
    await after.send('bump');
    expect(after.state?.count).toBe(1);
  });

  it('moves the seat to the newest connection when a session is opened twice', async () => {
    server = await startServer([counter]);
    const storage = memoryStorage();
    const { code } = await hostAndPlayer();
    const first = server.client<Counter>(storage);
    await first.join(code, { name: 'Bob' });
    const removed: Removed[] = [];
    first.on('removed', (info) => removed.push(info));

    const second = server.client<Counter>(storage);
    await second.resume();
    await vi.waitFor(() => expect(removed).toEqual([{ reason: 'replaced' }]));
    expect(second.status).toBe('joined');
    expect(first.status).toBe('idle');
  });

  it('frees the seat when the grace period runs out', async () => {
    server = await startServer([counter], { reconnectGraceMs: 50 });
    const storage = memoryStorage();
    const host = server.client<Counter>();
    const { room } = await host.create();
    const player = server.client<Counter>(storage);
    await player.join(room.code, { name: 'Ada' });

    player.close();
    await vi.waitFor(() => expect(host.state?.log.at(-1)).toBe('leave:Ada:timeout'));
    expect(host.members.map((m) => m.name)).toEqual(['Host']);
    await expect(server.client<Counter>(storage).resume()).resolves.toBeUndefined();
  });

  it('closes the room when the host stays away too long', async () => {
    server = await startServer([counter], { hostGraceMs: 50 });
    const { host, player } = await hostAndPlayer();
    const removed: Removed[] = [];
    player.on('removed', (info) => removed.push(info));

    host.close();
    await vi.waitFor(() => expect(removed).toEqual([{ reason: 'host_left', message: 'The host left the room' }]));
    expect(server.hydra.rooms()).toEqual([]);
  });
});

describe('untrusted input', () => {
  it('answers malformed requests with bad_request and keeps running', async () => {
    server = await startServer([counter]);
    const raw = connect(server.url, { transports: ['websocket'], forceNew: true });
    await new Promise<void>((resolve) => raw.on('connect', resolve));

    const ask = (event: string, ...args: unknown[]) => raw.timeout(2000).emitWithAck(event, ...args);
    expect(await ask('hydra:join', 'not an object')).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(await ask('hydra:join', { code: 42, name: 'x' })).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(await ask('hydra:join', { code: 'ABCD', name: 'x', role: 'host' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
    expect(await ask('hydra:resume', { session: 'forged' })).toMatchObject({
      ok: false,
      error: { code: 'session_expired' },
    });
    expect(await ask('hydra:action', { type: 'x'.repeat(100) })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
    expect(await ask('hydra:action', null)).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    // No ack at all: must not throw on the server.
    raw.emit('hydra:create', { name: 'x' });
    raw.emit('hydra:join');
    raw.disconnect();

    const host = server.client<Counter>();
    await expect(host.create()).resolves.toBeTruthy();
  });
});
