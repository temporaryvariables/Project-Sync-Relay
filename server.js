// Link: https://github.com/temporaryvariables/Project-Sync-Relay
// rover-relay-starter
// =============================================================================
// This is your STARTING POINT — a deliberately empty scaffold.
//
// Mission Control (the Deep Space Network) sends each command to this service at
// POST /replicate. Your job is to forward every command to the three ground
// stations (NASA, ESA, JAXA) so they all end up holding the same value, in the
// right order, even when deep space gets noisy (blackouts, throttling, latency,
// out-of-order delivery).
//
// Right now this scaffold does almost nothing: it accepts the request, writes a
// single example log line, and returns an empty response. It does NOT talk to
// the stations yet — that part is up to you.
//
// Your mission: implement the forwarding inside POST /replicate. Suggested order
// of difficulty as you make it resilient:
//   1. Write to all three stations (start sequential, then go parallel).
//   2. Retry with exponential backoff when a station returns HTTP 500.
//   3. Respect HTTP 429 + Retry-After when a station is throttling.
//   4. Keep sequence numbers monotonic so stale writes (HTTP 409) don't win.
//   5. Add a queue / persistence so nothing is lost mid-flight.
// =============================================================================

// `express` is the HTTP framework that turns this file into a web server.
import express from "express";
// `cors` lets browsers and other origins call this service without being blocked
// by the browser's same-origin policy. Mission Control runs on a different host,
// so we enable it. 
import cors from "cors";

// The TCP port this server listens on. Read it from the environment if present
// (your hosting platform sets PORT), otherwise default to 4000 for local dev.
const PORT = process.env.PORT || 4000;

// Where the three ground stations live. You will send your PUT writes to URLs
// built from this base, e.g. `${GROUND_STATION_URL}/groundstation/nasa/<selector>`.
// `normalizeUrl` (defined below) tolerates a bare host or a full http(s) URL.
const GROUND_STATION_URL = normalizeUrl(process.env.GROUND_STATION_URL, "http://localhost:3001");

// Where to send your own log lines so they appear in Mission Control's trace,
// interleaved with the platform's logs for the same command. Point this at the
// same Flight Director URL Mission Control uses. Set RELAY_LOGGING=false to mute.
const FLIGHT_DIRECTOR_URL = normalizeUrl(process.env.FLIGHT_DIRECTOR_URL, "http://localhost:3002");

// A simple on/off switch for your logging. Logging is on unless you explicitly
// set RELAY_LOGGING=false. (`!== "false"` means "anything other than the string
// 'false' counts as enabled".)
const RELAY_LOGGING = process.env.RELAY_LOGGING !== "false";

// The three stations you must keep in sync. You'll loop over these when you
// implement forwarding. Left here as a hint — nothing reads it yet.
const STATIONS = ["nasa", "esa", "jaxa"];

// Accept a service URL with or without a scheme. A bare host like
// "stations.example.com" becomes "https://stations.example.com", while an
// explicit "http://ground-station-api:3001" is left untouched. This keeps the
// env vars forgiving whether you paste a domain or a full URL.
function normalizeUrl(value, fallback) {
  // Use the provided value, fall back to the default, and trim stray whitespace.
  const v = (value || fallback || "").trim();
  // If it's empty, return it as-is (nothing to normalize).
  if (!v) return v;
  // If it already starts with http:// or https://, keep it; otherwise assume https.
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

function buildStationUrl(station, selector) {
  return `${GROUND_STATION_URL}/groundstation/${station}/${selector}`;
}

// Create the Express application instance.
const app = express();
// Enable CORS for every route so cross-origin callers (Mission Control) are allowed.
app.use(cors());
// Parse incoming JSON request bodies into `req.body` automatically.
app.use(express.json());

// -----------------------------------------------------------------------------
// missionLog(): send ONE line of your own story to Mission Control.
//
// What it does: makes a fire-and-forget POST to the Flight Director's /logs
// endpoint. "Fire and forget" means we never `await` it and we swallow any
// error (`.catch(() => {})`), so logging can never slow down or break a
// replication. If logging is disabled, or we're missing the auth token /
// correlation id / Flight Director URL, it simply does nothing.
//
// Why a correlation id: every command carries an X-Correlation-Id. Sending it
// with your log lets Mission Control stitch your message into the same end-to-end
// trace as the platform's own log lines for that command.
//
// Fields you can pass:
//   level      "info" | "success" | "warn" | "error"  (controls the color/badge)
//   step       a short machine name for this moment, e.g. "relay.received"
//   selector   which command this is about
//   station    optional station name if the line is about one station
//   message    the human-readable sentence shown in the dashboard
//   properties any extra key/values to attach (shown as chips in the trace)
// -----------------------------------------------------------------------------
function missionLog(token, correlationId, { level = "info", step, selector, station, message, properties = {} }) {
  // Bail out unless logging is on and we have everything we need.
  if (!RELAY_LOGGING || !token || !correlationId || !FLIGHT_DIRECTOR_URL) return;
  // The Flight Director expects a Bearer token; add the prefix if it's missing.
  const auth = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  // POST the log event. We do not await this promise — it runs in the background.
  fetch(`${FLIGHT_DIRECTOR_URL}/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({
      ts: new Date().toISOString(), // when this happened, for correct ordering
      service: "rover-relay",        // who emitted it (labeled "Relay" in the UI)
      level,                          // info/success/warn/error
      step: step || "relay.note",    // a short machine name for this step
      selector,                       // which command
      station,                        // optional station this line is about
      message,                        // the human-readable sentence
      correlation_id: correlationId,  // ties this line into the command's trace
      meta: properties,               // any extra structured detail
    }),
  }).catch(() => { }); // ignore network/log errors entirely
}

// A health check so your platform (and Mission Control) can confirm the relay is
// up. Returns a tiny JSON object with HTTP 200.
app.get("/health", (_req, res) => res.json({ status: "ok", service: "rover-relay-starter" }));
app.get("/ReturnHelloWorld", (_req, res) => res.json({ status: "ok", service: "rover-relay-starter", message: "Hello, World!" }));
app.post("/ReturnMyName/:name", (req, res) => {
  const name = req.params.name || "";
  res.json({ status: "ok", service: "rover-relay-starter", message: `Hello, my name is ${name}!` });
});

const MAX_STATION_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 5000;
const QUEUE_RETRY_DELAY_MS = 1000;
const commandQueue = [];
let isProcessingQueue = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(header) {
  if (!header) return null;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds)) {
    return Math.max(seconds * 1000, 0);
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : Math.max(parsed - Date.now(), 0);
}

function isServerError(status) {
  return status >= 500 && status < 600;
}

async function writeToStation({ station, selector, payload, sequence_number, auth, correlationId }) {
  const url = buildStationUrl(station, selector);
  const headers = {
    "Content-Type": "application/json",
    Authorization: auth,
    "X-Correlation-Id": correlationId,
  };
  const body = JSON.stringify({ payload, sequence_number });

  for (let attempt = 1; attempt <= MAX_STATION_ATTEMPTS; attempt += 1) {
    missionLog(auth, correlationId, {
      level: "info",
      step: "relay.station.write",
      selector,
      station,
      message: `Sending ${selector} to ${station.toUpperCase()} (attempt ${attempt}).`,
      properties: { attempt, sequence_number },
    });

    let response;
    try {
      response = await fetch(url, { method: "PUT", headers, body });
    } catch (error) {
      missionLog(auth, correlationId, {
        level: "warn",
        step: "relay.station.network",
        selector,
        station,
        message: `${station.toUpperCase()} network error on attempt ${attempt}.`,
        properties: { error: error?.message || "unknown" },
      });
      if (attempt === MAX_STATION_ATTEMPTS) {
        const err = new Error(`station_network_failure:${station}`);
        err.code = "STATION_FAILURE";
        throw err;
      }
      await delay(Math.min(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS));
      continue;
    }

    if (response.ok) {
      missionLog(auth, correlationId, {
        level: "success",
        step: "relay.station.success",
        selector,
        station,
        message: `${station.toUpperCase()} accepted ${selector} on attempt ${attempt}.`,
        properties: { status: response.status },
      });
      return;
    }

    const responseText = await response.text().catch(() => "<unreadable>");

    if (response.status === 409) {
      missionLog(auth, correlationId, {
        level: "warn",
        step: "relay.station.conflict",
        selector,
        station,
        message: `${station.toUpperCase()} rejected ${selector} because sequence ${sequence_number} is stale.`,
        properties: { status: response.status, body: responseText },
      });
      const err = new Error(`stale_sequence:${station}`);
      err.code = "STALE_SEQUENCE";
      throw err;
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after")) ?? Math.min(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      missionLog(auth, correlationId, {
        level: "warn",
        step: "relay.station.throttled",
        selector,
        station,
        message: `${station.toUpperCase()} throttled ${selector}, retrying in ${retryAfterMs}ms.`,
        properties: { status: response.status, retryAfterMs, body: responseText },
      });
      await delay(retryAfterMs);
      continue;
    }

    if (isServerError(response.status)) {
      const backoff = Math.min(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      missionLog(auth, correlationId, {
        level: "warn",
        step: "relay.station.retry",
        selector,
        station,
        message: `${station.toUpperCase()} returned ${response.status}. Retrying in ${backoff}ms.`,
        properties: { status: response.status, body: responseText },
      });
      await delay(backoff);
      continue;
    }

    missionLog(auth, correlationId, {
      level: "error",
      step: "relay.station.failed",
      selector,
      station,
      message: `${station.toUpperCase()} rejected ${selector} with status ${response.status}.`,
      properties: { status: response.status, body: responseText },
    });
    const err = new Error(`station_failed:${station}:${response.status}`);
    err.code = "STATION_FAILURE";
    throw err;
  }

  const err = new Error(`max_retries_exceeded:${station}`);
  err.code = "MAX_RETRIES_EXCEEDED";
  missionLog(auth, correlationId, {
    level: "error",
    step: "relay.station.failed",
    selector,
    station,
    message: `${station.toUpperCase()} did not succeed after ${MAX_STATION_ATTEMPTS} attempts.`,
    properties: {},
  });
  throw err;
}

async function replicateCommand({ selector, payload, sequence_number, auth, correlationId }) {
  missionLog(auth, correlationId, {
    level: "info",
    step: "relay.replicate.start",
    selector,
    message: `Beginning replication for ${selector}.`,
    properties: { payload, sequence_number },
  });

  const stationWrites = STATIONS.map((station) =>
    writeToStation({ station, selector, payload, sequence_number, auth, correlationId })
  );

  const results = await Promise.allSettled(stationWrites);
  const rejected = results.filter((item) => item.status === "rejected");
  const stale = rejected.find((item) => item.reason?.code === "STALE_SEQUENCE");

  if (stale) {
    missionLog(auth, correlationId, {
      level: "warn",
      step: "relay.replicate.stale",
      selector,
      message: `Command ${selector} is stale and will not be retried.`,
      properties: { station: stale.reason?.message },
    });
    throw stale.reason;
  }

  if (rejected.length > 0) {
    const errors = rejected.map((item) => item.reason?.message || "unknown");
    missionLog(auth, correlationId, {
      level: "error",
      step: "relay.replicate.failed",
      selector,
      message: `Replication failed for ${rejected.length}/${STATIONS.length} stations.`,
      properties: { errors },
    });
    throw rejected[0].reason;
  }

  missionLog(auth, correlationId, {
    level: "success",
    step: "relay.replicate.completed",
    selector,
    message: `Replication completed for ${selector}.`,
    properties: { payload, sequence_number },
  });
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (commandQueue.length > 0) {
    const command = commandQueue[0];
    try {
      await replicateCommand(command);
      commandQueue.shift();
    } catch (error) {
      if (error?.code === "STALE_SEQUENCE") {
        commandQueue.shift();
        continue;
      }
      missionLog(command.auth, command.correlationId, {
        level: "warn",
        step: "relay.queue.retry",
        selector: command.selector,
        message: `Retrying ${command.selector} after transient failure.`,
        properties: { error: error?.message || "unknown" },
      });
      await delay(QUEUE_RETRY_DELAY_MS);
    }
  }

  isProcessingQueue = false;
}

function enqueueCommand(command) {
  commandQueue.push(command);
  processQueue().catch((err) => {
    console.error("Queue processing error", err);
  });
}

app.post("/replicate", (req, res) => {
  const { selector, payload, sequence_number } = req.body || {};
  const auth = req.headers.authorization || "";
  const correlationId = req.headers["x-correlation-id"] || "";

  if (!selector || typeof selector !== "string") {
    return res.status(400).json({ error: "invalid_request", message: "selector is required and must be a string." });
  }

  if (typeof sequence_number !== "number" || !Number.isInteger(sequence_number) || sequence_number < 0) {
    return res.status(400).json({ error: "invalid_request", message: "sequence_number is required and must be a non-negative integer." });
  }

  if (payload === undefined) {
    return res.status(400).json({ error: "invalid_request", message: "payload is required." });
  }

  enqueueCommand({ selector, payload, sequence_number, auth, correlationId });
  missionLog(auth, correlationId, {
    level: "info",
    step: "relay.enqueued",
    selector,
    message: `Queued ${selector} for replication to all stations.`,
    properties: { payload, sequence_number },
  });

  return res.status(200).end();
});

// Start listening for requests and print where we're pointed, to make local
// debugging easier. Bind to 0.0.0.0 (all interfaces) so the container is
// reachable from Coolify's reverse proxy — binding to localhost would make the
// proxy fail with "Bad Gateway".
app.listen(PORT, "0.0.0.0", () => {
  console.log(`rover-relay-starter listening on 0.0.0.0:${PORT}`);
  console.log(`forwarding target (once you implement it): ${GROUND_STATION_URL}`);
});
