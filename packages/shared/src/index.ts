/**
 * Shared contract between the web client and the Node backend.
 *
 * Anything both sides must agree on lives here so it cannot drift: the session
 * state machine, the WebSocket protocol, and the text-reconciliation rules.
 */

export * from './sessionState.js';
export * from './protocol.js';
export * from './text.js';
