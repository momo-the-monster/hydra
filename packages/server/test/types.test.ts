import { createClient, type Member } from '@hydra/client';
import { describe, expectTypeOf, it } from 'vitest';
import { defineGame, eventTypes } from '../src/index.js';

// These checks run in `npm run typecheck`; at test time they are no-ops.

const quiz = defineGame({
  name: 'quiz',
  events: eventTypes<{ tick: { secondsLeft: number }; reveal: undefined }>(),
  setup: () => ({ answer: 42, guesses: {} as Record<string, number> }),
  view: (state, viewer: Member) => ({ guessed: viewer.id in state.guesses }),
  actions: {
    guess: {
      input: (raw) => Number(raw),
      run(ctx, value: number) {
        ctx.state.guesses[ctx.sender.id] = value;
        return value === ctx.state.answer;
      },
    },
    reveal: {
      roles: ['host'],
      run(ctx) {
        ctx.broadcast('reveal');
        ctx.broadcast('tick', { secondsLeft: 0 }, { to: 'player' });
      },
    },
    poke: async (ctx, who: string) => {
      ctx.send(who, 'tick', { secondsLeft: 1 });
      return { poked: who };
    },
  },
});

describe('typed client', () => {
  it('derives state, actions, results and events from the game definition', () => {
    const client = createClient<typeof quiz>({ storage: null, io: { autoConnect: false } });

    expectTypeOf(client.state).toEqualTypeOf<{ guessed: boolean } | undefined>();
    expectTypeOf(client.send('guess', 3)).toEqualTypeOf<Promise<boolean>>();
    expectTypeOf(client.send('reveal')).toEqualTypeOf<Promise<void>>();
    expectTypeOf(client.send('poke', 'abc')).toEqualTypeOf<Promise<{ poked: string }>>();
    client.onEvent('tick', (payload) => expectTypeOf(payload).toEqualTypeOf<{ secondsLeft: number }>());

    // @ts-expect-error missing payload
    void client.send('guess');
    // @ts-expect-error wrong payload type
    void client.send('guess', 'three');
    // @ts-expect-error unknown action
    void client.send('cheat');
    // @ts-expect-error unknown event
    client.onEvent('boom', () => {});
    client.close();
  });

  it('falls back to loose types without a game', () => {
    const client = createClient({ storage: null, io: { autoConnect: false } });
    expectTypeOf(client.send('anything', { at: 'all' })).toEqualTypeOf<Promise<unknown>>();
    client.close();
  });

  it('catches mistakes in game definitions', () => {
    defineGame({
      name: 'broken',
      events: eventTypes<{ ping: number }>(),
      setup: () => ({ n: 0 }),
      actions: {
        // @ts-expect-error run() must accept what input() returns
        mismatched: { input: (raw) => String(raw), run(_ctx, value: number) {} },
        wrongEvent(ctx) {
          // @ts-expect-error unknown event
          ctx.broadcast('pong', 1);
          // @ts-expect-error event payload is required
          ctx.broadcast('ping');
          // @ts-expect-error state has no such field
          ctx.state.m = 1;
        },
      },
    });
  });
});
