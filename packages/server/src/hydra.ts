import type {
  ClientToServerEvents,
  ErrorInfo,
  JoinRole,
  Joined,
  Member,
  Result,
  Role,
  ServerToClientEvents,
} from '@hydra/protocol';
import type { Namespace, Server, Socket } from 'socket.io';
import { generateCode, isValidCustomCode, normalizeCode } from './codes.js';
import { HydraError } from './errors.js';
import type { GameDefinition } from './game.js';
import { Room, type Logger, type RoomEnvironment } from './room.js';

export interface HydraOptions {
  /** Games this server can run. */
  games: readonly GameDefinition[];
  /** How long a disconnected player or viewer keeps their seat. Defaults to 2 minutes. */
  reconnectGraceMs?: number;
  /** How long a disconnected host keeps their seat (and the room stays open). Defaults to 1 minute. */
  hostGraceMs?: number;
  /** Where to report errors thrown by game code. Defaults to `console`; pass `null` to silence. */
  logger?: Logger | null;
}

export interface RoomSummary {
  code: string;
  game: string;
  members: Member[];
}

export interface Hydra {
  /** Start handling Hydra traffic on a socket.io server or namespace. */
  attach(target: Server | Namespace): void;
  /** Snapshot of the open rooms, for dashboards and debugging. */
  rooms(): RoomSummary[];
  /** Close one room. Returns false if there was no such room. */
  closeRoom(code: string, message?: string): boolean;
  /** Close every room, e.g. before shutting the server down. */
  close(message?: string): void;
}

interface SocketData {
  binding?: { room: Room; memberId: string };
}

type HydraSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type HydraNamespace = Namespace<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const MAX_NAME_LENGTH = 24;
const MAX_ACTION_TYPE_LENGTH = 64;
const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export function createHydra(options: HydraOptions): Hydra {
  const games = new Map<string, GameDefinition>();
  for (const game of options.games) {
    if (games.has(game.name)) throw new Error(`createHydra: two games are named "${game.name}"`);
    games.set(game.name, game);
  }
  if (games.size === 0) throw new Error('createHydra: at least one game is required');

  const logger = options.logger === null ? silentLogger : (options.logger ?? console);
  const reconnectGraceMs = options.reconnectGraceMs ?? 120_000;
  const hostGraceMs = options.hostGraceMs ?? 60_000;

  const rooms = new Map<string, Room>();
  const sessions = new Map<string, { room: Room; memberId: string }>();
  let nsp: HydraNamespace | undefined;

  const env: RoomEnvironment = {
    bind(socketId, room, memberId) {
      const socket = nsp?.sockets.get(socketId);
      if (!socket?.connected) return false;
      socket.data.binding = { room, memberId };
      return true;
    },
    unbind(socketId) {
      const socket = nsp?.sockets.get(socketId);
      if (socket) socket.data.binding = undefined;
    },
    sendState: (socketId, state) => nsp?.to(socketId).emit('hydra:state', state),
    sendMembers: (socketId, members) => nsp?.to(socketId).emit('hydra:members', members),
    sendEvent: (socketId, event) => nsp?.to(socketId).emit('hydra:event', event),
    sendRemoved: (socketId, info) => nsp?.to(socketId).emit('hydra:removed', info),
    addSession: (token, room, memberId) => sessions.set(token, { room, memberId }),
    removeSession: (token) => sessions.delete(token),
    roomClosed(room) {
      if (rooms.get(room.code) === room) rooms.delete(room.code);
    },
    graceMs: (role: Role) => (role === 'host' ? hostGraceMs : reconnectGraceMs),
    logger,
  };

  /** Game code errors are worth logging; HydraErrors (like "room already closed") are expected. */
  function logUnexpected(what: string) {
    return (error: unknown) => {
      if (!(error instanceof HydraError)) logger.error(`[hydra] ${what} failed`, error);
    };
  }

  /** Leave whatever room this socket is in before it joins another. */
  async function leaveCurrent(socket: HydraSocket): Promise<void> {
    const binding = socket.data.binding;
    if (binding) await binding.room.leave(binding.memberId).catch(logUnexpected('leave'));
  }

  async function create(socket: HydraSocket, request: unknown): Promise<Joined> {
    const req = asObject(request ?? {});
    const game = pickGame(req.game);
    const name = cleanName(req.name ?? 'Host');

    let code: string | undefined;
    if (req.code !== undefined) {
      if (!game.customCodes) throw new HydraError('bad_request', `${game.name} does not allow choosing a room code`);
      if (typeof req.code !== 'string') throw new HydraError('bad_request', 'code must be a string');
      code = normalizeCode(req.code);
      if (!isValidCustomCode(code)) {
        throw new HydraError('bad_request', 'Room codes are 2-24 letters, digits, "-" or "_"');
      }
    }

    await leaveCurrent(socket);
    if (code === undefined) code = generateCode((candidate) => rooms.has(candidate));
    else if (rooms.has(code)) throw new HydraError('code_taken', `Room ${code} already exists`);
    const room = new Room(code, game, env);
    rooms.set(code, room);
    try {
      return await room.seatHost(socket.id, name);
    } catch (error) {
      room.close();
      throw error;
    }
  }

  async function join(socket: HydraSocket, request: unknown): Promise<Joined> {
    const req = asObject(request);
    if (typeof req.code !== 'string') throw new HydraError('bad_request', 'code is required');
    const name = cleanName(req.name);
    const role = req.role ?? 'player';
    if (role !== 'player' && role !== 'viewer') throw new HydraError('bad_request', 'role must be "player" or "viewer"');

    const room = rooms.get(normalizeCode(req.code));
    if (!room) throw new HydraError('room_not_found', `There is no room ${normalizeCode(req.code)}`);
    await leaveCurrent(socket);
    return room.join(socket.id, name, role as JoinRole);
  }

  async function resume(socket: HydraSocket, request: unknown): Promise<Joined> {
    const req = asObject(request);
    if (typeof req.session !== 'string') throw new HydraError('bad_request', 'session is required');
    const session = sessions.get(req.session);
    if (!session) throw new HydraError('session_expired', 'That session has ended');

    const current = socket.data.binding;
    if (current && (current.room !== session.room || current.memberId !== session.memberId)) {
      await leaveCurrent(socket);
    }
    return session.room.resume(session.memberId, socket.id);
  }

  async function leave(socket: HydraSocket): Promise<null> {
    await leaveCurrent(socket);
    return null;
  }

  async function act(socket: HydraSocket, request: unknown): Promise<unknown> {
    const req = asObject(request);
    if (typeof req.type !== 'string' || req.type.length === 0 || req.type.length > MAX_ACTION_TYPE_LENGTH) {
      throw new HydraError('bad_request', 'type must be a non-empty string');
    }
    const binding = socket.data.binding;
    if (!binding) throw new HydraError('not_in_room', 'Join a room first');
    return binding.room.act(binding.memberId, req.type, req.payload);
  }

  function pickGame(name: unknown): GameDefinition {
    if (name === undefined) {
      if (games.size === 1) return games.values().next().value!;
      throw new HydraError('bad_request', 'game is required when the server runs more than one game');
    }
    const game = typeof name === 'string' ? games.get(name) : undefined;
    if (!game) throw new HydraError('unknown_game', `Unknown game "${String(name)}"`);
    return game;
  }

  function respond(ack: (result: Result<unknown>) => void, task: () => Promise<unknown>, what: string): void {
    task().then(
      (value) => ack({ ok: true, value: value ?? null }),
      (error: unknown) => {
        if (!(error instanceof HydraError)) logger.error(`[hydra] ${what} failed`, error);
        ack({ ok: false, error: toErrorInfo(error) });
      },
    );
  }

  function onConnection(socket: HydraSocket): void {
    // Clients are untrusted: accept any arguments, take the ack from the end if there is one.
    const handle = (event: keyof ClientToServerEvents, task: (request: unknown) => Promise<unknown>) => {
      socket.on(event, (...args: unknown[]) => {
        const ack = typeof args.at(-1) === 'function' ? (args.pop() as (result: Result<unknown>) => void) : () => {};
        respond(ack, () => task(args[0]), event);
      });
    };
    handle('hydra:create', (request) => create(socket, request));
    handle('hydra:join', (request) => join(socket, request));
    handle('hydra:resume', (request) => resume(socket, request));
    handle('hydra:leave', () => leave(socket));
    handle('hydra:action', (request) => act(socket, request));

    socket.on('disconnect', () => {
      const binding = socket.data.binding;
      if (!binding) return;
      socket.data.binding = undefined;
      binding.room.disconnect(binding.memberId, socket.id).catch(logUnexpected('disconnect'));
    });
  }

  return {
    attach(target) {
      if (nsp) throw new Error('Hydra is already attached');
      nsp = ('of' in target ? target.of('/') : target) as unknown as HydraNamespace;
      nsp.on('connection', onConnection);
    },
    rooms() {
      return [...rooms.values()].map((room) => ({ code: room.code, game: room.game.name, members: room.members }));
    },
    closeRoom(code, message) {
      const room = rooms.get(normalizeCode(code));
      room?.close('closed', message);
      return room !== undefined;
    },
    close(message) {
      for (const room of [...rooms.values()]) room.close('closed', message);
    },
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HydraError('bad_request', 'Expected an object');
  }
  return value as Record<string, unknown>;
}

function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') throw new HydraError('bad_request', 'name is required');
  const name = Array.from(raw.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim())
    .slice(0, MAX_NAME_LENGTH)
    .join('')
    .trim();
  if (!name) throw new HydraError('bad_request', 'name is required');
  return name;
}

function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof HydraError) return error.toInfo();
  return { code: 'internal_error', message: 'Something went wrong on the server' };
}
