import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * jsdom implements almost none of the platform APIs this app relies on — Web
 * Audio, MediaRecorder, matchMedia, rAF timing. Rather than mocking these per
 * test, they are stubbed once here with behaviour close enough to the real
 * thing that component code runs unmodified.
 */

// Installed at module scope, not in beforeEach: GSAP's ScrollTrigger calls
// matchMedia the moment a plugin is registered, which can happen inside a
// suite's `beforeAll` — that runs before any `beforeEach`.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  if (!window.HTMLElement.prototype.setPointerCapture) {
    window.HTMLElement.prototype.setPointerCapture = vi.fn();
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
    window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  }

  if (!window.HTMLElement.prototype.scrollTo) {
    window.HTMLElement.prototype.scrollTo = vi.fn();
  }

  if (!('vibrate' in navigator)) {
    Object.defineProperty(navigator, 'vibrate', { value: vi.fn(), configurable: true });
  }

  // jsdom's HTMLMediaElement throws "not implemented" on play().
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  window.HTMLMediaElement.prototype.pause = vi.fn();

  if (!URL.createObjectURL) {
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});
