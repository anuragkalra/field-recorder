/** Microphone capture and FFT analysis via the Web Audio API. */

const FFT_SIZE = 2048;
const SMOOTHING = 0.2;

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export class MicError extends Error {
  constructor(
    readonly kind: 'denied' | 'insecure' | 'missing' | 'busy' | 'unknown',
    message: string,
  ) {
    super(message);
  }
}

export class Microphone {
  readonly data: Float32Array<ArrayBuffer>;
  onEnded: (() => void) | null = null;

  private constructor(
    private readonly ctx: AudioContext,
    private readonly stream: MediaStream,
    private readonly analyser: AnalyserNode,
  ) {
    this.data = new Float32Array(analyser.frequencyBinCount);
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => this.onEnded?.());
    }
  }

  /**
   * Must be called from a user gesture: the AudioContext is created and
   * resumed synchronously, before awaiting the permission prompt, so iOS
   * Safari treats it as user-initiated.
   */
  static async open(): Promise<Microphone> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new MicError('insecure', 'The microphone needs a secure (https) connection.');
    }
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) {
      throw new MicError('unknown', 'This browser does not support Web Audio.');
    }

    const ctx = new Ctor({ latencyHint: 'interactive' });
    const resumed = ctx.resume().catch(() => {});

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Voice processing filters out exactly the high, tonal sounds we want.
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      void ctx.close().catch(() => {});
      throw toMicError(err);
    }
    await resumed;

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = SMOOTHING;
    source.connect(analyser);

    return new Microphone(ctx, stream, analyser);
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  get fftSize(): number {
    return this.analyser.fftSize;
  }

  get binHz(): number {
    return this.ctx.sampleRate / this.analyser.fftSize;
  }

  /** Fills and returns `data` with the current spectrum in dBFS. */
  read(): Float32Array<ArrayBuffer> {
    this.analyser.getFloatFrequencyData(this.data);
    return this.data;
  }

  /** iOS suspends the context on interruptions (calls, backgrounding). */
  resume(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  close(): void {
    this.onEnded = null;
    for (const track of this.stream.getTracks()) track.stop();
    void this.ctx.close().catch(() => {});
  }
}

function toMicError(err: unknown): MicError {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return new MicError(
        'denied',
        'Microphone access is blocked. Allow it for this site in your browser settings, then try again.',
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return new MicError('missing', 'No microphone was found on this device.');
    case 'NotReadableError':
    case 'AbortError':
      return new MicError('busy', 'The microphone is in use by another app. Close it and try again.');
    default:
      return new MicError('unknown', 'The microphone could not be started. Please try again.');
  }
}

/** Loudest frequency in [minHz, maxHz], refined with parabolic interpolation. */
export function peakFrequency(
  spectrum: Float32Array,
  binHz: number,
  minHz: number,
  maxHz: number,
): { hz: number; db: number } {
  const lo = Math.max(1, Math.floor(minHz / binHz));
  const hi = Math.min(spectrum.length - 2, Math.ceil(maxHz / binHz));
  let best = lo;
  let db = -Infinity;
  for (let i = lo; i <= hi; i++) {
    if (spectrum[i] > db) {
      db = spectrum[i];
      best = i;
    }
  }
  const a = spectrum[best - 1];
  const b = spectrum[best];
  const c = spectrum[best + 1];
  const denom = a - 2 * b + c;
  const offset = Number.isFinite(denom) && denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return { hz: (best + Math.max(-0.5, Math.min(0.5, offset))) * binHz, db };
}
