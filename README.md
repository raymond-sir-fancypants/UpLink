# ConnectionMonitor

A lightweight, dependency-free JavaScript library for monitoring real internet connectivity in the browser.

Unlike `navigator.onLine` and the native `online`/`offline` window events — which only detect whether a network interface is available — ConnectionMonitor actively pings a remote server to verify actual internet access. This means it catches situations like being connected to a router with no WAN, or being behind a captive portal.

---

## Features

- ✅ Real connectivity detection via active pinging
- 🔒 Fully encapsulated state — enforced by private class fields
- 📶 Signal strength expressed as bars (0–5) and named conditions
- ⚡ Latency and jitter tracking over a rolling window
- 🔁 Adaptive polling — backs off when the connection is stable
- 🔋 Tab-aware — pauses when the tab is hidden, resumes when visible
- 🎯 Event-driven API built on native `EventTarget`
- 📦 Zero dependencies

---

## Installation

Just copy `ConnectionMonitor.js` into your project and import it:

```js
import CoMon from './ConnectionMonitor.js';
```

---

## Usage

### Start monitoring

```js
CoMon.watchNetwork();
```

### Listen for events

```js
// Fires on every ping cycle
CoMon.addEventListener('ping', (e) => {
  console.log(e.detail.condition);   // "Excellent", "Good", "Slow" etc.
  console.log(e.detail.latency);     // average latency in ms
  console.log(e.detail.bars);        // 0 to 5
  console.log(e.detail.jitter);      // average jitter in ms
  console.log(e.detail.reliability); // 0 to 100 score
  console.log(e.detail.online);      // true / false
});

// Fires when connectivity is lost
CoMon.addEventListener('offline', () => {
  console.log('Connection lost');
});

// Fires when connectivity is restored
CoMon.addEventListener('online', () => {
  console.log('Back online');
});
```

### Stop monitoring

```js
CoMon.stopWatchingNetwork();
```

---

## API

### Properties

| Property | Type | Description |
|---|---|---|
| `onlineStatus` | `boolean` | Whether the device currently has internet access |
| `networkCondition` | `string` | Current condition label (see table below) |
| `bars` | `number` | Signal strength from 0 (offline) to 5 (excellent) |
| `latency` | `number` | Average latency in ms over the last 10 pings |
| `jitter` | `number` | Average variation between consecutive pings in ms |
| `reliability` | `number` | 0–100 score based on success rate and jitter |
| `refreshIntervalTime` | `number` | Current polling interval in ms (adapts automatically) |

### Methods

| Method | Description |
|---|---|
| `watchNetwork()` | Start monitoring |
| `stopWatchingNetwork()` | Stop monitoring |
| `getLatencyAs(format)` | Get average latency as `"ms"`, `"s"`, or `"m"` |

### Network Conditions

| Condition | Bars | Avg Latency |
|---|---|---|
| Excellent | 5 | < 100ms |
| Good | 4 | < 300ms |
| Slow | 3 | < 600ms |
| Bad | 2 | < 1000ms |
| Unacceptable | 1 | ≥ 1000ms |
| Offline | 0 | No response |

### Events

All events are fired on the `CoMon` instance.

#### `ping`
Fired on every polling cycle. The `event.detail` object contains:

| Key | Type | Description |
|---|---|---|
| `online` | `boolean` | Current online status |
| `latency` | `number` | Average latency in ms |
| `condition` | `string` | Named condition (e.g. `"Good"`) |
| `bars` | `number` | 0 to 5 |
| `jitter` | `number` | Average jitter in ms |
| `reliability` | `number` | 0 to 100 |

#### `online`
Fired once when connectivity is restored after being lost.

#### `offline`
Fired once when connectivity is lost.

---

## Custom Server

By default, ConnectionMonitor pings Google DNS (`https://dns.google/resolve?name=.&type=NS`), which is globally distributed, highly reliable, and supports `no-cors` fetch mode. You can provide your own endpoint if needed:

```js
const monitor = new ConnectionMonitor('https://your-server.com/ping');
```

Note: the exported `CoMon` singleton uses the default server. Instantiate the class directly if you need a custom one.

---

## How It Works

Every second (by default), ConnectionMonitor fetches a lightweight endpoint. Based on how long that takes, it classifies the connection and fires a `ping` event. If the fetch fails or times out after 3.5 seconds, the connection is marked offline.

To avoid unnecessary requests, the polling interval backs off automatically:
- **1 second** — default
- **3 seconds** — after 10 consecutive pings with the same condition
- **5 seconds** — after 20 consecutive pings with the same condition

The interval resets to 1 second whenever the condition changes.

---

## License

MIT
