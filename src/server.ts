import express from 'express';
import type { Request, Response } from 'express';
import { ChatCompletionSchema } from './schemas';
import { BoundedQueue, QueueFullError, QueueTimeoutError } from './queue';
import { initDb, logRequestMetrics } from './db';
import { authenticateApiKey, AuthenticateRequest } from './auth.ts';

const app = express();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {console.log(`server listening on port : ${PORT}`)});

app.use(express.json());
const gpuQueue = new BoundedQueue(2, 5, 10_000);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';

app.get('/healthz', async (_req: Request, res: Response) => {
    try{
        const upstreamRes = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
        if(!upstreamRes.ok) throw new Error('Ollama not reachable');
        res.json({ status: 'ok', engine: 'reachable', queue: gpuQueue.getStats() })  
    }
    catch (err) {
        res.status(503).json({ status : 'error', engine: 'unreachable' });
        console.error("Health check failed:", err);
    }
});

app.get('/v1/models', async (_req: Request, res: Response) => {
    try{
        const upstreamRes = await fetch(`${OLLAMA_BASE_URL}/v1/models`);
        const data = await upstreamRes.json();
        res.json(data);
    }catch (err : any){
        res.status(502).json({ error: 'Failed to fetch models from Ollama'})
    }
});

app.post('/v1/chat/completions', authenticateApiKey, async (req: AuthenticatedRequest, res: Response) => {
    const startTime = performance.now();
    const apiKeyId = req.apiKey?.id ?? null;


    //validating the request body
    const parsed = ChatCompletionSchema.safeParse(req.body);
    if(!parsed.success){
        return res.status(400).json({
            error: { messages: 'Bad Request', details: parsed.error.issues }
        });
    }
    const body = parsed.data;

    //checking the queue availability
    try{
        await gpuQueue.acquire();
    }catch (err) {
        if(err instanceof QueueFullError || err instanceof QueueTimeoutError){
            return res.status(503).json({
                error : {message: err.message, type: 'server_overloaded' },
            });
        }
        return res.status(500).json({ error: 'Queue error' });
    }
    const abortController = new AbortController();
    //read abt this abortController and the req.on() thing
    req.on('close', () => {
        if(!res.writableEnded){
            console.warn('[Gateway] client disconnected! cancelling Ollama request');
            abortController.abort();
        }
    });

    let promptTokens = 0;
    let compleitonTokens = 0;
    let ttftMs: number | null = null;
    let statusCode = 200;

    try{
        const upstreamPayload = {
            ...body,
            stream_options: body.stream ? { include_usage: true }: undefined,
        };
        const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(upstreamPayload),
            signal: abortController.signal,
        });

        if(!ollamaRes.ok || !ollamaRes.body){
            statusCode = ollamaRes.status;
            const errText = await ollamaRes.text();
            return res.status(ollamaRes.status).send(errText);
        }

        //mode A : Non streaming (stream : false)
        if(!body.stream){
            const json = await ollamaRes.json();
            promptTokens = json.usage?.prompt_tokens ?? 0;
            compleitonTokens = json.usage?.completion-tokens ?? 0;
            //const totalMs = Math.round(performance.now() - startTime);
            //console.log(`[Non streaming completed in ${totalMs} ms]`);
            return res.json(json);
        }

        //mode B : server-sent Events(stream : true)
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection' : 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        const reader = ollamaRes.body.getReader();
        const decoder  = new TextDecoder();
        let ttftMs: number | null = null;

        while(true) {
            const { done, value } = await reader.read();
            if(done) break;

            const chunkText = decoder.decode(value, { stream : true});

            //tracking ttft on the first content-bearing token
            if(ttftMs === null && /"content":"[^"]/.test(chunkText)){
                ttftMs = Math.round(performance.now() - startTime);
            }
            if(/"content":"[^"]/.test(chunkText)) {
                compleitonTokens++;
            }
            res.write(chunkText);
        }
        res.end();
        const totalMs = Math.round(performance.now() - startTime);
        console.log(`[Streaming] TTFT: ${ttftMs}ms | Total: ${totalMs}ms`);
    }
    catch(err : any){
        if(err.name === 'AbortError'){
            console.log('[Gateway] Upstream generation aborted cleanly.');
        }
        else{
            console.error('[Gateway] Upstream error', err);
            if(!res.headersSent){
                res.status(502).json({ error: 'Inference engine communication failed'});
            }
        }
    }
    finally{
        //Release the concurrency slot so the next request can proceed
        gpuQueue.release();
        const totalDurationMs = Math.round(performance.now() - startTime);
        logRequestMetrics({
            apiKeyId,
            model: body.model,
            promptTokens,
            compleitonTokens,
            ttftMs,
            totalDurationMs,
            statusCode,
        });
    }


});