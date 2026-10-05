import { createClient } from '@hydra/client';
import type { Buzzer } from './game.js';
import { byId, errorMessage, removalMessage, showOnly, trackConnection } from './ui.js';

const client = createClient<Buzzer>();

const join = byId('join');
const game = byId('game');
const form = byId<HTMLFormElement>('join-form');
const codeInput = byId<HTMLInputElement>('code');
const nameInput = byId<HTMLInputElement>('name');
const joinError = byId('join-error');
const buzz = byId<HTMLButtonElement>('buzz');
const message = byId('message');

const NAME_KEY = 'buzzer:name';

codeInput.value = new URLSearchParams(location.search).get('room') ?? client.storedRoom ?? '';
nameInput.value = remembered(NAME_KEY);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = form.querySelector('button')!;
  submit.disabled = true;
  joinError.textContent = '';
  try {
    remember(NAME_KEY, nameInput.value.trim());
    await client.join(codeInput.value, { name: nameInput.value });
  } catch (error) {
    joinError.textContent = errorMessage(error);
  } finally {
    submit.disabled = false;
  }
});

// pointerdown fires sooner than click on touch screens, which matters in a race.
buzz.addEventListener('pointerdown', async () => {
  if (buzz.disabled) return;
  navigator.vibrate?.(40);
  try {
    await client.send('buzz');
  } catch (error) {
    message.textContent = errorMessage(error);
  }
});

byId('leave').addEventListener('click', () => {
  void client.leave();
});

client.on('state', render);
client.on('members', render);
client.on('status', render);
client.on('removed', (info) => {
  joinError.textContent = removalMessage(info);
});
trackConnection(client);

function render(): void {
  const { state, me } = client;
  if (client.status === 'idle' || !state || !me) {
    showOnly(join, game);
    return;
  }
  showOnly(game, join);
  byId('me').textContent = me.name;
  byId('room').textContent = client.room?.code ?? '';
  byId('score').textContent = `${state.scores[me.id] ?? 0} pts`;

  buzz.disabled = state.locked || state.position !== null;
  buzz.classList.toggle('first', state.position === 1);
  if (state.position === 1) message.textContent = 'You were first!';
  else if (state.position !== null) message.textContent = `You were #${state.position}`;
  else if (state.locked) message.textContent = 'Buzzers are locked';
  else message.textContent = 'Get ready…';
}

function remembered(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not important.
  }
}

// Rejoin after a reload if this tab was already in a room.
client.resume().catch(() => undefined).finally(render);
