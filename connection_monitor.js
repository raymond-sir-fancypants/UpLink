"use strict"

class ConnectionMonitor extends EventTarget {
    
    // We use Google DNS because it's globally distributed (low latency), 
    // extremely reliable, and supports 'no-cors' mode for lightweight pings.
    constructor(server = 'https://dns.google/resolve?name=.&type=NS') {
        super();
        this.server = server;
        this.networkStatuses = ["Excellent", "Good", "Slow", "Bad", "Unacceptable", "Offline", "Unknown"];
        this.__latency = [100];
        this.onlineStatus = navigator.onLine;
        this.networkCondition = "Slow";
        this.bars = 3;
        this.watchingNetwork = false;
        this.visibilityBlock = false;
        this.refreshIntervalTime = 1000;
        this.stabilityLog = [];

        if (document.hidden && this.watchingNetwork) {
            this.stopWatchingNetwork();
            this.visibilityBlock = true;
        }

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

    watchNetwork() {
        this.watchingNetwork = true;
        this.onlineStatusChecker();
    }

    stopWatchingNetwork() { this.watchingNetwork = false; }

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

            const timeout = setTimeout(() => { this.abortController.abort() }, 3500);

            await fetch(this.server, {
                mode: 'no-cors', // Avoids the CORS error
                priority: 'high',
                signal: this.abortController.signal
            });

            clearTimeout(timeout)

            if (!this.onlineStatus) {
                const event = new CustomEvent("online", {
                    bubbles: true,
                    cancelable: true
                });

                this.dispatchEvent(event);
                this.onlineStatus = true;
            }

            if (this.__latency.includes(Infinity)) {
                this.__latency = this.__latency.map((value) => (value === Infinity) ? 3000 : value)
            }

            this.__latency.unshift(Date.now() - start);

            if (this.__latency.length > 10) {
                this.__latency.pop()
            }

            this.networkConditionCheck();

        } catch (error) {
            this.__latency.unshift(Infinity);

            if (this.__latency.length > 10) {
                this.__latency.pop()
            }

            this.networkConditionCheck();

            if (this.onlineStatus) {
                const event = new CustomEvent("offline", {
                    bubbles: true,
                    cancelable: true
                });

                this.dispatchEvent(event);
                this.onlineStatus = false;


            }
        } finally { restart(); }

    }

    get latency() {
        const latencies = this.__latency;

        if (latencies.length === 0) return Infinity;

        return (latencies.reduce((sum, val) => sum + val, 0) / latencies.length);
    }

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

    getLatencyAs(format = "ms") {
        if (this.latency !== Infinity) {

            switch (format) {
                case "ms": return this.latency;
                    break;
                case "s": return (this.latency === 0) ? 0 : this.latency / 1000;
                    break;
                case "m": return (this.latency === 0) ? 0 : this.latency / 60000;
            }

        } else return Infinity
    }

    get reliability() {
        const successRate = (this.__latency.filter(v => v !== 3000 && v !== Infinity).length / this.__latency.length) * 100;
        const jitterFactor = Math.max(0, 100 - (this.jitter / 10));

        const score = (successRate * 0.7) + (jitterFactor * 0.3);
        return Math.round(score);
    }

    networkConditionCheck() {
        const avg = this.latency;

        if (avg < 100) {
            this.bars = 5;
            this.networkCondition = this.networkStatuses[0];
        } else if (avg < 300) {
            this.bars = 4;
            this.networkCondition = this.networkStatuses[1];
        } else if (avg < 600) {
            this.bars = 3;
            this.networkCondition = this.networkStatuses[2];
        } else if (avg < 1000) {
            this.bars = 2;
            this.networkCondition = this.networkStatuses[3];
        } else if (avg !== Infinity) {
            this.bars = 1;
            this.networkCondition = this.networkStatuses[4];
        } else {
            this.bars = 0;
            this.networkCondition = this.networkStatuses[5];
        }

        if (this.watchingNetwork) {
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

    stabilityCheck() {

        if (this.stabilityLogLastEntry !== this.networkCondition) {
            this.stabilityLog = [];
            this.refreshIntervalTime = 1000;
        };

        this.stabilityLog.unshift(this.networkCondition);

        if (this.stabilityLog.length > 10) {
            this.refreshIntervalTime = 3000;

            if (this.networkCondition === "Offline") {
                this.stabilityLog.pop();
            }

            if (this.stabilityLog.length > 20) {
                this.stabilityLog.pop();

                this.refreshIntervalTime = 5000;
            }
        }

        this.stabilityLogLastEntry = this.networkCondition;

    }
}

const CoMon = new ConnectionMonitor();
Object.freeze(CoMon);
export default CoMon;