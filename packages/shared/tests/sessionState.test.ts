import { describe, expect, it } from 'vitest';
import {
  SESSION_STATES,
  applyEvent,
  canStart,
  canTransition,
  isBusy,
  isCapturing,
  isSessionOpen,
  micStateFor,
  nextState,
} from '../src/sessionState.js';
import type { SessionEvent, SessionState } from '../src/sessionState.js';

/**
 * These tests encode the guarantees the microphone bug report asked for. Each
 * one corresponds to a scenario that previously produced a stuck session or a
 * contradictory client state.
 */
describe('session state machine', () => {
  describe('the happy path', () => {
    it('walks idle → starting → active → paused → active → stopping → idle', () => {
      let state: SessionState = 'idle';
      state = applyEvent(state, 'START');
      expect(state).toBe('starting');
      state = applyEvent(state, 'STARTED');
      expect(state).toBe('active');
      state = applyEvent(state, 'PAUSE');
      expect(state).toBe('paused');
      state = applyEvent(state, 'RESUME');
      expect(state).toBe('active');
      state = applyEvent(state, 'STOP');
      expect(state).toBe('stopping');
      state = applyEvent(state, 'STOPPED');
      expect(state).toBe('idle');
    });

    it('allows a clean restart after a full stop', () => {
      const afterStop = ['START', 'STARTED', 'STOP', 'STOPPED'].reduce<SessionState>(
        (s, e) => applyEvent(s, e as SessionEvent),
        'idle',
      );
      expect(afterStop).toBe('idle');
      expect(canStart(afterStop)).toBe(true);
      expect(applyEvent(afterStop, 'START')).toBe('starting');
    });
  });

  describe('rapid interaction cannot create duplicate sessions', () => {
    /**
     * The core guarantee. Three taps in a row must produce one session, and the
     * machine enforces it structurally: START has no transition out of
     * `starting` or `active`, so the extra taps are inert.
     */
    it('START START START opens exactly one session', () => {
      let state: SessionState = 'idle';
      let starts = 0;

      for (let i = 0; i < 3; i += 1) {
        const next = applyEvent(state, 'START');
        if (next !== state && next === 'starting') starts += 1;
        state = next;
      }

      expect(starts).toBe(1);
      expect(state).toBe('starting');
    });

    it('ignores START while already active', () => {
      expect(canTransition('active', 'START')).toBe(false);
      expect(applyEvent('active', 'START')).toBe('active');
    });

    it('survives PAUSE RESUME PAUSE RESUME without drifting', () => {
      let state: SessionState = 'active';
      for (let i = 0; i < 4; i += 1) {
        state = applyEvent(state, 'PAUSE');
        expect(state).toBe('paused');
        state = applyEvent(state, 'RESUME');
        expect(state).toBe('active');
      }
      expect(state).toBe('active');
    });

    it('ignores a redundant RESUME while active', () => {
      expect(applyEvent('active', 'RESUME')).toBe('active');
    });

    it('ignores a redundant PAUSE while paused', () => {
      expect(applyEvent('paused', 'PAUSE')).toBe('paused');
    });

    it('ignores repeated STOP while stopping', () => {
      expect(applyEvent('stopping', 'STOP')).toBe('stopping');
    });
  });

  describe('stop always wins', () => {
    it.each<SessionState>(['starting', 'active', 'paused', 'reconnecting'])(
      'can stop from %s',
      (state) => {
        expect(applyEvent(state, 'STOP')).toBe('stopping');
      },
    );

    it('treats a late STOPPED in idle as a no-op, not an error', () => {
      // Fires when the server confirms a stop after the client has moved on.
      expect(applyEvent('idle', 'STOPPED')).toBe('idle');
    });

    /**
     * The server can end a session without being asked: a time limit expires,
     * or another connection takes the slot. That notification lands while the
     * client is still active, so STOPPED has to be accepted there directly.
     */
    it.each<SessionState>(['active', 'paused', 'reconnecting'])(
      'accepts a server-initiated STOPPED from %s',
      (state) => {
        expect(applyEvent(state, 'STOPPED')).toBe('idle');
      },
    );
  });

  describe('connection loss', () => {
    it('moves an active session to reconnecting rather than idle', () => {
      // The user did not stop; showing "idle" would misreport what happened.
      expect(applyEvent('active', 'CONNECTION_LOST')).toBe('reconnecting');
    });

    it('recovers to active on reconnect', () => {
      expect(applyEvent('reconnecting', 'RECONNECTED')).toBe('active');
    });

    it('treats a drop during stopping as a successful stop', () => {
      // The goal was "no session", and a closed socket achieves exactly that.
      expect(applyEvent('stopping', 'CONNECTION_LOST')).toBe('idle');
    });

    it('fails a session that drops mid-start', () => {
      expect(applyEvent('starting', 'CONNECTION_LOST')).toBe('error');
    });
  });

  describe('error recovery', () => {
    it('lets the next tap start a session directly from error', () => {
      // No separate dismiss step: after a failure the mic button just works.
      expect(applyEvent('error', 'START')).toBe('starting');
      expect(canStart('error')).toBe(true);
    });

    it('resets to idle from any state', () => {
      for (const state of SESSION_STATES) {
        expect(applyEvent(state, 'RESET')).toBe('idle');
      }
    });
  });

  describe('illegal transitions are inert', () => {
    it('returns null from nextState for an illegal pair', () => {
      expect(nextState('idle', 'PAUSE')).toBeNull();
      expect(nextState('idle', 'RESUME')).toBeNull();
      expect(nextState('paused', 'STARTED')).toBeNull();
    });

    it('never throws, whatever the sequence', () => {
      const events: SessionEvent[] = [
        'STOP', 'RESUME', 'PAUSE', 'STARTED', 'RECONNECTED', 'START', 'START',
        'CONNECTION_LOST', 'STOPPED', 'FAIL', 'RESET', 'PAUSE',
      ];
      let state: SessionState = 'idle';
      expect(() => {
        for (const event of events) state = applyEvent(state, event);
      }).not.toThrow();
      expect(SESSION_STATES).toContain(state);
    });

    it('always lands on a declared state', () => {
      for (const state of SESSION_STATES) {
        for (const event of ['START', 'STARTED', 'PAUSE', 'RESUME', 'STOP', 'STOPPED', 'CONNECTION_LOST', 'RECONNECTED', 'FAIL', 'RESET'] as SessionEvent[]) {
          expect(SESSION_STATES).toContain(applyEvent(state, event));
        }
      }
    });
  });

  describe('derived predicates', () => {
    it('reports which states hold a server slot', () => {
      expect(isSessionOpen('starting')).toBe(true);
      expect(isSessionOpen('active')).toBe(true);
      expect(isSessionOpen('paused')).toBe(true);
      expect(isSessionOpen('reconnecting')).toBe(true);
      expect(isSessionOpen('idle')).toBe(false);
      expect(isSessionOpen('error')).toBe(false);
    });

    it('captures audio only while active', () => {
      expect(isCapturing('active')).toBe(true);
      // Paused must not capture — that is the whole point of pausing.
      expect(isCapturing('paused')).toBe(false);
      expect(isCapturing('starting')).toBe(false);
    });

    it('marks transitional states busy so input can be ignored', () => {
      expect(isBusy('starting')).toBe(true);
      expect(isBusy('stopping')).toBe(true);
      expect(isBusy('active')).toBe(false);
    });

    it('maps every state to a mic appearance', () => {
      for (const state of SESSION_STATES) {
        expect(['idle', 'listening', 'processing', 'blocked']).toContain(micStateFor(state));
      }
      expect(micStateFor('active')).toBe('listening');
      expect(micStateFor('error')).toBe('blocked');
      expect(micStateFor('reconnecting')).toBe('processing');
    });
  });

  describe('the contradictory-state class of bug', () => {
    /**
     * The reported symptom was a UI showing "not recording, not paused,
     * connected" while the backend still held a live session. With one enum
     * there is no way to express that: a state is exactly one value, and
     * whether a slot is held is derived from it rather than tracked separately.
     */
    it('cannot be simultaneously capturing and idle', () => {
      for (const state of SESSION_STATES) {
        expect(isCapturing(state) && state === 'idle').toBe(false);
      }
    });

    it('never holds a server slot while idle', () => {
      expect(isSessionOpen('idle')).toBe(false);
    });

    it('never reports capturing while a session is closed', () => {
      for (const state of SESSION_STATES) {
        if (isCapturing(state)) expect(isSessionOpen(state)).toBe(true);
      }
    });
  });
});
