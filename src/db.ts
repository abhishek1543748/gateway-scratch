import { Pool } from 'pg';

export const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT) || 5432,
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'password',
    database: process.env.PG_DATABASE || 'llm-gateway',
    max: 20,
});

export async function initDb() {
    const client = await pool.connect();
    try{
        await client.query(`
            `)
    }finally {
        client.release()
    }
}

export function logRequestMetrics(data: {
    apiKeyId: number | null:
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
            )
        } catch(err) {
            console.error('[Database] Failed to log request: ', err);
        }
    });
}