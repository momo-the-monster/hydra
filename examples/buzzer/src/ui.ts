import { HydraClientError, type HydraClient, type Removed } from '@hydra/client';
import './style.css';

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

/** Create an element. Text always goes through textContent, so player names can't inject markup. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string } = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  element.append(...children);
  return element;
}

/** Show exactly one of the given sections. */
export function showOnly(visible: HTMLElement, ...others: HTMLElement[]): void {
  visible.hidden = false;
  for (const other of others) other.hidden = true;
}

export function errorMessage(error: unknown): string {
  if (error instanceof HydraClientError) return error.message;
  return 'Something went wrong. Try again?';
}

export function removalMessage(info: Removed): string {
  if (info.message) return info.message;
  switch (info.reason) {
    case 'kicked':
      return 'You were removed from the room.';
    case 'timeout':
      return 'You were away too long and lost your seat.';
    case 'replaced':
      return 'This room is open in another tab.';
    case 'host_left':
      return 'The host left, so the room closed.';
    default:
      return 'The room closed.';
  }
}

/** Show a banner while the connection is down. */
export function trackConnection(client: HydraClient<any>): void {
  const banner = byId('connection');
  const update = () => {
    const reconnecting = client.status === 'reconnecting';
    banner.hidden = !reconnecting;
    banner.textContent = reconnecting ? 'Connection lost. Reconnecting…' : '';
  };
  client.on('status', update);
  update();
}
