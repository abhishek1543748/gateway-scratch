import client from 'prom-client';
import type { Request, Response, NextFunction } from 'express';
import type { BoundedQueue } from './queue';

//creating a registry and collecting free default metrics
//read abt this .....
export const register  = new client.Registry();
client.collectDefaultMetrics({ register });

export const ttftSeconds = new client.Histogram({
    name: 'llm_ttft_seconds',
    help: 'Time to first token, measured from req arrival at the gateway'
    labelNames: ['model', 'api_key'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [register],
});
//registers: [register] registers each metric to our registry 

export const requestDurationSeconds = new client.Histogram({
    name: 'llm_request_duration_seconds',
    help: 'Total latency of chat completions (queue wait + generation)',
    labelNames: ['model', 'status_code'] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60, 120],
    registers: [register],
});

export const queueWaitSeconds = new client.Histogram({
    name: 'llm_queue_wait_seconds',
    help: 'Time spent waiting in the queue',
    labelNames: ['model', 'status_code'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
    registers: [register],
});

export const tokensTotal = new client.Counter({
    name: 'llm_tokens_generated_total',
    help: 'Total tokens processed, by type (prompt|completion)',
    labelNames: ['model', 'api_key', 'type'] as const,
    registers: [register],
});

export const rateLimitedTotal = new client.Counter({
    name: 'llm_rate_limited_total',
    help: 'Requests rejected by the rate limiter, by limiter type (rpm|tpm)',
    labelNames: ['type'] as const,
    registers: [register],
});

export const httpRequestsTotal = new client.Counter({
    name: 'llm_http_requests_total',
    help: 'HTTP requests by final status code (499 = client disconnected)',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [register],
});

export function registerQueueGauges(queue: BoundedQueue){
    new client.Gauge({
        name:'',
        help: '',
        registers: [register],
        collect() { this.set(queue.getStats().waiting); },
    });
    new client.Gauge({
        name: 'llm_queue_active_slots',
        help: 'Slots currently running inference on the engine',
        registers: [register],
        collect() {this.set(queue.getStats().active); },
    });
    new client.Gauge({
        name: 'llm_queue_max_slots',
        help: 'Configured maximum concurrent inference slots',
        registers: [register],
        collect() { this.set(queue.getStats().maxConcurrency); },
    });
    new client.Gauge({
        name: 'llm_queue_max_depth',
        help: 'Configured maximum queue depth',
        registers: [register],
        collect() { this.set(queue.getStats().maxQueueDepth); },
    });
}

export function httpMetrics(req: Request, res: Response, next: NextFunction) {
    res.on('close', () => {
        const route = req.route?.path ?? 'unmatched';
        if(route === '/metrics') return;
        const status = res.writableFinished ? res.statusCode: 499;
        httpRequestsTotal.inc( { method: req.method, route, status_code: String(status)})
    });
    next();
}




