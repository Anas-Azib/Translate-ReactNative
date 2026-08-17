/**
 * Audio decoding for the Whisper pipeline.
 *
 * Whisper wants exactly one thing: mono 32-bit float PCM at 16 kHz. The client
 * captures and encodes precisely that (see `client/src/services/wav.ts`), so
 * this module only has to parse a WAV container — no ffmpeg, no native codec
 * bindings, no transcode step in the request path.
 */

export const WHISPER_SAMPLE_RATE = 16_000;

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
}

export class AudioDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioDecodeError';
  }
}

/**
 * Parses a RIFF/WAVE buffer into mono float samples.
 *
 * Walks the chunk list rather than assuming a 44-byte header: plenty of
 * encoders insert `LIST`/`fact` chunks before `data`, and a fixed offset would
 * read metadata as audio and produce noise.
 */
export function decodeWav(buffer: Buffer): DecodedAudio {
  if (buffer.length < 44) throw new AudioDecodeError('Audio is too short to be a WAV file');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AudioDecodeError('Expected a RIFF/WAVE payload');
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let format = 1;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      format = buffer.readUInt16LE(offset + 8);
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      // Some encoders write 0 or 0xFFFFFFFF for a stream of unknown length.
      dataLength = Math.min(chunkSize || buffer.length - dataOffset, buffer.length - dataOffset);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || channels === 0 || sampleRate === 0) {
    throw new AudioDecodeError('WAV file is missing a fmt or data chunk');
  }
  if (format !== 1 && format !== 3) {
    throw new AudioDecodeError(`Unsupported WAV encoding (format ${format})`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLength / (channels * bytesPerSample));
  const mono = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const position = dataOffset + (frame * channels + channel) * bytesPerSample;
      sum += readSample(buffer, position, bitsPerSample, format);
    }
    // Downmix by averaging: the client sends mono, but a stereo input must not
    // come out at double amplitude and clip.
    mono[frame] = sum / channels;
  }

  return {
    samples: mono,
    sampleRate,
    channels,
    durationSeconds: frameCount / sampleRate,
  };
}

function readSample(buffer: Buffer, position: number, bits: number, format: number): number {
  if (format === 3) return buffer.readFloatLE(position); // IEEE float
  switch (bits) {
    case 8:
      return (buffer.readUInt8(position) - 128) / 128;
    case 16:
      return buffer.readInt16LE(position) / 32_768;
    case 24: {
      const raw = buffer.readUIntLE(position, 3);
      // Sign-extend the 24-bit value into 32 bits.
      return (raw >= 0x800000 ? raw - 0x1000000 : raw) / 8_388_608;
    }
    case 32:
      return buffer.readInt32LE(position) / 2_147_483_648;
    default:
      throw new AudioDecodeError(`Unsupported bit depth: ${bits}`);
  }
}

/**
 * Linear resampling to Whisper's rate.
 *
 * Linear interpolation rather than a windowed-sinc filter is a deliberate
 * trade: the client already delivers 16 kHz, so this only runs as a safety net
 * for an unexpected rate, and speech recognition is far more tolerant of mild
 * aliasing than music playback would be.
 */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  if (samples.length === 0) return samples;

  const ratio = from / to;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = samples[index] ?? 0;
    const b = samples[index + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Root-mean-square level of a frame, 0–1. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

/**
 * Peak level over the loudest 100 ms window.
 *
 * Whole-clip RMS is the wrong gate for a segment that is mostly silence with a
 * short word in it — the average washes the word out. Taking the loudest window
 * asks the question we actually care about: did anything at all happen here?
 */
export function peakWindowRms(samples: Float32Array, sampleRate: number): number {
  const window = Math.max(1, Math.floor(sampleRate * 0.1));
  if (samples.length <= window) return rms(samples);

  let peak = 0;
  for (let start = 0; start + window <= samples.length; start += Math.floor(window / 2)) {
    peak = Math.max(peak, rms(samples.subarray(start, start + window)));
  }
  return peak;
}

export function decodeForWhisper(buffer: Buffer): DecodedAudio {
  const decoded = decodeWav(buffer);
  if (decoded.sampleRate === WHISPER_SAMPLE_RATE) return decoded;

  const samples = resample(decoded.samples, decoded.sampleRate, WHISPER_SAMPLE_RATE);
  return {
    samples,
    sampleRate: WHISPER_SAMPLE_RATE,
    channels: 1,
    durationSeconds: samples.length / WHISPER_SAMPLE_RATE,
  };
}
