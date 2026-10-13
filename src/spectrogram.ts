/**
 * Scrolling spectrogram renderer.
 *
 * Columns are written into an offscreen ring-buffer canvas, one device pixel
 * wide, and the visible canvas is composed from two slices of it each frame.
 * Nothing is ever shifted, so the cost per frame is one new column plus two
 * drawImage calls. Raw levels are kept alongside so the history can be
 * recoloured (theme change) or resampled (resize) without losing it.
 */

export interface Palette {
  paper: string;
  ink: string;
  accent: string;
}

type RGB = [number, number, number];

export class Spectrogram {
  /** Scroll speed in device pixels per second. */
  pxPerSecond = 0;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly history = document.createElement('canvas');
  private readonly hctx: CanvasRenderingContext2D;

  private w = 0;
  private h = 0;
  /** Column-major levels (0–255), w × h. */
  private levels = new Uint8Array(0);
  /** Next column to write; also the oldest visible column. */
  private head = 0;
  private prev = new Uint8Array(0);
  private cur = new Uint8Array(0);
  private column: ImageData | null = null;
  private column32: Uint32Array = new Uint32Array(0);

  /** Per-row FFT bin lookup for the log frequency axis. */
  private rowBin = new Float32Array(0);
  private rowLo = new Int32Array(0);
  private rowHi = new Int32Array(0);
  private binHz = 48000 / 2048;

  private lut: Uint32Array = new Uint32Array(256);
  private carry = 0;
  private dirty = true;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly minHz: number,
    readonly maxHz: number,
  ) {
    this.ctx = get2d(canvas);
    this.hctx = get2d(this.history);
  }

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  setPalette(palette: Palette): void {
    this.lut = buildLut(palette);
    this.recolor();
  }

  setBinHz(binHz: number): void {
    if (binHz === this.binHz) return;
    this.binHz = binHz;
    this.mapRows();
  }

  /** Resize to device pixels, keeping the most recent history. */
  resize(w: number, h: number, pxPerSecond: number): void {
    this.pxPerSecond = pxPerSecond;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w === this.w && h === this.h) return;

    const { levels: old, w: ow, h: oh, head: ohead } = this;
    const levels = new Uint8Array(w * h);
    if (ow > 0 && oh > 0) {
      // Newest column lands at the right edge; frequency rows are stretched.
      const rowMap = new Int32Array(h);
      for (let y = 0; y < h; y++) rowMap[y] = Math.min(oh - 1, Math.floor(((y + 0.5) * oh) / h));
      const cols = Math.min(w, ow);
      for (let age = 0; age < cols; age++) {
        const nx = (w - 1 - age) * h;
        const ox = (((ohead - 1 - age) % ow) + ow) % ow * oh;
        for (let y = 0; y < h; y++) levels[nx + y] = old[ox + rowMap[y]];
      }
    }

    this.w = w;
    this.h = h;
    this.levels = levels;
    this.head = 0;
    this.prev = levels.slice((w - 1) * h, w * h);
    this.cur = new Uint8Array(h);

    this.canvas.width = w;
    this.canvas.height = h;
    this.history.width = w;
    this.history.height = h;
    this.ctx.imageSmoothingEnabled = false;
    this.column = this.hctx.createImageData(1, h);
    this.column32 = new Uint32Array(this.column.data.buffer);

    this.mapRows();
    this.recolor();
    this.render();
  }

  /**
   * Append the latest spectrum (dBFS per bin). `dt` seconds of scroll are
   * filled by interpolating from the previous column, so motion stays
   * smooth regardless of display refresh rate.
   */
  push(spectrum: Float32Array, dt: number, floorDb: number, rangeDb: number): void {
    const { w, h, column } = this;
    if (!column) return;

    this.carry += dt * this.pxPerSecond;
    const n = Math.min(w, Math.floor(this.carry));
    if (n <= 0) return;
    this.carry -= n;

    const { rowBin, rowLo, rowHi, cur, prev, levels, column32, lut } = this;
    const last = spectrum.length - 1;
    const scale = 255 / rangeDb;

    for (let y = 0; y < h; y++) {
      const lo = rowLo[y];
      const hi = rowHi[y];
      let v: number;
      if (hi > lo) {
        // Row spans several bins: take the loudest so narrow tones survive.
        v = spectrum[lo];
        for (let b = lo + 1; b <= hi; b++) if (spectrum[b] > v) v = spectrum[b];
      } else {
        const f = rowBin[y];
        const i = f | 0;
        const t = f - i;
        const a = Math.max(-200, spectrum[i]);
        const b = Math.max(-200, spectrum[i < last ? i + 1 : last]);
        v = a + (b - a) * t;
      }
      const level = (v - floorDb) * scale;
      // NaN and negatives fall through to 0.
      cur[y] = level > 0 ? (level < 255 ? level : 255) : 0;
    }

    for (let k = 1; k <= n; k++) {
      const x = this.head;
      const base = x * h;
      const t = k / n;
      for (let y = 0; y < h; y++) {
        const p = prev[y];
        const value = (p + (cur[y] - p) * t) | 0;
        levels[base + y] = value;
        column32[y] = lut[value];
      }
      this.hctx.putImageData(column, x, 0);
      this.head = x + 1 === w ? 0 : x + 1;
    }

    this.cur = prev;
    this.prev = cur;
    this.dirty = true;
  }

  /** Draw the ring buffer to the visible canvas if anything changed. */
  render(): void {
    if (!this.dirty || this.w === 0) return;
    this.dirty = false;
    const { ctx, history, w, h, head } = this;
    ctx.drawImage(history, head, 0, w - head, h, 0, 0, w - head, h);
    if (head > 0) ctx.drawImage(history, 0, 0, head, h, w - head, 0, head, h);
  }

  clear(): void {
    this.levels.fill(0);
    this.prev.fill(0);
    this.carry = 0;
    this.recolor();
  }

  /** Repaint the whole history from stored levels with the current palette. */
  private recolor(): void {
    const { w, h, levels, lut } = this;
    if (w === 0 || h === 0) return;
    const image = this.hctx.createImageData(w, h);
    const out = new Uint32Array(image.data.buffer);
    for (let x = 0; x < w; x++) {
      const base = x * h;
      for (let y = 0, i = x; y < h; y++, i += w) out[i] = lut[levels[base + y]];
    }
    this.hctx.putImageData(image, 0, 0);
    this.dirty = true;
  }

  /** Row y (0 = top) maps to a log-spaced frequency between maxHz and minHz. */
  private mapRows(): void {
    const { h, binHz } = this;
    this.rowBin = new Float32Array(h);
    this.rowLo = new Int32Array(h);
    this.rowHi = new Int32Array(h);
    const top = Math.log(this.maxHz);
    const span = Math.log(this.minHz) - top;
    const hz = (edge: number) => Math.exp(top + (edge / h) * span) / binHz;
    for (let y = 0; y < h; y++) {
      const upper = hz(y);
      const lower = hz(y + 1);
      this.rowBin[y] = hz(y + 0.5);
      this.rowLo[y] = Math.ceil(lower);
      this.rowHi[y] = Math.floor(upper);
    }
  }
}

function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas 2D is not supported');
  return ctx;
}

/** Paper → ink for most of the range, ink → accent for the loudest peaks. */
function buildLut({ paper, ink, accent }: Palette): Uint32Array {
  const bg = toRGB(paper);
  const fg = toRGB(ink);
  const hot = toRGB(accent);
  const knee = 0.8;
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = Math.pow(i / 255, 1.3);
    const [r, g, b] = u < knee ? mix(bg, fg, u / knee) : mix(fg, hot, (u - knee) / (1 - knee));
    // ImageData is RGBA in memory; little-endian Uint32 reads it as ABGR.
    lut[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  return lut;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

let probe: CanvasRenderingContext2D | null = null;

/** Resolve any CSS color to sRGB by painting a single pixel. */
function toRGB(color: string): RGB {
  if (!probe) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    probe = c.getContext('2d', { willReadFrequently: true });
    if (!probe) return [0, 0, 0];
  }
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}
