import { describe, expect, it } from 'vitest';
import { toWebSocketUrl } from '../../src/config/env';

/**
 * The scheme mapping is a deployment safety rule, not a formatting detail.
 *
 * Browsers block an insecure WebSocket opened from a secure page. Getting this
 * wrong produces a build that works perfectly against a local `http://` dev
 * server and fails only once it is live on Vercel over `https://` — the worst
 * possible time to discover it.
 */
describe('toWebSocketUrl', () => {
  it('maps https to wss', () => {
    expect(toWebSocketUrl('https://translate-api.onrender.com')).toBe('wss://translate-api.onrender.com');
  });

  it('maps http to ws for local development', () => {
    expect(toWebSocketUrl('http://localhost:8787')).toBe('ws://localhost:8787');
  });

  it('is case-insensitive about the scheme', () => {
    expect(toWebSocketUrl('HTTPS://example.com')).toBe('wss://example.com');
  });

  it('never downgrades a secure origin to an insecure socket', () => {
    // The mixed-content failure this whole function exists to prevent.
    const result = toWebSocketUrl('https://example.com');
    expect(result.startsWith('wss://')).toBe(true);
    expect(result.startsWith('ws://')).toBe(false);
  });

  it('preserves host, port and path', () => {
    expect(toWebSocketUrl('https://api.example.com:8443/base')).toBe('wss://api.example.com:8443/base');
  });

  it('only rewrites the leading scheme', () => {
    // A host containing "http" must not be mangled.
    expect(toWebSocketUrl('https://http-proxy.example.com')).toBe('wss://http-proxy.example.com');
  });
});
