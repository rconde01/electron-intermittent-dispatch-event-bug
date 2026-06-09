// Electron main process.
//
// - Opens a hidden renderer (nodeIntegration, no contextIsolation).
// - Attaches the DevTools Protocol so it can genuinely suspend the renderer's
//   V8 isolate (a real breakpoint pause), then resume it — repeatedly.
// - Acts as the message SENDER: connects to the renderer's pipe server and
//   streams length-prefixed messages continuously.
//
// The renderer reports an "anomaly" the first time a dispatched DOM event fails
// to invoke its listeners (the bug). We then print a result and exit.

const { app, BrowserWindow, ipcMain } = require("electron");
const net = require("net");
const path = require("path");
const fs = require("fs");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

// ---- Tunables -------------------------------------------------------------
const SEND_INTERVAL_MS = 10; // how often to send a message
const PAUSE_PERIOD_MS = 300; // how often to pause the renderer
const PAUSE_DURATION_MS = 100; // how long each pause lasts
const MAX_RUN_MS = 120000; // give up (no repro) after this long
// ---------------------------------------------------------------------------

const LOG = path.join(__dirname, "run.log");
try {
  fs.writeFileSync(LOG, "");
} catch {}

function out(s) {
  const line = s + "\n";
  try {
    fs.appendFileSync(LOG, line);
  } catch {}
  process.stdout.write(line);
}

app.whenReady().then(() => {
  out(
    `[env] electron=${process.versions.electron} chrome=${process.versions.chrome} ` +
      `node=${process.versions.node} v8=${process.versions.v8} platform=${process.platform}`,
  );

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
    },
  });

  const dbg = win.webContents.debugger;
  let client = null;
  let sendTimer = null;
  let pauseTimer = null;
  let pauseCount = 0;
  let seq = 0;
  let finished = false;

  const forceExit = (code) => {
    if (finished) return;
    finished = true;
    if (sendTimer) clearInterval(sendTimer);
    if (pauseTimer) clearInterval(pauseTimer);
    try {
      if (dbg.isAttached()) dbg.detach();
    } catch {}
    try {
      client && client.destroy();
    } catch {}
    setTimeout(() => app.exit(code), 100);
  };

  ipcMain.on("log", (_e, msg) => out(`[renderer] ${msg}`));

  ipcMain.on("anomaly", (_e, info) => {
    out("");
    out("============================================================");
    out(`REPRODUCED: ${JSON.stringify(info)}`);
    out(`Total pauses issued before repro: ${pauseCount}`);
    out("dispatchEvent() returned but invoked zero listeners, coincident");
    out("with a Debugger.pause transition. See the *** ANOMALY *** line.");
    out("============================================================");
    forceExit(0);
  });

  ipcMain.on("listening", (_e, pipePath) => {
    out(`[main] renderer listening on ${pipePath}; connecting sender + starting pause cycle`);

    client = net.connect(pipePath, () => {
      const send = (s) => {
        const payload = Buffer.from(s, "utf8");
        const head = Buffer.alloc(8);
        head.writeBigUInt64LE(BigInt(payload.length), 0);
        client.write(head);
        client.write(payload);
      };
      sendTimer = setInterval(() => send(`msg-${++seq}`), SEND_INTERVAL_MS);
    });
    client.on("error", (e) => out(`[main] sender error: ${e.message}`));

    pauseTimer = setInterval(() => {
      pauseCount += 1;
      out(`[main] Debugger.pause #${pauseCount}`);
      dbg.sendCommand("Debugger.pause").catch(() => {});
      setTimeout(() => dbg.sendCommand("Debugger.resume").catch(() => {}), PAUSE_DURATION_MS);
    }, PAUSE_PERIOD_MS);
  });

  win.loadFile("index.html");

  // Attach the debugger only after the page has loaded.
  win.webContents.on("did-finish-load", () => {
    try {
      dbg.attach("1.3");
      dbg
        .sendCommand("Debugger.enable")
        .then(() => out("[main] debugger attached + Debugger.enable ok"))
        .catch((e) => out(`[main] Debugger.enable error: ${e}`));
    } catch (e) {
      out(`[main] debugger attach failed: ${e}`);
    }
  });

  setTimeout(() => {
    out(`[main] no anomaly within ${MAX_RUN_MS}ms (timing-sensitive — try re-running)`);
    forceExit(1);
  }, MAX_RUN_MS);
});

app.on("window-all-closed", () => app.quit());
