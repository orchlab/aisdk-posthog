/**
 * Minimal structural logger interface so the package can plug into any host's
 * logging stack (winston, pino, consola, console). Mirrors the shape of the
 * common `info`/`warn`/`error`/`debug` methods.
 */
export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Default logger that delegates to `console`. Used when the consumer does not
 * supply one via `AISDKTelemetryOptions.logger`.
 */
export function consoleLogger(): Logger {
  return {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args),
  };
}
