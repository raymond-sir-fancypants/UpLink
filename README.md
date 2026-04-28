# UpLink

A lightweight, dependency-free JavaScript library for monitoring real internet connectivity in the browser.

Unlike `navigator.onLine` and the native `online`/`offline` window events — which only detect whether a network interface is present — UpLink actively pings remote endpoints to verify actual internet access. This catches common failure cases like being connected to a router with no WAN, sitting behind a captive portal, or having an intermittent mobile signal.

---

## What's new in v2.0.1

- **Native event hybrid monitoring** — UpLink now listens to the browser's native `online` and `offline` window events as early-warning signals. When either fires, UpLink immediately restarts its polling loop to run a confirmation ping ahead of the next scheduled cycle — catching outages faster without relying solely on the timer.
- **Debounce buffers** — separate 2-second debounce buffers on the `online` and `offline` native events prevent flickering connections from triggering repeated restarts. Kept separate so a genuine rapid offline → online transition is never masked.
- **Duplicate polling guard** — `startPollingNetwork()` now returns immediately if polling is already running, preventing duplicate loops.
- **Simplified `reliability` scoring** — the success rate now counts any ping that did not fail outright. High-latency pings are treated as successes — only complete failures (`Infinity`) penalise the score.

---

## Features

- 📦 Zero dependencies
- 🔒 Fully encapsulated state — enforced by private class fields
- 🌐 Dual endpoint with automatic fallback and recovery
- 📡 Hybrid monitoring — active polling confirmed by native browser events
- 📶 Signal bars (0–5) and named condition states
- ⚡ Latency, jitter, and reliability tracking over a rolling 10-ping window
- 🔋 Tab-aware — pauses when the tab is hidden, resumes when visible
- 🎯 Event-driven API built on native `EventTarget`
- ⚙️ Fully configurable thresholds, intervals, and endpoints

---

## Browser Support

UpLink uses the following modern browser features:

| Feature | Supported since |
|---|---|
| Private class fields (`#field`) | Chrome 74, Firefox 90, Safari 14.1 (2021) |
| `AbortController` | Chrome 66, Firefox 57, Safari 12.1 (2018) |
| `fetch` with `no-cors` | Chrome 42, Firefox 39, Safari 10.1 (2016) |
| `EventTarget` constructor | Chrome 64, Firefox 59, Safari 14 (2020) |
| `document.visibilityState` | Chrome 33, Firefox 18, Safari 7 (2013) |

**Effective minimum:** all modern browsers released after mid-2021. Not compatible with Internet Explorer.

---

## Installation

Copy `UpLink.js` into your project and import it:

```js
import UpLink from './UpLink.js';
```

Polling starts immediately on import with default settings.

---

## Important — Call `config()` First, and Only Once

`config()` should be the **very first call** after importing UpLink, before attaching any event listeners or reading any properties. It stops the current polling loop, applies your settings, then restarts cleanly.

**`config()` can only be called once.** Calling it a second time throws an `UpLinkError` with code `ALREADY_CONFIGURED`. This is intentional — re-configuring a live monitor mid-session would produce unpredictable results.

```js
// ✅ Correct — config first, then listeners
import UpLink from './UpLink.js';

UpLink.config({
  pollingIntervals: { stable: 10000 }
});

UpLink.addEventListener("ping", handler);
```

```js
// ⚠️ Avoid — listeners may fire with default settings before config runs
UpLink.addEventListener("ping", handler);
UpLink.config({ pollingIntervals: { stable: 10000 } });
```

```js
// ❌ Will throw ALREADY_CONFIGURED
UpLink.config({ pollingIntervals: { stable: 10000 } });
UpLink.config({ latencyThresholds: { optimal: 50 } });
```

---

## Quick Start

```js
import UpLink from './UpLink.js';

UpLink.config({
  pollingIntervals: { stable: 8000 },
  latencyThresholds: { optimal: 80, stable: 200, highLatency: 400, degraded: 600 }
});

// Fires on every ping cycle
UpLink.addEventListener("ping", (e) => {
  console.log(e.detail.condition.label); // "Optimal", "Stable", "High Latency" etc.
  console.log(e.detail.latency);         // average ms
  console.log(e.detail.bars);            // 0–5
  console.log(e.detail.jitter);          // average jitter in ms
  console.log(e.detail.reliability);     // 0–100 score
});

// Fires once when connectivity is lost
UpLink.addEventListener("offline", () => {
  console.log("Connection lost");
});

// Fires once when connectivity is restored
UpLink.addEventListener("online", () => {
  console.log("Back online");
});
```

---

## API

### `UpLink.config(options)`

Configures UpLink. **Call once, before anything else.**

| Option | Type | Description |
|---|---|---|
| `endPoints` | `Object` | Custom polling endpoints |
| `latencyThresholds` | `Object` | Override ms thresholds for condition classification |
| `pollingIntervals` | `Object` | Override polling interval durations in ms |
| `silenceWarnings` | `boolean` | Suppress console warnings about unusually low thresholds |

#### `endPoints`

```js
UpLink.config({
  endPoints: {
    main: 'https://my-server.com/ping',
    backup: 'https://dns.google/resolve?name=.&type=NS'
  }
});
```

Both endpoints must support `no-cors` fetch mode. If `main` times out, UpLink automatically switches to `backup` and checks every 5 minutes whether `main` has recovered.

#### `latencyThresholds`

```js
UpLink.config({
  latencyThresholds: {
    optimal: 80,      // below 80ms   → Optimal      (5 bars)
    stable: 200,      // below 200ms  → Stable       (4 bars)
    highLatency: 400, // below 400ms  → High Latency (3 bars)
    degraded: 600     // below 600ms  → Degraded     (2 bars)
                      // above 600ms  → Critical     (1 bar)
                      // Infinity     → Disconnected (0 bars)
  }
});
```

Values must be in **strictly ascending order**. Values ≤ 10ms throw a `CONFIG_ERR`. Values ≤ 30ms log a warning unless `silenceWarnings: true`.

#### `pollingIntervals`

```js
UpLink.config({
  pollingIntervals: {
    unstable: 2000,    // condition changing (default: 2000ms)
    stabilising: 5000, // after 10 same-condition pings (default: 4000ms)
    stable: 10000      // after 20 same-condition pings (default: 6000ms)
  }
});
```

Minimum allowed value is **500ms** to prevent network flooding.

---

### `UpLink.startPollingNetwork()`

Starts the polling loop and attaches the `visibilitychange`, `offline`, and `online`
listeners. If polling is already running, this call is silently ignored — no duplicate
loops can be created.

Called automatically on import and after `config()`. You can also call it manually
to resume after `stopPollingNetwork()`.

---

### `UpLink.stopPollingNetwork()`

Stops the polling loop, cancels all pending fetches and timers, and removes the
`visibilitychange`, `offline`, and `online` listeners by aborting the shared
`AbortController`. No event listener leaks.

---

### `UpLink.getLatencyAs(format)`

Returns the current average latency in the specified unit.

| Format | Unit |
|---|---|
| `"ms"` (default) | Milliseconds |
| `"s"` | Seconds |
| `"m"` | Minutes |

Returns `Infinity` if the connection is offline.

```js
UpLink.getLatencyAs("ms"); // 142.3
UpLink.getLatencyAs("s");  // 0.1423
```

---

## Properties

All properties are read-only getters backed by private fields.

| Property | Type | Description |
|---|---|---|
| `online` | `boolean` | Whether the device has internet access |
| `bars` | `number` | Signal strength from 0 (offline) to 5 (optimal) |
| `networkCondition` | `Object` | Current condition with `label`, `alias`, and `code` |
| `latency` | `number` | Average latency in ms over the last 10 pings |
| `jitter` | `number` | Average variation between consecutive pings in ms |
| `reliability` | `number` | 0–100 score based on success rate and jitter |

---

## Network Conditions

| Condition | Bars | `label` | `alias` | `code` | Default threshold |
|---|---|---|---|---|---|
| Optimal | 5 | `"Optimal"` | `"Excellent"` | `"NET_EXCELLENT"` | < 100ms |
| Stable | 4 | `"Stable"` | `"Good"` | `"NET_GOOD"` | < 250ms |
| High Latency | 3 | `"High Latency"` | `"Slow"` | `"NET_SLOW"` | < 500ms |
| Degraded | 2 | `"Degraded"` | `"Bad"` | `"NET_BAD"` | < 700ms |
| Critical | 1 | `"Critical"` | `"Unacceptable"` | `"NET_CRITICAL"` | ≥ 700ms |
| Disconnected | 0 | `"Disconnected"` | `"Offline"` | `"NET_OFFLINE"` | Infinity |
| Syncing | — | `"Syncing"` | `"Calculating"` | `"NET_PENDING"` | Initial state |

```js
UpLink.addEventListener("ping", (e) => {
  if (e.detail.condition.code === "NET_OFFLINE") {
    showOfflineBanner();
  }
});
```

---

## Events

All events fire on the `UpLink` instance.

### `ping`

Fires on every polling cycle.

| Key | Type | Description |
|---|---|---|
| `online` | `boolean` | Current online status |
| `latency` | `number` | Average latency in ms (`Infinity` if offline) |
| `condition` | `Object` | `{ label, alias, code }` |
| `bars` | `number` | 0 to 5 |
| `jitter` | `number` | Average jitter in ms |
| `reliability` | `number` | 0 to 100 |

### `online`

Fires once when connectivity is restored after being lost. Triggered by a confirmed successful ping — not by the native browser event alone.

### `offline`

Fires once when connectivity is lost. Triggered by a confirmed failed ping — not by the native browser event alone.

---

## Adaptive Polling

UpLink automatically backs off the polling interval as the connection proves consistent:

| Phase | Trigger | Default interval |
|---|---|---|
| Unstable | Any condition change | 2000ms |
| Stabilising | 10 consecutive same-condition pings | 4000ms |
| Stable | 20 consecutive same-condition pings | 6000ms |

The interval resets to `unstable` whenever the condition changes.

---

## How It Works

**Active polling:** On every cycle, UpLink fetches a lightweight endpoint. The request is force-aborted after 3.5 seconds — if it times out, the endpoint switches to the backup and a background timer checks every 5 minutes whether the main endpoint has recovered.

**Native event hybrid:** UpLink also listens to the browser's native `online` and `offline` window events. These events are unreliable as a source of truth but useful as early-warning signals — they often fire before the next polling cycle would catch a change. When either fires, UpLink immediately restarts its loop to run a confirmation ping. A 2-second debounce on each event prevents flickering from causing repeated restarts. The `online` and `offline` buffers are kept separate so a genuine rapid offline → online transition is never masked.

**Rolling window:** The latency of each successful ping is added to a rolling 10-item window. The window average determines the condition and bars, smoothing out individual spikes and preventing rapid condition flickering.

**Tab awareness:** Polling pauses when the tab is hidden and resumes when it becomes visible. The `visibilitychange`, `offline`, and `online` listeners all share a single `AbortController` signal and are cleaned up together whenever polling stops.

---

## Error Handling

UpLink throws `UpLinkError` for invalid usage. Each error has a `code` property:

| Code | Thrown by | Reason |
|---|---|---|
| `ALREADY_CONFIGURED` | `config()` | `config()` was called more than once |
| `CONFIG_ERR` | `config()` | An option value is invalid or out of range |
| `GENERAL_ERROR` | Any | Unexpected internal error |

```js
try {
  UpLink.config({ latencyThresholds: { optimal: 5 } });
} catch (e) {
  console.log(e.name);    // "UpLinkError"
  console.log(e.code);    // "CONFIG_ERR"
  console.log(e.message); // "impossible latency value set for 'optimal'..."
}
```

---

## License

MIT
