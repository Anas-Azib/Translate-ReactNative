/**
 * Runtime endpoint configuration.
 *
 * The rule this file exists to enforce: **no component ever writes a URL**.
 * Everything resolves here, from build-time env vars, so switching between a
 * local backend and the Render deployment is a `.env` change rather than a
 * code change.
 *
 * Vite only exposes variables prefixed `VITE_` to the bundle, which is also the
 * safety boundary — a backend secret cannot reach the client unless someone
 * deliberately renames it, and none of the backend's variables use that prefix.
 */

interface RawEnv {
  VITE_API_URL?: string;
  VITE_WS_URL?: string;
  DEV?: boolean;
  PROD?: boolean;
}

const raw: RawEnv =
  typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env as unknown as RawEnv)
    : {};

/**
 * Derives the WebSocket origin from an HTTP origin.
 *
 * `https` must become `wss`, never `ws`: browsers block an insecure socket from
 * a secure page, so a production build that got this wrong would connect fine
 * in development and fail only once deployed.
 */
export function toWebSocketUrl(httpUrl: string): string {
  return httpUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Resolves the API origin.
 *
 * With nothing configured we fall back to the page's own origin, which is what
 * makes the Vite dev proxy and a single-origin production deployment both work
 * untouched.
 */
function resolveApiOrigin(): string {
  if (raw.VITE_API_URL) return stripTrailingSlash(raw.VITE_API_URL);
  if (typeof window !== 'undefined') return stripTrailingSlash(window.location.origin);
  return 'http://localhost:8787';
}

function resolveWebSocketOrigin(apiOrigin: string): string {
  if (raw.VITE_WS_URL) return stripTrailingSlash(raw.VITE_WS_URL);
  return toWebSocketUrl(apiOrigin);
}

const apiOrigin = resolveApiOrigin();
const wsOrigin = resolveWebSocketOrigin(apiOrigin);

export const env = {
  isDev: Boolean(raw.DEV),
  isProd: Boolean(raw.PROD),

  /** Origin for REST calls. Empty-path safe: endpoints append `/api/...`. */
  apiOrigin,

  /** Base URL for REST, e.g. `https://api.example.com/api`. */
  apiBaseUrl: `${apiOrigin}/api`,

  /** Full WebSocket endpoint, e.g. `wss://api.example.com/ws`. */
  websocketUrl: `${wsOrigin}/ws`,
} as const;

export type AppEnv = typeof env;
