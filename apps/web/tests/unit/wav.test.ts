import { describe, expect, it } from 'vitest';
import { TARGET_SAMPLE_RATE, downsample, durationOf, encodeWav, mergeChunks } from '../../src/services/wav';

/**
 * The client produces exactly the format Whisper consumes — mono 16 kHz PCM —
 * so the server never has to transcode. A bug here means the model receives
 * malformed or aliased audio and quietly transcribes nonsense.
 */

/** Reads a WAV Blob back into its header fields and samples. */
async function parseWav(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...new Uint8Array(buffer, offset, length));

  const dataLength = view.getUint32(40, true);
  const samples = new Int16Array(dataLength / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(44 + i * 2, true);

  return {
    riff: ascii(0, 4),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataChunk: ascii(36, 4),
    dataLength,
    samples,
    totalBytes: buffer.byteLength,
  };
}

describe('encodeWav', () => {
  it('writes a valid mono 16-bit PCM header', async () => {
    const wav = await parseWav(encodeWav(new Float32Array(1000), TARGET_SAMPLE_RATE));

    expect(wav.riff).toBe('RIFF');
    expect(wav.wave).toBe('WAVE');
    expect(wav.fmt).toBe('fmt ');
    expect(wav.dataChunk).toBe('data');
    expect(wav.format).toBe(1); // PCM
    expect(wav.channels).toBe(1);
    expect(wav.sampleRate).toBe(16_000);
    expect(wav.bitsPerSample).toBe(16);
  });

  it('writes consistent byte rate and block align', async () => {
    const wav = await parseWav(encodeWav(new Float32Array(100), 16_000));

    expect(wav.blockAlign).toBe(2); // 1 channel × 16 bits
    expect(wav.byteRate).toBe(16_000 * 2);
  });

  it('sizes the file as header plus two bytes per sample', async () => {
    const wav = await parseWav(encodeWav(new Float32Array(500), 16_000));

    expect(wav.dataLength).toBe(1000);
    expect(wav.totalBytes).toBe(44 + 1000);
  });

  it('round-trips sample values', async () => {
    const wav = await parseWav(encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16_000));

    expect(wav.samples[0]).toBe(0);
    expect(wav.samples[1]).toBeCloseTo(0.5 * 0x7fff, -1);
    expect(wav.samples[2]).toBeCloseTo(-0.5 * 0x8000, -1);
    expect(wav.samples[3]).toBe(0x7fff);
    expect(wav.samples[4]).toBe(-0x8000);
  });

  it('clamps out-of-range samples instead of letting them wrap', async () => {
    // Without the clamp, 1.5 would overflow Int16 and wrap to a loud negative
    // value — an audible click, and a spike that skews the energy gate.
    const wav = await parseWav(encodeWav(new Float32Array([1.5, -1.5]), 16_000));

    expect(wav.samples[0]).toBe(0x7fff);
    expect(wav.samples[1]).toBe(-0x8000);
  });

  it('produces a blob typed as audio/wav', () => {
    expect(encodeWav(new Float32Array(10), 16_000).type).toBe('audio/wav');
  });

  it('handles an empty buffer without producing a malformed file', async () => {
    const wav = await parseWav(encodeWav(new Float32Array(0), 16_000));

    expect(wav.riff).toBe('RIFF');
    expect(wav.dataLength).toBe(0);
  });
});

describe('downsample', () => {
  it('returns the input untouched when rates already match', () => {
    const samples = new Float32Array([0.1, 0.2]);
    expect(downsample(samples, 16_000, 16_000)).toBe(samples);
  });

  it('reduces 48 kHz to a third of the samples', () => {
    expect(downsample(new Float32Array(4800), 48_000, 16_000)).toHaveLength(1600);
  });

  it('handles 44.1 kHz, the other common capture rate', () => {
    const out = downsample(new Float32Array(44_100), 44_100, 16_000);
    expect(out.length).toBeCloseTo(16_000, -2);
  });

  it('preserves a constant signal exactly', () => {
    const out = downsample(new Float32Array(300).fill(0.4), 48_000, 16_000);
    for (const sample of out) expect(sample).toBeCloseTo(0.4, 5);
  });

  /**
   * The box average is a crude low-pass filter. Plain decimation — taking every
   * third sample — would alias high-frequency energy down into the speech band
   * as a metallic buzz that measurably degrades recognition.
   */
  it('attenuates a tone above the new Nyquist limit rather than aliasing it', () => {
    const sourceRate = 48_000;
    const samples = new Float32Array(sourceRate * 0.1);
    // 12 kHz is above the 8 kHz Nyquist limit of a 16 kHz signal.
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 12_000 * i) / sourceRate);
    }

    const out = downsample(samples, sourceRate, 16_000);
    const outRms = Math.sqrt(out.reduce((sum, s) => sum + s * s, 0) / out.length);

    // Averaging pushes this well below the ~0.707 RMS of the original tone.
    expect(outRms).toBeLessThan(0.35);
  });

  it('keeps speech-band content intact', () => {
    const sourceRate = 48_000;
    const samples = new Float32Array(sourceRate * 0.1);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 300 * i) / sourceRate);
    }

    const out = downsample(samples, sourceRate, 16_000);
    const outRms = Math.sqrt(out.reduce((sum, s) => sum + s * s, 0) / out.length);

    // A 300 Hz tone is squarely in the voice range and must survive.
    expect(outRms).toBeGreaterThan(0.6);
  });

  it('refuses to upsample rather than fabricating detail', () => {
    expect(() => downsample(new Float32Array(10), 8_000, 16_000)).toThrow(/upsample/i);
  });
});

describe('mergeChunks', () => {
  it('concatenates frames in order', () => {
    const merged = mergeChunks([new Float32Array([1, 2]), new Float32Array([3, 4])]);
    expect([...merged]).toEqual([1, 2, 3, 4]);
  });

  it('honours an explicit total length', () => {
    const merged = mergeChunks([new Float32Array([1, 2]), new Float32Array([3, 4])], 3);
    expect([...merged]).toEqual([1, 2, 3]);
  });

  it('returns an empty buffer for no chunks', () => {
    expect(mergeChunks([])).toHaveLength(0);
  });
});

describe('durationOf', () => {
  it('converts sample count to seconds at the target rate', () => {
    expect(durationOf(new Float32Array(16_000))).toBe(1);
    expect(durationOf(new Float32Array(8_000))).toBe(0.5);
  });
});

describe('the capture contract', () => {
  it('turns 48 kHz microphone frames into a Whisper-ready WAV', async () => {
    // The whole client-side chain in one assertion: raw frames from the audio
    // callback → merged → downsampled → encoded.
    const frames = Array.from({ length: 10 }, () => new Float32Array(4096).fill(0.25));
    const merged = mergeChunks(frames);
    const samples = downsample(merged, 48_000, TARGET_SAMPLE_RATE);
    const wav = await parseWav(encodeWav(samples, TARGET_SAMPLE_RATE));

    expect(wav.sampleRate).toBe(16_000);
    expect(wav.channels).toBe(1);
    expect(wav.bitsPerSample).toBe(16);
    expect(wav.samples.length).toBeCloseTo((4096 * 10) / 3, -2);
  });
});
