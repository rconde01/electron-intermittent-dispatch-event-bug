// Pure-Node control for the Electron dispatchEvent-during-pause bug.
//
// Same shape as the Electron repro, but with NO Chromium/Blink:
//   - MAIN thread: a `net` pipe server + a `MessageSocket extends EventTarget`
//     that dispatches a CustomEvent (and calls a plain onMessage) per message.
//   - A WORKER thread drives the V8 inspector against the main thread
//     (`connectToMainThread` + Debugger.pause/resume) and also acts as the
//     message sender, so it keeps sending while the main thread is paused.
//
// If `dispatchEvent` ever skips its listeners (while returning) coincident with
// a pause, an ANOMALY is logged — exactly as in the Electron version.
//
// Run with system Node:        node repro.js
// Run with Electron's V8/Node:  ELECTRON_RUN_AS_NODE=1 electron repro.js

const net = require("net");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");

const MAX_RUN_MS = 300000;

// CustomEvent has been a Node global since v23/22.1; shim just in case.
const CE =
  globalThis.CustomEvent ||
  class CustomEvent extends Event {
    constructor(type, opts) {
      super(type, opts);
      this.detail = opts && opts.detail;
    }
  };

const PIPE =
  process.platform === "win32"
    ? `\\\\.\\pipe\\node-et-repro-${process.pid}`
    : path.join(os.tmpdir(), `node-et-repro-${process.pid}.sock`);

function log(s) {
  process.stdout.write(s + "\n");
}

log(`[env] node=${process.versions.node} v8=${process.versions.v8} platform=${process.platform}`);

class Decoder {
  #buf = Buffer.alloc(0);
  push(chunk) {
    this.#buf = Buffer.concat([this.#buf, chunk]);
  }
  decode() {
    if (this.#buf.length < 8) return null;
    const len = Number(this.#buf.readBigUInt64LE(0));
    if (this.#buf.length < 8 + len) return null;
    const payload = this.#buf.subarray(8, 8 + len).toString("utf8");
    this.#buf = this.#buf.subarray(8 + len);
    return payload;
  }
}

class MessageSocket extends EventTarget {
  #server = null;
  #decoder = new Decoder();
  onMessage = null;
  _internal = false;
  _external = false;
  _direct = false;
  total = 0;
  anomalies = 0;

  constructor() {
    super();
    this.addEventListener("message", () => {
      this._internal = true;
    });
  }

  connect(pipePath) {
    this.#server = net.createServer((socket) => {
      socket.on("data", (data) => {
        this.#decoder.push(data);
        while (true) {
          const msg = this.#decoder.decode();
          if (msg === null) return;

          this._internal = false;
          this._external = false;
          this._direct = false;

          let nc;
          try {
            nc = this.dispatchEvent(new CE("message", { detail: msg }));
          } catch (err) {
            log(`*** dispatch THREW for ${msg}: ${err}`);
          }
          this.onMessage?.(msg);

          this.total += 1;
          if (!(this._internal && this._external)) {
            this.anomalies += 1;
            log(
              `*** ANOMALY *** ${msg}: dispatchEvent notCanceled=${nc}, listeners NOT run ` +
                `(internal=${this._internal}, external=${this._external}); plain callback ran=${this._direct}. [#${this.total}]`,
            );
          }
        }
      });
    });
    return new Promise((resolve) => {
      this.#server.listen(pipePath, () => {
        log(`server listening on ${pipePath}`);
        resolve();
      });
    });
  }
}

(async () => {
  const ms = new MessageSocket();
  ms.addEventListener("message", () => {
    ms._external = true;
  });
  ms.onMessage = () => {
    ms._direct = true;
  };

  await ms.connect(PIPE);

  const worker = new Worker(path.join(__dirname, "controller-worker.js"), {
    workerData: { pipe: PIPE },
  });
  worker.on("message", (m) => m && m.log && log(`[worker] ${m.log}`));
  worker.on("error", (e) => log(`[worker error] ${e && e.stack ? e.stack : e}`));

  setInterval(() => log(`[heartbeat] received=${ms.total} anomalies=${ms.anomalies}`), 5000);

  setTimeout(() => {
    log(`[done] received=${ms.total} anomalies=${ms.anomalies}`);
    process.exit(ms.anomalies > 0 ? 0 : 1);
  }, MAX_RUN_MS);
})();
