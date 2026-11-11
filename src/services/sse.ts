export class SseJsonParser {
    private buffer = '';
    constructor(private readonly onEvent: (json: any) => void) {}

    //actual token count, NOT newtwork Chunk counts
    //leaving unfinished tail in the buffer 
    feed(text: string): void {
        this.buffer += text;
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, idx).replace(/\r$/, '');
            this.buffer = this.buffer.slice(idx + 1);
            this.handleLine(line);
        }
    }

    //call this once the stream ends, in case the last line had no trailing newline
    flush(): void{ 
        if(this.buffer.length) {
            this.handleLine(this.buffer.replace(/\r$/, ''));
            this.buffer = '';            
        }
        
    }
    private handleLine(line: string) {
        if(!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if(!payload || payload === '[DONE]') return;
        try{
            this.onEvent(JSON.parse(payload));
        }catch {

        }
    }
}