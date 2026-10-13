/** Compose the current spectrogram frame into a labelled PNG. */

export interface SnapshotOptions {
  source: HTMLCanvasElement;
  /** Device pixels per CSS pixel of the source canvas. */
  scale: number;
  ticks: { hz: number; label: string; y: number }[];
  seconds: number;
  colors: { bg: string; ink: string; muted: string; line: string };
  font: string;
  date: Date;
}

export function composeSnapshot(o: SnapshotOptions): HTMLCanvasElement {
  const s = o.scale;
  const margin = 32 * s;
  const head = 44 * s;
  const foot = 36 * s;
  const axis = 52 * s;
  const { width: w, height: h } = o.source;

  const out = document.createElement('canvas');
  out.width = Math.round(w + margin * 2 + axis);
  out.height = Math.round(h + margin * 2 + head + foot);
  const ctx = out.getContext('2d');
  if (!ctx) return out;

  ctx.fillStyle = o.colors.bg;
  ctx.fillRect(0, 0, out.width, out.height);

  const top = margin + head;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = o.colors.ink;
  ctx.font = `600 ${18 * s}px ${o.font}`;
  ctx.fillText('Field Recorder', margin, margin + 18 * s);

  ctx.fillStyle = o.colors.muted;
  ctx.font = `400 ${13 * s}px ${o.font}`;
  ctx.textAlign = 'right';
  ctx.fillText(formatDate(o.date), margin + w, margin + 18 * s);

  ctx.drawImage(o.source, margin, top);
  ctx.strokeStyle = o.colors.line;
  ctx.lineWidth = Math.max(1, Math.round(s));
  ctx.strokeRect(margin - ctx.lineWidth / 2, top - ctx.lineWidth / 2, w + ctx.lineWidth, h + ctx.lineWidth);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `400 ${11 * s}px ${o.font}`;
  for (const tick of o.ticks) {
    const y = top + tick.y * h;
    ctx.fillStyle = o.colors.line;
    ctx.fillRect(margin + w, Math.round(y), 6 * s, Math.max(1, Math.round(s)));
    ctx.fillStyle = o.colors.muted;
    ctx.fillText(tick.label, margin + w + 10 * s, y);
  }

  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`1–10 kHz, logarithmic · ${o.seconds.toFixed(1)} s`, margin, top + h + 24 * s);

  return out;
}

export function snapshotFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `field-recorder-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.png`;
}

function formatDate(date: Date): string {
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Share sheet on touch devices (Save Image on iOS), download elsewhere. */
export async function deliver(canvas: HTMLCanvasElement, name: string): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return;

  const file = new File([blob], name, { type: 'image/png' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Lost user activation or unsupported: fall back to a download.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
