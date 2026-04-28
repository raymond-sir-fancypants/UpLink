"use strict"

// UpLink v2.0.1

/**
 * @class Utility
 * @description Internal helper class. Not part of the public API.
 * @private
 */
class Utility {

    /**
     * Checks whether a value is a plain object (i.e. `{}`).
     * Returns `false` for arrays, class instances, `null`, and other non-plain objects.
     * Used internally to validate config options.
     * @param {*} value
     * @returns {boolean}
     * @private
     */
    static isPlainObject(value) {
        return Object.prototype.toString.call(value) === '[object Object]';
    }
}

/**
 * @class UpLinkError
 * @extends Error
 * @description Custom error class for UpLink. Includes a `code` property for
 * programmatic error handling so you can distinguish error types without
 * parsing the message string.
 *
 * @example
 * try {
 *   UpLink.config({ pollingIntervals: { unstable: 100 } });
 * } catch (e) {
 *   if (e.code === "CONFIG_ERR") {
 *     console.log("Bad config value:", e.message);
 *   }
 * }
 */
class UpLinkError extends Error {

    /**
     * @param {string} message - Human-readable error description.
     * @param {string} [code="GENERAL_ERROR"] - Machine-readable error code.
     */
    constructor(message, code = "GENERAL_ERROR") {
        super(message);
        this.name = "UpLinkError";
        this.code = code;

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, UpLinkError);
        }
    }
}

/**
 * @class Monitor
 * @extends EventTarget
 * @description Core monitoring class for UpLink. Actively polls a remote
 * endpoint on a timer to verify real internet connectivity. More reliable
 * than `navigator.onLine` or the native `online`/`offline` window events,
 * which only detect whether a network interface is available — not whether
 * the internet is actually reachable.
 *
 * As of v2.0.1, UpLink also listens to the native `online` and `offline`
 * window events as early-warning signals. When they fire, UpLink immediately
 * restarts its polling loop to run a confirmation ping ahead of the next
 * scheduled cycle. A 2-second debounce buffer on each event prevents
 * flickering connections from triggering repeated restarts.
 *
 * On construction, polling starts immediately with default settings.
 *
 * ---
 *
 * **Important — call `config()` first and only once:**
 * `config()` must be called before your app begins reacting to network events.
 * It stops polling, applies your settings, then restarts cleanly. Calling it
 * after listeners are already attached means the first few pings may use
 * default settings. `config()` can only be called once — calling it a second
 * time throws an `UpLinkError` with code `ALREADY_CONFIGURED`.
 *
 * ```js
 * // ✅ Correct
 * UpLink.config({ pollingIntervals: { stable: 8000 } });
 * UpLink.addEventListener("ping", handler);
 *
 * // ❌ Will throw ALREADY_CONFIGURED
 * UpLink.config({ pollingIntervals: { stable: 8000 } });
 * UpLink.config({ latencyThresholds: { optimal: 50 } });
 * ```
 *
 * ---
 *
 * **Dual endpoint fallback:**
 * UpLink polls a `main` endpoint by default (Google DNS). If that endpoint
 * times out, it silently switches to a `backup` endpoint (Cloudflare) and
 * begins checking every 5 minutes whether the main endpoint has recovered.
 * When it does, polling switches back automatically.
 *
 * ---
 *
 * **Tab visibility:**
 * Polling automatically pauses when the browser tab is hidden and resumes
 * when the tab becomes visible again, avoiding unnecessary background requests.
 *
 * ---
 *
 * **Listener lifetime:**
 * The `visibilitychange`, `offline`, and `online` listeners all share the
 * same `AbortController` signal. When `stopPollingNetwork()` is called — whether
 * manually or triggered by a native event — all three listeners are removed
 * automatically. `startPollingNetwork()` then creates a fresh controller and
 * re-attaches them.
 *
 * @fires Monitor#ping
 * @fires Monitor#online
 * @fires Monitor#offline
 */
class Monitor extends EventTarget {

    /**
     * Rolling window of the last 10 latency readings in ms.
     * `Infinity` represents a failed ping. Replaced with the `degraded`
     * threshold value on recovery to avoid permanently skewing averages.
     * @type {number[]}
     * @private
     */
    #latencyLog = [];

    /**
     * Named network condition state objects used by `#networkConditionCheck`.
     * Each state has a `label`, `alias`, and `code`.
     * @type {Object}
     * @private
     */
    #networkConditionStates = {
        optimal: {
            label: "Optimal",
            alias: "Excellent",
            code: "NET_EXCELLENT",
        },
        stable: {
            label: "Stable",
            alias: "Good",
            code: "NET_GOOD",
        },
        highLatency: {
            label: "High Latency",
            alias: "Slow",
            code: "NET_SLOW",
        },
        degraded: {
            label: "Degraded",
            alias: "Bad",
            code: "NET_BAD",
        },
        critical: {
            label: "Critical",
            alias: "Unacceptable",
            code: "NET_CRITICAL",
        },
        disconnected: {
            label: "Disconnected",
            alias: "Offline",
            code: "NET_OFFLINE",
        },
        syncing: {
            label: "Syncing",
            alias: "Calculating",
            code: "NET_PENDING",
        }
    };

    /**
     * The endpoints used for polling. `main` is tried first; `backup` is
     * used if `main` times out. Both must support `no-cors` fetch mode.
     * Configurable via `config()`.
     * @type {{ main: string, backup: string }}
     * @private
     */
    #endPoints = {
        main: 'https://dns.google/resolve?name=.&type=NS',
        backup: 'https://1.1.1.1/cdn-cgi/trace',
    };

    /**
     * Tracks which endpoint is currently active and its type.
     * @type {{ endPoint: string, type: "main"|"backup" }}
     * @private
     */
    #currentEndPoint = {
        endPoint: 'https://dns.google/resolve?name=.&type=NS',
        type: "main"
    };

    /**
     * Polling interval durations in ms, indexed by stability phase.
     * Backs off as the connection stabilises to reduce unnecessary requests.
     * Configurable via `config()`. Minimum allowed value: 500ms.
     * @type {{ unstable: number, stabilising: number, stable: number }}
     * @private
     */
    #pollingIntervals = {
        unstable: 2000,
        stabilising: 4000,
        stable: 6000,
    };

    /**
     * The currently active polling interval in ms. Starts at `unstable`
     * and increases as the connection proves consistent.
     * @type {number}
     * @private
     */
    #currentpollingInterval = 2000;

    /**
     * Average latency thresholds in ms used to classify the connection.
     * Configurable via `config()`. Must be set in strictly ascending order.
     *
     * | Key           | Default | Meaning                            |
     * |---------------|---------|------------------------------------|
     * | `optimal`     | 100ms   | Below this → Optimal  (5 bars)     |
     * | `stable`      | 250ms   | Below this → Stable   (4 bars)     |
     * | `highLatency` | 500ms   | Below this → High Latency (3 bars) |
     * | `degraded`    | 700ms   | Below this → Degraded (2 bars)     |
     * | Above degraded|         | Critical (1 bar)                   |
     * | Infinity      |         | Disconnected (0 bars)              |
     *
     * @type {{ optimal: number, stable: number, highLatency: number, degraded: number }}
     * @private
     */
    #latencyThresholds = {
        optimal: 100,
        stable: 250,
        highLatency: 500,
        degraded: 700,
    };

    /** @type {number|false} Timeout ID for the main endpoint pulse check. `false` when inactive. @private */
    #checkMainEndPointTimeOutId = false;

    /** @type {AbortController} Used to cancel the active fetch request. @private */
    #fetchAbortController;

    /**
     * Whether the polling loop is currently running.
     * Initialised as `false` so `startPollingNetwork()` can safely run on
     * construction without the guard blocking it.
     * @type {boolean}
     * @private
     */
    #pollingNetwork = false;

    /** @type {boolean} Whether polling was paused due to tab visibility. Used to auto-resume. @private */
    #pollingPausedByVisibilityListener = false;

    /** @type {boolean} Whether `config()` has already been called. Prevents re-configuration. @private */
    #configured = false;

    /** @type {number} Timeout ID for the polling loop interval. @private */
    #pollingTimeOutId;

    /** @type {string|undefined} The condition label from the last stability check. @private */
    #stabilityLatencyLogLastEntry;

    /** @type {string[]} Rolling log of recent condition labels used to detect stability. @private */
    #stabilityLatencyLog = [];

    /** @type {boolean} When `true`, suppresses low-threshold console warnings from `config()`. @private */
    #silenceWarnings = false;

    /**
     * Signal bars representing connection strength. 0 = offline, 5 = optimal.
     * @type {number}
     * @private
     */
    #bars = 0;

    /**
     * The current network condition object. Starts as `syncing` until the
     * first ping completes.
     * @type {{ label: string, alias: string, code: string }}
     * @private
     */
    #networkCondition = {
        label: "Syncing",
        alias: "Calculating",
        code: "NET_PENDING",
    };

    /** @type {boolean} Current online status. Initialised from `navigator.onLine`. @private */
    #online = navigator.onLine;

    /** @type {AbortController} Controls the lifetime of the visibilitychange, offline, and online listeners. @private */
    #mainAbortController;

    /** @type {number} Timeout ID for the per-request force-abort timer. @private */
    #forceTimeOutOnNetworkRequest;

    /**
     * Debounce flag for the native `offline` window event.
     * When `true`, further `offline` events are ignored for 2 seconds.
     * Prevents flickering connections from triggering repeated restarts.
     * @type {boolean}
     * @private
     */
    #nativeEventBufferOffline = false;

    /**
     * Debounce flag for the native `online` window event.
     * When `true`, further `online` events are ignored for 2 seconds.
     * Kept separate from the offline buffer so a genuine rapid
     * offline → online transition is never masked.
     * @type {boolean}
     * @private
     */
    #nativeEventBufferOnline = false;

    constructor() {
        super();
        this.startPollingNetwork();
    }

    /**
     * Starts the polling loop and attaches the tab visibility, `offline`,
     * and `online` listeners. All three listeners share a single
     * `AbortController` signal and are automatically removed when
     * `stopPollingNetwork()` is called.
     *
     * If polling is already running (`#pollingNetwork === true`), this method
     * returns immediately — preventing duplicate polling loops.
     *
     * Called automatically on construction and after `config()` completes.
     * Safe to call manually to resume polling after `stopPollingNetwork()`.
     *
     * @returns {void}
     */
    startPollingNetwork() {
        if (this.#pollingNetwork) return; // Guard — prevent duplicate polling loops

        this.#mainAbortController = new AbortController();
        this.#pollingNetwork = true;

        // If the tab is already hidden on start, pause immediately
        if (document.hidden) {
            this.stopPollingNetwork();
            this.#pollingPausedByVisibilityListener = true;
        }

        // Pause when tab is hidden, resume when visible again
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === 'visible') {
                if (this.#pollingPausedByVisibilityListener) {
                    this.startPollingNetwork();
                }
            } else {
                if (this.#pollingNetwork) {
                    this.stopPollingNetwork();
                    this.#pollingPausedByVisibilityListener = true;
                }
            }
        }, { signal: this.#mainAbortController.signal });

        // Native offline event — use as an early-warning trigger.
        // Immediately restarts the polling loop to run a confirmation ping
        // ahead of the next scheduled cycle. Debounced to 2 seconds to
        // prevent flickering connections from causing repeated restarts.
        window.addEventListener("offline", () => {
            if (this.#nativeEventBufferOffline) return;

            this.#nativeEventBufferOffline = true;
            setTimeout(() => { this.#nativeEventBufferOffline = false; }, 2000);

            this.stopPollingNetwork();
            this.startPollingNetwork();
        }, { signal: this.#mainAbortController.signal });

        // Native online event — same early-warning approach as offline.
        // Kept as a separate buffer so a genuine rapid offline → online
        // transition is never masked by the offline buffer.
        window.addEventListener("online", () => {
            if (this.#nativeEventBufferOnline) return;

            this.#nativeEventBufferOnline = true;
            setTimeout(() => { this.#nativeEventBufferOnline = false; }, 2000);

            this.stopPollingNetwork();
            this.startPollingNetwork();
        }, { signal: this.#mainAbortController.signal });

        this.#pollingHandler();
    }

    /**
     * Stops the polling loop, cancels all pending timeouts and fetches,
     * and removes the `visibilitychange`, `offline`, and `online` listeners
     * by aborting the shared `AbortController`.
     * @returns {void}
     */
    stopPollingNetwork() {
        clearTimeout(this.#checkMainEndPointTimeOutId);
        clearTimeout(this.#pollingTimeOutId);
        clearTimeout(this.#forceTimeOutOnNetworkRequest);

        if (this.#mainAbortController) this.#mainAbortController.abort();
        if (this.#fetchAbortController) this.#fetchAbortController.abort();

        this.#pollingNetwork = false;
    }

    /**
     * Signal bars representing the current connection strength.
     * Updated on every ping cycle.
     * @type {number} 0 (offline) to 5 (optimal)
     */
    get bars() { return this.#bars; }

    /**
     * Whether the device currently has internet access.
     * Transitions trigger `online` and `offline` events.
     * @type {boolean}
     */
    get online() { return this.#online; }

    /**
     * The current network condition. An object with three fields:
     * - `label` — descriptive name (e.g. `"High Latency"`)
     * - `alias` — short alias (e.g. `"Slow"`)
     * - `code` — machine-readable code (e.g. `"NET_SLOW"`)
     *
     * Starts as `{ label: "Syncing", alias: "Calculating", code: "NET_PENDING" }`
     * until the first ping completes.
     * @type {{ label: string, alias: string, code: string }}
     */
    get networkCondition() { return this.#networkCondition; }

    /**
     * Average latency across the rolling 10-ping window in ms.
     * Returns `Infinity` if no successful pings have been recorded yet.
     * @type {number}
     */
    get latency() {
        if (this.#latencyLog.length === 0) return Infinity;
        return this.#latencyLog.reduce((sum, val) => sum + val, 0) / this.#latencyLog.length;
    }

    /**
     * Average variation between consecutive latency readings in ms.
     * High jitter indicates an unstable connection.
     * Returns `0` if fewer than 2 readings are available.
     * Returns `5000` if all available consecutive pairs include a failed ping.
     * @type {number}
     */
    get jitter() {
        if (this.#latencyLog.length < 2) return 0;
        const diffs = [];
        for (let i = 0; i < this.#latencyLog.length - 1; i++) {
            if (this.#latencyLog[i] !== Infinity && this.#latencyLog[i + 1] !== Infinity) {
                diffs.push(Math.abs(this.#latencyLog[i] - this.#latencyLog[i + 1]));
            }
        }
        return diffs.length ? (diffs.reduce((a, b) => a + b) / diffs.length) : 5000;
    }

    /**
     * A 0–100 reliability score based on ping success rate (70%) and
     * jitter stability (30%).
     *
     * The success rate counts any ping that did not fail outright (i.e. any
     * entry that is not `Infinity`). High-latency pings are counted as
     * successes — only complete failures penalise this score.
     *
     * Returns `0` if no pings have been recorded yet.
     * @type {number}
     */
    get reliability() {
        if (this.#latencyLog.length === 0) return 0;
        const successRate = (
            this.#latencyLog.filter(v => v !== Infinity).length / this.#latencyLog.length
        ) * 100;
        const jitterFactor = Math.max(0, 100 - (this.jitter / 10));
        return Math.round((successRate * 0.7) + (jitterFactor * 0.3));
    }

    /**
     * Configures UpLink behaviour. **Must be called before attaching event
     * listeners or reacting to network state.** Can only be called once —
     * calling it a second time throws an `UpLinkError` with code
     * `ALREADY_CONFIGURED`.
     *
     * Internally, `config()` stops the current polling loop, applies all
     * settings, then restarts polling cleanly with the new configuration.
     *
     * @param {Object} [options={}]
     *
     * @param {Object} [options.endPoints] - Custom polling endpoints.
     *   Both must support `no-cors` fetch mode.
     * @param {string} [options.endPoints.main] - Primary endpoint. Defaults to Google DNS.
     * @param {string} [options.endPoints.backup] - Fallback endpoint used when `main` times out.
     *   Defaults to Cloudflare. UpLink automatically switches back to `main` every 5 minutes.
     *
     * @param {Object} [options.latencyThresholds] - Override the ms thresholds used to
     *   classify the connection. All values must be positive numbers in strictly
     *   ascending order. Values ≤ 10ms throw an error (physically impossible over a network).
     *   Values ≤ 30ms log a warning unless `silenceWarnings` is `true`.
     * @param {number} [options.latencyThresholds.optimal=100]
     * @param {number} [options.latencyThresholds.stable=250]
     * @param {number} [options.latencyThresholds.highLatency=500]
     * @param {number} [options.latencyThresholds.degraded=700]
     *
     * @param {Object} [options.pollingIntervals] - Override polling interval durations in ms.
     *   Minimum allowed value is 500ms to prevent network flooding.
     * @param {number} [options.pollingIntervals.unstable=2000] - Used when the condition
     *   is changing or has just changed.
     * @param {number} [options.pollingIntervals.stabilising=4000] - Used after 10 consecutive
     *   pings with the same condition.
     * @param {number} [options.pollingIntervals.stable=6000] - Used after 20 consecutive
     *   pings with the same condition.
     *
     * @param {boolean} [options.silenceWarnings=false] - Set to `true` to suppress
     *   console warnings about unusually low latency threshold values.
     *
     * @throws {UpLinkError} ALREADY_CONFIGURED — if `config()` has already been called.
     * @throws {UpLinkError} CONFIG_ERR — if any option value is invalid.
     *
     * @example
     * // Call before anything else
     * UpLink.config({
     *   pollingIntervals: { stable: 10000 },
     *   latencyThresholds: { optimal: 80, stable: 200, highLatency: 400, degraded: 600 }
     * });
     *
     * UpLink.addEventListener("ping", (e) => {
     *   console.log(e.detail.condition.label);
     * });
     *
     * @example
     * // Custom endpoints
     * UpLink.config({
     *   endPoints: {
     *     main: 'https://my-server.com/ping',
     *     backup: 'https://dns.google/resolve?name=.&type=NS'
     *   }
     * });
     */
    config({ endPoints, pollingIntervals, latencyThresholds, silenceWarnings } = {}) {
        if (this.#configured) throw new UpLinkError(
            "UpLink configuration can only be set once. Re-initialization is not supported.",
            "ALREADY_CONFIGURED"
        );

        this.stopPollingNetwork();

        this.#silenceWarnings = (silenceWarnings !== undefined)
            ? !!silenceWarnings
            : this.#silenceWarnings;

        if (endPoints) {
            if (!Utility.isPlainObject(endPoints)) {
                throw new UpLinkError("'endpoints' option is expected to be a plain object", "CONFIG_ERR");
            }

            if (endPoints.main !== undefined) {
                if (typeof endPoints.main === "string") {
                    this.#endPoints.main = endPoints.main;
                } else {
                    throw new UpLinkError(`'main' endpoint value must be a string`, "CONFIG_ERR");
                }
            }

            if (endPoints.backup !== undefined) {
                if (typeof endPoints.backup === "string") {
                    this.#endPoints.backup = endPoints.backup;
                } else {
                    throw new UpLinkError("'backup' endpoint value must be a string", "CONFIG_ERR");
                }
            }
        }

        if (latencyThresholds) {
            if (!Utility.isPlainObject(latencyThresholds)) throw new UpLinkError(
                "'latencyThresholds' is expected to be a plain object",
                "CONFIG_ERR"
            );

            // Sort threshold values ascending to validate in order
            const thresholdValues = Object.values(this.#latencyThresholds).sort((a, b) => a - b);
            const invertedLatencyThresholds = {};

            // Invert the defaults map so we can look up keys by value
            Object.keys(this.#latencyThresholds).forEach(key => {
                invertedLatencyThresholds[this.#latencyThresholds[key]] = key;
            });

            let sequenceIntegrity = { value: 0, key: "" };

            thresholdValues.forEach(threshold => {
                let value;
                const invertedKey = invertedLatencyThresholds[threshold];

                if (latencyThresholds[invertedKey] !== undefined) {
                    const setValue = Number(latencyThresholds[invertedKey]);
                    if (!isNaN(setValue)) { value = setValue; }
                    else throw new UpLinkError(
                        `the 'latencyThreshold' value '${invertedKey}' can only be a number`,
                        "CONFIG_ERR"
                    );
                } else value = threshold;

                if (value < 0) throw new UpLinkError(
                    `'latencyThreshold' values cannot be less than 0`,
                    "CONFIG_ERR"
                );

                if (sequenceIntegrity.value <= value) {
                    if (latencyThresholds[invertedKey] !== undefined) {
                        if (value <= 10) throw new UpLinkError(
                            `impossible latency value set for '${invertedKey}'. Latency below 10ms is unlikely over a network.`,
                            "CONFIG_ERR"
                        );
                        else if (value <= 30 && !this.#silenceWarnings) {
                            console.warn(
                                `The latency threshold for '${invertedKey}' is set to '${value}ms'. While technically possible on high-end local fiber, it is highly unusual for general network conditions. Are you sure this is the target you intended?`
                            );
                        }
                        this.#latencyThresholds[invertedKey] = value;
                    }
                } else throw new UpLinkError(
                    `the value set for '${invertedKey}' cannot be less than that set for '${sequenceIntegrity.key}'`,
                    "CONFIG_ERR"
                );

                sequenceIntegrity.value = value;
                sequenceIntegrity.key = invertedKey;
            });
        }

        if (pollingIntervals) {
            if (!Utility.isPlainObject(pollingIntervals)) throw new UpLinkError(
                "'pollingIntervals' is expected to be a plain object",
                "CONFIG_ERR"
            );

            for (const key in this.#pollingIntervals) {
                if (pollingIntervals[key] !== undefined) {
                    const setValue = Number(pollingIntervals[key]);
                    if (!isNaN(setValue)) {
                        if (setValue < 500) throw new UpLinkError(
                            `the 'pollingIntervals' value '${key}' is too low. Minimum allowed is 500ms to prevent network flooding.`,
                            "CONFIG_ERR"
                        );
                        this.#pollingIntervals[key] = setValue;
                    } else throw new UpLinkError(
                        `the 'pollingIntervals' value '${key}' can only be a number`,
                        "CONFIG_ERR"
                    );
                }
            }
        }

        this.#currentpollingInterval = this.#pollingIntervals.unstable;
        this.#currentEndPoint = {
            endPoint: this.#endPoints.main,
            type: "main"
        };

        this.#configured = true;
        this.startPollingNetwork();
    }

    /**
     * Periodically checks whether the main endpoint has recovered after a
     * timeout caused a switch to the backup. Runs every 5 minutes.
     * Recursively schedules itself until the main endpoint responds.
     * When the main endpoint responds, polling switches back to it automatically.
     * @returns {void}
     * @private
     */
    #checkMainEndPointForAPulse() {
        clearTimeout(this.#checkMainEndPointTimeOutId);

        this.#checkMainEndPointTimeOutId = setTimeout(async () => {
            const abortController = new AbortController();
            const timeout = setTimeout(() => { abortController.abort(); }, 3500);

            try {
                await fetch(this.#endPoints.main, {
                    mode: 'no-cors',
                    signal: abortController.signal
                });

                clearTimeout(timeout);

                // Main endpoint is back — switch back to it
                this.#currentEndPoint.endPoint = this.#endPoints.main;
                this.#currentEndPoint.type = "main";

            } catch (e) {
                clearTimeout(timeout);
                // Still unreachable — try again in another 5 minutes
                this.#checkMainEndPointForAPulse();
            }

            this.#checkMainEndPointTimeOutId = false;
        }, 300000); // 5 minutes
    }

    /**
     * Core polling loop. Fetches the current endpoint, records the latency,
     * and schedules the next cycle. Accounts for request duration when
     * calculating the next interval so timing stays consistent.
     *
     * On timeout (3.5s), switches from main → backup or backup → main and
     * initiates a background check to restore the main endpoint if needed.
     *
     * @returns {Promise<void>}
     * @private
     */
    async #pollingHandler() {
        const start = Date.now();

        const restart = () => {
            const timeoutDuration = this.#currentpollingInterval - (Date.now() - start);
            if (this.#pollingNetwork) {
                this.#pollingTimeOutId = setTimeout(() => {
                    this.#pollingHandler();
                }, (timeoutDuration < 0) ? 0 : timeoutDuration);
            }
        };

        this.#fetchAbortController = new AbortController();

        try {
            // Force-abort and switch endpoints if the fetch takes longer than 3.5 seconds
            this.#forceTimeOutOnNetworkRequest = setTimeout(() => {
                this.#fetchAbortController.abort();

                if (this.#currentEndPoint.type === "main") {
                    // Main timed out — fall back to backup and watch for recovery
                    this.#currentEndPoint.endPoint = this.#endPoints.backup;
                    this.#currentEndPoint.type = "backup";
                    if (this.#checkMainEndPointTimeOutId === false) this.#checkMainEndPointForAPulse();
                } else {
                    // Backup also timed out — switch back to main and cancel the recovery watch
                    this.#currentEndPoint.endPoint = this.#endPoints.main;
                    this.#currentEndPoint.type = "main";
                    clearTimeout(this.#checkMainEndPointTimeOutId);
                    this.#checkMainEndPointTimeOutId = false;
                }
            }, 3500);

            await fetch(this.#currentEndPoint.endPoint, {
                mode: 'no-cors',
                signal: this.#fetchAbortController.signal
            });

            clearTimeout(this.#forceTimeOutOnNetworkRequest);

            // Transition from offline → online
            if (!this.#online) {
                this.dispatchEvent(new CustomEvent("online", { cancelable: true }));
                this.#online = true;
            }

            // Replace any Infinity entries before recording new latency so the
            // average isn't permanently skewed by old failures
            if (this.#latencyLog.includes(Infinity)) {
                this.#latencyLog = this.#latencyLog.map(
                    (value) => (value === Infinity) ? this.#latencyThresholds.degraded : value
                );
            }

            this.#latencyLog.unshift(Date.now() - start);
            if (this.#latencyLog.length > 10) this.#latencyLog.pop();

            this.#networkConditionCheck();

        } catch (error) {
            // Ping failed — record as Infinity and check if we just went offline
            this.#latencyLog.unshift(Infinity);
            if (this.#latencyLog.length > 10) this.#latencyLog.pop();

            this.#networkConditionCheck();

            // Transition from online → offline
            if (this.#online) {
                this.dispatchEvent(new CustomEvent("offline", { cancelable: true }));
                this.#online = false;
            }

        } finally {
            this.#pollingNetwork ? restart() : "";
        }
    }

    /**
     * Evaluates the current average latency against the configured thresholds,
     * updates `#bars` and `#networkCondition`, runs the stability check,
     * and fires the `ping` event.
     * @returns {void}
     * @private
     */
    #networkConditionCheck() {
        const avg = this.latency;

        if (avg < this.#latencyThresholds.optimal)         { this.#bars = 5; this.#networkCondition = this.#networkConditionStates.optimal; }
        else if (avg < this.#latencyThresholds.stable)      { this.#bars = 4; this.#networkCondition = this.#networkConditionStates.stable; }
        else if (avg < this.#latencyThresholds.highLatency) { this.#bars = 3; this.#networkCondition = this.#networkConditionStates.highLatency; }
        else if (avg < this.#latencyThresholds.degraded)    { this.#bars = 2; this.#networkCondition = this.#networkConditionStates.degraded; }
        else if (avg !== Infinity)                          { this.#bars = 1; this.#networkCondition = this.#networkConditionStates.critical; }
        else                                                { this.#bars = 0; this.#networkCondition = this.#networkConditionStates.disconnected; }

        if (this.#pollingNetwork) {
            this.#stabilityCheck();

            /**
             * Fired on every polling cycle with the latest network snapshot.
             * @event Monitor#ping
             * @type {CustomEvent}
             * @property {boolean}  detail.online      - Current online status.
             * @property {number}   detail.latency     - Average latency in ms (`Infinity` if offline).
             * @property {Object}   detail.condition   - Current condition `{ label, alias, code }`.
             * @property {number}   detail.bars        - Signal bars, 0–5.
             * @property {number}   detail.jitter      - Average jitter in ms.
             * @property {number}   detail.reliability - Reliability score, 0–100.
             */
            this.dispatchEvent(new CustomEvent("ping", {
                detail: {
                    online: this.#online,
                    latency: avg,
                    condition: this.#networkCondition,
                    bars: this.#bars,
                    jitter: this.jitter,
                    reliability: this.reliability,
                }
            }));
        }
    }

    /**
     * Tracks how long the connection has been in the same condition and
     * backs off the polling interval when stable. Resets to the `unstable`
     * interval whenever the condition changes.
     *
     * Progression:
     * - 0–10 consecutive same-condition pings  → `unstable` interval
     * - 10–20 consecutive same-condition pings → `stabilising` interval
     * - 20+  consecutive same-condition pings  → `stable` interval
     *
     * @returns {void}
     * @private
     */
    #stabilityCheck() {
        if (this.#stabilityLatencyLogLastEntry !== this.#networkCondition.label) {
            this.#stabilityLatencyLog = [];
            this.#currentpollingInterval = this.#pollingIntervals.unstable;
        }

        this.#stabilityLatencyLog.unshift(this.#networkCondition.label);

        if (this.#stabilityLatencyLog.length > 10) {
            this.#currentpollingInterval = this.#pollingIntervals.stabilising;

            if (this.#stabilityLatencyLog.length > 20) {
                this.#stabilityLatencyLog.pop();
                this.#currentpollingInterval = this.#pollingIntervals.stable;
            }
        }

        this.#stabilityLatencyLogLastEntry = this.#networkCondition.label;
    }

    /**
     * Returns the current average latency converted to the specified unit.
     * Returns `Infinity` if the connection is offline.
     *
     * @param {"ms"|"s"|"m"} [format="ms"] - The time unit to return.
     *   `"ms"` = milliseconds, `"s"` = seconds, `"m"` = minutes.
     * @returns {number} The latency in the requested unit, or `Infinity`.
     *
     * @example
     * UpLink.getLatencyAs("ms"); // 142.3
     * UpLink.getLatencyAs("s");  // 0.1423
     */
    getLatencyAs(format = "ms") {
        if (this.latency !== Infinity) {
            switch (format) {
                case "s": return (this.latency === 0) ? 0 : this.latency / 1000;
                case "m": return (this.latency === 0) ? 0 : this.latency / 60000;
                default:  return this.latency;
            }
        } else return Infinity;
    }
}

const UpLink = new Monitor();
export default UpLink;
