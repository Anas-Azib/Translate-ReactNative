import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExperimentProvider, useExperiments } from './experiments/ExperimentProvider';
import { ApiClient } from './services/api';
import { setupGsap } from './animations/gsapSetup';
import { TranslateScreen } from './components/screens/TranslateScreen';
import { Onboarding } from './components/screens/Onboarding';
import { Aurora } from './components/ui/Aurora';
import type { AppConfigResponse } from './types';

const ONBOARDED_KEY = 'atl.onboarded';

export interface AppProps {
  /** Injected by the integration tests; production builds construct their own. */
  api?: ApiClient;
}

export function App({ api: injectedApi }: AppProps = {}) {
  const api = useMemo(() => injectedApi ?? new ApiClient(), [injectedApi]);

  useEffect(() => {
    setupGsap();
  }, []);

  return (
    <ExperimentProvider api={api}>
      <AppShell api={api} />
    </ExperimentProvider>
  );
}

/**
 * Boot sequence: fetch config, then decide between onboarding and the main
 * screen. Onboarding is gated on the experiment *and* on whether this device
 * has seen it before, so a returning user is never shown the tour again
 * regardless of which variant they are in.
 */
function AppShell({ api }: { api: ApiClient }) {
  const { variant, track, ready } = useExperiments();
  const [config, setConfig] = useState<AppConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(() => !hasOnboarded());

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((result) => {
        if (!cancelled) setConfig(result);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const finishOnboarding = useCallback(() => {
    track('onboarding_finished');
    try {
      localStorage.setItem(ONBOARDED_KEY, '1');
    } catch {
      // Private mode — the tour will show again next launch. Acceptable.
    }
    setShowOnboarding(false);
  }, [track]);

  if (error) {
    return (
      <>
        <Aurora />
        <div className="app boot">
          <div className="boot__panel glass">
            <h1 className="boot__title">Can’t reach the server</h1>
            <p className="boot__body">{error}</p>
            <button type="button" className="boot__retry" onClick={() => window.location.reload()}>
              Try again
            </button>
          </div>
        </div>
      </>
    );
  }

  if (!config || !ready) {
    return (
      <>
        <Aurora />
        <div className="app boot">
          <div className="boot__loader" aria-label="Loading" role="status">
            <span />
            <span />
            <span />
          </div>
        </div>
      </>
    );
  }

  if (showOnboarding) {
    return (
      <>
        <Aurora />
        <Onboarding variant={variant('onboarding')} onFinish={finishOnboarding} />
      </>
    );
  }

  return <TranslateScreen api={api} config={config} />;
}

function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

export default App;
