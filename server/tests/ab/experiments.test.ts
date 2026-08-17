import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { ExperimentStore } from '../../src/experiments/store.js';
import { applyOverrides, assignAll, assignVariant } from '../../src/experiments/assignment.js';
import { EXPERIMENTS, getExperiment } from '../../src/experiments/registry.js';
import {
  compareVariants,
  normalCdf,
  rate,
  requiredSampleSize,
  twoTailedPValue,
} from '../../src/experiments/stats.js';
import { FakeClock, scriptedProviders, testConfig } from '../helpers.js';

describe('A/B — assignment', () => {
  const salt = 'test-salt';

  it('is deterministic: the same user always gets the same variant', () => {
    const experiment = getExperiment('mic_control')!;
    const first = assignVariant(experiment, 'user-42', salt);

    for (let i = 0; i < 50; i += 1) {
      expect(assignVariant(experiment, 'user-42', salt)).toBe(first);
    }
  });

  it('only ever returns a declared variant', () => {
    const experiment = getExperiment('mic_control')!;
    const allowed = new Set(experiment.variants.map((v) => v.key));

    for (let i = 0; i < 500; i += 1) {
      expect(allowed.has(assignVariant(experiment, `user-${i}`, salt))).toBe(true);
    }
  });

  it('splits an even-weighted experiment close to 50/50', () => {
    const experiment = getExperiment('mic_control')!;
    let hold = 0;
    const n = 10_000;

    for (let i = 0; i < n; i += 1) {
      if (assignVariant(experiment, `user-${i}`, salt) === 'hold') hold += 1;
    }

    // ±3% is well inside the noise for n=10k.
    expect(hold / n).toBeGreaterThan(0.47);
    expect(hold / n).toBeLessThan(0.53);
  });

  it('respects unequal weights', () => {
    const experiment = {
      key: 'weighted',
      description: 'test',
      primaryMetric: 'translation_completed' as const,
      enabled: true,
      variants: [
        { key: 'control', label: 'c', weight: 9 },
        { key: 'treatment', label: 't', weight: 1 },
      ],
    };

    let treatment = 0;
    for (let i = 0; i < 10_000; i += 1) {
      if (assignVariant(experiment, `user-${i}`, salt) === 'treatment') treatment += 1;
    }

    expect(treatment / 10_000).toBeGreaterThan(0.08);
    expect(treatment / 10_000).toBeLessThan(0.12);
  });

  it('assigns experiments independently of one another', () => {
    // If the experiment key were left out of the hash, a user in variant A of
    // one experiment would always be in variant A of the next.
    let sameBucket = 0;
    const n = 4000;

    for (let i = 0; i < n; i += 1) {
      const assignments = assignAll(`user-${i}`, salt);
      const micIsControl = assignments.mic_control === 'hold';
      const layoutIsControl = assignments.result_layout === 'stacked';
      if (micIsControl === layoutIsControl) sameBucket += 1;
    }

    // Independent experiments agree ~50% of the time; correlated ones ~100%.
    expect(sameBucket / n).toBeGreaterThan(0.46);
    expect(sameBucket / n).toBeLessThan(0.54);
  });

  it('changes the split when the salt changes, so a rerun is a fresh experiment', () => {
    const experiment = getExperiment('mic_control')!;
    let differences = 0;

    for (let i = 0; i < 1000; i += 1) {
      if (assignVariant(experiment, `user-${i}`, 'salt-a') !== assignVariant(experiment, `user-${i}`, 'salt-b')) {
        differences += 1;
      }
    }

    expect(differences).toBeGreaterThan(400);
  });

  it('pins every user to the control when an experiment is disabled', () => {
    const experiment = { ...getExperiment('mic_control')!, enabled: false };

    for (let i = 0; i < 100; i += 1) {
      expect(assignVariant(experiment, `user-${i}`, salt)).toBe('hold');
    }
  });

  it('covers every registered experiment in assignAll', () => {
    const assignments = assignAll('user-1', salt);
    expect(Object.keys(assignments).sort()).toEqual(EXPERIMENTS.map((e) => e.key).sort());
  });

  describe('overrides', () => {
    it('applies a valid override', () => {
      const base = assignAll('user-1', salt);
      const result = applyOverrides(base, { ab_mic_control: 'tap' });
      expect(result.mic_control).toBe('tap');
    });

    it('ignores an override naming a variant that does not exist', () => {
      const base = assignAll('user-1', salt);
      const result = applyOverrides(base, { ab_mic_control: 'telepathy' });
      expect(result.mic_control).toBe(base.mic_control);
    });

    it('leaves other experiments untouched', () => {
      const base = assignAll('user-1', salt);
      const result = applyOverrides(base, { ab_mic_control: 'tap' });
      expect(result.result_layout).toBe(base.result_layout);
    });
  });
});

describe('A/B — statistics', () => {
  describe('normalCdf', () => {
    it('is 0.5 at the mean', () => {
      expect(normalCdf(0)).toBeCloseTo(0.5, 5);
    });

    it('matches known z-table values', () => {
      expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
      expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
      expect(normalCdf(1)).toBeCloseTo(0.8413, 3);
    });
  });

  describe('twoTailedPValue', () => {
    it('returns ~0.05 at z = 1.96', () => {
      expect(twoTailedPValue(1.96)).toBeCloseTo(0.05, 3);
    });

    it('is symmetric in the sign of z', () => {
      expect(twoTailedPValue(2.3)).toBeCloseTo(twoTailedPValue(-2.3), 10);
    });

    it('returns ~1 for no difference', () => {
      expect(twoTailedPValue(0)).toBeCloseTo(1, 5);
    });
  });

  describe('compareVariants', () => {
    it('detects a large, real improvement', () => {
      const result = compareVariants(
        { variant: 'hold', exposures: 1000, conversions: 400 },
        { variant: 'tap', exposures: 1000, conversions: 520 },
      );

      expect(result.significant).toBe(true);
      expect(result.verdict).toBe('treatment_wins');
      expect(result.absoluteUplift).toBeCloseTo(0.12, 5);
      expect(result.relativeUplift).toBeCloseTo(0.3, 5);
      expect(result.pValue).toBeLessThan(0.001);
    });

    it('calls a small difference inconclusive rather than a win', () => {
      const result = compareVariants(
        { variant: 'hold', exposures: 1000, conversions: 500 },
        { variant: 'tap', exposures: 1000, conversions: 510 },
      );

      expect(result.significant).toBe(false);
      expect(result.verdict).toBe('inconclusive');
      expect(result.pValue).toBeGreaterThan(0.05);
    });

    it('detects a significant regression', () => {
      const result = compareVariants(
        { variant: 'hold', exposures: 800, conversions: 480 },
        { variant: 'tap', exposures: 800, conversions: 360 },
      );

      expect(result.verdict).toBe('control_wins');
      expect(result.absoluteUplift).toBeLessThan(0);
    });

    it('refuses to call a winner on a tiny sample, however lopsided', () => {
      // 100% vs 0% — but on five users per arm it means nothing.
      const result = compareVariants(
        { variant: 'a', exposures: 5, conversions: 0 },
        { variant: 'b', exposures: 5, conversions: 5 },
      );

      expect(result.verdict).toBe('insufficient_data');
      expect(result.significant).toBe(false);
    });

    it('produces a confidence interval that brackets the observed difference', () => {
      const result = compareVariants(
        { variant: 'a', exposures: 1000, conversions: 400 },
        { variant: 'b', exposures: 1000, conversions: 500 },
      );

      const [low, high] = result.confidenceInterval;
      expect(low).toBeLessThan(result.absoluteUplift);
      expect(high).toBeGreaterThan(result.absoluteUplift);
      // A significant result's interval must exclude zero.
      expect(low).toBeGreaterThan(0);
    });

    it('produces an interval containing zero for a null result', () => {
      const result = compareVariants(
        { variant: 'a', exposures: 500, conversions: 250 },
        { variant: 'b', exposures: 500, conversions: 252 },
      );

      const [low, high] = result.confidenceInterval;
      expect(low).toBeLessThan(0);
      expect(high).toBeGreaterThan(0);
    });

    it('handles empty arms without dividing by zero', () => {
      const result = compareVariants(
        { variant: 'a', exposures: 0, conversions: 0 },
        { variant: 'b', exposures: 0, conversions: 0 },
      );

      expect(Number.isFinite(result.zScore)).toBe(true);
      expect(result.pValue).toBe(1);
      expect(result.verdict).toBe('insufficient_data');
    });
  });

  describe('requiredSampleSize', () => {
    it('demands more users for a smaller effect', () => {
      expect(requiredSampleSize(0.4, 0.02)).toBeGreaterThan(requiredSampleSize(0.4, 0.1));
    });

    it('lands in the right ballpark for a standard test', () => {
      // 40% baseline, +10pp MDE at 80% power ≈ 380–400 per arm.
      const n = requiredSampleSize(0.4, 0.1);
      expect(n).toBeGreaterThan(300);
      expect(n).toBeLessThan(450);
    });

    it('is infinite for a zero effect', () => {
      expect(requiredSampleSize(0.4, 0)).toBe(Infinity);
    });
  });

  describe('rate', () => {
    it('is zero rather than NaN with no exposures', () => {
      expect(rate(0, 0)).toBe(0);
    });
  });
});

describe('A/B — event store', () => {
  let store: ExperimentStore;

  beforeEach(() => {
    store = new ExperimentStore({ clock: new FakeClock() });
  });

  it('counts a user once per experiment no matter how many events they fire', () => {
    for (let i = 0; i < 10; i += 1) {
      store.recordEvent({
        userId: 'user-1',
        experiment: 'mic_control',
        variant: 'hold',
        metric: 'translation_completed',
      });
    }

    expect(store.exposures('mic_control', 'hold')).toBe(1);
    expect(store.conversions('mic_control', 'translation_completed', 'hold')).toBe(1);
  });

  it('keeps a user in their first variant even if a later event disagrees', () => {
    // Guards against a client that reloads into a different bucket polluting both arms.
    store.recordExposure('mic_control', 'hold', 'user-1');
    store.recordExposure('mic_control', 'tap', 'user-1');

    expect(store.exposures('mic_control', 'hold')).toBe(1);
    expect(store.exposures('mic_control', 'tap')).toBe(0);
  });

  it('counts distinct users separately', () => {
    store.recordEvent({ userId: 'a', experiment: 'mic_control', variant: 'hold', metric: 'translation_completed' });
    store.recordEvent({ userId: 'b', experiment: 'mic_control', variant: 'hold', metric: 'translation_completed' });

    expect(store.conversions('mic_control', 'translation_completed', 'hold')).toBe(2);
  });

  it('sums numeric values alongside the conversion count', () => {
    store.recordEvent({
      userId: 'a',
      experiment: 'autoplay_tts',
      variant: 'autoplay',
      metric: 'tts_played',
      value: 120,
    });
    store.recordEvent({
      userId: 'b',
      experiment: 'autoplay_tts',
      variant: 'autoplay',
      metric: 'tts_played',
      value: 80,
    });

    const report = store.report('autoplay_tts')!;
    const metric = report.metrics.find((m) => m.metric === 'tts_played')!;
    expect(metric.variants.find((v) => v.variant === 'autoplay')!.valueSum).toBe(200);
  });

  it('builds a report with a comparison of control against treatment', () => {
    for (let i = 0; i < 200; i += 1) {
      store.recordExposure('mic_control', 'hold', `hold-${i}`);
      store.recordExposure('mic_control', 'tap', `tap-${i}`);
    }
    for (let i = 0; i < 80; i += 1) {
      store.recordEvent({
        userId: `hold-${i}`,
        experiment: 'mic_control',
        variant: 'hold',
        metric: 'first_translation_completed',
      });
    }
    for (let i = 0; i < 130; i += 1) {
      store.recordEvent({
        userId: `tap-${i}`,
        experiment: 'mic_control',
        variant: 'tap',
        metric: 'first_translation_completed',
      });
    }

    const report = store.report('mic_control')!;
    const primary = report.metrics.find((m) => m.metric === 'first_translation_completed')!;

    expect(report.totalExposures).toBe(400);
    expect(primary.comparison!.control.conversionRate).toBeCloseTo(0.4);
    expect(primary.comparison!.treatment.conversionRate).toBeCloseTo(0.65);
    expect(primary.comparison!.verdict).toBe('treatment_wins');
  });

  it('returns null for an unknown experiment', () => {
    expect(store.report('does_not_exist')).toBeNull();
  });

  it('reports every registered experiment', () => {
    expect(store.reportAll()).toHaveLength(EXPERIMENTS.length);
  });

  it('caps the retained event log so memory stays bounded', () => {
    const bounded = new ExperimentStore({ clock: new FakeClock(), maxEvents: 5 });
    for (let i = 0; i < 20; i += 1) {
      bounded.recordEvent({
        userId: `u-${i}`,
        experiment: 'mic_control',
        variant: 'hold',
        metric: 'translation_completed',
      });
    }

    expect(bounded.eventCount).toBe(5);
    // Aggregates survive even though raw events were dropped.
    expect(bounded.conversions('mic_control', 'translation_completed', 'hold')).toBe(20);
  });
});

describe('A/B — HTTP endpoints', () => {
  const config = testConfig();
  let app: Express;
  let experiments: ExperimentStore;

  beforeEach(() => {
    const clock = new FakeClock();
    experiments = new ExperimentStore({ clock });
    app = createApp({ config, clock, providers: scriptedProviders(), experiments }).app;
  });

  it('returns an assignment for every experiment and records the exposure', async () => {
    const response = await request(app)
      .get('/api/ab/assignments')
      .set('x-device-id', 'device-ab-000001')
      .expect(200);

    expect(Object.keys(response.body.assignments).sort()).toEqual(EXPERIMENTS.map((e) => e.key).sort());
    expect(experiments.reportAll().reduce((sum, r) => sum + r.totalExposures, 0)).toBe(EXPERIMENTS.length);
  });

  it('gives the same device the same assignment across requests', async () => {
    const first = await request(app).get('/api/ab/assignments').set('x-device-id', 'device-stable-01').expect(200);
    const second = await request(app).get('/api/ab/assignments').set('x-device-id', 'device-stable-01').expect(200);

    expect(second.body.assignments).toEqual(first.body.assignments);
  });

  it('honours a query-string override', async () => {
    const response = await request(app)
      .get('/api/ab/assignments?ab_mic_control=tap')
      .set('x-device-id', 'device-override-1')
      .expect(200);

    expect(response.body.assignments.mic_control).toBe('tap');
  });

  it('accepts a batch of conversion events', async () => {
    const response = await request(app)
      .post('/api/ab/event')
      .set('x-device-id', 'device-events-001')
      .send({
        events: [
          { experiment: 'mic_control', variant: 'tap', metric: 'session_started' },
          { experiment: 'mic_control', variant: 'tap', metric: 'first_translation_completed' },
        ],
      })
      .expect(202);

    expect(response.body.recorded).toBe(2);
    expect(experiments.conversions('mic_control', 'first_translation_completed', 'tap')).toBe(1);
  });

  it('accepts a single event posted on its own', async () => {
    await request(app)
      .post('/api/ab/event')
      .set('x-device-id', 'device-single-0001')
      .send({ experiment: 'onboarding', variant: 'guided', metric: 'onboarding_finished' })
      .expect(202);

    expect(experiments.conversions('onboarding', 'onboarding_finished', 'guided')).toBe(1);
  });

  it('rejects an unknown metric rather than recording a typo', async () => {
    await request(app)
      .post('/api/ab/event')
      .set('x-device-id', 'device-bad-000001')
      .send({ experiment: 'mic_control', variant: 'tap', metric: 'made_up_metric' })
      .expect(400);
  });

  it('serves a full report with comparisons', async () => {
    for (let i = 0; i < 40; i += 1) {
      await request(app)
        .post('/api/ab/event')
        .set('x-device-id', `device-report-${String(i).padStart(4, '0')}`)
        .send({
          experiment: 'mic_control',
          variant: i % 2 === 0 ? 'hold' : 'tap',
          metric: 'translation_completed',
        })
        .expect(202);
    }

    const response = await request(app).get('/api/ab/report/mic_control').expect(200);

    expect(response.body.report.experiment).toBe('mic_control');
    expect(response.body.report.totalExposures).toBe(40);
    expect(response.body.report.metrics.length).toBeGreaterThan(0);
  });

  it('404s a report for an unknown experiment', async () => {
    await request(app).get('/api/ab/report/nope').expect(404);
  });
});
