/**
 * The microphone / transcription session state machine.
 *
 * This is the single most important file for the "session already in progress"
 * bug. The old design tracked liveness with independent booleans on each side
 * (`isRecording`, `isPaused`, plus a server-side session record), which can
 * disagree — the classic broken state being:
 *
 *     isRecording = false, isPaused = false, isConnected = true
 *
 * while the backend still believes a session is live. Representing the session
 * as one enum with explicit, guarded transitions makes that combination
 * unrepresentable, and running *the same* reducer on both the client and the
 * server means the two cannot drift apart in the first place.
 */

export const SESSION_STATES = [
  'idle',
  'starting',
  'active',
  'paused',
  'stopping',
  'reconnecting',
  'error',
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_EVENTS = [
  'START',
  'STARTED',
  'PAUSE',
  'RESUME',
  'STOP',
  'STOPPED',
  'CONNECTION_LOST',
  'RECONNECTED',
  'FAIL',
  'RESET',
] as const;

export type SessionEvent = (typeof SESSION_EVENTS)[number];

/**
 * Legal transitions. Anything absent is illegal *by construction* — which is
 * what makes rapid tapping safe: a second START while `starting` or `active`
 * has nowhere to go, so it cannot open a second session.
 *
 *   idle → starting → active ⇄ paused → stopping → idle
 *                       ↓
 *                 reconnecting → active
 *                       ↓
 *                     error → idle
 */
const TRANSITIONS: Record<SessionState, Partial<Record<SessionEvent, SessionState>>> = {
  idle: {
    START: 'starting',
    // A late STOPPED for a session we already forgot is not an error.
    STOPPED: 'idle',
    RESET: 'idle',
  },
  starting: {
    STARTED: 'active',
    // Stopping mid-start is allowed: the user changed their mind before the
    // server answered. The handshake result is then discarded.
    STOP: 'stopping',
    FAIL: 'error',
    CONNECTION_LOST: 'error',
    RESET: 'idle',
  },
  active: {
    PAUSE: 'paused',
    STOP: 'stopping',
    // The server can end a session on its own — a time limit was reached, or
    // another connection took over. That arrives as STOPPED while we are still
    // active, so it has to be legal here rather than only after our own STOP.
    STOPPED: 'idle',
    CONNECTION_LOST: 'reconnecting',
    FAIL: 'error',
    RESET: 'idle',
  },
  paused: {
    RESUME: 'active',
    STOP: 'stopping',
    STOPPED: 'idle',
    CONNECTION_LOST: 'reconnecting',
    FAIL: 'error',
    RESET: 'idle',
  },
  stopping: {
    STOPPED: 'idle',
    // If the socket dies mid-stop we still reached the goal: no session.
    CONNECTION_LOST: 'idle',
    FAIL: 'error',
    RESET: 'idle',
  },
  reconnecting: {
    RECONNECTED: 'active',
    STOP: 'stopping',
    STOPPED: 'idle',
    FAIL: 'error',
    RESET: 'idle',
  },
  error: {
    RESET: 'idle',
    // Recovering straight into a new session is allowed: after a failure the
    // user's next tap should just work, not require a separate dismiss step.
    START: 'starting',
  },
};

/** Returns the next state, or `null` when the event is not legal here. */
export function nextState(state: SessionState, event: SessionEvent): SessionState | null {
  return TRANSITIONS[state]?.[event] ?? null;
}

export function canTransition(state: SessionState, event: SessionEvent): boolean {
  return nextState(state, event) !== null;
}

/**
 * Applies an event, staying put when it is not legal.
 *
 * Deliberately forgiving rather than throwing: these events come from user taps
 * and network callbacks, where a redundant STOP or a duplicate STARTED is
 * normal traffic, not a programming error. Illegal events are simply ignored.
 */
export function applyEvent(state: SessionState, event: SessionEvent): SessionState {
  return nextState(state, event) ?? state;
}

/** True while the session occupies a slot on the server. */
export function isSessionOpen(state: SessionState): boolean {
  return state === 'starting' || state === 'active' || state === 'paused' || state === 'reconnecting';
}

/** True when audio should be flowing. */
export function isCapturing(state: SessionState): boolean {
  return state === 'active';
}

/** True when the user may start a new session. */
export function canStart(state: SessionState): boolean {
  return canTransition(state, 'START');
}

/** True when the session is settling and input should be ignored. */
export function isBusy(state: SessionState): boolean {
  return state === 'starting' || state === 'stopping';
}

/** Maps a state to the mic-button appearance. Keeps client and server aligned. */
export function micStateFor(state: SessionState): 'idle' | 'listening' | 'processing' | 'blocked' {
  switch (state) {
    case 'active':
      return 'listening';
    case 'starting':
    case 'stopping':
    case 'reconnecting':
      return 'processing';
    case 'error':
      return 'blocked';
    case 'paused':
    case 'idle':
    default:
      return 'idle';
  }
}
