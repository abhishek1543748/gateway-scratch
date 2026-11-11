import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '../infra/db.js';

export interface  AuthenticatedRequest extends Request{
    apiKey?: {
        id: number;
        name: string;
        rpmLimit: number;
        tpmLimit: number;
    };
}

export async function authenticateApiKey(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
) {
    const authHeader = req.headers.authorization;

    if(!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: {
                message: 'Missing or Invalid authorization header.Expected: Bearer <API_KEY>',
                type: 'authentication_error',
            },
        });
    }



const rawKey = authHeader.replace('Bearer ', '').trim();
const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
try{
    const result = await pool.query(
        'SELECT id, name, rpm_limit, tpm_limit, is_active FROM api_keys WHERE key_hash = $1',
        [keyHash]
    );
    if(result.rows.length === 0 || !result.rows[0].is_active){
        //below typo fixed ,earlier --> result.status
        return res.status(401).json({
            error: {
                message: 'Invalid or deactivated API key',
                type: 'authentication_error',
            },
        });

    }

    req.apiKey = {
        id: result.rows[0].id,
        name: result.rows[0].name,
        rpmLimit: result.rows[0].rpm_limit,
        tpmLimit:  result.rows[0].tpm_limit,
    };

    next();
} catch (err) {
    console.error('[Auth] Database error:', err);
    return res.status(500).json({ error: 'Internal server error during authentication' });
}
}

