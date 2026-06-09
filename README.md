# Electron: `EventTarget.dispatchEvent()` skips listener invocation when it coincides with a V8 inspector pause

## Summary

In an Electron renderer (`nodeIntegration: true`, `contextIsolation: false`), calling
`EventTarget.dispatchEvent()` **from a Node.js `net` socket `'data'` callback** can
**silently invoke zero listeners** — even though listeners are registered and never
removed, and `dispatchEvent()` returns `true` — **if the call coincides with the V8
inspector transitioning into a paused state** (`Debugger.pause`, i.e. a breakpoint being
hit / the renderer being paused by DevTools or the DevTools Protocol).

A plain function call made on the very next line *does* execute, so the JS thread is not
frozen — it is specifically the **listener-invocation step inside `dispatchEvent`** that is
skipped.

This matches a real-world failure: protobuf messages arriving over a socket were decoded
and "dispatched", but the registered handlers never ran — and **only while debugging with
breakpoints**.

## Environment

Reproduced on (the exact versions print at the top of every run as the `[env]` line):

| Electron | Chromium | V8 | Node | Reproduces? |
| --- | --- | --- | --- | --- |
| 42.3.3 (latest stable at time of writing) | 148.0.7778.218 | 14.8.178.28 | 24.15.0 | yes |
| 41.0.2 | 146.0.7680.72 | 14.6.202.11 | 24.14.0 | yes |

```
[env] electron=42.3.3 chrome=148.0.7778.218 node=24.15.0 v8=14.8.178.28-electron.0 platform=win32
```

- OS: Windows 11 (named-pipe transport). The repro is cross-platform (uses a Unix domain
  socket in `os.tmpdir()` on macOS/Linux) and the mechanism is not believed to be
  platform-specific — please confirm on your platform.
- `webPreferences`: `{ contextIsolation: false, nodeIntegration: true, nodeIntegrationInWorker: true }`

## How to run

```sh
npm install      # installs electron (see package.json; pin to your version to test)
npm start
```

The process exits `0` and prints `REPRODUCED: …` on the first anomaly, or exits `1` with
`no anomaly within …ms` if it didn't hit the race this run.

**It is timing-sensitive / intermittent.** The anomaly fires only when a `dispatchEvent`
call lands on a pause transition; in practice it has surfaced anywhere from ~40 to ~860
pauses into a run (the default `MAX_RUN_MS` is 5 minutes). **If a run times out without an
anomaly, run it again** — a clean run does not mean the bug is absent. All output is also
written to `run.log`. Counter-intuitively, sending *faster* did not help; the tunables at
the top of `main.js` (`SEND_INTERVAL_MS=10`, `PAUSE_PERIOD_MS=300`, `PAUSE_DURATION_MS=100`)
are the ones observed to reproduce most reliably.

## What the repro does

- **Renderer** (`renderer.js`): a `MessageSocket extends EventTarget` runs a local pipe
  **server**. For every length-prefixed message it receives it does two things:
  1. `this.dispatchEvent(new CustomEvent("message", { detail: msg }))` — two listeners are
     registered for `"message"` (one in the constructor, one externally; **neither is ever
     removed**).
  2. calls a plain `this.onMessage(msg)` callback on the next line.
  It then records, per message, whether each path ran. If `dispatchEvent` returned but the
  listeners did **not** run, it logs `*** ANOMALY ***`.
- **Main** (`main.js`): connects to the renderer's pipe as the **sender** and streams
  messages continuously; and, via the DevTools Protocol (`webContents.debugger`), repeatedly
  issues `Debugger.pause` / `Debugger.resume` to genuinely suspend and resume the renderer's
  V8 isolate (a real breakpoint). The sender runs in the main process so it keeps sending
  while the renderer is paused.

## Expected vs. actual

**Expected:** every dispatched `"message"` event invokes its registered listeners.

**Actual:** occasionally — when a `dispatchEvent` call lands exactly on a `Debugger.pause`
transition — `dispatchEvent` returns `true` but invokes **none** of the registered
listeners. The plain callback on the next line still runs.

## Evidence

The anomaly always appears immediately after a `Debugger.pause` is issued (representative
lines from `run.log`):

```
[main] Debugger.pause #857
[renderer] *** ANOMALY *** msg-17032: dispatchEvent returned notCanceled=true, but EventTarget listeners did NOT run (internal=false, external=false); plain callback ran=true. [message #17032]
```

(Captured on Electron 42.3.3 / Chromium 148. The same signature reproduces on 41.0.2 /
Chromium 146.)

Reading the flags:

- `notCanceled=true` — `dispatchEvent` ran its full algorithm and returned normally.
- `internal=false`, `external=false` — **neither** registered `"message"` listener was invoked.
- `plain callback ran=true` — the `onMessage(msg)` call on the *next line* executed, so the
  JS thread was not frozen; only the listener-invocation inside `dispatchEvent` was skipped.

Every other message in the run (hundreds–thousands) dispatches normally. The drop only
occurs on the message whose `dispatchEvent` coincides with the pause transition.

## Analysis / likely mechanism

When Blink is transitioning the isolate into the inspector-paused state, the
"invoke listeners" phase of the DOM event-dispatch algorithm appears to be suppressed
(invoking a listener means entering a fresh JS callframe, which the pausing isolate refuses
at that instant). `dispatchEvent` then returns to its caller as if it had completed with no
matching listeners, while the caller's already-running callframe continues normally (hence
the plain callback on the next line still runs).

The trigger requires JS to be executing a `dispatchEvent` at the exact moment the pause
engages. A Node `net` socket `'data'` callback is an effective way to hit this window
because it runs as a libuv I/O callback interleaved with Chromium's loop, independently of
the page's own task scheduling.

## Why this is filed against Electron (not Chromium)

The reproduction fundamentally requires a **Node.js `net` socket callback in the renderer
driving `dispatchEvent`** while the inspector pauses — i.e. Node integration in the renderer
and the integrated Node/Chromium event loop, which is Electron-specific. There is no
straightforward way to construct the same "dispatch from a socket `'data'` callback" timing
in stock Chromium.

**It is NOT a V8/Node issue — it requires Blink.** A pure-Node control (`node-only/`, see
below) runs the identical logic — a `net` server, `class … extends EventTarget`,
`dispatchEvent` per message — with a Worker thread driving the V8 inspector against the main
thread (`Session.connectToMainThread()` + `Debugger.pause`/`resume`). Run under Electron's
own bundled Node via `ELECTRON_RUN_AS_NODE=1`, i.e. **the exact same V8 build (14.8) as the
failing renderer, just without Blink**, it does **not** reproduce:

| Configuration | V8 | Real main-thread pauses | Anomalies |
| --- | --- | --- | --- |
| Electron renderer (Blink) | 14.8 | hit at pause #857 | reproduces |
| Pure Node, same V8, no Blink (`ELECTRON_RUN_AS_NODE=1`) | 14.8 | ~1,900 over 10 min | 0 |

Node's `EventTarget` invokes listeners as plain JS calls; a V8 inspector pause suspends the
isolate at a safepoint without skipping that invocation. The skip is specific to **Blink's**
DOM event-dispatch path (which guards entering a fresh listener callframe while the isolate
is transitioning into the paused state). Hence this is reported as an Electron/Chromium
(Blink) issue.

To run the pure-Node control yourself:

```sh
ELECTRON_RUN_AS_NODE=1 npx electron node-only/repro.js   # same V8 as the renderer, no Blink
# or with any system Node:
node node-only/repro.js
```

## Workaround

Do not route socket data through `EventTarget`/`dispatchEvent`. A plain callback (or any
direct function call) is unaffected — note `plain callback ran=true` on the very message
where the listeners were skipped. In the original application, replacing the
`dispatchEvent("message")` hop with a direct `onMessage` callback fully resolved the dropped
messages.

## Files

- `main.js` — Electron main process: window, DevTools-Protocol pause/resume loop, socket sender, anomaly reporting. Tunables (send rate, pause cadence/duration, max run time) are constants at the top.
- `renderer.js` — `MessageSocket extends EventTarget` pipe server + per-message anomaly detection.
- `index.html` — loads `renderer.js`.
- `run.log` — written on each run (overwritten at start).
- `node-only/` — pure-Node control (no Blink) showing the bug does **not** reproduce with
  the same V8: `repro.js` (main thread: `net` server + `EventTarget`) and
  `controller-worker.js` (Worker: drives `Debugger.pause`/`resume` on the main thread and
  sends messages).
