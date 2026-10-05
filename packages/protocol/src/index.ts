/**
 * The Hydra wire protocol: everything the server and the client agree on.
 *
 * All traffic goes through a handful of `hydra:*` socket events. Games never
 * register their own socket events; they define actions, which the client sends
 * through `hydra:action`. That keeps the core in charge of rooms, permissions
 * and validation, and lets any number of games share one server.
 */

export type Role = 'host' | 'player' | 'viewer';

/** Roles a client may request when joining an existing room. Hosts only come from `create`. */
export type JoinRole = Exclude<Role, 'host'>;

/** A person (or screen) in a room. Safe to show to everyone in the room. */
export interface Member {
  /** Stable for the member's whole stay, including reconnects. Not a secret. */
  id: string;
  name: string;
  role: Role;
  /** False while the member's connection is down and they are inside their reconnect grace period. */
  connected: boolean;
}

export interface RoomInfo {
  /** Short code people type to join, always upper case. */
  code: string;
  /** Name of the game this room runs. */
  game: string;
}

/** What a client gets back from `create`, `join` and `resume`. */
export interface Joined<View = unknown> {
  room: RoomInfo;
  you: Member;
  /** Secret token that lets this member reclaim their seat after a dropped connection or a page reload. */
  session: string;
  members: Member[];
  state: View;
}

export type ErrorCode =
  | 'bad_request'
  | 'unknown_game'
  | 'room_not_found'
  | 'code_taken'
  | 'room_full'
  | 'name_taken'
  | 'join_refused'
  | 'not_in_room'
  | 'unknown_action'
  | 'forbidden'
  | 'invalid_payload'
  | 'session_expired'
  | 'internal_error';

export interface ErrorInfo {
  /** One of {@link ErrorCode}, or a game-specific code thrown from an action. */
  code: ErrorCode | (string & {});
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ErrorInfo };

export type Ack<T> = (result: Result<T>) => void;

/**
 * Why a client is no longer in its room.
 * - `left`: the client called `leave`.
 * - `kicked`: the game removed the member.
 * - `timeout`: the member stayed disconnected past the grace period.
 * - `replaced`: the same session was resumed from another connection.
 * - `host_left`: the host left and the game closes rooms without one.
 * - `closed`: the game closed the room.
 */
export type RemovalReason = 'left' | 'kicked' | 'timeout' | 'replaced' | 'host_left' | 'closed';

export interface Removed {
  reason: RemovalReason;
  message?: string;
}

export interface CreateRequest {
  /** Game to run. May be omitted when the server only runs one game. */
  game?: string;
  /** Display name for the host. Defaults to "Host". */
  name?: string;
  /** Ask for a specific room code. Only allowed for games with `customCodes: true`. */
  code?: string;
}

export interface JoinRequest {
  code: string;
  name: string;
  role?: JoinRole;
}

export interface ResumeRequest {
  session: string;
}

export interface ActionRequest {
  type: string;
  payload?: unknown;
}

export interface GameEvent<Type extends string = string, Payload = unknown> {
  type: Type;
  payload: Payload;
}

export interface ClientToServerEvents {
  'hydra:create': (request: CreateRequest, ack: Ack<Joined>) => void;
  'hydra:join': (request: JoinRequest, ack: Ack<Joined>) => void;
  'hydra:resume': (request: ResumeRequest, ack: Ack<Joined>) => void;
  'hydra:leave': (ack: Ack<null>) => void;
  'hydra:action': (request: ActionRequest, ack: Ack<unknown>) => void;
}

export interface ServerToClientEvents {
  /** This member's view of the game state. Sent whenever it changes. */
  'hydra:state': (state: unknown) => void;
  /** The full member list. Sent whenever anyone joins, leaves, drops or reconnects. */
  'hydra:members': (members: Member[]) => void;
  /** A one-off game event (a sound cue, a chat line, a MIDI note...). Not stored. */
  'hydra:event': (event: GameEvent) => void;
  /** This connection is no longer in the room. */
  'hydra:removed': (info: Removed) => void;
}

/**
 * Compile-time description of a game, used to type the client.
 *
 * The server's `defineGame` produces values that carry these types in a
 * phantom `~types` property, so a client can be typed from a game definition
 * with a type-only import and no server code in the browser bundle.
 */
export interface GameTypes {
  view: unknown;
  /** Action name -> payload type. */
  actions: Record<string, unknown>;
  /** Action name -> value the action returns to the sender. */
  results: Record<string, unknown>;
  /** Event name -> payload type. */
  events: Record<string, unknown>;
}

export interface TypedGame<T extends GameTypes = GameTypes> {
  readonly name: string;
  /** Phantom: never set at runtime. */
  readonly '~types'?: T;
}

type TypesOf<G extends TypedGame> = NonNullable<G['~types']>;
export type ViewOf<G extends TypedGame> = TypesOf<G>['view'];
export type ActionsOf<G extends TypedGame> = TypesOf<G>['actions'];
export type ResultsOf<G extends TypedGame> = TypesOf<G>['results'];
export type EventsOf<G extends TypedGame> = TypesOf<G>['events'];
