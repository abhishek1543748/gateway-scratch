const int = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== undefined && v !== '' ? n : d;
};


export const config = {
    port: int(process.env.PORT, 3000),
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

    gpuMaxConcurrency: int(process.env.GPU_MAX_CONCURRENCY, 2),
    queueMaxDepth: int(process.env.QUEUE_MAX_DEPTH, 20),
    queueTimeoutMs: int(process.env.QUEUE_TIMEOUT_MS, 20_000),

    rateLimitFailOpen: (process.env.RATE_LIMIT_FAIL_OPEN ?? 'true') !== 'false',
    metricsToken: process.env.METRICS_TOKEN || '',
};