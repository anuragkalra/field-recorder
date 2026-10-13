# Field Recorder

Real-time birdsong spectrogram. Static site, no backend.

## Stack
- Vite + TypeScript (strict), plain CSS. No UI framework, no CSS framework, no runtime deps beyond `@fontsource-variable/inter`.
- Deploys to Vercel with zero config (`npm run build` → `dist/`). Don't add a `vercel.json` unless something truly needs it.
- `npm run build` runs `tsc --noEmit` then `vite build`; it must pass with no errors before finishing any change.

## Code map
- `src/audio.ts` — mic via `getUserMedia` (echo cancellation / noise suppression / AGC off) + `AnalyserNode`. The `AudioContext` is created synchronously inside the click handler (iOS needs the user gesture).
- `src/spectrogram.ts` — ring-buffer canvas renderer: one new column per frame into an offscreen canvas, two `drawImage` slices to screen. Stores raw levels so history survives resize and theme changes. Canvas is sized in device pixels.
- `src/snapshot.ts` — labelled PNG export (share sheet on touch devices, download elsewhere).
- `src/wakelock.ts` — Screen Wake Lock while listening; always fails silently.
- `src/main.ts` — state machine (`idle | starting | listening | paused | error` on `#app[data-state]`), axes, controls, frame loop.

## Audio/visual rules
- Log frequency axis, 1–10 kHz. Constant scroll speed in CSS px/s so the time axis means something.
- Keep the frame loop allocation-free; 60 fps on a phone is the bar.
- Mic errors get a plain-language message in `#error`; never fail silently on permission denial.

## Design rules
- Minimal Swiss: off-white background, near-black text, exactly one accent color (`--accent`), hairline rules, generous spacing, small radius (2px).
- Inter (`Inter Variable`) with a system-font fallback stack. Tabular numerals for any changing number.
- All colors are CSS custom properties on `:root`, redefined under `prefers-color-scheme: dark`. The spectrogram colormap is built from `--paper`, `--ink`, `--accent` — never hard-code colors in TS.
- Phones: controls in a bottom bar within thumb reach; respect `env(safe-area-inset-*)`; touch targets ≥ 44px.
- Desktop (≥ 960px, or landscape ≥ 640px): centered layout, large spectrogram, controls in a right-hand side panel.
- Motion is subtle (opacity/translate, 150–600ms) and disabled under `prefers-reduced-motion`.
