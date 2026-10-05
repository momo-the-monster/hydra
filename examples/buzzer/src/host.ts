import { createClient } from '@hydra/client';
import type { Buzzer } from './game.js';
import { byId, el, errorMessage, removalMessage, showOnly, trackConnection } from './ui.js';

const client = createClient<Buzzer>();

const lobby = byId('lobby');
const board = byId('board');
const lobbyError = byId('lobby-error');
const buzzList = byId('buzzes');
const playerList = byId('players');
const lockButton = byId<HTMLButtonElement>('lock');
const toast = byId('toast');

let audio: AudioContext | undefined;
// Browsers only allow sound after a user gesture (this also covers a host page that was reloaded).
document.addEventListener('pointerdown', () => (audio ??= new AudioContext()), { once: true });

byId('start').addEventListener('click', async () => {
  lobbyError.textContent = '';
  try {
    await client.create({ name: 'Host' });
  } catch (error) {
    lobbyError.textContent = errorMessage(error);
  }
});

byId('reset').addEventListener('click', () => act(client.send('reset')));
lockButton.addEventListener('click', () => act(client.send('lock', !client.state?.locked)));

client.onEvent('buzzed', ({ first }) => {
  if (first) beep();
});
client.onEvent('awarded', ({ name }) => {
  toast.textContent = `+1 for ${name}`;
  toast.classList.remove('show');
  void toast.offsetWidth; // restart the animation
  toast.classList.add('show');
});
client.on('state', render);
client.on('members', render);
client.on('status', render);
client.on('removed', (info) => {
  lobbyError.textContent = removalMessage(info);
});
trackConnection(client);

function render(): void {
  const { state, room } = client;
  if (client.status === 'idle' || !state || !room) {
    showOnly(lobby, board);
    return;
  }
  showOnly(board, lobby);
  byId('room-code').textContent = room.code;
  byId('join-url').textContent = location.host;

  buzzList.replaceChildren(
    ...state.buzzes.map((buzz, index) => {
      const award = el('button', { className: 'small', text: '+1' });
      award.title = `Give ${buzz.name} a point`;
      award.addEventListener('click', () => act(client.send('award', buzz.memberId)));
      return el(
        'li',
        { className: index === 0 ? 'first' : '' },
        el('span', { className: 'name', text: buzz.name }),
        el('span', { className: 'muted', text: index === 0 ? 'first' : `+${(buzz.afterMs / 1000).toFixed(3)}s` }),
        award,
      );
    }),
  );
  byId('no-buzzes').hidden = state.buzzes.length > 0;

  const players = client.members
    .filter((member) => member.role === 'player')
    .sort((a, b) => (state.scores[b.id] ?? 0) - (state.scores[a.id] ?? 0) || a.name.localeCompare(b.name));
  playerList.replaceChildren(
    ...players.map((player) =>
      el(
        'li',
        { className: player.connected ? '' : 'away' },
        el('span', { className: 'dot' }),
        el('span', { className: 'name', text: player.name }),
        el('span', { className: 'score', text: String(state.scores[player.id] ?? 0) }),
      ),
    ),
  );
  byId('no-players').hidden = players.length > 0;

  lockButton.textContent = state.locked ? 'Unlock buzzers' : 'Lock buzzers';
}

function act(request: Promise<unknown>): void {
  request.catch((error: unknown) => {
    toast.textContent = errorMessage(error);
    toast.classList.add('show');
  });
}

function beep(): void {
  if (!audio) return;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = 'square';
  oscillator.frequency.value = 880;
  gain.gain.setValueAtTime(0.15, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.35);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + 0.35);
}

client.resume().catch(() => undefined).finally(render);
