import { describe, expect, it } from 'vitest';
import {
  AudioDecodeError,
  WHISPER_SAMPLE_RATE,
  decodeForWhisper,
  decodeWav,
  peakWindowRms,
  resample,
  rms,
} from '../../src/lib/audio.js';
import { silentWav, wavFixture, wrapWav } from '../helpers.js';

/**
 * Whisper takes mono 16 kHz float PCM and nothing else. This module is the only
 * thing standing between an uploaded WAV and the model, so a bug here is silent
 * garbage in the transcript rather than a visible error.
 */
describe('decodeWav', () => {
  it('decodes a mono 16-bit WAV', () => {
    const decoded = decodeWav(wavFixture({ seconds: 1 }));

    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.channels).toBe(1);
    expect(decoded.samples.length).toBe(16_000);
    expect(decoded.durationSeconds).toBeCloseTo(1, 3);
  });

  it('produces samples inside the normalised float range', () => {
    const { samples } = decodeWav(wavFixture());
    for (const sample of samples) {
      expect(sample).toBeGreaterThanOrEqual(-1);
      expect(sample).toBeLessThanOrEqual(1);
    }
  });

  it('round-trips a known PCM value', () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(16_384, 0); // half of full scale
    pcm.writeInt16LE(-16_384, 2);

    const { samples } = decodeWav(wrapWav(pcm, 16_000));

    expect(samples[0]).toBeCloseTo(0.5, 3);
    expect(samples[1]).toBeCloseTo(-0.5, 3);
  });

  it('downmixes stereo by averaging rather than summing', () => {
    // Summing would double the amplitude and clip on any loud passage.
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(16_384, 0); // left
    pcm.writeInt16LE(16_384, 2); // right
    const wav = wrapWav(pcm, 16_000, 2);

    const { samples, channels } = decodeWav(wav);

    expect(channels).toBe(2);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toBeCloseTo(0.5, 3);
  });

  it('walks the chunk list instead of assuming a 44-byte header', () => {
    // Many encoders insert a LIST chunk before `data`. Reading from a fixed
    // offset would decode that metadata as audio.
    const base = wavFixture({ seconds: 0.5 });
    const listChunk = Buffer.alloc(8 + 10);
    listChunk.write('LIST', 0);
    listChunk.writeUInt32LE(10, 4);
    listChunk.write('INFOhello', 8);

    const withList = Buffer.concat([base.subarray(0, 36), listChunk, base.subarray(36)]);
    withList.writeUInt32LE(withList.length - 8, 4); // fix RIFF size

    const decoded = decodeWav(withList);

    expect(decoded.samples.length).toBe(8_000);
    expect(decoded.sampleRate).toBe(16_000);
  });

  it('rejects a payload that is not a WAV', () => {
    expect(() => decodeWav(Buffer.from('this is definitely not audio data at all'))).toThrow(AudioDecodeError);
  });

  it('rejects a truncated file', () => {
    expect(() => decodeWav(Buffer.alloc(10))).toThrow(AudioDecodeError);
  });

  it('rejects a WAV with no data chunk', () => {
    const headerOnly = wrapWav(Buffer.alloc(0), 16_000).subarray(0, 36);
    expect(() => decodeWav(headerOnly)).toThrow(AudioDecodeError);
  });
});

describe('decodeForWhisper', () => {
  it('passes 16 kHz audio through untouched', () => {
    const decoded = decodeForWhisper(wavFixture({ seconds: 1 }));

    expect(decoded.sampleRate).toBe(WHISPER_SAMPLE_RATE);
    expect(decoded.samples.length).toBe(16_000);
  });

  it('resamples 48 kHz down to 16 kHz', () => {
    const decoded = decodeForWhisper(wavFixture({ seconds: 1, sampleRate: 48_000 }));

    expect(decoded.sampleRate).toBe(WHISPER_SAMPLE_RATE);
    expect(decoded.samples.length).toBeCloseTo(16_000, -2);
    expect(decoded.durationSeconds).toBeCloseTo(1, 1);
  });

  it('resamples 44.1 kHz, the other common capture rate', () => {
    const decoded = decodeForWhisper(wavFixture({ seconds: 1, sampleRate: 44_100 }));

    expect(decoded.sampleRate).toBe(WHISPER_SAMPLE_RATE);
    expect(decoded.samples.length).toBeCloseTo(16_000, -2);
  });

  it('preserves signal energy through the resample', () => {
    const original = decodeWav(wavFixture({ seconds: 1, sampleRate: 48_000 }));
    const resampled = decodeForWhisper(wavFixture({ seconds: 1, sampleRate: 48_000 }));

    // Resampling must not swallow the audio — a silent result would look like
    // a working pipeline that never recognises anything.
    expect(rms(resampled.samples)).toBeCloseTo(rms(original.samples), 1);
  });
});

describe('resample', () => {
  it('returns the input untouched when rates match', () => {
    const samples = new Float32Array([0.1, 0.2, 0.3]);
    expect(resample(samples, 16_000, 16_000)).toBe(samples);
  });

  it('halves the length when halving the rate', () => {
    const samples = new Float32Array(1000).fill(0.5);
    expect(resample(samples, 32_000, 16_000)).toHaveLength(500);
  });

  it('handles an empty buffer', () => {
    expect(resample(new Float32Array(0), 48_000, 16_000)).toHaveLength(0);
  });
});

describe('rms', () => {
  it('is 0 for silence', () => {
    expect(rms(new Float32Array(100))).toBe(0);
  });

  it('is 0 for an empty frame', () => {
    expect(rms(new Float32Array(0))).toBe(0);
  });

  it('equals the amplitude of a constant signal', () => {
    expect(rms(new Float32Array(10).fill(0.5))).toBeCloseTo(0.5, 6);
  });
});

describe('peakWindowRms', () => {
  /**
   * This is the gate that stops Whisper hallucinating on silence, so it has to
   * find a short word inside a mostly-quiet clip. Whole-clip RMS averages that
   * word away.
   */
  it('is 0 for a silent clip', () => {
    const { samples } = decodeWav(silentWav(1));
    expect(peakWindowRms(samples, 16_000)).toBe(0);
  });

  it('finds a brief loud word buried in silence', () => {
    const samples = new Float32Array(16_000); // 1 second of silence
    // 150 ms of speech-level signal in the middle.
    for (let i = 8_000; i < 10_400; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 200 * i) / 16_000) * 0.4;
    }

    const wholeClip = rms(samples);
    const peak = peakWindowRms(samples, 16_000);

    expect(peak).toBeGreaterThan(0.2);
    // The averaged measure is far quieter — which is exactly why it is wrong
    // for this job.
    expect(wholeClip).toBeLessThan(peak / 2);
  });

  it('falls back to whole-clip RMS for a clip shorter than one window', () => {
    const samples = new Float32Array(200).fill(0.3);
    expect(peakWindowRms(samples, 16_000)).toBeCloseTo(0.3, 3);
  });

  it('rates real speech above the silence threshold used in production', () => {
    const { samples } = decodeWav(wavFixture({ amplitude: 0.3 }));
    expect(peakWindowRms(samples, 16_000)).toBeGreaterThan(0.006);
  });
});
