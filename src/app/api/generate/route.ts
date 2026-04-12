import { Agent } from "undici"
import { NextResponse } from "next/server"

import { canUseInlineLlm, generateTerraformInline } from "@/lib/terraform-llm"

export const runtime = "nodejs"

/** Vercel caps this by plan (e.g. 60s Hobby, 300s Pro). Groq is usually faster. */
export const maxDuration = 800

type GenerateRequest = {
  prompt: string
  enqueue_execution?: boolean
}

const backendAgent = new Agent({
  headersTimeout: Number(process.env.BACKEND_FETCH_TIMEOUT_MS ?? 900000) || 900000,
  bodyTimeout: Number(process.env.BACKEND_FETCH_TIMEOUT_MS ?? 900000) || 900000,
  connectTimeout: 60_000,
})

async function proxyToPython(
  prompt: string,
  enqueueExecution: boolean
): Promise<Response> {
  const backendBaseUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:8000"
  const url = `${backendBaseUrl}/generate`
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, enqueue_execution: enqueueExecution }),
    dispatcher: backendAgent,
  } as RequestInit)
}

export async function POST(req: Request) {
  const body = (await req.json()) as Partial<GenerateRequest>
  const prompt = (body.prompt ?? "").trim()
  const enqueueExecution = body.enqueue_execution === true

  if (!prompt) {
    return NextResponse.json({ error: "Missing prompt" }, { status: 400 })
  }

  if (canUseInlineLlm()) {
    try {
      const result = await generateTerraformInline(prompt)
      const payload = JSON.stringify({
        hcl_code: result.hcl_code,
        explanation: result.explanation,
        job_id: null,
      })
      return new NextResponse(payload, {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return NextResponse.json(
        { error: "Generation failed", detail: msg },
        { status: 500 }
      )
    }
  }

  const backendUrl = process.env.BACKEND_URL?.trim()
  if (!backendUrl) {
    return NextResponse.json(
      {
        error: "No LLM configured",
        detail:
          "Set GROQ_API_KEY or GEMINI_API_KEY for Vercel (see .env.example), or set BACKEND_URL to use the Python API.",
      },
      { status: 503 }
    )
  }

  let res: Response
  try {
    res = await proxyToPython(prompt, enqueueExecution)
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

  return new NextResponse(text, {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
