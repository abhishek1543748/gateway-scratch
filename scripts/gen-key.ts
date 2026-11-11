import crypto from 'crypto';
import { pool, initDb } from '../src/infra/db.js';

async function createKey() {
    const keyName = process.argv[2] || 'default-client';
    const rpm = Number(process.argv[3]) || 60;
    const tpm = Number(process.argv[4]) || 20000;
    await initDb();

    const rawKey = `sk-live-${crypto.randomBytes(16).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const result = await pool.query(
        'INSERT INTO api_keys (name, key_hash, rpm_limit, tpm_limit) VALUES ($1, $2, $3, $4) RETURNING id',
        [keyName, keyHash, rpm, tpm]
    );
    console.log(`${rawKey}`);
    console.log('\n=============================');
    console.log('API Key Generated & Stored in Postgres!');
    
    
    await pool.end();
}

createKey().catch((e) => {console.error(e); process.exit(1); });