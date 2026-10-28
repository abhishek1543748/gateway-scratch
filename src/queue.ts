export class QueueFullError extends Error {}
export class QueueTimeoutError extends Error {}

export class BoundedQueue {
    private active = 0;
    private waiting: Array<{ resolve: () => void; reject: (err: Error) => void}> = [];

    constructor(
        private readonly maxConcurrency: number,
        private readonly maxQueueDepth: number,
        private readonly queueTimeoutMs: number
    ) {}

    async acquire(): Promise<void> {
        if(this.active < this.maxConcurrency){
            this.active++;
            return;        
        }
        if(this.waiting.length >= this.maxQueueDepth){
            throw new QueueFullError('Server Queue is Full');
        }

        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this.waiting.findIndex((Item) => Item.resolve === onResolve);
                if(idx !== -1) this.waiting.splice(idx, 1);
                reject(new QueueTimeoutError('Timed out waiting in queue'));
            }, this.queueTimeoutMs);

            const onResolve = () => {
                clearTimeout(timer);
                resolve();
            };
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