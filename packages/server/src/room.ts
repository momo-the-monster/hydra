import type {
  GameEvent,
  JoinRole,
  Joined,
  Member,
  RemovalReason,
  Removed,
  Role,
} from '@hydra/protocol';
import { generateMemberId, generateToken } from './codes.js';
import { HydraError } from './errors.js';
import type {
  ActionConfig,
  ActionContext,
  Cancel,
  EventMap,
  EventOptions,
  GameDefinition,
  RoomContext,
} from './game.js';

export interface Logger {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

/** What a room needs from the server that owns it. */
export interface RoomEnvironment {
  /** Attach a socket to a member of this room. Returns false if the socket is already gone. */
  bind(socketId: string, room: Room, memberId: string): boolean;
  unbind(socketId: string): void;
  sendState(socketId: string, state: unknown): void;
  sendMembers(socketId: string, members: Member[]): void;
  sendEvent(socketId: string, event: GameEvent): void;
  sendRemoved(socketId: string, info: Removed): void;
  addSession(token: string, room: Room, memberId: string): void;
  removeSession(token: string): void;
  roomClosed(room: Room): void;
  graceMs(role: Role): number;
  logger: Logger;
}

interface Seat {
  member: Member;
  session: string;
  socketId: string | undefined;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
  /** JSON of the last state view sent to this seat, to skip redundant updates. */
  lastView: string | undefined;
}

const DEFAULT_ACTION_ROLES: readonly Role[] = ['host', 'player'];
const DEFAULT_MAX_PLAYERS = 16;

const noop = () => {};

export class Room<S = any, E extends EventMap = EventMap> {
  readonly code: string;
  readonly game: GameDefinition<S, any, any, E>;
  state: S;
  closed = false;

  private readonly env: RoomEnvironment;
  private readonly seats = new Map<string, Seat>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly context: RoomContext<S, E>;
  private queue: Promise<unknown> = Promise.resolve();
  private outbox: Array<{ socketId: string; event: GameEvent }> = [];
  private membersChanged = false;
  private running = false;
  private flushScheduled = false;

  constructor(code: string, game: GameDefinition<S, any, any, E>, env: RoomEnvironment) {
    this.code = code;
    this.game = game;
    this.env = env;
    this.state = game.setup({ code });
    this.context = this.createContext();
  }

  // ---------------------------------------------------------------------------------------------
  // Membership

  get members(): Member[] {
    return [...this.seats.values()].map((seat) => ({ ...seat.member }));
  }

  /** Seat the host of a freshly created room. */
  seatHost(socketId: string, name: string): Promise<Joined> {
    return this.run(async () => {
      const seat = this.addSeat(socketId, name, 'host');
      await this.runJoinHook(seat);
      return this.snapshot(seat);
    });
  }

  join(socketId: string, name: string, role: JoinRole): Promise<Joined> {
    return this.run(async () => {
      if (role === 'player') {
        const players = [...this.seats.values()].filter((seat) => seat.member.role === 'player').length;
        if (players >= (this.game.maxPlayers ?? DEFAULT_MAX_PLAYERS)) {
          throw new HydraError('room_full', 'This room is full');
        }
      }
      const lower = name.toLowerCase();
      for (const seat of this.seats.values()) {
        if (seat.member.name.toLowerCase() === lower) {
          throw new HydraError('name_taken', `Someone in this room is already called ${seat.member.name}`);
        }
      }
      if (this.game.canJoin) {
        const verdict = this.game.canJoin(this.context, { name, role });
        if (verdict !== true) {
          throw new HydraError('join_refused', typeof verdict === 'string' ? verdict : 'You cannot join this room');
        }
      }
      const seat = this.addSeat(socketId, name, role);
      await this.runJoinHook(seat);
      return this.snapshot(seat);
    });
  }

  resume(memberId: string, socketId: string): Promise<Joined> {
    return this.run(async () => {
      const seat = this.seats.get(memberId);
      if (!seat) throw new HydraError('session_expired', 'Your seat in this room is gone');
      if (seat.socketId === socketId) return this.snapshot(seat);

      if (!this.env.bind(socketId, this, memberId)) throw new HydraError('bad_request', 'Connection closed');
      const wasConnected = seat.socketId !== undefined;
      if (seat.socketId !== undefined) {
        // Same session resumed from a second tab or a new connection: the newest one wins.
        this.env.sendRemoved(seat.socketId, { reason: 'replaced' });
        this.env.unbind(seat.socketId);
      }
      seat.socketId = socketId;
      seat.lastView = undefined;
      this.clearGrace(seat);
      if (!wasConnected) {
        seat.member.connected = true;
        this.membersChanged = true;
        await this.game.onReconnect?.(this.context, { ...seat.member });
      }
      return this.snapshot(seat);
    });
  }

  /** The socket for this member dropped. They keep their seat for a grace period. */
  disconnect(memberId: string, socketId: string): Promise<void> {
    return this.run(async () => {
      const seat = this.seats.get(memberId);
      if (!seat || seat.socketId !== socketId) return;
      seat.socketId = undefined;
      seat.member.connected = false;
      this.membersChanged = true;
      seat.graceTimer = setTimeout(() => {
        seat.graceTimer = undefined;
        this.run(() => this.remove(memberId, 'timeout')).catch(noop);
      }, this.env.graceMs(seat.member.role));
      await this.game.onDisconnect?.(this.context, { ...seat.member });
    });
  }

  leave(memberId: string): Promise<void> {
    return this.run(() => this.remove(memberId, 'left'));
  }

  // ---------------------------------------------------------------------------------------------
  // Actions

  act(memberId: string, type: string, raw: unknown): Promise<unknown> {
    const definition = Object.hasOwn(this.game.actions, type) ? this.game.actions[type] : undefined;
    if (!definition) throw new HydraError('unknown_action', `Unknown action "${type}"`);
    const action: ActionConfig<S, E> = typeof definition === 'function' ? { run: definition } : definition;

    const sender = this.seats.get(memberId);
    if (!sender) throw new HydraError('not_in_room', 'You are not in this room');
    if (!(action.roles ?? DEFAULT_ACTION_ROLES).includes(sender.member.role)) {
      throw new HydraError('forbidden', `A ${sender.member.role} cannot send "${type}"`);
    }

    let payload = raw;
    if (action.input) {
      try {
        payload = action.input(raw);
      } catch (error) {
        throw new HydraError('invalid_payload', error instanceof Error ? error.message : 'Invalid payload');
      }
    }

    return this.run(async () => {
      const seat = this.seats.get(memberId);
      if (!seat) throw new HydraError('not_in_room', 'You are not in this room');
      const ctx: ActionContext<S, E> = Object.create(this.context, {
        sender: { value: { ...seat.member }, enumerable: true },
      });
      return action.run(ctx, payload);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle

  /** Close the room: tell everyone, end every session, stop every timer. */
  close(reason: RemovalReason = 'closed', message?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.outbox = [];
    for (const seat of this.seats.values()) {
      this.clearGrace(seat);
      this.env.removeSession(seat.session);
      if (seat.socketId !== undefined) {
        this.env.sendRemoved(seat.socketId, message === undefined ? { reason } : { reason, message });
        this.env.unbind(seat.socketId);
      }
    }
    this.seats.clear();
    this.env.roomClosed(this);
    const { onClose } = this.game;
    if (onClose) {
      Promise.resolve()
        .then(() => onClose(this.state))
        .catch((error) => this.env.logger.error(`[hydra] onClose failed in room ${this.code}`, error));
    }
  }

  /**
   * Run game code in this room's queue, one task at a time, then sync state, members and events.
   * Keeps async handlers from interleaving with each other.
   */
  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.closed) throw new HydraError('room_not_found', 'This room has closed');
      this.running = true;
      try {
        return await task();
      } finally {
        this.running = false;
        this.flush();
      }
    });
    this.queue = result.catch(noop);
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // Internals

  private addSeat(socketId: string, name: string, role: Role): Seat {
    let id = generateMemberId();
    while (this.seats.has(id)) id = generateMemberId();
    const seat: Seat = {
      member: { id, name, role, connected: true },
      session: generateToken(),
      socketId,
      graceTimer: undefined,
      lastView: undefined,
    };
    if (!this.env.bind(socketId, this, id)) throw new HydraError('bad_request', 'Connection closed');
    this.seats.set(id, seat);
    this.env.addSession(seat.session, this, id);
    this.membersChanged = true;
    return seat;
  }

  private async runJoinHook(seat: Seat): Promise<void> {
    try {
      await this.game.onJoin?.(this.context, { ...seat.member });
    } catch (error) {
      // Undo the join so a failed hook doesn't leave a half-joined member behind.
      this.seats.delete(seat.member.id);
      this.env.removeSession(seat.session);
      if (seat.socketId !== undefined) this.env.unbind(seat.socketId);
      this.membersChanged = true;
      if (seat.member.role === 'host') this.close();
      throw error;
    }
  }

  private remove(memberId: string, reason: RemovalReason, message?: string): void {
    const seat = this.seats.get(memberId);
    if (!seat || this.closed) return;
    this.seats.delete(memberId);
    this.clearGrace(seat);
    this.env.removeSession(seat.session);
    if (seat.socketId !== undefined) {
      if (reason !== 'left') {
        this.env.sendRemoved(seat.socketId, message === undefined ? { reason } : { reason, message });
      }
      this.env.unbind(seat.socketId);
    }
    this.membersChanged = true;

    const member = { ...seat.member, connected: false };
    if (member.role === 'host' && this.game.closeWhenHostLeaves !== false) {
      this.close('host_left', 'The host left the room');
      return;
    }
    if (this.seats.size === 0) {
      this.close();
      return;
    }
    const { onLeave } = this.game;
    if (onLeave) {
      // Queued rather than awaited: remove() can be called synchronously from ctx.kick().
      this.run(() => onLeave(this.context, member, reason)).catch((error) => this.logFailure('onLeave', error));
    }
    this.scheduleFlush();
  }

  private clearGrace(seat: Seat): void {
    if (seat.graceTimer !== undefined) {
      clearTimeout(seat.graceTimer);
      seat.graceTimer = undefined;
    }
  }

  private snapshot(seat: Seat): Joined {
    const state = this.viewFor(seat);
    seat.lastView = JSON.stringify(state);
    return {
      room: { code: this.code, game: this.game.name },
      you: { ...seat.member },
      session: seat.session,
      members: this.members,
      state,
    };
  }

  private viewFor(seat: Seat): unknown {
    return this.game.view ? this.game.view(this.state, { ...seat.member }) : this.state;
  }

  /** Send whatever changed: member list first, then each member's state view, then queued events. */
  private flush(): void {
    this.flushScheduled = false;
    if (this.closed) return;

    if (this.membersChanged) {
      this.membersChanged = false;
      const members = this.members;
      for (const seat of this.seats.values()) {
        if (seat.socketId !== undefined) this.env.sendMembers(seat.socketId, members);
      }
    }

    let shared: string | undefined;
    for (const seat of this.seats.values()) {
      if (seat.socketId === undefined) continue;
      try {
        const view = this.viewFor(seat);
        const json = this.game.view ? JSON.stringify(view) : (shared ??= JSON.stringify(view));
        if (json !== seat.lastView) {
          seat.lastView = json;
          this.env.sendState(seat.socketId, view);
        }
      } catch (error) {
        this.logFailure('view', error);
      }
    }

    const outbox = this.outbox;
    this.outbox = [];
    for (const { socketId, event } of outbox) this.env.sendEvent(socketId, event);
  }

  /** For changes made outside a queued task (e.g. a kick from a hook that already returned). */
  private scheduleFlush(): void {
    if (this.running || this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private logFailure(where: string, error: unknown): void {
    if (error instanceof HydraError && error.code === 'room_not_found') return;
    this.env.logger.error(`[hydra] ${where} failed in room ${this.code} (${this.game.name})`, error);
  }

  private startTimer(
    kind: 'timeout' | 'interval',
    callback: (ctx: RoomContext<S, E>) => void | Promise<void>,
    ms: number,
  ): Cancel {
    if (this.closed) return noop;
    const fire = () => {
      if (kind === 'timeout') this.timers.delete(handle);
      this.run(() => callback(this.context)).catch((error) => this.logFailure(`timer`, error));
    };
    const handle = kind === 'timeout' ? setTimeout(fire, ms) : setInterval(fire, ms);
    this.timers.add(handle);
    return () => {
      clearTimeout(handle);
      this.timers.delete(handle);
    };
  }

  private createContext(): RoomContext<S, E> {
    const room = this;
    const deliver = (seat: Seat, type: string, payload: unknown) => {
      if (seat.socketId !== undefined) {
        room.outbox.push({ socketId: seat.socketId, event: { type, payload: payload ?? null } });
      }
    };
    return {
      get code() {
        return room.code;
      },
      get game() {
        return room.game.name;
      },
      get state() {
        return room.state;
      },
      set state(next: S) {
        room.state = next;
      },
      get members() {
        return room.members;
      },
      getMember(id: string) {
        const seat = room.seats.get(id);
        return seat ? { ...seat.member } : undefined;
      },
      broadcast(type: string, payload?: unknown, options?: EventOptions) {
        if (room.closed) return;
        const roles = options?.to === undefined ? undefined : ([] as Role[]).concat(options.to);
        for (const seat of room.seats.values()) {
          if (seat.member.id === options?.except) continue;
          if (roles && !roles.includes(seat.member.role)) continue;
          deliver(seat, type, payload);
        }
        room.scheduleFlush();
      },
      send(memberId: string, type: string, payload?: unknown) {
        if (room.closed) return;
        const seat = room.seats.get(memberId);
        if (seat) deliver(seat, type, payload);
        room.scheduleFlush();
      },
      kick(memberId: string, message?: string) {
        room.remove(memberId, 'kicked', message);
      },
      close(message?: string) {
        room.close('closed', message);
      },
      setTimeout(callback, ms) {
        return room.startTimer('timeout', callback, ms);
      },
      setInterval(callback, ms) {
        return room.startTimer('interval', callback, ms);
      },
    } as RoomContext<S, E>;
  }
}
