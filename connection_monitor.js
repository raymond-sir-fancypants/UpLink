"use strict"

/**
 * @class ConnectionMonitor
 * @extends EventTarget
 * @description Monitors internet connectivity by periodically pinging a remote server.
 * More reliable than `navigator.onLine` or the `online`/`offline` window events,
 * which only detect network interface changes — not actual internet access.
 *
 * @fires ConnectionMonitor#online
 * @fires ConnectionMonitor#offline
 * @fires ConnectionMonitor#ping
 *
 * @example
 * import CoMan from './ConnectionMonitor.js';
 *
 * CoMan.watchNetwork();
 *
 * CoMan.addEventListener('ping', (e) => {
 *   console.log(e.detail.condition); // "Excellent", "Good", "Slow" etc.
 * });
 *
 * CoMan.addEventListener('offline', () => {
 *   console.log('Lost connection');
 * });
 */
class ConnectionMonitor extends EventTarget {

    /**
     * @param {string} [server='https://dns.google/resolve?name=.&type=NS'] 
     * The endpoint to ping. Defaults to Google DNS — globally distributed,
     * highly reliable, and works with `no-cors` fetch mode.
     */
    constructor(server = 'https://dns.google/resolve?name=.&type=NS') {
        super();

        /** @type {string} */
        #server = server;

        /** @type {string[]} */
        #networkStatuses = ["Excellent", "Good", "Slow", "Bad", "Unacceptable", "Offline", "Unknown"];

        /**
         * Rolling window of the last 10 latency measurements in ms.
         * `Infinity` represents a failed ping. Replaced with 3000 on recovery
         * to avoid skewing averages with stale failures.
         * @type {number[]}
         * @private
         */
        #__latency = [100];

        /** @type {boolean} */
        #onlineStatus = navigator.onLine;

        /** @type {string} */
        #networkCondition = "Slow";

        /**
         * Signal bars from 0 (offline) to 5 (excellent).
         * @type {number}
         */
        #bars = 3;

        /** @type {boolean} */
        #watchingNetwork = false;

        /**
         * True if monitoring was paused due to the tab becoming hidden.
         * Used to auto-resume when the tab becomes visible again.
         * @type {boolean}
         */
        #visibilityBlock = false;

        /**
         * Interval between pings in ms. Backs off from 1000 → 3000 → 5000
         * as the connection stabilises, to reduce unnecessary requests.
         * @type {number}
         */
        #refreshIntervalTime = 1000;

        /** @type {string[]} */
        #stabilityLog = [];

        // Pause monitoring if the tab is already hidden on construction
        if (document.hidden && this.watchingNetwork) {
            this.stopWatchingNetwork();
            this.visibilityBlock = true;
        }

        // Pause when tab is hidden, resume when visible again
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === 'visible') {
                if (this.visibilityBlock) {
                    this.watchNetwork();
                }
            } else {
                if (this.watchingNetwork) {
                    this.stopWatchingNetwork();
                    this.visibilityBlock = true;
                }
            }
        });
    }

    /**
     * Starts monitoring the network connection.
     * Fires `ping` events on each check and `online`/`offline` on state changes.
     * @returns {void}
     */
    watchNetwork() {
        this.watchingNetwork = true;
        this.onlineStatusChecker();
    }

    /**
     * Stops monitoring the network connection.
     * @returns {void}
     */
    stopWatchingNetwork() { this.watchingNetwork = false; }

    /**
     * Core monitoring loop. Pings the server, records latency, and schedules
     * the next check. Automatically accounts for the time spent on the request
     * so the interval stays consistent.
     * @returns {Promise<void>}
     * @private
     */
    async onlineStatusChecker() {
        const start = Date.now();

        const restart = () => {
            const timeoutDuration = this.refreshIntervalTime - (Date.now() - start);
            if (this.watchingNetwork) {
                setTimeout(() => {
                    this.onlineStatusChecker();
                }, (timeoutDuration < 0) ? 0 : timeoutDuration);
            }
        }

        this.abortController = new AbortController();

        try {
            // Abort the fetch if it takes longer than 3.5 seconds
            const timeout = setTimeout(() => { this.abortController.abort() }, 3500);

            await fetch(this.server, {
                mode: 'no-cors',
                priority: 'high',
                signal: this.abortController.signal
            });

            clearTimeout(timeout);

            // Transition from offline → online
            if (!this.onlineStatus) {
                this.dispatchEvent(new CustomEvent("online", { bubbles: true, cancelable: true }));
                this.onlineStatus = true;
            }

            // Replace any Infinity values before recording new latency,
            // so the average isn't permanently skewed by old failures
            if (this.__latency.includes(Infinity)) {
                this.__latency = this.__latency.map((value) => (value === Infinity) ? 3000 : value);
            }

            this.__latency.unshift(Date.now() - start);
            if (this.__latency.length > 10) this.__latency.pop();

            this.networkConditionCheck();

        } catch (error) {
            // Ping failed — record as Infinity and check if we just went offline
            this.__latency.unshift(Infinity);
            if (this.__latency.length > 10) this.__latency.pop();

            this.networkConditionCheck();

            // Transition from online → offline
            if (this.onlineStatus) {
                this.dispatchEvent(new CustomEvent("offline", { bubbles: true, cancelable: true }));
                this.onlineStatus = false;
            }

        } finally { restart(); }
    }

    /**
     * Average latency across the rolling window in ms.
     * Returns `Infinity` if all recent pings failed.
     * @type {number}
     */
    get latency() {
        if (this.__latency.length === 0) return Infinity;
        return this.__latency.reduce((sum, val) => sum + val, 0) / this.__latency.length;
    }

    /**
     * Average variation between consecutive latency readings in ms.
     * High jitter indicates an unstable connection.
     * Returns 5000 if there isn't enough data to calculate.
     * @type {number}
     */
    get jitter() {
        if (this.__latency.length < 2) return 0;
        let diffs = [];
        for (let i = 0; i < this.__latency.length - 1; i++) {
            if (this.__latency[i] !== Infinity && this.__latency[i + 1] !== Infinity) {
                diffs.push(Math.abs(this.__latency[i] - this.__latency[i + 1]));
            }
        }
        return diffs.length ? (diffs.reduce((a, b) => a + b) / diffs.length) : 5000;
    }

    /**
     * Returns the average latency converted to the specified unit.
     * @param {"ms"|"s"|"m"} [format="ms"] - The time unit to convert to.
     * @returns {number} The latency in the requested unit, or `Infinity` if offline.
     */
    getLatencyAs(format = "ms") {
        if (this.latency !== Infinity) {
            switch (format) {
                case "ms": return this.latency;
                case "s": return (this.latency === 0) ? 0 : this.latency / 1000;
                case "m": return (this.latency === 0) ? 0 : this.latency / 60000;
            }
        } else return Infinity;
    }

    /**
     * A 0–100 score representing connection reliability.
     * Weighted average of ping success rate (70%) and jitter stability (30%).
     * @type {number}
     */
    get reliability() {
        const successRate = (this.__latency.filter(v => v !== 3000 && v !== Infinity).length / this.__latency.length) * 100;
        const jitterFactor = Math.max(0, 100 - (this.jitter / 10));
        return Math.round((successRate * 0.7) + (jitterFactor * 0.3));
    }

    /**
     * Updates `networkCondition` and `bars` based on current average latency,
     * then fires a `ping` event with the latest network details.
     * @returns {void}
     * @private
     */
    networkConditionCheck() {
        const avg = this.latency;

        if (avg < 100) { this.bars = 5; this.networkCondition = this.networkStatuses[0]; }
        else if (avg < 300) { this.bars = 4; this.networkCondition = this.networkStatuses[1]; }
        else if (avg < 600) { this.bars = 3; this.networkCondition = this.networkStatuses[2]; }
        else if (avg < 1000) { this.bars = 2; this.networkCondition = this.networkStatuses[3]; }
        else if (avg !== Infinity) { this.bars = 1; this.networkCondition = this.networkStatuses[4]; }
        else { this.bars = 0; this.networkCondition = this.networkStatuses[5]; }

        if (this.watchingNetwork) {
            /**
             * Fired on every ping cycle with current network details.
             * @event ConnectionMonitor#ping
             * @type {CustomEvent}
             * @property {boolean} detail.online
             * @property {number}  detail.latency - Average latency in ms
             * @property {string}  detail.condition - e.g. "Good", "Slow"
             * @property {number}  detail.bars - 0 to 5
             * @property {number}  detail.jitter - Average jitter in ms
             * @property {number}  detail.reliability - 0 to 100 score
             */
            this.dispatchEvent(new CustomEvent("ping", {
                detail: {
                    online: this.onlineStatus,
                    latency: avg,
                    condition: this.networkCondition,
                    bars: this.bars,
                    jitter: this.jitter,
                    reliability: this.reliability,
                }
            }));

            this.stabilityCheck();
        }
    }

    /**
     * Tracks how long the connection has been in the same state and
     * backs off the polling interval when stable, to reduce network noise.
     * Resets to 1000ms whenever the condition changes.
     * @returns {void}
     * @private
     */
    stabilityCheck() {
        if (this.stabilityLogLastEntry !== this.networkCondition) {
            this.stabilityLog = [];
            this.refreshIntervalTime = 1000;
        }

        this.stabilityLog.unshift(this.networkCondition);

        if (this.stabilityLog.length > 10) {
            this.refreshIntervalTime = 3000;

            if (this.networkCondition === "Offline") this.stabilityLog.pop();

            if (this.stabilityLog.length > 20) {
                this.stabilityLog.pop();
                this.refreshIntervalTime = 5000;
            }
        }

        this.stabilityLogLastEntry = this.networkCondition;
    }
}

const CoMan = new ConnectionMonitor();
Object.freeze(CoMan);
export default CoMan;