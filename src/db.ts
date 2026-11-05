import { Pool } from 'pg';

export const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT) || 5432,
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'password',
    database: process.env.PG_DATABASE || 'llm_gateway',
    max: 20,
});

export async function initDb() {
    const client = await pool.connect();
    try{
        await client.query(`
            CREATE TABLE IF NOT EXISTS api_keys (
                id         SERIAL PRIMARY KEY,
                name       TEXT NOT NULL,
                key_hash   TEXT UNIQUE NOT NULL,
                rpm_limit  INTEGER NOT NULL DEFAULT 60,
                is_active  BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS request_logs (
                id                SERIAL PRIMARY KEY,
                api_key_id        INTEGER REFERENCES api_keys(id),
                model             TEXT NOT NULL,
                prompt_tokens     INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                ttft_ms           INTEGER,
                total_duration_ms INTEGER NOT NULL,
                status_code       INTEGER NOT NULL,
                created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_request_logs_key_time
                ON request_logs (api_key_id, created_at);
            `)
    }finally {
        client.release()
    }
}

export function logRequestMetrics(data: {
    apiKeyId: number | null;
    model: string;
    promptTokens: number;
    completionTokens: number;
    ttftMs: number | null;
    totalDurationMs: number;
    statusCode: number;
}) {
    setImmediate(async () => {
        try{
            await pool.query(
                //SQL Query 
                `INSERT INTO request_logs
                   (api_key_id, model, prompt_tokens, completion_tokens,
                    ttft_ms, total_duration_ms, status_code)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    data.apiKeyId,
                    data.model,
                    data.promptTokens,
                    data.completionTokens,
                    data.ttftMs,
                    data.totalDurationMs,
                    data.statusCode,
                ]

            )
        } catch(err) {
            console.error('[Database] Failed to log request: ', err);
        }
    });
}