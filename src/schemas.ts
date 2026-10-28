import { z } from 'zod';
export const ChatCompletionSchema = z.object({
    model: z.string().min(1),
    messages: z
        .array(
            z.object({
                role: z.enum(['system', 'user', 'assistant']),
                content: z.string().min(1).max(10000)
            })
        )
        .min(1),
    stream: z.boolean().optional().default(true),
    max_tokens: z.number().int().min(1).max(1024).optional().default(256),
temperature: z.number().min(0).max(2).optional().default(1),
});

export type ChatCompletionSchema = z.infer<typeof ChatCompletionSchema>;