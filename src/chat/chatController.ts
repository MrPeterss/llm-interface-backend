import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1, 'Message content cannot be empty'),
});

const chatRequestSchema = z.object({
  messages: z
    .array(messageSchema)
    .min(1, 'At least one message is required')
    .max(100, 'Too many messages (max 100)'),
  stream: z.boolean().optional().default(false),
});

interface LlmUsage {
  completion_tokens?: number;
  reasoning_tokens?: number;
}

function extractOutputTokens(usage: LlmUsage): number {
  return (usage.completion_tokens ?? 0) + (usage.reasoning_tokens ?? 0);
}

async function logRequest(apiKeyId: number, totalTokens: number | null): Promise<void> {
  try {
    await prisma.apiKeyRequest.create({
      data: {
        apiKeyId,
        createdAt: new Date(),
        totalTokens,
      },
    });
  } catch (error) {
    console.error('Failed to log API key request:', error);
  }
}

export async function chat(req: Request, res: Response): Promise<void> {
  const validation = chatRequestSchema.safeParse(req.body);

  if (!validation.success) {
    res.status(400).json({
      error: 'Validation failed',
      details: validation.error.issues.map((err) => ({
        field: err.path.join('.'),
        message: err.message,
      })),
    });
    return;
  }

  const { messages, stream } = validation.data;
  const apiKeyId: number | undefined = res.locals.apiKeyId;

  const fetchUrl = process.env.FETCH_URL || 'http://vllm:8000/v1/chat/completions';
  const model = process.env.MODEL || 'openai/gpt-oss-20b';

  const abortController = new AbortController();

  req.on('close', () => {
    if (!res.writableEnded) {
      console.log('Client disconnected, aborting LLM request');
      abortController.abort();
    }
  });

  try {
    const response = await fetch(fetchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream,
        keep_alive: -1,
        // Request usage info in the final streaming chunk
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      }),
      signal: abortController.signal,
    });

    res.status(response.status);

    if (stream) {
      res.setHeader('X-Accel-Buffering', 'no');
    }

    const headersToForward = [
      'content-type',
      'transfer-encoding',
      'cache-control',
      'content-encoding',
    ];
    headersToForward.forEach((header) => {
      const value = response.headers.get(header);
      if (value) res.setHeader(header, value);
    });

    if (response.body) {
      if (stream) {
        // Streaming: pipe SSE chunks, intercept usage from final usage chunk
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let capturedTokens: number | null = null;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            if (apiKeyId !== undefined) {
              const text = decoder.decode(value, { stream: true });
              for (const line of text.split('\n')) {
                if (!line.startsWith('data:')) continue;
                const json = line.slice(5).trim();
                if (json === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(json) as { usage?: LlmUsage | null };
                  if (parsed.usage) {
                    capturedTokens = extractOutputTokens(parsed.usage);
                  }
                } catch {
                  // non-JSON SSE line, ignore
                }
              }
            }

            if (!res.write(value)) {
              await new Promise((resolve) => res.once('drain', resolve));
            }
          }
          res.end();
        } catch (error) {
          console.error('Error streaming response:', error);
          if (!res.headersSent) {
            res.status(502).json({ error: 'Error streaming response' });
          }
          res.end();
        } finally {
          reader.releaseLock();
          if (apiKeyId !== undefined) {
            await logRequest(apiKeyId, capturedTokens);
          }
        }
      } else {
        // Non-streaming: read full JSON body, extract usage, forward to client
        let capturedTokens: number | null = null;
        try {
          const body = await response.json() as { usage?: LlmUsage | null };
          if (body.usage) {
            capturedTokens = extractOutputTokens(body.usage);
          }
          res.json(body);
        } catch (error) {
          console.error('Error reading non-streaming response:', error);
          if (!res.headersSent) {
            res.status(502).json({ error: 'Error reading LLM response' });
          }
        } finally {
          if (apiKeyId !== undefined) {
            await logRequest(apiKeyId, capturedTokens);
          }
        }
      }
    } else {
      res.end();
      if (apiKeyId !== undefined) {
        await logRequest(apiKeyId, null);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.log('LLM request aborted due to client disconnect');
      if (!res.headersSent) {
        res.status(499).end();
      }
      return;
    }
    console.error('Error connecting to LLM:', error);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Failed to connect to LLM' });
    }
  }
}
