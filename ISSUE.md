# Title

`EventTarget.dispatchEvent()` silently invokes zero listeners in a renderer when it coincides with a `Debugger.pause` (breakpoint) transition

---

## Preflight Checklist

- [x] I have read the Contributing Guidelines for this project.
- [x] I agree to follow the Code of Conduct that this project adheres to.
- [x] I have searched the issue tracker for a bug report that matches the one I want to file, without success.

## Electron Version

42.3.3 (also reproduced on Electron 41.x)

## What operating system(s) are you using?

Windows

## Operating System Version

Windows 11. (The mechanism is not believed to be platform-specific; the testcase is cross-platform — please confirm on macOS/Linux.)

## What arch are you using?

x64

## Last Known Working Electron version

Unknown — reproduces on both 41.x and 42.3.3 (latest stable at time of writing).

## Expected Behavior

A `"message"` event dispatched via `EventTarget.dispatchEvent()` should always invoke its registered listeners.

## Actual Behavior

In a renderer with `nodeIntegration: true`, when `dispatchEvent()` is called **from a Node.js `net` socket `'data'` callback** and the call **coincides with the V8 inspector transitioning into a paused state** (a breakpoint being hit, or `Debugger.pause` via DevTools / the DevTools Protocol), `dispatchEvent()`:

- returns `true` (i.e. runs to completion), but
- **invokes none of the registered listeners** — even listeners that are never removed,

while a **plain function call on the very next line still executes**. So the JS thread is not frozen; specifically the *listener-invocation* step inside `dispatchEvent` is skipped.

Observed log (the anomaly always lands immediately after a pause is issued):

```
[main] Debugger.pause #857
[renderer] *** ANOMALY *** msg-17032: dispatchEvent returned notCanceled=true, but EventTarget listeners did NOT run (internal=false, external=false); plain callback ran=true. [message #17032]
```

- `notCanceled=true` — the dispatch algorithm completed normally.
- `internal=false external=false` — neither registered `"message"` listener ran (no `removeEventListener` is ever called; tracked listener count stays at 2).
- `plain callback ran=true` — the direct `onMessage(msg)` call on the next line executed.

This was originally hit in a real app where protobuf messages arriving over a socket were decoded and "dispatched" but the registered handlers never ran — **only while debugging with breakpoints**. It is intermittent: the drop happens only when a `dispatchEvent` call lands on a pause transition (observed anywhere from ~40 to ~860 pauses into a run).

## Testcase Gist URL

<!-- Replace with your gist/repo URL for the attached minimal repro -->
(minimal repro attached / linked)

### How to run

```sh
npm install
npm start
```

The app opens a hidden renderer (`nodeIntegration: true`, `contextIsolation: false`) running a `MessageSocket extends EventTarget` pipe **server**; the main process streams length-prefixed messages to it and repeatedly issues `Debugger.pause`/`Debugger.resume` via `webContents.debugger`. For each message the renderer dispatches a `CustomEvent` and also calls a plain callback, then reports an `*** ANOMALY ***` if `dispatchEvent` returned but the listeners didn't run. It exits `0` and prints `REPRODUCED: …` on the first anomaly, or exits `1` after the timeout.

It is timing-sensitive — **if a run times out, run it again** (a clean run does not mean the bug is absent). Tunables are at the top of `main.js`.

## Additional Information

### It is not a V8/Node bug — it requires Blink

A pure-Node control (`node-only/` in the testcase) runs the identical logic — a `net` server, `class … extends EventTarget`, `dispatchEvent` per message — with a Worker thread driving the V8 inspector against the main thread (`inspector.Session.connectToMainThread()` + `Debugger.pause`/`resume`). Run under Electron's own bundled Node via `ELECTRON_RUN_AS_NODE=1` — i.e. **the same V8 build (14.8) as the failing renderer, without Blink** — it does **not** reproduce:

| Configuration | V8 | Real main-thread pauses | Anomalies |
| --- | --- | --- | --- |
| Electron renderer (Blink) | 14.8 (Electron 42.3.3) | hit at pause #857 | **reproduces** |
| Pure Node, same V8, no Blink (`ELECTRON_RUN_AS_NODE=1`) | 14.8 | ~1,900 across two 5-min runs | **0** |

Node's `EventTarget` invokes listeners as plain JS calls, and a V8 inspector pause suspends the isolate at a safepoint without skipping that invocation. The skip appears specific to **Blink's** DOM event-dispatch path — presumably a guard that refuses to enter a fresh listener callframe while the isolate is transitioning into the inspector-paused state — so `dispatchEvent` returns having invoked no listeners while the already-running caller frame continues.

To run the control:

```sh
ELECTRON_RUN_AS_NODE=1 npx electron node-only/repro.js   # same V8 as renderer, no Blink
# or any system Node:
node node-only/repro.js
```

### Versions reproduced on

| Electron | Chromium | V8 |
| --- | --- | --- |
| 42.3.3 (latest stable) | 148.0.7778.218 | 14.8.178.28 |
| 41.x | 146.0.7680.72 | 14.6.202.11 |

(Exact build versions print as the `[env]` line at the top of every run.)

### Workaround

Do not route socket data through `EventTarget`/`dispatchEvent`. A plain callback (or any direct function call) is unaffected — note `plain callback ran=true` on the very message where the listeners were skipped. Replacing the `dispatchEvent("message")` hop with a direct callback fully resolved the dropped messages in the original application.
