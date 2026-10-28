import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from './db';

export interface  AuthenticatedRequest extends Request{
    apiKey?: {
        id: number;
        name: string;
        rpmLimit: number;
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

    );
    if(result.rows.length === 0 || !result.rows[0].is_active){
        return result.status(401).json({
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
    };

    next();
} catch (err) {
    console.error('[Auth] Database error:', err);
    return res.status(500).json({ error: 'Internal server error during authentication' });
}
}

