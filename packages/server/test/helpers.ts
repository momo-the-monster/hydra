import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient, type HydraClient, type SessionStore } from '@hydra/client';
import type { TypedGame } from '@hydra/protocol';
import { Server } from 'socket.io';
import { createHydra, type GameDefinition, type HydraOptions } from '../src/index.js';

export function memoryStorage(): SessionStore {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

export async function startServer(games: GameDefinition[], options: Partial<HydraOptions> = {}) {
  const httpServer = createServer();
  const io = new Server(httpServer);
  const hydra = createHydra({ games, logger: null, ...options });
  hydra.attach(io);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
  const clients: HydraClient<any>[] = [];

  return {
    hydra,
    io,
    url,
    client<G extends TypedGame = TypedGame>(storage: SessionStore = memoryStorage()): HydraClient<G> {
      const client = createClient<G>({ url, storage, io: { transports: ['websocket'], forceNew: true } });
      clients.push(client);
      return client;
    },
    async close() {
      for (const client of clients) client.close();
      hydra.close();
      await io.close();
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
