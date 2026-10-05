import { HydraError, defineGame, eventTypes } from '@hydra/server';

interface Buzz {
  memberId: string;
  name: string;
  at: number;
}

/**
 * Game-show buzzers. The host screen shows who buzzed first and hands out points;
 * players get one big button on their phones.
 */
export const buzzer = defineGame({
  name: 'buzzer',
  maxPlayers: 12,

  events: eventTypes<{
    /** Someone buzzed. `first` is true for the buzz that won the round. */
    buzzed: { name: string; first: boolean };
    /** The host gave someone a point. */
    awarded: { name: string };
  }>(),

  setup: () => ({
    locked: false,
    buzzes: [] as Buzz[],
    scores: {} as Record<string, number>,
  }),

  // Everyone sees the same board, plus their own place in line.
  view: (state, viewer) => {
    const first = state.buzzes[0]?.at ?? 0;
    const position = state.buzzes.findIndex((buzz) => buzz.memberId === viewer.id);
    return {
      locked: state.locked,
      buzzes: state.buzzes.map((buzz) => ({ memberId: buzz.memberId, name: buzz.name, afterMs: buzz.at - first })),
      scores: state.scores,
      position: position === -1 ? null : position + 1,
    };
  },

  onJoin(ctx, member) {
    if (member.role === 'player') ctx.state.scores[member.id] ??= 0;
  },

  onLeave(ctx, member) {
    delete ctx.state.scores[member.id];
    ctx.state.buzzes = ctx.state.buzzes.filter((buzz) => buzz.memberId !== member.id);
  },

  actions: {
    buzz: {
      roles: ['player'],
      run(ctx) {
        const { state, sender } = ctx;
        const already = state.buzzes.findIndex((buzz) => buzz.memberId === sender.id);
        if (already !== -1) return { position: already + 1 };
        if (state.locked) throw new HydraError('locked', 'Buzzers are locked');

        state.buzzes.push({ memberId: sender.id, name: sender.name, at: Date.now() });
        ctx.broadcast('buzzed', { name: sender.name, first: state.buzzes.length === 1 });
        return { position: state.buzzes.length };
      },
    },

    /** Clear the board for the next question. */
    reset: {
      roles: ['host'],
      run(ctx) {
        ctx.state.buzzes = [];
        ctx.state.locked = false;
      },
    },

    lock: {
      roles: ['host'],
      input: (raw) => {
        if (typeof raw !== 'boolean') throw new Error('lock expects true or false');
        return raw;
      },
      run(ctx, locked: boolean) {
        ctx.state.locked = locked;
      },
    },

    /** Give a point to a player and start the next round. */
    award: {
      roles: ['host'],
      input: (raw) => {
        if (typeof raw !== 'string') throw new Error('award expects a member id');
        return raw;
      },
      run(ctx, memberId: string) {
        const member = ctx.getMember(memberId);
        if (!member || member.role !== 'player') throw new HydraError('unknown_player', 'No such player');
        ctx.state.scores[memberId] = (ctx.state.scores[memberId] ?? 0) + 1;
        ctx.state.buzzes = [];
        ctx.state.locked = false;
        ctx.broadcast('awarded', { name: member.name });
      },
    },
  },
});

export type Buzzer = typeof buzzer;
