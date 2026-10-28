import crypto from 'crypto';
import { pool, initDb } from './db';

async function createKey() {
    const keyName = process.argv[2] || 'default-client';
    await initDb();

    const rawKey = `sk-live-${crypto.randomBytes(16).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const result = await pool.query(

    );

    console.log('\n=============================');
    console.log('API Key Generated & Stored in Postgres!');
    
    await pool.end();
}

createKey().catch(console.error);