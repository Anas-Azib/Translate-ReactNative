/**
 * PCM capture helpers.
 *
 * Whisper wants mono 16 kHz PCM. Rather than record Opus-in-WebM and make the
 * server transcode it — which would mean ffmpeg or a native codec binding in
 * the request path — the browser produces exactly that format directly. The
 * AudioContext is already running for the level meter, so the samples are right
 * there; all that is missing is a downsample and a 44-byte header.
 */

export const TARGET_SAMPLE_RATE = 16_000;

/**
 * Downsamples float samples to `targetRate`.
 *
 * Averages every source sample that falls inside an output sample's window
 * rather than picking the nearest one. Plain decimation of 48 kHz → 16 kHz
 * throws away two of every three samples and aliases high-frequency energy down
 * into the speech band as a metallic buzz, which measurably hurts recognition.
 * Box-averaging is a crude low-pass, but it is the difference between clean
 * speech and artefacts.
 */
export function downsample(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number = TARGET_SAMPLE_RATE,
): Float32Array {
  if (targetRate === sourceRate) return samples;
  if (targetRate > sourceRate) {
    throw new Error(`Cannot upsample ${sourceRate}Hz to ${targetRate}Hz`);
  }

  const ratio = sourceRate / targetRate;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += samples[j]!;
      count += 1;
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  return out;
}

/** Concatenates the captured frames into one contiguous buffer. */
export function mergeChunks(chunks: Float32Array[], totalLength?: number): Float32Array {
  const length = totalLength ?? chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset + chunk.length > length) {
      merged.set(chunk.subarray(0, length - offset), offset);
      break;
    }
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/**
 * Wraps float samples in a 16-bit PCM WAV container.
 *
 * 16-bit rather than 32-bit float: it halves the upload with no audible or
 * measurable recognition cost at speech dynamic range, and every decoder
 * understands it.
 */
export function encodeWav(samples: Float32Array, sampleRate: number = TARGET_SAMPLE_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    // Clamp before scaling: a sample above 1.0 would wrap around to a loud
    // negative value and produce a click.
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Seconds of audio in a sample buffer at a given rate. */
export function durationOf(samples: Float32Array, sampleRate: number = TARGET_SAMPLE_RATE): number {
  return samples.length / sampleRate;
}
