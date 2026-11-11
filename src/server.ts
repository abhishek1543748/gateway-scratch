import express from 'express';
import type { Request, Response } from 'express';
import { ChatCompletionSchema } from './schemas';
import { BoundedQueue, QueueFullError, QueueTimeoutError, QueueAbortedError } from './services/queue';
import { initDb, logRequestMetrics, pool  } from './infra/db';
import { authenticateApiKey } from './middleware/auth';
import type { AuthenticatedRequest } from './middleware/auth';

//New imports 
import { config } from './config';
import { redis } from './infra/redis';
import { SseJsonParser } from './services/sse';
import {
    rpmLimiter,
    reserveTokens,
    adjustTokens,
    estimatePromptTokens,
    setTpmHeaders,
    sendRateLimited,
} from './middleware/ratelimit';
import {
    register,
    httpMetrics,
    registerQueueGauges,
    ttftSeconds,
    requestDurationSeconds,
    queueWaitSeconds,
    tokensTotal,
} from './observability/metrics';
// ----------------------------------------

const app = express();
//what is app.dosable used for 
app.disable('x-powered-by');// removes the "express" in headers

const gpuQueue = new BoundedQueue(config.gpuMaxConcurrency, config.queueMaxDepth, config.queueTimeoutMs);
registerQueueGauges(gpuQueue);

//New
app.use(httpMetrics);
app.use(express.json({ limit: '1mb' }))

//New Endpoint: liveness probe for the docker healthcheck (must not depend on Ollama)
app.get('/livez', (_req, res) => { res.json({ status: 'ok'  }); });

//Changed : now also repsorts Redis and has a 3s timeout on the Ollama call
//Readiness: dependencies. 503 only if the inference engine is unreachable
app.get('/healthz', async (_req: Request, res: Response) => {
    const redisOk = await redis.ping().then(() => true, () => false);
    try{
        //abortsignal timeout: 
        const upstreamRes = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(3000)});
        if(!upstreamRes.ok) throw new Error('Ollama not reachable');
        res.json({ status: 'ok', engine: 'reachable', redis: redisOk ? 'ok' : 'down', queue: gpuQueue.getStats() })  
    }
    catch (err) {
        console.error("Health check failed:", err);
        res.status(503).json({ status : 'error', engine: 'unreachable', redis: redisOk ? 'ok' : 'down' });
        //503 only when Ollama is unreachable.Redis is not dependent
    }
});


//new API endpoint for metrics and Prometheus.PUBLIC by default;set METRCIS_TOKEN to require a bearer token
app.get('/metrics', async (req: Request, res: Response) => {
    if( config.metricsToken && req.headers.authorization !== `Bearer $(config.metricsToken)`){
        return res.status(401).end();
    }
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
    //register.metrics() is async and returns all metric values as Prometheus text format. res.end(...) sends it as the body
})


app.get('/v1/models', authenticateApiKey, async (_req: Request, res: Response) => {
    try{
        const upstreamRes = await fetch(`${config.ollamaBaseUrl}/v1/models`);
        res.json(await upstreamRes.json());
    }catch (err : any){
        res.status(502).json({ error: 'Failed to fetch models from Ollama'})
    }
});
//---------------------------------------------------------------------------------------
app.post('/v1/chat/completions', 
    authenticateApiKey,
    rpmLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
        const startTime = performance.now();
        const key = req.apiKey!;


        //validating the request body
        const parsed = ChatCompletionSchema.safeParse(req.body);
        if(!parsed.success){
            return res.status(400).json({
                error: { message: 'Bad Request', details: parsed.error.issues }
        });
    }
        const body = parsed.data;

        //-----TPM pre check: reserve a worst case budget (prompt_estimate + max_tokens)---
        const estPrompt = estimatePromptTokens(body.messages);
        const reserved = estPrompt + body.max_tokens;

        if(reserved > key.tpmLimit) {
            //this could never suceed even after using the whole bucket: 429 "Retry_later" would be a lie
            return res.status(400).json({ 
                error: {
                    message: `Request needs ~${reserved} tokens (prompt ~${estPrompt} + max_tokens ${body.max_tokens}) but this key's budget is ${key.tpmLimit}/min. Shorten the prompt or lower max_tokens.`,
                    type: 'invalid_request_error',
                    code: 'request_exceeds_token_budget',
                },
            });
        }
        const tpm = await reserveTokens(key.id, key.tpmLimit, reserved);
        if(tpm === null){
            return res.status(503).json({ error: { message: 'Rate limiter unavailable', type: 'server_error' } });
        }
        setTpmHeaders(res, key.tpmLimit, tpm.remaining);
        if(!tpm.allowed) {
            return sendRateLimited(
                res, 'tpm', tpm,
                `token budegt exhausted (${key.tpmLimit} tokens/min).Retry in ${tpm.retryAfter}s.`
            );
        }
        const reservationActive = !tpm.degraded; //nothing to refund if we failed open

    //-------------------------client dicsonnect cancellation


    // 1. Create the controller and start watching for disconnects FIRSt
    const abortController = new AbortController();
    //read abt this abortController and the req.on() thing
    //changed req.on() to res.on() .. study this later
    res.on('close', () => {
        if(!res.writableEnded){
            console.warn('[Gateway] client disconnected! cancelling Ollama request');
            abortController.abort();
        }
    });
    //this below line is also added 


    //per request accounting state
    let slotHeld = false;
    let dispatched = false;
    let statusCode = 200;
    let ttftMs: number | null = null;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
    let streamedChunks = 0;
    let upstreamOk = false;

    //checking the queue availability
    try{
        //--Waiting for a GPU Slot
        const queueStart = performance.now();
        try{
            await gpuQueue.acquire(abortController.signal);
            slotHeld = true;
            queueWaitSeconds.observe((performance.now() - queueStart) / 1000);
        
        }catch (err) {
            if (err instanceof QueueAbortedError) {
                statusCode = 499;
                return; // client is gone already, nothing to send now
            }
            if(err instanceof QueueFullError || err instanceof QueueTimeoutError){
                statusCode = 503;
                res.setHeader('Retry-After', '5');
                return res.status(503).json({
                    error : {message: err.message, type: 'server_overloaded' },
                });
            }
            statusCode = 500;
            return res.status(500).json({ error: 'Queue error', type: 'server_overloaded'});
        }

        if(abortController.signal.aborted){
            statusCode = 499;     //this slot will be released in finally now
            return;
        }

    
        const upstreamPayload = {
            ...body,
            stream_options: body.stream ? { include_usage: true }: undefined,
        };
        const ollamaRes = await fetch(`${config.ollamaBaseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(upstreamPayload),
            signal: abortController.signal,
        });

        if(!ollamaRes.ok || !ollamaRes.body){
            statusCode = ollamaRes.status;
            const errText = await ollamaRes.text();
            return res.status(ollamaRes.status).type('application/json').send(errText);
            //dispatched = false --> full refund below
        }
        //now if the upper if block is not entered means ollama is accepting req sucessfully
        //now we dispatched = true .. says that tokens were spent here so charge for them
        dispatched = true;
        upstreamOk = true;

        //mode A : Non streaming (stream : false)
        if(!body.stream){
            const json: any  = await ollamaRes.json();
            usage = json.usage ?? null;
            if (!usage){
                const text: string = json.choices?.[0]?.message?.content ?? '';
                streamedChunks = Math.ceil(text.length / 4);
            }
            res.json(json);
            return;
        }

        //mode B : server-sent Events(stream : true)
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection' : 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        //changed now: we are using the SSE Json parser
        const parser = new SseJsonParser((evt) => {
            if(evt?.usage) usage = evt.usage;
            const delta = evt?.choices?.[0]?.delta;
            if (delta && (delta.content || delta.reasoning || delta.reasoning_content)){
                streamedChunks++;
                if (ttftMs === null) ttftMs = Math.round(performance.now() - startTime);
            }
        });

        const reader = ollamaRes.body.getReader();
        const decoder  = new TextDecoder();
        //let ttftMs: number | null = null;

        while(true) {
            const { done, value } = await reader.read();
            if(done) break;

            const text = decoder.decode(value, { stream : true});
            parser.feed(text);
            res.write(value);
            //tracking ttft on the first content-bearing token
            //if(ttftMs === null && /"content":"[^"]/.test(chunkText)){
                //ttftMs = Math.round(performance.now() - startTime);
            //}
            //if(/"content":"[^"]/.test(chunkText)) {
                //completionTokens++;
            //}
            //res.write(chunkText);
        }
        parser.flush();
        res.end();//need to study more on this of it's working


        const totalMs = Math.round(performance.now() - startTime);
        console.log(`[Streaming] TTFT: ${ttftMs}ms | Total: ${totalMs}ms`);
    }
    catch(err : any){
        if(err?.name === 'AbortError'){
            console.log('[Gateway] Upstream generation aborted cleanly.');
            statusCode = 499; //adding this as this was seen as a 200 earlier.ai
        }
        else{
            console.error('[Gateway] Upstream error', err);
            statusCode = 502;
            if(!res.headersSent){
                res.status(502).json({ error: 'Inference engine communication failed'});
            }
            else if (!res.writableEnded) {
                res.end();
            }
        }
    }
    finally{
        //Release the concurrency slot so the next request can proceed
        //---freeing the gpu slot first: nothing below may delay the next request---
        if (slotHeld) gpuQueue.release();
        const totalDurationMs = Math.round(performance.now() - startTime);

        let promptTokens = 0;
        let completionTokens = 0;
        if (dispatched) {
            const u = usage as { prompt_tokens?: number, completion_tokens?: number } | null;
            promptTokens = u?.completion_tokens ?? estPrompt;
            completionTokens = u?.completion_tokens ?? streamedChunks; 
        }

        //8 psot request TPm reconiciliation (fire and forget)
        if (reservationActive) {
            adjustTokens(key.id, key.tpmLimit, promptTokens + completionTokens - reserved).catch((e) => 
                console.error('[RateLimit] reconcile failed: ', e.message)
            );
        }

        //promehteus
        const modelLabel = upstreamOk ? body.model : 'unknown';
        requestDurationSeconds.observe({ model: modelLabel, status_code: String(statusCode) }, totalDurationMs / 1000);
        if(ttftMs !== null) ttftSeconds.observe({ model: modelLabel, api_key: key.name }, ttftMs / 1000);
        if(promptTokens) tokensTotal.inc({model: modelLabel, api_key: key.name, type: 'prompt' }, promptTokens);
        if(completionTokens) tokensTotal.inc({ model: modelLabel, api_key: key.name, type: 'completion' }, completionTokens );
        
        //-----POSTGRESS Logging
        logRequestMetrics({ apiKeyId: key.id, model: body.model, promptTokens, completionTokens, ttftMs, totalDurationMs, statusCode});

        if(ttftMs !== null){
            console.log(`[stream] ${key.name} ${body.model} TTFT ${ttftMs}ms total ${totalDurationMs}ms tokens ${promptTokens}+${completionTokens}`)
        }
    }


});
const PORT = process.env.PORT || 3000;

initDb()
    .then(() => {
        app.listen(PORT, () => console.log(`Gateway listening on port ${PORT}`));
    })
    .catch((err: any) => {
        console.error(`Database initialization Failed due to ${err} Soryy..`, );
        process.exit(1);
    });
