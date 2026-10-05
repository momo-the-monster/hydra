import type {
  ActionsOf,
  ClientToServerEvents,
  ErrorInfo,
  EventsOf,
  GameEvent,
  JoinRole,
  Joined,
  Member,
  Removed,
  Result,
  ResultsOf,
  RoomInfo,
  ServerToClientEvents,
  TypedGame,
  ViewOf,
} from '@hydra/protocol';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';

export type * from '@hydra/protocol';

/**
 * - `idle`: not in a room.
 * - `joining`: a create, join or resume request is in flight.
 * - `joined`: in a room and connected.
 * - `reconnecting`: in a room, but the connection dropped; the client resumes automatically.
 */
export type Status = 'idle' | 'joining' | 'joined' | 'reconnecting';

/** The subset of the Web Storage API the client uses to remember its session. */
export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ClientOptions {
  /** Server URL. Defaults to the page's origin. */
  url?: string;
  /** Options for the socket.io connection. */
  io?: Partial<ManagerOptions & SocketOptions>;
  /** Use an existing socket instead of opening one. */
  socket?: Socket;
  /**
   * Where to remember the session so a page reload can rejoin. Defaults to `sessionStorage`
   * (one seat per tab). Pass `localStorage` to survive closing the tab, or `null` to disable.
   */
  storage?: SessionStore | null;
  /** Storage key. Use different keys if one page holds several clients. Defaults to `hydra:session`. */
  storageKey?: string;
  /** How long to wait for the server to answer a request. Defaults to 10 seconds. */
  timeoutMs?: number;
}

export interface CreateOptions {
  game?: string;
  name?: string;
  code?: string;
}

export interface JoinOptions {
  name: string;
  role?: JoinRole;
}

export interface ClientEvents<G extends TypedGame> {
  state: (state: ViewOf<G>) => void;
  members: (members: Member[]) => void;
  event: (event: GameEvent) => void;
  status: (status: Status) => void;
  /** The client is no longer in its room (kicked, room closed, seat expired, ...). */
  removed: (info: Removed) => void;
}

type PayloadArgs<P> = undefined extends P ? [payload?: P] : [payload: P];

export class HydraClientError extends Error {
  readonly code: string;

  constructor(info: ErrorInfo) {
    super(info.message);
    this.name = 'HydraClientError';
    this.code = info.code;
  }
}

interface StoredSession {
  session: string;
  code: string;
}

type HydraSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export class HydraClient<G extends TypedGame = TypedGame> {
  readonly socket: Socket;
  status: Status = 'idle';
  room: RoomInfo | undefined;
  me: Member | undefined;
  members: Member[] = [];
  state: ViewOf<G> | undefined;

  private readonly hydraSocket: HydraSocket;
  private readonly storage: SessionStore | null;
  private readonly storageKey: string;
  private readonly timeoutMs: number;
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  private session: string | undefined;

  constructor(options: ClientOptions = {}) {
    this.socket = options.socket ?? (options.url === undefined ? io(options.io) : io(options.url, options.io));
    this.hydraSocket = this.socket as HydraSocket;
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.storageKey = options.storageKey ?? 'hydra:session';
    this.timeoutMs = options.timeoutMs ?? 10_000;

    // Room traffic is ignored once the client has left (or before it starts joining).
    const socket = this.hydraSocket;
    socket.on('hydra:state', (state) => {
      if (this.status === 'idle') return;
      this.state = state as ViewOf<G>;
      this.emit('state', this.state);
    });
    socket.on('hydra:members', (members) => {
      if (this.status !== 'idle') this.setMembers(members);
    });
    socket.on('hydra:event', (event) => {
      if (this.status === 'idle') return;
      this.emit('event', event);
      this.emit(`event:${event.type}`, event.payload);
    });
    socket.on('hydra:removed', (info) => {
      if (this.status !== 'idle') this.removed(info);
    });
    socket.on('disconnect', (reason) => {
      if (this.status === 'joined') this.setStatus('reconnecting');
      // socket.io won't reconnect on its own after a server-side disconnect.
      if (reason === 'io server disconnect' && this.session) socket.connect();
    });
    socket.on('connect', () => {
      if (this.status === 'reconnecting' && this.session) {
        this.resumeSession(this.session).catch(() => {});
      }
    });
  }

  /** The room code stored from a previous visit, if any. Handy for a "rejoin?" prompt. */
  get storedRoom(): string | undefined {
    return this.readStored()?.code;
  }

  /** Create a room and become its host. */
  create(options: CreateOptions = {}): Promise<Joined<ViewOf<G>>> {
    return this.enter(() => this.request('hydra:create', options));
  }

  /** Join an existing room by code. */
  join(code: string, options: JoinOptions): Promise<Joined<ViewOf<G>>> {
    return this.enter(() => this.request('hydra:join', { code, ...options }));
  }

  /**
   * Rejoin the room this tab was in before a reload, if the seat is still there.
   * Resolves to `undefined` when there is nothing to resume.
   */
  async resume(): Promise<Joined<ViewOf<G>> | undefined> {
    const stored = this.readStored();
    if (!stored) return undefined;
    try {
      return await this.resumeSession(stored.session);
    } catch (error) {
      if (error instanceof HydraClientError && error.code === 'session_expired') return undefined;
      throw error;
    }
  }

  /** Send an action to the game. Resolves with whatever the action returned. */
  async send<K extends keyof ActionsOf<G> & string>(
    type: K,
    ...[payload]: PayloadArgs<ActionsOf<G>[K]>
  ): Promise<ResultsOf<G>[K]> {
    await this.whenJoined();
    return (await this.request('hydra:action', { type, payload })) as ResultsOf<G>[K];
  }

  /** Leave the room. The session is forgotten. */
  async leave(): Promise<void> {
    const wasInRoom = this.status !== 'idle';
    this.reset();
    if (wasInRoom && this.socket.connected) await this.request('hydra:leave');
  }

  /** Listen to client events. Returns a function that removes the listener. */
  on<K extends keyof ClientEvents<G>>(event: K, listener: ClientEvents<G>[K]): () => void {
    return this.addListener(event, listener);
  }

  /** Listen to one kind of game event. Returns a function that removes the listener. */
  onEvent<K extends keyof EventsOf<G> & string>(type: K, listener: (payload: EventsOf<G>[K]) => void): () => void {
    return this.addListener(`event:${type}`, listener);
  }

  /** Close the connection. The stored session is kept so a later client can resume. */
  close(): void {
    this.socket.disconnect();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------------------------

  private async enter(request: () => Promise<unknown>): Promise<Joined<ViewOf<G>>> {
    const previous = this.status;
    this.setStatus('joining');
    try {
      const joined = (await request()) as Joined<ViewOf<G>>;
      this.joined(joined);
      return joined;
    } catch (error) {
      if (this.status === 'joining') this.setStatus(previous === 'joined' ? 'joined' : 'idle');
      throw error;
    }
  }

  private async resumeSession(session: string): Promise<Joined<ViewOf<G>>> {
    this.session = session;
    if (this.status === 'idle') this.setStatus('joining');
    try {
      const joined = (await this.request('hydra:resume', { session })) as Joined<ViewOf<G>>;
      this.joined(joined);
      return joined;
    } catch (error) {
      if (error instanceof HydraClientError && error.code === 'session_expired') {
        const wasInRoom = this.room !== undefined;
        this.reset();
        if (wasInRoom) this.emit('removed', { reason: 'timeout', message: error.message });
      } else if (this.status === 'joining') {
        this.setStatus('idle');
      }
      throw error;
    }
  }

  private joined(joined: Joined<ViewOf<G>>): void {
    this.session = joined.session;
    this.room = joined.room;
    this.me = joined.you;
    this.writeStored({ session: joined.session, code: joined.room.code });
    this.setMembers(joined.members);
    this.state = joined.state;
    this.emit('state', joined.state);
    this.setStatus('joined');
  }

  private removed(info: Removed): void {
    this.reset();
    this.emit('removed', info);
  }

  private reset(): void {
    this.session = undefined;
    this.room = undefined;
    this.me = undefined;
    this.members = [];
    this.state = undefined;
    this.clearStored();
    this.setStatus('idle');
  }

  private setMembers(members: Member[]): void {
    this.members = members;
    if (this.me) this.me = members.find((member) => member.id === this.me!.id) ?? this.me;
    this.emit('members', members);
  }

  private setStatus(status: Status): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  private whenJoined(): Promise<void> {
    if (this.status === 'joined') return Promise.resolve();
    if (this.status === 'idle') return Promise.reject(new HydraClientError({ code: 'not_in_room', message: 'Join a room first' }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new HydraClientError({ code: 'timeout', message: 'Timed out waiting to rejoin the room' }));
      }, this.timeoutMs);
      const off = this.on('status', (status) => {
        if (status === 'joined' || status === 'idle') {
          clearTimeout(timer);
          off();
          if (status === 'joined') resolve();
          else reject(new HydraClientError({ code: 'not_in_room', message: 'No longer in the room' }));
        }
      });
    });
  }

  private async request(event: keyof ClientToServerEvents, ...args: unknown[]): Promise<unknown> {
    let result: Result<unknown>;
    try {
      result = await this.socket.timeout(this.timeoutMs).emitWithAck(event, ...args);
    } catch {
      throw new HydraClientError({ code: 'timeout', message: 'The server did not answer in time' });
    }
    if (!result.ok) throw new HydraClientError(result.error);
    return result.value;
  }

  private addListener(event: string, listener: (...args: any[]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        listener(...args);
      } catch (error) {
        console.error(`[hydra] "${event}" listener threw`, error);
      }
    }
  }

  private readStored(): StoredSession | undefined {
    try {
      const raw = this.storage?.getItem(this.storageKey);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Partial<StoredSession>;
      return typeof parsed.session === 'string' && typeof parsed.code === 'string'
        ? { session: parsed.session, code: parsed.code }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private writeStored(value: StoredSession): void {
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify(value));
    } catch {
      // Storage can be full or blocked (private browsing); resuming after reload just won't work.
    }
  }

  private clearStored(): void {
    try {
      this.storage?.removeItem(this.storageKey);
    } catch {
      // See writeStored.
    }
  }
}

/**
 * Connect to a Hydra server. Pass your game's type to get typed state, actions and events:
 * `createClient<typeof myGame>()` with `import type { myGame } from './game'`.
 */
export function createClient<G extends TypedGame = TypedGame>(options?: ClientOptions): HydraClient<G> {
  return new HydraClient<G>(options);
}

function defaultStorage(): SessionStore | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
