# Hydra

Multiplayer experiences using people's own devices. One shared screen hosts a room; everyone else
joins from their phone with a short code, the way Jackbox games work.

Version 1 is a rewrite of the 2016–2017 Hydra Node Server. Apps no longer copy the `hydra/` folder and
register their own socket events. Instead, a game is a single definition: its state, the actions
players can send, and what each person gets to see. The server takes care of rooms, codes, roles,
validation, reconnection and cleanup.

```
packages/protocol   wire types shared by server and client
packages/server     @hydra/server: createHydra, defineGame
packages/client     @hydra/client: createClient for the browser
examples/buzzer     game-show buzzers built on the above
```

## Quick start

Requires Node 20 or newer.

```sh
npm install
npm run dev
```

Open <http://localhost:3000/host> on the big screen and click **Open a room**. Then open
<http://localhost:3000> on a few phones (or browser tabs) and join with the code.

Other scripts:

| Command             | What it does                                         |
| ------------------- | ---------------------------------------------------- |
| `npm test`          | Integration tests (real server, client and sockets)  |
| `npm run typecheck` | Type-check the packages, tests and example           |
| `npm run build`     | Compile the packages to `dist/`                      |

To run the example in production mode: `npm run build -w examples/buzzer`, then
`npm start -w examples/buzzer`.

## Writing a game

```ts
// game.ts
import { HydraError, defineGame, eventTypes } from '@hydra/server';

export const buzzer = defineGame({
  name: 'buzzer',
  maxPlayers: 12,
  events: eventTypes<{ buzzed: { name: string } }>(),

  setup: () => ({ locked: false, order: [] as string[] }),

  actions: {
    // Plain function: any host or player may send it.
    buzz(ctx) {
      if (ctx.state.locked) throw new HydraError('locked', 'Buzzers are locked');
      ctx.state.order.push(ctx.sender.name);
      ctx.broadcast('buzzed', { name: ctx.sender.name });
      return { position: ctx.state.order.length }; // sent back to the sender
    },

    // Config object: restrict who may send it and validate the payload.
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
  },
});
```

```ts
// server.ts
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createHydra } from '@hydra/server';
import { buzzer } from './game.js';

const httpServer = createServer(/* your express app, if any */);
const io = new Server(httpServer);
createHydra({ games: [buzzer] }).attach(io);
httpServer.listen(3000);
```

```ts
// player.ts (browser)
import { createClient } from '@hydra/client';
import type { buzzer } from './game.js'; // type-only: no server code in the bundle

const client = createClient<typeof buzzer>();
await client.join('BKTL', { name: 'Ada' });
client.on('state', (state) => render(state)); // state is typed
client.onEvent('buzzed', ({ name }) => flash(name));
const { position } = await client.send('buzz'); // action names and payloads are typed
```

The full example lives in [`examples/buzzer`](examples/buzzer).

## Concepts

**Rooms and codes.** A host calls `create()` and gets a four-letter code. Codes use consonants only,
so they can't spell words. A game can set `customCodes: true` to allow fixed codes like `PIXEL`.
Codes are case-insensitive. A room closes when its host leaves (unless the game sets
`closeWhenHostLeaves: false`), when the game calls `ctx.close()`, or when its last member is gone.

**Roles.** `host` (whoever created the room), `player` and `viewer` (a screen that only watches).
`maxPlayers` limits players only. Actions are open to hosts and players unless they set `roles`.

**State and views.** `setup()` builds the room's state. Action handlers, hooks and timers change
`ctx.state`. When a handler finishes, every member receives their `view(state, member)` if it
changed since the last update. Leave `view` out to send the whole state to everyone. Use it to hide
secrets or to add per-person fields like "your position". Keep state JSON-serializable.

**Actions.** These are the only way clients change the game. Each room runs one action at a time,
so async handlers never interleave. To reject an action, throw `new HydraError(code, message)`: the
sender's `send()` rejects with that code and message. Any other error is logged and reported as
`internal_error`. Use `input` to validate payloads; it also works with schema libraries, for example
`input: z.object({ x: z.number() }).parse`. TypeScript reports an error if `run` expects a different
type than `input` returns.

**Events.** `ctx.broadcast(type, payload, { to, except })` and `ctx.send(memberId, type, payload)`
deliver one-off messages: sounds, animations, chat, MIDI notes. They aren't stored, and they arrive
after the state update from the same handler.

**Hooks.** `canJoin`, `onJoin`, `onLeave(member, reason)`, `onDisconnect`, `onReconnect` and
`onClose`. They run in the same queue as actions.

**Timers.** `ctx.setTimeout` and `ctx.setInterval` behave like the built-ins, but their callbacks run
in the room's queue, sync state afterwards, and stop when the room closes.

**Reconnecting.** Every member gets a secret session token. If a phone's connection drops (screen
lock, wifi change), the client resumes automatically, and anything sent in the meantime waits until
it has rejoined. After a page reload, call `client.resume()`; the token is kept in `sessionStorage`.
Disconnected members keep their seat for `reconnectGraceMs` (default 2 minutes, 1 minute for hosts
via `hostGraceMs`). Everyone sees their `connected: false` status until they come back or the grace
period runs out. If the same session is opened in a second tab, the newest tab takes the seat.

## API

### Server: `@hydra/server`

`createHydra(options)` returns `{ attach, rooms, closeRoom, close }`.

| Option             | Default    | Meaning                                         |
| ------------------ | ---------- | ----------------------------------------------- |
| `games`            | (required) | Game definitions this server runs               |
| `reconnectGraceMs` | `120000`   | Seat kept for a disconnected player or viewer   |
| `hostGraceMs`      | `60000`    | Seat (and room) kept for a disconnected host    |
| `logger`           | `console`  | Where game errors go; `null` to silence         |

- `attach(ioOrNamespace)` starts handling Hydra traffic.
- `rooms()` lists open rooms and their members, for dashboards.
- `closeRoom(code, message?)` closes one room; `close(message?)` closes all of them, for example on
  `SIGTERM`.

`defineGame(config)` accepts `name`, `setup`, `actions`, and optionally `view`, `events`,
`maxPlayers` (default 16), `customCodes`, `closeWhenHostLeaves` (default true), and the hooks above.

Inside handlers, `ctx` has `code`, `game`, `state`, `members`, `getMember(id)`, `broadcast`, `send`,
`kick(id, message?)`, `close(message?)`, `setTimeout` and `setInterval`. Action handlers also get
`ctx.sender`.

### Client: `@hydra/client`

`createClient<typeof game>(options?)` returns a client with:

- `create({ game?, name?, code? })`, `join(code, { name, role? })` and `resume()`. Each resolves with
  `{ room, you, session, members, state }`.
- `send(action, payload?)` resolves with what the action returned, or rejects with a
  `HydraClientError` that has a `code` and a `message`.
- `leave()` and `close()`. `close()` keeps the session so the seat can be resumed later.
- `on('state' | 'members' | 'event' | 'status' | 'removed', listener)` and `onEvent(type, listener)`.
  Both return an unsubscribe function.
- `status` (`idle`, `joining`, `joined` or `reconnecting`), plus `room`, `me`, `members`, `state` and
  `storedRoom`.

Options: `url` (default: same origin), `io` (socket.io options), `socket`, `storage`
(default `sessionStorage`; `localStorage` or `null` also work), `storageKey` and `timeoutMs`.

### Protocol

Everything goes over socket.io events, so devices that aren't browsers can join too:

| Client → server | Payload                     | Ack value                                |
| --------------- | --------------------------- | ---------------------------------------- |
| `hydra:create`  | `{ game?, name?, code? }`   | `{ room, you, session, members, state }` |
| `hydra:join`    | `{ code, name, role? }`     | same                                     |
| `hydra:resume`  | `{ session }`               | same                                     |
| `hydra:action`  | `{ type, payload? }`        | the action's return value                |
| `hydra:leave`   | none                        | `null`                                   |

Every ack has the shape `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.
The server sends `hydra:state` (your view), `hydra:members`, `hydra:event` (`{ type, payload }`) and
`hydra:removed` (`{ reason, message? }`). Types are in [`packages/protocol`](packages/protocol/src/index.ts).

## Migrating from 0.2

| 0.2                                            | 1.0                                                         |
| ---------------------------------------------- | ----------------------------------------------------------- |
| Copy `hydra/` into each app                    | Depend on `@hydra/server` and `@hydra/client`               |
| `game.js` registers `socket.on(...)` handlers  | `defineGame({ actions })`                                   |
| `adminLogin` → room code                       | `client.create()`                                           |
| `playerLogin` + `playerJoinRoom`               | `client.join(code, { name })`                               |
| `io.to(room).emit(...)` from game code         | `ctx.broadcast(...)`, or change `ctx.state` and let it sync |
| `socket.game`, `hydra.games[roomID]`           | `ctx.state`, `hydra.rooms()`                                |
| Rooms that never go away                       | Rooms close when empty or the host leaves                   |
| Four-letter dictionary words                   | Random consonant codes, or `customCodes`                    |
| jQuery, socket.io 1, Express 4.13, jade        | TypeScript, socket.io 4, Vite, Express 5 (example)          |

Porting hydra-pixel and hydra-midi will need features this version doesn't have yet:

- **Persistence.** Pixel keeps its canvas in Redis. Rooms are currently in memory and end when the
  server restarts.
- **Binary events.** Pixel's LED matrix reads a compact `pixelbin` stream. Events are JSON today.
- **Rooms anyone can open by name.** Pixel and midi create a room on first join with `?room=NAME`.
  `customCodes` covers part of this; a `joinOrCreate` call would cover the rest.

Other known gaps: no per-client rate limiting, and a single server process (no multi-node adapter).

## History

**1.0.0-alpha.0** (October 2026). Rewritten in TypeScript as a monorepo:
- a game definition API with typed client
- roles, payload validation and per-member views
- reconnection with grace periods
- room lifecycle and cleanup
- integration tests, and a buzzer example

**0.2** (April 2017). Added tests, simplified the demo game and cleaned up the codebase.

**0.1** (August 2016). First working version.

## Credits

Written by Surya Buchwald. Inspired by Jackbox.tv and Kevin's Experiments.

## License

MIT
