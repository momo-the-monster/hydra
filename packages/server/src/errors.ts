import type { ErrorCode, ErrorInfo } from '@hydra/protocol';

/**
 * Throw from an action or hook to reject it. The sender receives `{ code, message }`;
 * any other thrown error is logged and reported to the sender as `internal_error`.
 */
export class HydraError extends Error {
  readonly code: ErrorCode | (string & {});

  constructor(code: ErrorCode | (string & {}), message: string = code) {
    super(message);
    this.name = 'HydraError';
    this.code = code;
  }

  toInfo(): ErrorInfo {
    return { code: this.code, message: this.message };
  }
}
