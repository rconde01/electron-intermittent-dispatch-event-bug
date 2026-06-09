// Worker thread: drives the V8 inspector against the MAIN thread (pausing and
// resuming it like a debugger), and acts as the message sender so it keeps
// sending while the main thread is paused.

const { workerData, parentPort } = require("worker_threads");
const inspector = require("inspector");
const net = require("net");

const SEND_INTERVAL_MS = 10;
const PAUSE_PERIOD_MS = 300;
const PAUSE_DURATION_MS = 100;

const tell = (log) => parentPort.postMessage({ log });

// --- Inspector: pause/resume the MAIN thread ------------------------------
const session = new inspector.Session();
try {
  session.connectToMainThread();
} catch (e) {
  tell(`connectToMainThread failed: ${e}`);
}

let pauseEvents = 0;
session.on("Debugger.paused", () => {
  pauseEvents += 1;
});

session.post("Debugger.enable", (err) => {
  if (err) {
    tell(`Debugger.enable error: ${err.message}`);
    return;
  }
  tell("Debugger.enable ok (controlling main thread)");

  let pauseCmds = 0;
  setInterval(() => {
    pauseCmds += 1;
    if (pauseCmds % 50 === 0) {
      tell(`pause commands=${pauseCmds}, main paused events observed=${pauseEvents}`);
    }
    session.post("Debugger.pause", () => {});
    setTimeout(() => session.post("Debugger.resume", () => {}), PAUSE_DURATION_MS);
  }, PAUSE_PERIOD_MS);
});

// --- Sender ----------------------------------------------------------------
const client = net.connect(workerData.pipe, () => {
  tell("sender connected");
  let seq = 0;
  const send = (s) => {
    const payload = Buffer.from(s, "utf8");
    const head = Buffer.alloc(8);
    head.writeBigUInt64LE(BigInt(payload.length), 0);
    client.write(head);
    client.write(payload);
  };
  setInterval(() => send(`msg-${++seq}`), SEND_INTERVAL_MS);
});
client.on("error", (e) => tell(`sender error: ${e.message}`));
