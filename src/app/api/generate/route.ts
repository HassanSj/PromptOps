import { Agent } from "undici"
import { NextResponse } from "next/server"

export const runtime = "nodejs"

type GenerateRequest = {
  prompt: string
  enqueue_execution?: boolean
}

// Next.js server-side fetch uses Undici; default headers timeout (~5m) kills long LLM calls.
const backendAgent = new Agent({
  headersTimeout: Number(process.env.BACKEND_FETCH_TIMEOUT_MS ?? 900000) || 900000,
  bodyTimeout: Number(process.env.BACKEND_FETCH_TIMEOUT_MS ?? 900000) || 900000,
  connectTimeout: 60_000,
})

export async function POST(req: Request) {
  const body = (await req.json()) as Partial<GenerateRequest>
  const prompt = (body.prompt ?? "").trim()
  // Opt-in: Redis / Go engine queue is optional for local testing.
  const enqueueExecution = body.enqueue_execution === true

  if (!prompt) {
    return NextResponse.json(
      { error: "Missing prompt" },
      { status: 400 }
    )
  }

  const backendBaseUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:8000"
  const url = `${backendBaseUrl}/generate`

  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, enqueue_execution: enqueueExecution }),
      // Node's fetch (Undici) supports `dispatcher`; DOM RequestInit types omit it.
      dispatcher: backendAgent,
    } as RequestInit)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      {
        error: "Upstream fetch failed",
        detail: msg,
        hint:
          "LLM calls can take several minutes. If you see HeadersTimeoutError, increase BACKEND_FETCH_TIMEOUT_MS in .env.local (default 900000 ms).",
      },
      { status: 504 }
    )
  }

  const text = await res.text()

  if (!res.ok) {
    return NextResponse.json(
      { error: "Backend error", detail: text },
      { status: 502 }
    )
  }

  // Backend returns JSON: { hcl_code, explanation }
  return new NextResponse(text, {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

