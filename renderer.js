// Renderer (nodeIntegration, no contextIsolation).
//
// Acts as a local pipe SERVER. For every length-prefixed message it receives,
// it dispatches a DOM CustomEvent on a MessageSocket (which `extends EventTarget`)
// AND calls a plain `onMessage` callback. It then checks whether the EventTarget
// listeners actually ran.
//
// BUG: when `dispatchEvent` is called at the instant the V8 inspector is
// transitioning into a paused state, the dispatch returns `true` but invokes
// ZERO listeners — while the plain callback on the next line still runs. Any
// such message is reported as an ANOMALY.

const net = require("net");
const os = require("os");
const path = require("path");
const { ipcRenderer } = require("electron");

function log(...args) {
  ipcRenderer.send(
    "log",
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
  );
}

// Length-prefixed framing: 8-byte little-endian length + payload.
const PIPE =
  process.platform === "win32"
    ? `\\\\.\\pipe\\et-repro-${process.pid}`
    : path.join(os.tmpdir(), `et-repro-${process.pid}.sock`);

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

  // Per-message firing flags.
  _internal = false;
  _external = false;
  _direct = false;

  total = 0;
  anomalies = 0;
  reported = false;

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

          let notCanceled;
          try {
            notCanceled = this.dispatchEvent(new CustomEvent("message", { detail: msg }));
          } catch (err) {
            log(`*** dispatch THREW for ${msg}: ${err}`);
          }
          // Plain callback on the very next line — for contrast.
          this.onMessage?.(msg);

          this.total += 1;
          if (!(this._internal && this._external)) {
            this.anomalies += 1;
            log(
              `*** ANOMALY *** ${msg}: dispatchEvent returned notCanceled=${notCanceled}, ` +
                `but EventTarget listeners did NOT run ` +
                `(internal=${this._internal}, external=${this._external}); ` +
                `plain callback ran=${this._direct}. [message #${this.total}]`,
            );
            if (!this.reported) {
              this.reported = true;
              ipcRenderer.send("anomaly", { msg, total: this.total });
            }
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

async function main() {
  const ms = new MessageSocket();
  ms.addEventListener("message", () => {
    ms._external = true;
  });
  ms.onMessage = () => {
    ms._direct = true;
  };

  await ms.connect(PIPE);
  ipcRenderer.send("listening", PIPE);

  setInterval(() => {
    log(`[heartbeat] received=${ms.total} anomalies=${ms.anomalies}`);
  }, 2000);
}

main().catch((e) => log("renderer error: " + ((e && e.stack) || e)));
