// Stages the MediaPipe hand-tracking assets into public/mediapipe/ so the
// StrumCam view can load them from the app origin (a Tauri webview can't fetch
// them from a CDN, and ~42 MB of wasm + model weights don't belong in git):
//
//   public/mediapipe/wasm/                 copied from @mediapipe/tasks-vision
//   public/mediapipe/hand_landmarker.task  downloaded from Google's model zoo
//                                          (float16, pinned version, ~7.8 MB)
//
// Runs automatically before `pnpm dev` / `pnpm build` and is idempotent — it
// re-copies the wasm (cheap, tracks the npm package) and downloads the model
// only if missing. A failed download is a WARNING, not an error: the app
// falls back to the frame-diff motion tracker, so an offline build still
// works, just with the weaker StrumCam signal.

import { cpSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmSrc = join(appDir, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const outDir = join(appDir, "public", "mediapipe");
const modelPath = join(outDir, "hand_landmarker.task");

// Pinned, not "latest": a silently different model would change every number
// the StrumCam lab produces.
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
// float16 hand_landmarker.task v1 is ~7.8 MB; anything much smaller is an
// error page saved as a file.
const MODEL_MIN_BYTES = 5_000_000;

mkdirSync(outDir, { recursive: true });

if (!existsSync(wasmSrc)) {
  console.error("fetch-mediapipe: @mediapipe/tasks-vision is not installed — run pnpm install first");
  process.exit(1);
}
cpSync(wasmSrc, join(outDir, "wasm"), { recursive: true });
console.log("fetch-mediapipe: wasm staged into public/mediapipe/wasm");

if (existsSync(modelPath) && statSync(modelPath).size >= MODEL_MIN_BYTES) {
  console.log("fetch-mediapipe: hand_landmarker.task already present");
  process.exit(0);
}

try {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < MODEL_MIN_BYTES) throw new Error(`suspiciously small download (${bytes.length} bytes)`);
  writeFileSync(modelPath, bytes);
  console.log(`fetch-mediapipe: hand_landmarker.task downloaded (${(bytes.length / 1e6).toFixed(1)} MB)`);
} catch (e) {
  if (existsSync(modelPath)) unlinkSync(modelPath); // never leave a truncated model
  console.warn(`fetch-mediapipe: WARNING — could not download hand model (${e}).`);
  console.warn("fetch-mediapipe: StrumCam will use the frame-diff motion fallback.");
  console.warn(`fetch-mediapipe: to fix manually, put the file at ${modelPath}`);
  console.warn(`fetch-mediapipe: from ${MODEL_URL}`);
}
