import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/App';
import { ApiClient } from '../../src/services/api';
import { apiError, createMockServer } from '../mockServer';
import type { MockServer } from '../mockServer';

/**
 * Full-app integration: boot, onboarding, language selection, and the resting
 * state of the translate screen, rendered through the real component tree with
 * only the network doubled.
 */
describe('App integration', () => {
  let server: MockServer;

  beforeEach(() => {
    server = createMockServer();
  });

  function renderApp(options: { assignments?: Record<string, string>; onboarded?: boolean } = {}) {
    if (options.assignments) server = createMockServer({ assignments: options.assignments });
    if (options.onboarded !== false) localStorage.setItem('atl.onboarded', '1');

    const api = new ApiClient({
      deviceId: 'device-app-test',
      fetchImpl: server.fetch as unknown as typeof fetch,
      retryDelayMs: 0,
    });
    return { ...render(<App api={api} />), api };
  }

  describe('boot', () => {
    it('loads config and shows the translate screen', async () => {
      renderApp();

      expect(await screen.findByTestId('mic-orb')).toBeInTheDocument();
      expect(server.requestsTo('/config')).toHaveLength(1);
    });

    it('fetches experiment assignments before rendering', async () => {
      renderApp();
      await screen.findByTestId('mic-orb');

      expect(server.requests.some((r) => r.url.includes('/ab/assignments'))).toBe(true);
    });

    it('shows a recoverable error screen when the backend is unreachable', async () => {
      server.setHandler('/config', () => ({
        status: 503,
        body: apiError('transient', 'The service is busy. Please try again in a moment.', {
          retryable: true,
        }),
      }));

      renderApp();

      expect(await screen.findByText(/can’t reach the server/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });
  });

  describe('onboarding', () => {
    it('shows the tour on a first visit', async () => {
      renderApp({ onboarded: false });

      expect(await screen.findByTestId('onboarding')).toBeInTheDocument();
      // Queried by role: the title is mid character-reveal, so its text lives
      // in per-character spans. The accessible name still reads correctly,
      // which is the property that actually matters.
      expect(screen.getByRole('heading', { name: /speak normally/i })).toBeInTheDocument();
    });

    it('is skipped for a returning user', async () => {
      renderApp({ onboarded: true });

      await screen.findByTestId('mic-orb');
      expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument();
    });

    it('walks through all three steps in the guided variant', async () => {
      const user = userEvent.setup();
      renderApp({ onboarded: false, assignments: { onboarding: 'guided', mic_control: 'hold' } });

      await screen.findByTestId('onboarding');
      expect(screen.getByTestId('onboarding-next')).toHaveTextContent(/next/i);

      await user.click(screen.getByTestId('onboarding-next'));
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: /we translate it/i })).toBeInTheDocument(),
      );

      await user.click(screen.getByTestId('onboarding-next'));
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: /they hear it/i })).toBeInTheDocument(),
      );

      expect(screen.getByTestId('onboarding-next')).toHaveTextContent(/start translating/i);
    });

    it('is a single step in the instant variant', async () => {
      renderApp({ onboarded: false, assignments: { onboarding: 'instant', mic_control: 'hold' } });

      await screen.findByTestId('onboarding');
      expect(screen.getByTestId('onboarding-next')).toHaveTextContent(/start translating/i);
      expect(screen.queryByTestId('onboarding-skip')).not.toBeInTheDocument();
    });

    it('lands on the translate screen when finished, and stays skipped afterwards', async () => {
      const user = userEvent.setup();
      renderApp({ onboarded: false, assignments: { onboarding: 'instant', mic_control: 'hold' } });

      await screen.findByTestId('onboarding');
      await user.click(screen.getByTestId('onboarding-next'));

      expect(await screen.findByTestId('mic-orb')).toBeInTheDocument();
      expect(localStorage.getItem('atl.onboarded')).toBe('1');
    });

    it('can be skipped from the first step', async () => {
      const user = userEvent.setup();
      renderApp({ onboarded: false, assignments: { onboarding: 'guided', mic_control: 'hold' } });

      await screen.findByTestId('onboarding');
      await user.click(screen.getByTestId('onboarding-skip'));

      expect(await screen.findByTestId('mic-orb')).toBeInTheDocument();
    });
  });

  describe('the translate screen at rest', () => {
    it('defaults to Arabic → English, the plan document’s primary user', async () => {
      renderApp();
      await screen.findByTestId('mic-orb');

      expect(within(screen.getByTestId('source-chip')).getByText('العربية')).toBeInTheDocument();
      expect(within(screen.getByTestId('target-chip')).getByText('English')).toBeInTheDocument();
    });

    it('shows an empty state that tells a first-time user what to do', async () => {
      renderApp();
      await screen.findByTestId('empty-state');

      expect(screen.getByText(/say something in arabic/i)).toBeInTheDocument();
    });

    it('shows the remaining session and daily time', async () => {
      renderApp();
      await screen.findByTestId('quota-meter');

      expect(screen.getByTestId('quota-session')).toHaveTextContent('2:00 left');
      expect(screen.getByText('10:00 today')).toBeInTheDocument();
    });
  });

  describe('language selection', () => {
    it('opens a sheet listing the available languages', async () => {
      const user = userEvent.setup();
      renderApp();
      await screen.findByTestId('mic-orb');

      await user.click(screen.getByTestId('source-chip'));

      const sheet = await screen.findByTestId('language-sheet');
      expect(within(sheet).getByText('Français')).toBeInTheDocument();
      expect(within(sheet).getByText('I am speaking')).toBeInTheDocument();
    });

    it('changes the source language when one is picked', async () => {
      const user = userEvent.setup();
      renderApp();
      await screen.findByTestId('mic-orb');

      await user.click(screen.getByTestId('source-chip'));
      const sheet = await screen.findByTestId('language-sheet');
      await user.click(within(sheet).getByText('Français'));

      await waitFor(() =>
        expect(within(screen.getByTestId('source-chip')).getByText('Français')).toBeInTheDocument(),
      );
    });

    it('filters the list as the user searches', async () => {
      const user = userEvent.setup();
      renderApp();
      await screen.findByTestId('mic-orb');

      await user.click(screen.getByTestId('target-chip'));
      const sheet = await screen.findByTestId('language-sheet');

      await user.type(within(sheet).getByTestId('language-search'), 'fran');

      expect(within(sheet).getByText('Français')).toBeInTheDocument();
      expect(within(sheet).queryByText('العربية')).not.toBeInTheDocument();
    });

    it('finds a language typed in its own script', async () => {
      const user = userEvent.setup();
      renderApp();
      await screen.findByTestId('mic-orb');

      await user.click(screen.getByTestId('target-chip'));
      const sheet = await screen.findByTestId('language-sheet');
      await user.type(within(sheet).getByTestId('language-search'), 'العربية');

      expect(within(sheet).getByText('العربية')).toBeInTheDocument();
    });

    it('prevents choosing the same language on both sides', async () => {
      const user = userEvent.setup();
      renderApp();
      await screen.findByTestId('mic-orb');

      await user.click(screen.getByTestId('target-chip'));
      const sheet = await screen.findByTestId('language-sheet');

      // Arabic is already the source, so it must be unavailable as the target.
      const arabicOption = within(sheet).getByText('العربية').closest('button')!;
      expect(arabicOption).toBeDisabled();
      expect(within(sheet).getByText('in use')).toBeInTheDocument();
    });

    it('swaps the two languages', async () => {
      const user = userEvent.setup();
      renderApp();
      await screen.findByTestId('mic-orb');

      await user.click(screen.getByTestId('swap-languages'));

      await waitFor(() =>
        expect(within(screen.getByTestId('source-chip')).getByText('English')).toBeInTheDocument(),
      );
      expect(within(screen.getByTestId('target-chip')).getByText('العربية')).toBeInTheDocument();
    });

    it('remembers the chosen languages for the next visit', async () => {
      const user = userEvent.setup();
      renderApp();
      await screen.findByTestId('mic-orb');

      await user.click(screen.getByTestId('swap-languages'));

      await waitFor(() => expect(localStorage.getItem('atl.source')).toBe('en-US'));
      expect(localStorage.getItem('atl.target')).toBe('ar-SA');
    });

    it('closes the sheet on the backdrop', async () => {
      const user = userEvent.setup();
      renderApp();
      await screen.findByTestId('mic-orb');

      await user.click(screen.getByTestId('source-chip'));
      await screen.findByTestId('language-sheet');

      await user.click(screen.getByTestId('sheet-backdrop'));

      await waitFor(() => expect(screen.queryByTestId('language-sheet')).not.toBeInTheDocument());
    });
  });

  describe('accessibility', () => {
    it('labels the mic button for screen readers', async () => {
      renderApp({ assignments: { mic_control: 'hold', onboarding: 'guided', autoplay_tts: 'autoplay', result_layout: 'stacked' } });
      await screen.findByTestId('mic-orb');

      expect(screen.getByTestId('mic-orb')).toHaveAccessibleName(/hold to speak/i);
      expect(screen.getByTestId('mic-orb')).toHaveAttribute('aria-pressed', 'false');
    });

    it('describes the language chips with their current selection', async () => {
      renderApp();
      await screen.findByTestId('mic-orb');

      expect(screen.getByTestId('source-chip')).toHaveAccessibleName(/source language: arabic/i);
      expect(screen.getByTestId('target-chip')).toHaveAccessibleName(/target language: english/i);
    });

    it('marks the language sheet as a modal dialog', async () => {
      const user = userEvent.setup();
      renderApp();
      await screen.findByTestId('mic-orb');

      await user.click(screen.getByTestId('source-chip'));

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
    });

    it('gives the notice pill a polite live region', async () => {
      renderApp();
      await screen.findByTestId('mic-orb');

      expect(screen.getByTestId('notice-pill')).toHaveAttribute('aria-live', 'polite');
    });
  });
});
