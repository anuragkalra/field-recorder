import '@fontsource-variable/inter';
import './style.css';
import { Microphone, MicError, peakFrequency } from './audio';
import { Spectrogram } from './spectrogram';
import { composeSnapshot, deliver, snapshotFilename } from './snapshot';
import { allowSleep, keepAwake } from './wakelock';

const MIN_HZ = 1000;
const MAX_HZ = 10000;
/** Scroll speed in CSS pixels per second — constant, so the time axis is too. */
const SPEED = 80;
const RANGE_DB = 45;
const FONT = '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const GRID_HZ = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
const LABEL_HZ = new Set([1000, 2000, 3000, 4000, 5000, 7000, 10000]);
const SENSITIVITY_KEY = 'field-recorder:sensitivity';

type State = 'idle' | 'starting' | 'listening' | 'paused' | 'error';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const app = $<HTMLDivElement>('app');
const canvas = $<HTMLCanvasElement>('spectrogram');
const freqAxis = $<HTMLDivElement>('freq-axis');
const timeAxis = $<HTMLDivElement>('time-axis');
const statusText = $<HTMLSpanElement>('status-text');
const errorText = $<HTMLParagraphElement>('error');
const peakText = $<HTMLSpanElement>('peak');
const startButton = $<HTMLButtonElement>('start');
const pauseButton = $<HTMLButtonElement>('pause');
const clearButton = $<HTMLButtonElement>('clear');
const saveButton = $<HTMLButtonElement>('save');
const sensitivity = $<HTMLInputElement>('sensitivity');
const sensitivityValue = $<HTMLOutputElement>('sensitivity-value');
const metaRate = $<HTMLElement>('meta-rate');
const metaRes = $<HTMLElement>('meta-res');

const spectrogram = new Spectrogram(canvas, MIN_HZ, MAX_HZ);
let mic: Microphone | null = null;
let state: State = 'idle';

/* ---------- Frequency mapping & axes ---------- */

/** Fraction from the top of the stage (0 = MAX_HZ, 1 = MIN_HZ). */
const yForHz = (hz: number) => Math.log(MAX_HZ / hz) / Math.log(MAX_HZ / MIN_HZ);
const formatKHz = (hz: number) => `${hz / 1000} kHz`;

function buildFreqAxis(): void {
  const frag = document.createDocumentFragment();
  for (const hz of GRID_HZ) {
    const line = document.createElement('div');
    line.className = 'grid-line';
    if (hz === MIN_HZ) line.classList.add('is-bottom');
    if (hz === MAX_HZ) line.classList.add('is-top');
    line.style.top = `${yForHz(hz) * 100}%`;
    if (LABEL_HZ.has(hz)) {
      const label = document.createElement('span');
      label.className = 'grid-label';
      label.textContent = hz === MAX_HZ ? formatKHz(hz) : `${hz / 1000}k`;
      line.append(label);
    }
    frag.append(line);
  }
  freqAxis.replaceChildren(frag);
}

function buildTimeAxis(cssWidth: number): void {
  const step = [1, 2, 5, 10, 20].find((s) => s * SPEED >= 96) ?? 20;
  const frag = document.createDocumentFragment();
  for (let t = step; t * SPEED < cssWidth - 24; t += step) {
    const tick = document.createElement('span');
    tick.className = 'time-tick';
    tick.style.right = `${t * SPEED}px`;
    tick.textContent = `−${t} s`;
    frag.append(tick);
  }
  timeAxis.replaceChildren(frag);
}

/* ---------- Theme ---------- */

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function applyPalette(): void {
  spectrogram.setPalette({ paper: cssVar('--paper'), ink: cssVar('--ink'), accent: cssVar('--accent') });
  spectrogram.render();
}

/* ---------- Sizing ---------- */

let cssWidth = 0;

function resize(entry?: ResizeObserverEntry): void {
  const rect = entry?.contentRect ?? canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  let w = Math.round(rect.width * dpr);
  let h = Math.round(rect.height * dpr);
  // Prefer the exact device-pixel box, but only when it agrees with dpr
  // (some emulated/zoomed environments report CSS pixels here).
  const device = entry?.devicePixelContentBoxSize?.[0];
  if (device && Math.abs(device.inlineSize - w) <= 2 && Math.abs(device.blockSize - h) <= 2) {
    w = device.inlineSize;
    h = device.blockSize;
  }
  if (rect.width !== cssWidth) {
    cssWidth = rect.width;
    buildTimeAxis(cssWidth);
  }
  spectrogram.resize(w, h, SPEED * (w / Math.max(1, rect.width)));
}

function observeSize(): void {
  const observer = new ResizeObserver(([entry]) => resize(entry));
  try {
    // Exact device pixels, and fires when devicePixelRatio changes (zoom, new monitor).
    observer.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    observer.observe(canvas);
  }
}

/* ---------- Sensitivity ---------- */

/** 0 → only loud sounds; 100 → down to the noise floor. */
let floorDb = -80;

function setSensitivity(value: number): void {
  floorDb = -50 - 50 * (value / 100);
  sensitivityValue.value = String(value);
  sensitivity.style.setProperty('--fill', `${value}%`);
}

/* ---------- State ---------- */

const STATUS: Record<State, string> = {
  idle: 'Ready',
  starting: 'Waiting for microphone…',
  listening: 'Listening',
  paused: 'Paused',
  error: 'Microphone off',
};

function setState(next: State): void {
  state = next;
  app.dataset.state = next;
  statusText.textContent = STATUS[next];

  const live = next === 'listening' || next === 'paused';
  startButton.hidden = live;
  startButton.disabled = next === 'starting';
  startButton.textContent = next === 'error' ? 'Try again' : 'Start listening';
  for (const el of [pauseButton, clearButton, saveButton, sensitivity]) el.disabled = !live;

  pauseButton.setAttribute('aria-pressed', String(next === 'paused'));
  pauseButton.querySelector('.btn-text')!.textContent = next === 'paused' ? 'Resume' : 'Pause';

  if (next !== 'listening') peakText.textContent = '—';
  if (live) keepAwake();
  else allowSleep();
}

function showError(message: string | null): void {
  errorText.hidden = !message;
  errorText.textContent = message ?? '';
}

async function start(): Promise<void> {
  if (state === 'starting' || mic) return;
  showError(null);
  setState('starting');
  try {
    mic = await Microphone.open();
  } catch (err) {
    showError(err instanceof MicError ? err.message : 'The microphone could not be started.');
    setState('error');
    return;
  }

  mic.onEnded = () => {
    stop();
    showError('The microphone was disconnected.');
    setState('error');
  };
  spectrogram.setBinHz(mic.binHz);
  metaRate.textContent = `${(mic.sampleRate / 1000).toFixed(1)} kHz`;
  metaRes.textContent = `${mic.binHz.toFixed(1)} Hz · FFT ${mic.fftSize}`;
  lastFrame = 0;
  setState('listening');
}

function stop(): void {
  mic?.close();
  mic = null;
}

function togglePause(): void {
  if (state === 'listening') setState('paused');
  else if (state === 'paused') {
    lastFrame = 0;
    mic?.resume();
    setState('listening');
  }
}

function clear(): void {
  if (!mic) return;
  spectrogram.clear();
  spectrogram.render();
}

async function save(): Promise<void> {
  if (!mic || spectrogram.width === 0) return;
  const date = new Date();
  const scale = spectrogram.width / Math.max(1, cssWidth);
  await document.fonts.ready;
  const image = composeSnapshot({
    source: canvas,
    scale,
    ticks: GRID_HZ.filter((hz) => LABEL_HZ.has(hz)).map((hz) => ({
      hz,
      label: formatKHz(hz),
      y: yForHz(hz),
    })),
    seconds: cssWidth / SPEED,
    colors: { bg: cssVar('--bg'), ink: cssVar('--ink'), muted: cssVar('--muted'), line: cssVar('--line-strong') },
    font: FONT,
    date,
  });
  await deliver(image, snapshotFilename(date));
}

/* ---------- Frame loop ---------- */

let lastFrame = 0;
let lastPeakUpdate = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  // Cap the step so a backgrounded tab doesn't smear one spectrum across the screen.
  const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
  lastFrame = now;

  if (state === 'listening' && mic) {
    const spectrum = mic.read();
    spectrogram.push(spectrum, dt, floorDb, RANGE_DB);

    if (now - lastPeakUpdate > 150) {
      lastPeakUpdate = now;
      const peak = peakFrequency(spectrum, mic.binHz, MIN_HZ, MAX_HZ);
      peakText.textContent = peak.db > floorDb + RANGE_DB * 0.4 ? `${(peak.hz / 1000).toFixed(2)} kHz` : '—';
    }
  }
  spectrogram.render();
}

/* ---------- Wiring ---------- */

startButton.addEventListener('click', () => void start());
pauseButton.addEventListener('click', togglePause);
clearButton.addEventListener('click', clear);
saveButton.addEventListener('click', () => void save());

sensitivity.addEventListener('input', () => {
  const value = Number(sensitivity.value);
  setSensitivity(value);
  try {
    localStorage.setItem(SENSITIVITY_KEY, String(value));
  } catch {
    // Storage unavailable (private mode): the slider still works.
  }
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, button')) return;
  if (e.key === ' ') {
    e.preventDefault();
    togglePause();
  } else if (e.key === 'c' || e.key === 'C') clear();
  else if (e.key === 's' || e.key === 'S') void save();
});

// iOS suspends audio on interruptions; any tap or returning to the tab revives it.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    lastFrame = 0;
    mic?.resume();
  }
});
document.addEventListener('pointerdown', () => mic?.resume(), { passive: true });

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPalette);

/* ---------- Boot ---------- */

let initial = 60;
try {
  const stored = Number(localStorage.getItem(SENSITIVITY_KEY));
  if (localStorage.getItem(SENSITIVITY_KEY) !== null && stored >= 0 && stored <= 100) initial = stored;
} catch {
  // Ignore unavailable storage.
}
sensitivity.value = String(initial);
setSensitivity(initial);

buildFreqAxis();
applyPalette();
resize();
observeSize();
setState('idle');
requestAnimationFrame(frame);
