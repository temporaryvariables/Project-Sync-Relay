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

// -----------------------------------------------------------------------------
// POST /replicate — the heart of your relay (currently a stub).
//
// Mission Control calls this once per command. The body looks like:
//   { "selector": "cmd-4821", "payload": "fire_thruster", "sequence_number": 12 }
//
// This scaffold does NOT validate the body and does NOT forward to the stations.
// It just reads the trace context, emits one example log, and returns an empty
// response. Replace the TODO below with your real forwarding logic.
// -----------------------------------------------------------------------------
app.post("/replicate", async (req, res) => {
  // Pull the command fields out of the JSON body. (No validation on purpose —
  // add your own checks here later if you want.)
  const { selector, payload, sequence_number } = req.body || {};

  // Mission Control forwards the caller's PocketBase token in the Authorization
  // header. You must pass this straight through on every call you make to the
  // ground stations so they can identify your team.
  const auth = req.headers.authorization || "";

  // The X-Correlation-Id header ties every hop of this one command together so
  // the dashboard can render a single end-to-end trace. Read it here and forward
  // it on every station request you make — good distributed-systems hygiene.
  const correlationId = req.headers["x-correlation-id"] || "";

  // The single example log line. This shows up in Mission Control's trace for
  // this command as an "info" entry from "Relay", proving your logging works and
  // giving you a template to copy. Add more missionLog(...) calls as you build
  // out the forwarding (e.g. one per station result).
  missionLog(auth, correlationId, {
    level: "info",
    step: "relay.received",
    selector,
    message: `Relay received ${selector} ("${payload}") — implement forwarding to the stations next. (Hello World!)`,
    properties: { payload, sequence_number },
  });

  const station = "nasa";
  const url = `${GROUND_STATION_URL}/groundstation/${station}/${selector}`;

  // Make the write. We `await` so we know the outcome before responding.
  await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,          // pass the caller's token through unchanged
      "X-Correlation-Id": correlationId, // keep the whole command in one trace
    },
    body: JSON.stringify({
      "payload": payload,
      "sequence_number": sequence_number,
    }),
  });

  // TODO (your mission): forward this command to NASA, ESA and JAXA, e.g.
  //   PUT `${GROUND_STATION_URL}/groundstation/<station>/${selector}`
  //   headers: Authorization: auth, X-Correlation-Id: correlationId
  //   body:    { payload, sequence_number }
  // Start simple (one station, then all three), then add retries, parallelism,
  // Retry-After handling, and sequence-number safeguards.

  // Return an empty 200 response for now. Mission Control only needs a quick
  // acknowledgement; the real work is the station writes you'll add above.
  res.status(200).end();
});

// Start listening for requests and print where we're pointed, to make local
// debugging easier. Bind to 0.0.0.0 (all interfaces) so the container is
// reachable from Coolify's reverse proxy — binding to localhost would make the
// proxy fail with "Bad Gateway".
app.listen(PORT, "0.0.0.0", () => {
  console.log(`rover-relay-starter listening on 0.0.0.0:${PORT}`);
  console.log(`forwarding target (once you implement it): ${GROUND_STATION_URL}`);
});
