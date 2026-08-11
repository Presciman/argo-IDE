import { WebContents } from 'electron'
import { request as httpRequest, ClientRequest } from 'http'
import { request as httpsRequest } from 'https'
import { ChatRequest, StreamEvent } from '../shared/types'
import { argoAuthHeaders, loadSettings, resolveBaseUrl } from './settings'

/**
 * Streams chat completions from Argo (through the shim, or directly on the
 * intranet) to the renderer.
 *
 * We use the OpenAI-format `/v1/chat/completions` endpoint rather than the
 * Anthropic `/v1/messages` one: it's the format the shim normalizes model
 * names for, and it covers Claude, GPT, and Gemini models with one code path.
 * The shim also injects the required `user` field for us.
 */

const inflight = new Map<string, ClientRequest>()

export function cancel(requestId: string): void {
  inflight.get(requestId)?.destroy()
  inflight.delete(requestId)
}

export function stream(sender: WebContents, req: ChatRequest): void {
  const s = loadSettings()
  const channel = `chat:stream:${req.requestId}`

  const emit = (event: StreamEvent): void => {
    if (!sender.isDestroyed()) sender.send(channel, event)
  }

  const url = new URL(resolveBaseUrl(s) + '/v1/chat/completions')
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...argoAuthHeaders(s)
  }

  const payload = JSON.stringify({
    model: req.model,
    messages: req.messages,
    stream: true,
    // Argo rejects /chat/completions without a valid ALCF user. The shim
    // injects this when absent, but in direct (intranet) mode nothing does.
    ...(s.celsUsername.trim() ? { user: s.celsUsername.trim() } : {})
  })
  headers['content-length'] = String(Buffer.byteLength(payload))

  const clientReq = send(url, { method: 'POST', headers, timeout: 300_000 }, (res) => {
    if (!res.statusCode || res.statusCode >= 400) {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        emit({ type: 'error', message: `HTTP ${res.statusCode}: ${body.slice(0, 400)}` })
        inflight.delete(req.requestId)
      })
      return
    }

    res.setEncoding('utf8')
    let buffer = ''

    res.on('data', (chunk: string) => {
      buffer += chunk
      // SSE frames are separated by a blank line; hold the trailing partial.
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)
            const delta = parsed?.choices?.[0]?.delta
            if (typeof delta?.content === 'string' && delta.content) {
              emit({ type: 'delta', text: delta.content })
            }

            // Reasoning models expose their chain of thought under one of two
            // spellings, and most models send neither. Purely additive: when
            // it's absent the trace just shows ArgoIDE's own steps.
            const reasoning = delta?.reasoning_content ?? delta?.reasoning
            if (typeof reasoning === 'string' && reasoning) {
              emit({ type: 'reasoning', text: reasoning })
            }

            if (parsed?.usage) {
              emit({
                type: 'usage',
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens
              })
            }
          } catch {
            // A frame we can't parse isn't fatal — skip it and keep streaming.
          }
        }
      }
    })

    res.on('end', () => {
      emit({ type: 'done' })
      inflight.delete(req.requestId)
    })
  })

  clientReq.on('timeout', () => clientReq.destroy(new Error('request timed out')))
  clientReq.on('error', (err) => {
    // destroy() during cancel() also lands here; the entry is already gone.
    if (inflight.has(req.requestId)) {
      emit({ type: 'error', message: err.message })
      inflight.delete(req.requestId)
    }
  })

  inflight.set(req.requestId, clientReq)
  clientReq.end(payload)
}
