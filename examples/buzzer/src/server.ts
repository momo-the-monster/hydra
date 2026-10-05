import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHydra } from '@hydra/server';
import express from 'express';
import { Server } from 'socket.io';
import { buzzer } from './game.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const production = process.env.NODE_ENV === 'production';

const app = express();
const httpServer = createServer(app);
// Buzzer messages are tiny; refuse anything big.
const io = new Server(httpServer, { maxHttpBufferSize: 16 * 1024 });

const hydra = createHydra({ games: [buzzer] });
hydra.attach(io);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: hydra.rooms().length });
});
app.get('/host', (_req, res) => res.redirect('/host.html'));

if (production) {
  app.use(express.static(fileURLToPath(new URL('../dist', import.meta.url))));
} else {
  // In development Vite serves the pages with hot reload, from this same server and port.
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root,
    appType: 'mpa',
    // Load vite.config.ts without writing a temp file, which would make `tsx watch` restart.
    configLoader: 'runner',
    server: { middlewareMode: true, hmr: { server: httpServer } },
  });
  app.use(vite.middlewares);
}

httpServer.listen(port, () => {
  console.log(`Buzzer running at http://localhost:${port}`);
  console.log(`  host screen:  http://localhost:${port}/host`);
  console.log(`  players join: http://localhost:${port}/`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    hydra.close('The server is restarting');
    io.close(() => process.exit(0));
  });
}
