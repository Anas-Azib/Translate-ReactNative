import { describe, expect, it } from 'vitest';
import {
  VoiceActivityDetector,
  computeRms,
  levelFromRms,
} from '../../src/services/vad';
import type { VadEvent } from '../../src/services/vad';

/**
 * The VAD is what stops silence from reaching Azure and Google (plan doc p.4).
 * These tests drive it with a scripted amplitude envelope — a stand-in for a
 * real microphone that is fully deterministic.
 */
describe('VoiceActivityDetector', () => {
  const LOUD = 0.2;
  const QUIET = 0.005;

  /** Feeds `level` for `ms` at 60 fps and returns every non-empty event. */
  function feed(vad: VoiceActivityDetector, level: number, ms: number, startAt: number): {
    events: VadEvent[];
    endTime: number;
  } {
    const events: VadEvent[] = [];
    const step = 1000 / 60;
    let t = startAt;
    for (; t < startAt + ms; t += step) {
      const event = vad.push(level, t);
      if (event.type !== 'none') events.push(event);
    }
    return { events, endTime: t };
  }

  it('starts in silence', () => {
    const vad = new VoiceActivityDetector();
    vad.reset(0);
    expect(vad.state).toBe('silence');
  });

  it('ignores a brief transient — a cough is not a sentence', () => {
    const vad = new VoiceActivityDetector({ minSpeechMs: 220 });
    vad.reset(0);

    const loud = feed(vad, LOUD, 100, 0); // under the 220ms floor
    const quiet = feed(vad, QUIET, 300, loud.endTime);

    expect([...loud.events, ...quiet.events].filter((e) => e.type === 'speech_start')).toHaveLength(0);
    expect(vad.state).toBe('silence');
  });

  it('opens a segment once speech is sustained', () => {
    const vad = new VoiceActivityDetector({ minSpeechMs: 220 });
    vad.reset(0);

    const { events } = feed(vad, LOUD, 500, 0);

    expect(events.filter((e) => e.type === 'speech_start')).toHaveLength(1);
    expect(vad.state).toBe('speech');
  });

  it('closes the segment after the trailing-silence hangover', () => {
    const vad = new VoiceActivityDetector({ minSpeechMs: 200, hangoverMs: 800 });
    vad.reset(0);

    const speech = feed(vad, LOUD, 1500, 0);
    const silence = feed(vad, QUIET, 900, speech.endTime);

    const ends = silence.events.filter((e) => e.type === 'speech_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ reason: 'silence' });
  });

  it('does not close on a short pause between words', () => {
    const vad = new VoiceActivityDetector({ minSpeechMs: 200, hangoverMs: 800 });
    vad.reset(0);

    let t = feed(vad, LOUD, 600, 0).endTime;
    const pause = feed(vad, QUIET, 300, t); // shorter than the hangover
    t = pause.endTime;
    const resumed = feed(vad, LOUD, 600, t);

    expect([...pause.events, ...resumed.events].filter((e) => e.type === 'speech_end')).toHaveLength(0);
    expect(vad.state).toBe('speech');
  });

  it('excludes the trailing silence from the reported duration', () => {
    const vad = new VoiceActivityDetector({ minSpeechMs: 200, hangoverMs: 800 });
    vad.reset(0);

    const speech = feed(vad, LOUD, 2000, 0);
    const silence = feed(vad, QUIET, 900, speech.endTime);

    const end = silence.events.find((e) => e.type === 'speech_end');
    expect(end).toBeDefined();
    if (end?.type !== 'speech_end') return;

    // ~2000ms of speech, and the 800ms hangover must not be billed.
    expect(end.durationMs).toBeGreaterThan(1800);
    expect(end.durationMs).toBeLessThan(2200);
  });

  it('cuts a long monologue at the maximum segment length', () => {
    const vad = new VoiceActivityDetector({ minSpeechMs: 200, maxSegmentMs: 3000 });
    vad.reset(0);

    const { events } = feed(vad, LOUD, 4000, 0);

    const ends = events.filter((e) => e.type === 'speech_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ reason: 'max_length' });
  });

  it('reports an idle timeout so the caller can shut the mic off', () => {
    const vad = new VoiceActivityDetector({ idleTimeoutMs: 2000 });
    vad.reset(0);

    const { events } = feed(vad, QUIET, 2500, 0);

    expect(events.filter((e) => e.type === 'idle_timeout')).toHaveLength(1);
  });

  it('reports the idle timeout only once, not on every frame after', () => {
    const vad = new VoiceActivityDetector({ idleTimeoutMs: 1000 });
    vad.reset(0);

    const { events } = feed(vad, QUIET, 5000, 0);

    expect(events.filter((e) => e.type === 'idle_timeout')).toHaveLength(1);
  });

  it('uses hysteresis so a voice near the threshold does not fragment', () => {
    // Between the two thresholds: neither clearly speech nor clearly silence.
    const vad = new VoiceActivityDetector({
      speechThreshold: 0.05,
      silenceThreshold: 0.02,
      minSpeechMs: 200,
      hangoverMs: 500,
    });
    vad.reset(0);

    let t = feed(vad, 0.2, 500, 0).endTime;
    // Hovering in the dead band must keep the segment open.
    const marginal = feed(vad, 0.035, 1000, t);

    expect(marginal.events.filter((e) => e.type === 'speech_end')).toHaveLength(0);
    expect(vad.state).toBe('speech');
  });

  it('handles several utterances in a row', () => {
    const vad = new VoiceActivityDetector({ minSpeechMs: 200, hangoverMs: 600 });
    vad.reset(0);

    let t = 0;
    const all: VadEvent[] = [];
    for (let i = 0; i < 3; i += 1) {
      const speech = feed(vad, LOUD, 800, t);
      const silence = feed(vad, QUIET, 700, speech.endTime);
      all.push(...speech.events, ...silence.events);
      t = silence.endTime;
    }

    expect(all.filter((e) => e.type === 'speech_start')).toHaveLength(3);
    expect(all.filter((e) => e.type === 'speech_end')).toHaveLength(3);
  });

  it('resets cleanly for a new session', () => {
    const vad = new VoiceActivityDetector();
    vad.reset(0);
    feed(vad, LOUD, 500, 0);
    expect(vad.state).toBe('speech');

    vad.reset(0);
    expect(vad.state).toBe('silence');
  });

  it('exposes the options it is running with', () => {
    const vad = new VoiceActivityDetector({ hangoverMs: 1234 });
    expect(vad.options.hangoverMs).toBe(1234);
    expect(vad.options.speechThreshold).toBeGreaterThan(vad.options.silenceThreshold);
  });
});

describe('computeRms', () => {
  it('is 0 for silence', () => {
    expect(computeRms(new Float32Array(512))).toBe(0);
  });

  it('is 0 for an empty frame', () => {
    expect(computeRms(new Float32Array(0))).toBe(0);
  });

  it('equals the amplitude for a constant signal', () => {
    expect(computeRms(new Float32Array(128).fill(0.5))).toBeCloseTo(0.5, 6);
  });

  it('is amplitude/√2 for a sine wave', () => {
    const samples = new Float32Array(1024);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * i) / 64);
    }
    expect(computeRms(samples)).toBeCloseTo(1 / Math.SQRT2, 2);
  });

  it('ignores sign — negative swings count as loudness', () => {
    expect(computeRms(new Float32Array([-0.5, -0.5]))).toBeCloseTo(0.5, 6);
  });
});

describe('levelFromRms', () => {
  it('is 0 at digital silence', () => {
    expect(levelFromRms(0)).toBe(0);
  });

  it('is 1 at full scale', () => {
    expect(levelFromRms(1)).toBeCloseTo(1, 5);
  });

  it('is 0 below the noise floor', () => {
    expect(levelFromRms(0.0001, -60)).toBe(0);
  });

  it('puts normal speech in the visible middle of the range', () => {
    // ~-26 dBFS is a comfortable speaking level; a linear meter would show ~5%.
    const level = levelFromRms(0.05);
    expect(level).toBeGreaterThan(0.4);
    expect(level).toBeLessThan(0.7);
  });

  it('increases monotonically', () => {
    let previous = 0;
    for (const rms of [0.001, 0.01, 0.05, 0.2, 0.5, 1]) {
      const level = levelFromRms(rms);
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });
});
