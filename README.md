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

Observed with (your numbers will print at the top of every run as the `[env]` line — please
paste your own):

```
[env] electron=41.0.2 chrome=146.0.7680.72 node=24.14.0 v8=14.6.202.11-electron.0 platform=win32
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

**It is timing-sensitive / intermittent.** A single anomaly in several hundred to a few
thousand messages is typical. If a run does not reproduce, **run it a few more times** (or
tweak the tunables at the top of `main.js`). All output is also written to `run.log`.

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
[main] Debugger.pause #28
[renderer] *** ANOMALY *** msg-1209: dispatchEvent returned notCanceled=true, but EventTarget listeners did NOT run (internal=false, external=false); plain callback ran=true. [message #1209]
```

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

The underlying listener-skip may ultimately be upstream V8/Blink inspector behavior, but it
is only practically observable in an Electron renderer, so it is reported here; please
escalate upstream if appropriate.

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
