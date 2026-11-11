import { randomUUID } from 'crypto';
import type { Response, NextFunction } from 'express';
import type { Redis } from 'ioredis';
import { redis } from './redis';
import { config } from './config';
import { rateLimitedTotal } from './metrics';  
import type { AuthenticatedRequest } from './auth';

//the RPM Lua Script(implementing Sliding window)

// RPM: sliding-window log in a sorted set (score = request time in ms).
// Rejected requests are NOT recorded, so hammering a 429 doesn't extend the ban.
// Returns {allowed, remaining, retryAfterSeconds}
const RPM_LUA = `
local key  =KEYS[1]
local limit  = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumbert[2] / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
    redis.call('ZADD', key, now, member)
    redis.call('PEXPIRE', key, window)
    return {1, limit - count - 1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry = math.ceil((tonumber(oldest[2]) + window - now) / 1000)
if retry < 1 then  retry = 1 end
return {0, 0, retry}
`;


// TPM: token bucket. capacity = tpm limit, refill = capacity / 60s.
//   mode 'reserve' : deduct 'cost' if the bucket has enough, else reject w/ retry-after
//   mode 'adjust'  : unconditionally apply a delta (positive = charge, negative = refund).
//                    Balance may go negative (debt) down to -capacity.
// Returns {allowed, remainingTokens, retryAfterSeconds}
const TPM_LUA = `
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local cost     = tonumber(ARGV[2])
local mode     = ARGV[3]
local rate     = capacity / 60000
local t   = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local d = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(d[1])
local ts     = tonumber(d[2])
if tokens == nil then
  tokens = capacity
else
  tokens = math.min(capacity, tokens + (now - ts) * rate)
end
local allowed = 1
local retry = 0
if mode == 'reserve' then
  if tokens >= cost then
    tokens = tokens - cost
  else
    allowed = 0
    retry = math.ceil((cost - tokens) / rate / 1000)
    if retry < 1 then retry = 1 end
  end
else
  tokens = math.min(capacity, math.max(-capacity, tokens - cost))
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(2 * capacity / rate) + 1000)
return {allowed, math.floor(tokens), retry}
`;
//don't knowwhat is happening here will see this later
type LuaRedis = Redis & {
    rpmCheck(key: string, limit: number, windowsMs: number, member: string): Promise<[number, number, number]>;
    tpmOp(key: string, capacity: number, cost: number, mode: 'reserve' | 'adjust'): Promise<[number, number, number]>
}
redis.defineCommand('rpmCheck', { numberOfKeys: 1, lua: RPM_LUA  });
redis.defineCommand('tpmOp', { numberOfKeys: 1, lua: TPM_LUA });
const lua = redis as unknown as LuaRedis;

export interface LimitResult {
    allowed: boolean;
    remaining: number;
    retryAfter: number;//seconds, 0 when allowed
    degraded?: boolean;// true when redis as unavailable and we defined and we failed open
}

function redisDown(err: unknown): LimitResult | null {
    console.error('[RateLimit] Redis unavailable:', (err as Error).message);
    if(config.rateLimitFailOpen) return { allowed: true, remaining: -1, retryAfter: 0, degraded: true};
    return null;
}

export async function checkRpm(keyId: number, limit: number): Promise<LimitResult | null> {
    try{
        const [allowed, remaining, retry] = await lua.rpmCheck(`rl:rpm:${keyId}`, limit, 60_000, randomUUID());
        return { allowed: allowed === 1, remaining, retryAfter: retry };
    } catch (err){
        return redisDown(err);
    }
}

export async function reserveTokens(keyId: number, limit: number, cost: number): Promise<LimitResult | null>{
    try{
        const [allowed, remaining, retry] = await lua.tpmOp(`rl:tpm:${keyId}`, limit, cost, 'reserve');
        return { allowed: allowed === 1, remaining, retryAfter: retry }; 
    } catch (err){
        return redisDown(err);
    }
}

export async function adjustTokens(keyId: number, limit: number, delta: number): Promise<void> {
    if (delta === 0) return;
    await lua.tpmOp(`rl:tpm:${keyId}`, limit, delta, 'adjust');
}

export function estimatePromptTokens(messages: Array<{ content: string  }>): number{
    return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4) + 4, 3);
}

//Rate Limiting Headers
export function setRpmHeaders(res: Response, limit: number, remaining: number){
    res.setHeader('X-RateLimit-Limit-Requests', String(limit));
    if(remaining >= 0) res.setHeader('X-RateLimit-Remaining-Requests', String(remaining))
}

export function setTpmHeaders(res: Response, limit: number, remaining: number) {
    res.setHeader('X-RateLimit-Limit-Tokens', String(limit));
    if (remaining >= 0) res.setHeader('X-RateLimit-Remaining-Tokens', String(Math.max(0, remaining)));
}


export function sendRateLimited(res: Response, type: 'rpm' | 'tpm', result: LimitResult, message: string) {
    rateLimitedTotal.inc({ type });
    res.setHeader('Retry-After', String(result.retryAfter));
    return res.status(429).json({
        error: { message, type: 'rate_limit_error', code: `$(type)_limit_exceeded` }
    });
}

export async function rpmLimiter(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const key = req.apiKey!;
    const result = await checkRpm(key.id, key.rpmLimit);

    if(result === null){
        return res.status(503).json({ error: { message: 'Rate limiter unavailable', type:'server_error' } });
    }
    setRpmHeaders(res, key.rpmLimit, result.remaining);
    if (!result.allowed) {
        return sendRateLimited(
            res, 'rpm', result,
            `Rate Limit reached: ${key.rpmLimit} requests/min. Retry in ${result.retryAfter}s`            
        );
    }
    next();
    
}