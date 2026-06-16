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
// =============================================================================

import express from "express";
import cors from "cors";

const PORT = process.env.PORT || 4000;
const GROUND_STATION_URL = normalizeUrl(process.env.GROUND_STATION_URL, "http://localhost:3001");
const FLIGHT_DIRECTOR_URL = normalizeUrl(process.env.FLIGHT_DIRECTOR_URL, "http://localhost:3002");
const RELAY_LOGGING = process.env.RELAY_LOGGING !== "false";
const STATIONS = ["nasa", "esa", "jaxa"];

// Tracks the last successfully forwarded sequence_number per selector.
// Used to detect and reject stale/duplicate writes before hitting the stations.
const lastSequence = new Map();

function normalizeUrl(value, fallback) {
  const v = (value || fallback || "").trim();
  if (!v) return v;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const app = express();
app.use(cors());
app.use(express.json());

function missionLog(token, correlationId, { level = "info", step, selector, station, message, properties = {} }) {
  if (!RELAY_LOGGING || !token || !correlationId || !FLIGHT_DIRECTOR_URL) return;
  const auth = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  fetch(`${FLIGHT_DIRECTOR_URL}/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({
      ts: new Date().toISOString(),
      service: "rover-relay",
      level,
      step: step || "relay.note",
      selector,
      station,
      message,
      correlation_id: correlationId,
      meta: properties,
    }),
  }).catch(() => {});
}

// Write to one station with retries for 500 (blackout) and 429 (throttle).
async function writeToStation(station, selector, payload, sequence_number, auth, correlationId) {
  const url = `${GROUND_STATION_URL}/groundstation/${station}/${selector}`;
  const MAX_RETRIES = 8;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
          "X-Correlation-Id": correlationId,
        },
        body: JSON.stringify({ payload, sequence_number }),
      });
    } catch (err) {
      // Network error — treat like a 500 and retry with backoff
      const backoff = Math.min(500 * Math.pow(2, attempt), 30000);
      missionLog(auth, correlationId, {
        level: "warn",
        step: "relay.network-error",
        selector,
        station,
        message: `Network error writing to ${station}, retrying in ${backoff}ms (attempt ${attempt + 1})`,
        properties: { error: String(err) },
      });
      await sleep(backoff);
      continue;
    }

    if (res.ok) {
      missionLog(auth, correlationId, {
        level: "success",
        step: "relay.written",
        selector,
        station,
        message: `Successfully wrote "${payload}" to ${station}`,
        properties: { sequence_number },
      });
      return { station, success: true };
    }

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const retryAfter = data.retry_after_ms || 1000;
      missionLog(auth, correlationId, {
        level: "warn",
        step: "relay.throttled",
        selector,
        station,
        message: `${station} is throttling — waiting ${retryAfter}ms before retry`,
        properties: { retry_after_ms: retryAfter, attempt },
      });
      await sleep(retryAfter);
      continue;
    }

    if (res.status === 500) {
      const backoff = Math.min(500 * Math.pow(2, attempt), 30000);
      missionLog(auth, correlationId, {
        level: "warn",
        step: "relay.blackout",
        selector,
        station,
        message: `${station} blacked out (500) — retrying in ${backoff}ms (attempt ${attempt + 1})`,
        properties: { backoff_ms: backoff, attempt },
      });
      await sleep(backoff);
      continue;
    }

    if (res.status === 409) {
      missionLog(auth, correlationId, {
        level: "warn",
        step: "relay.stale-sequence",
        selector,
        station,
        message: `${station} rejected write — stale sequence_number ${sequence_number} (409)`,
        properties: { sequence_number },
      });
      return { station, success: false, status: 409 };
    }

    // 401, 403, 404 — don't retry
    missionLog(auth, correlationId, {
      level: "error",
      step: "relay.write-failed",
      selector,
      station,
      message: `${station} returned ${res.status} — not retrying`,
      properties: { status: res.status },
    });
    return { station, success: false, status: res.status };
  }

  missionLog(auth, correlationId, {
    level: "error",
    step: "relay.max-retries",
    selector,
    station,
    message: `Gave up writing to ${station} after ${MAX_RETRIES} attempts`,
    properties: { sequence_number },
  });
  return { station, success: false, error: "max retries exceeded" };
}

// -----------------------------------------------------------------------------
// Practice endpoints from the meeting demo
// -----------------------------------------------------------------------------

app.get("/ReturnHelloWorld", (_req, res) => {
  res.json({ message: "Hello World" });
});

app.post("/ReturnMyName/:name", (req, res) => {
  const { name } = req.params;
  res.json({ message: `Hello my name is ${name}.` });
});

// Health check — confirms the relay is up and running.
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "rover-relay", team: "dea", message: "Dea's relay is online and ready!" });
});

// -----------------------------------------------------------------------------
// POST /replicate — fan out to all three stations in parallel with retries.
// -----------------------------------------------------------------------------
app.post("/replicate", async (req, res) => {
  const { selector, payload, sequence_number } = req.body || {};
  const auth = req.headers.authorization || "";
  const correlationId = req.headers["x-correlation-id"] || "";

  // Sequence number validation: reject commands that are older than what we
  // already forwarded for this selector, to prevent stale writes winning.
  if (selector && sequence_number != null) {
    const last = lastSequence.get(selector);
    if (last != null && sequence_number <= last) {
      missionLog(auth, correlationId, {
        level: "warn",
        step: "relay.seq-rejected",
        selector,
        message: `Dropping stale command: sequence_number ${sequence_number} <= last seen ${last}`,
        properties: { sequence_number, last_sequence: last },
      });
      return res.status(409).json({ error: "stale sequence_number", last_sequence: last });
    }
  }

  missionLog(auth, correlationId, {
    level: "info",
    step: "relay.received",
    selector,
    message: `Relay received ${selector} ("${payload}") — forwarding to all 3 stations in parallel`,
    properties: { payload, sequence_number },
  });

  // Fan out to all three stations simultaneously.
  const results = await Promise.all(
    STATIONS.map((station) =>
      writeToStation(station, selector, payload, sequence_number, auth, correlationId)
    )
  );

  // Update our sequence tracking on any success.
  const anySuccess = results.some((r) => r.success);
  if (anySuccess && selector && sequence_number != null) {
    const current = lastSequence.get(selector) ?? -Infinity;
    if (sequence_number > current) {
      lastSequence.set(selector, sequence_number);
    }
  }

  const allSuccess = results.every((r) => r.success);
  missionLog(auth, correlationId, {
    level: allSuccess ? "success" : "warn",
    step: "relay.complete",
    selector,
    message: allSuccess
      ? `All 3 stations confirmed "${payload}"`
      : `Partial sync: ${results.filter((r) => r.success).map((r) => r.station).join(", ")} succeeded`,
    properties: { results: results.map((r) => ({ station: r.station, success: r.success })) },
  });

  res.status(200).json({ ok: true, results });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`rover-relay-starter listening on 0.0.0.0:${PORT}`);
  console.log(`forwarding target: ${GROUND_STATION_URL}`);
});
