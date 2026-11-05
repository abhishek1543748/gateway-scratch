export class QueueFullError extends Error {}
export class QueueTimeoutError extends Error {}
export class QueueAbortedError extends Error{}

export class BoundedQueue {
    private active = 0;
    private waiting: Array<{ resolve: () => void; reject: (err: Error) => void}> = [];

    constructor(
        private readonly maxConcurrency: number,
        private readonly maxQueueDepth: number,
        private readonly queueTimeoutMs: number
    ) {}

    async acquire(signal?: AbortSignal): Promise<void> {

        if (signal?.aborted) throw new QueueAbortedError('client aborted while in the Queue');

        if(this.active < this.maxConcurrency){
            this.active++;
            return;        
        }
        if(this.waiting.length >= this.maxQueueDepth){
            throw new QueueFullError('Server Queue is Full');
        }

        return new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
            };
            const remove = () => {
                const idx = this.waiting.findIndex((item) => item.resolve === onResolve);
                if(idx !== -1) this.waiting.splice(idx, 1);
            };

            const timer = setTimeout(() => {
                remove();
                cleanup();
                reject(new QueueTimeoutError('Timed out waiting in queue'));
            }, this.queueTimeoutMs);

            const onAbort = () => {
                remove();
                cleanup();
                reject(new QueueAbortedError('client aborted while being in queue'));
            }
            const onResolve = () => {
                cleanup();
                resolve();
            };
            signal?.addEventListener('abort', onAbort, { once: true }); 
            this.waiting.push({ resolve: onResolve, reject });
        });
    }

    release(): void {
        const next = this.waiting.shift();
        if(next) {
            next.resolve();
        }
        else{
            this.active--;
        }
    }


getStats(){
    return{
        active: this.active,
        waiting: this.waiting.length,
        maxConcurrency: this.maxConcurrency,
        maxQueueDepth: this.maxQueueDepth,
    };
}

}