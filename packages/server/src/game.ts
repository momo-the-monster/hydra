import type { JoinRole, Member, RemovalReason, Role, TypedGame } from '@hydra/protocol';

export type EventMap = Record<string, unknown>;

/** Cancels a timer created with `ctx.setTimeout` / `ctx.setInterval`. */
export type Cancel = () => void;

export interface EventOptions {
  /** Only deliver to members with these roles. */
  to?: Role | readonly Role[];
  /** Skip this member id (for example `ctx.sender.id`). */
  except?: string;
}

/** Payload is optional when the event's payload type allows `undefined`. */
type EventArgs<E extends EventMap, K extends keyof E, Extra extends unknown[] = []> = undefined extends E[K]
  ? [payload?: E[K], ...Extra]
  : [payload: E[K], ...Extra];

/** What game code can do with a room. Passed to every hook, action and timer. */
export interface RoomContext<S, E extends EventMap = EventMap> {
  readonly code: string;
  readonly game: string;
  /** The authoritative game state. Mutate it or replace it; changes are synced after the handler returns. */
  state: S;
  /** Everyone in the room, including members who are briefly disconnected. */
  readonly members: readonly Member[];
  getMember(id: string): Member | undefined;
  /** Send a one-off event to everyone (or a subset) in the room. */
  broadcast<K extends keyof E & string>(type: K, ...args: EventArgs<E, K, [options?: EventOptions]>): void;
  /** Send a one-off event to a single member. */
  send<K extends keyof E & string>(memberId: string, type: K, ...args: EventArgs<E, K>): void;
  /** Remove a member from the room. Their session stops working. */
  kick(memberId: string, message?: string): void;
  /** Close the room for everyone. */
  close(message?: string): void;
  /** Like `setTimeout`, but runs in the room's queue, syncs state afterwards and is cleared when the room closes. */
  setTimeout(callback: (ctx: RoomContext<S, E>) => void | Promise<void>, ms: number): Cancel;
  /** Like `setInterval`, with the same guarantees as {@link RoomContext.setTimeout}. */
  setInterval(callback: (ctx: RoomContext<S, E>) => void | Promise<void>, ms: number): Cancel;
}

export interface ActionContext<S, E extends EventMap = EventMap> extends RoomContext<S, E> {
  /** The member who sent the action. */
  readonly sender: Member;
}

// Method syntax keeps the payload parameter bivariant, so handlers can annotate the payload type
// they expect while unannotated payloads stay `unknown`.
type ActionHandler<S, E extends EventMap> = {
  bivariant(ctx: ActionContext<S, E>, payload: unknown): unknown;
}['bivariant'];

export interface ActionConfig<S, E extends EventMap> {
  /**
   * Validate and convert the raw payload before `run` sees it. Throw to reject; the sender gets an
   * `invalid_payload` error. Works with schema libraries, e.g. `input: z.object({...}).parse`.
   */
  input?: (raw: unknown) => unknown;
  /** Who may send this action. Defaults to `['host', 'player']`. */
  roles?: readonly Role[];
  run(ctx: ActionContext<S, E>, payload: unknown): unknown;
}

export type ActionDefinition<S, E extends EventMap> = ActionHandler<S, E> | ActionConfig<S, E>;

export type ActionMap<S, E extends EventMap> = Record<string, ActionDefinition<S, E>>;

type PayloadOf<D> = D extends { input: (raw: unknown) => infer P }
  ? P
  : D extends { run(ctx: any, payload: infer P): any }
    ? P
    : D extends (ctx: any, payload: infer P) => any
      ? P
      : never;

type ResultOf<D> = D extends { run(...args: any[]): infer R }
  ? Awaited<R>
  : D extends (...args: any[]) => infer R
    ? Awaited<R>
    : never;

/** Compile-time check that `run` accepts whatever `input` returns. */
type CheckedActions<A> = {
  [K in keyof A]: A[K] extends { input: (raw: unknown) => infer P; run(ctx: any, payload: infer Q): any }
    ? [P] extends [Q]
      ? A[K]
      : { input: never; error: 'run() must accept the type that input() returns' }
    : A[K];
};

export interface JoinAttempt {
  name: string;
  role: JoinRole;
}

export interface GameConfig<S, A extends ActionMap<S, E>, V, E extends EventMap> {
  /** Unique name; clients use it to pick a game when creating a room. */
  name: string;
  /** Builds the initial state for a new room. */
  setup: (room: { code: string }) => S;
  actions: A & CheckedActions<A>;
  /**
   * What each member is allowed to see. Defaults to the whole state.
   * Use it to hide secrets (other players' hands, the answer) or to tailor the payload per role.
   */
  view?: (state: S, viewer: Member) => V;
  /** Declare event payload types with `eventTypes<{ ... }>()`. Type-only; has no runtime effect. */
  events?: E;
  /** Maximum number of members with the `player` role. Defaults to 16. */
  maxPlayers?: number;
  /** Let `create` request a specific room code (e.g. a permanent "PIXEL" room). Defaults to false. */
  customCodes?: boolean;
  /** Close the room when the host leaves or their grace period runs out. Defaults to true. */
  closeWhenHostLeaves?: boolean;
  /** Return `true` to let someone in, or a message explaining why not. */
  canJoin?: (ctx: RoomContext<S, E>, attempt: JoinAttempt) => true | string;
  onJoin?: (ctx: RoomContext<S, E>, member: Member) => void | Promise<void>;
  onLeave?: (ctx: RoomContext<S, E>, member: Member, reason: RemovalReason) => void | Promise<void>;
  onDisconnect?: (ctx: RoomContext<S, E>, member: Member) => void | Promise<void>;
  onReconnect?: (ctx: RoomContext<S, E>, member: Member) => void | Promise<void>;
  /** Last chance to clean up. Members have already been told the room closed. */
  onClose?: (state: S) => void | Promise<void>;
}

export type GameDefinition<S = any, A extends ActionMap<S, E> = any, V = any, E extends EventMap = any> = GameConfig<
  S,
  A,
  V,
  E
> &
  TypedGame<{
    view: V;
    actions: { [K in keyof A]: PayloadOf<A[K]> };
    results: { [K in keyof A]: ResultOf<A[K]> };
    events: E;
  }>;

/**
 * Define a game. The returned value is passed to `createHydra` on the server and can be imported
 * with `import type` on the client to type `createClient<typeof game>()`.
 */
export function defineGame<S, A extends ActionMap<S, E>, V = S, E extends EventMap = EventMap>(
  config: GameConfig<S, A, V, E>,
): GameDefinition<S, A, V, E> {
  if (!config.name) throw new Error('defineGame: name is required');
  return config as GameDefinition<S, A, V, E>;
}

/**
 * Declare the events a game sends, for type checking only:
 * `events: eventTypes<{ buzzed: { name: string }; reset: undefined }>()`
 */
export function eventTypes<E extends EventMap>(): E {
  return undefined as unknown as E;
}
