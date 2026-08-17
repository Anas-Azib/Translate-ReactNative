import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiClient } from '../services/api';
import type { ExperimentKey, MetricKey, VariantOf } from './registry';
import { DEFAULT_ASSIGNMENTS, EXPERIMENT_KEYS, localAssign } from './registry';

interface ExperimentContextValue {
  ready: boolean;
  assignments: Record<string, string>;
  variant: <K extends ExperimentKey>(key: K) => VariantOf<K>;
  track: (metric: MetricKey, options?: { experiment?: ExperimentKey; value?: number }) => void;
  flush: () => void;
}

const ExperimentContext = createContext<ExperimentContextValue | null>(null);

/** Query-string overrides so a variant can be demoed on demand: `?ab_mic_control=tap`. */
function readOverrides(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  const overrides: Record<string, string> = {};
  for (const key of EXPERIMENT_KEYS) {
    const value = params.get(`ab_${key}`);
    if (value) overrides[`ab_${key}`] = value;
  }
  return overrides;
}

/**
 * Supplies variant assignments and collects conversions.
 *
 * Events are batched and flushed on an interval and on page-hide rather than
 * posted individually: a translation session fires several metrics in quick
 * succession, and one request per metric would compete with the audio upload
 * for bandwidth on a phone.
 */
export function ExperimentProvider({
  api,
  children,
  // Short enough that a conversion is durable within a couple of seconds of
  // happening — mobile sessions end abruptly — but long enough that a burst of
  // metrics from one translation still leaves as a single request.
  flushIntervalMs = 1500,
}: {
  api: ApiClient;
  children: ReactNode;
  flushIntervalMs?: number;
}) {
  const [assignments, setAssignments] = useState<Record<string, string>>(() => {
    const salt = 'auto-transliteration-v1';
    return Object.fromEntries(
      EXPERIMENT_KEYS.map((key) => [key, localAssign(api.deviceId, key, salt)]),
    );
  });
  const [ready, setReady] = useState(false);

  const queue = useRef<Array<{ experiment: string; variant: string; metric: string; value?: number }>>([]);
  const assignmentsRef = useRef(assignments);
  assignmentsRef.current = assignments;

  useEffect(() => {
    let cancelled = false;
    const overrides = readOverrides(typeof window === 'undefined' ? '' : window.location.search);

    api
      .getAssignments(overrides)
      .then((result) => {
        if (cancelled) return;
        if (result.enabled) setAssignments((prev) => ({ ...prev, ...result.assignments }));
        setReady(true);
      })
      .catch(() => {
        // Offline: keep the local fallback rather than blocking the UI.
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [api]);

  const flush = useCallback(() => {
    if (queue.current.length === 0) return;
    const batch = queue.current.splice(0, queue.current.length);
    api.trackEvents(batch);
  }, [api]);

  useEffect(() => {
    const timer = setInterval(flush, flushIntervalMs);
    // Backgrounding a tab on mobile often means it will be killed — flush now.
    const onHide = () => flush();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      flush();
    };
  }, [flush, flushIntervalMs]);

  const variant = useCallback(<K extends ExperimentKey>(key: K): VariantOf<K> => {
    return (assignmentsRef.current[key] ?? DEFAULT_ASSIGNMENTS[key]) as VariantOf<K>;
  }, []);

  const track = useCallback(
    (metric: MetricKey, options: { experiment?: ExperimentKey; value?: number } = {}) => {
      // A metric with no named experiment is attributed to every running one —
      // that is how a shared funnel step ("completed a translation") can be read
      // from whichever experiment you are analysing.
      const targets = options.experiment ? [options.experiment] : EXPERIMENT_KEYS;
      for (const key of targets) {
        queue.current.push({
          experiment: key,
          variant: assignmentsRef.current[key] ?? DEFAULT_ASSIGNMENTS[key],
          metric,
          ...(options.value !== undefined ? { value: options.value } : {}),
        });
      }
    },
    [],
  );

  const value = useMemo<ExperimentContextValue>(
    () => ({ ready, assignments, variant, track, flush }),
    [ready, assignments, variant, track, flush],
  );

  return <ExperimentContext.Provider value={value}>{children}</ExperimentContext.Provider>;
}

export function useExperiments(): ExperimentContextValue {
  const context = useContext(ExperimentContext);
  if (!context) throw new Error('useExperiments must be used inside <ExperimentProvider>');
  return context;
}
