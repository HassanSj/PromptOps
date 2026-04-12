/**
 * Server-side Terraform generation (Groq / Gemini) for Vercel and local Next.js
 * without the Python FastAPI service.
 */

export type TerraformAIResult = {
  hcl_code: string
  explanation: string
}

const FENCE_RE = /^```(?:hcl|terraform|tf)?\s*|\s*```$/gim
/** `[\s\S]` instead of `.` with `s` flag for older TS targets */
const FENCED_BLOCK_RE = /```(?:hcl|terraform|tf)\s*\r?\n?([\s\S]*?)```/gi
const GENERIC_FENCE_RE = /```\w*\s*\r?\n?([\s\S]*?)```/gi

function stripCodeFences(s: string): string {
  return s.replace(FENCE_RE, "").trim()
}

function looksLikeHcl(s: string): boolean {
  const low = s.toLowerCase()
  return (
    low.includes("resource ") ||
    low.includes("provider ") ||
    low.includes("module ") ||
    low.includes("terraform {") ||
    low.includes("data ") ||
    low.includes("variable ")
  )
}

function largestHclFence(raw: string): string | null {
  const blocks: string[] = []
  for (const m of raw.matchAll(FENCED_BLOCK_RE)) {
    blocks.push(m[1]!.trim())
  }
  if (blocks.length === 0) {
    for (const m of raw.matchAll(GENERIC_FENCE_RE)) {
      if (looksLikeHcl(m[1]!)) blocks.push(m[1]!.trim())
    }
  }
  const hclBlocks = blocks.filter(looksLikeHcl)
  const pool = hclBlocks.length > 0 ? hclBlocks : blocks
  if (pool.length === 0) return null
  return pool.reduce((a, b) => (a.length >= b.length ? a : b))
}

function explanationFromPreamble(raw: string): string {
  const idx = raw.indexOf("```")
  let head = (idx !== -1 ? raw.slice(0, idx) : raw).trim()
  head = head.replace(/\s+/g, " ")
  if (!head) return "Recovered Terraform from markdown output (model did not return JSON)."
  return head.length > 1200 ? head.slice(0, 1200) + "…" : head
}

function fallbackFromText(raw: string): TerraformAIResult | null {
  const t = raw.trim()
  if (!t) return null
  const hcl = largestHclFence(t)
  if (hcl) {
    return { hcl_code: hcl, explanation: explanationFromPreamble(t) }
  }
  const start = t.indexOf("{")
  const end = t.lastIndexOf("}")
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>
      if (obj && typeof obj.hcl_code === "string") {
        return {
          hcl_code: obj.hcl_code,
          explanation:
            (typeof obj.explanation === "string" && obj.explanation.trim()) ||
            "Generated Terraform.",
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

const FORMAT_INSTRUCTIONS = `The JSON object must have exactly these keys:
- "hcl_code": string — Terraform HCL only (typically main.tf), no markdown fences.
- "explanation": string — short summary of what will be deployed and any defaults you chose.`

function buildMessages(userPrompt: string): { system: string; user: string } {
  const system = [
    "You are a senior cloud infrastructure engineer.",
    "Convert the user's request into Terraform configuration.",
    "",
    "Hard rules:",
    "- Output MUST be valid JSON that matches the provided schema.",
    "- Reply with that JSON object only — no preamble, no ``` fences around the whole answer.",
    "- The field `hcl_code` MUST contain only Terraform HCL, no Markdown fences.",
    "- Use Terraform best practices: least privilege, secure defaults, and clear naming.",
    "- Prefer widely-used official providers.",
    "- If the user omits critical info (region, names), choose safe defaults and mention them in `explanation`.",
    "",
    FORMAT_INSTRUCTIONS,
  ].join("\n")
  return { system, user: userPrompt }
}

function parseModelJson(text: string): TerraformAIResult {
  const trimmed = text.trim()
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>
    if (typeof obj.hcl_code === "string" && typeof obj.explanation === "string") {
      return {
        hcl_code: stripCodeFences(obj.hcl_code),
        explanation: obj.explanation.trim() || "Generated Terraform.",
      }
    }
  } catch {
    /* fall through */
  }
  const recovered = fallbackFromText(trimmed)
  if (!recovered) {
    throw new Error(
      "LLM output was not valid JSON and no Terraform ```hcl``` block could be recovered."
    )
  }
  return {
    hcl_code: stripCodeFences(recovered.hcl_code),
    explanation: recovered.explanation,
  }
}

function resolveProvider(): "groq" | "gemini" | "ollama" {
  const explicit = (process.env.LLM_PROVIDER ?? "").trim().toLowerCase()
  if (explicit === "gemini" || explicit === "groq" || explicit === "ollama") {
    return explicit
  }
  if (process.env.GROQ_API_KEY?.trim()) return "groq"
  if (["1", "true", "yes"].includes((process.env.USE_OLLAMA ?? "").trim().toLowerCase())) {
    return "ollama"
  }
  if (process.env.GEMINI_API_KEY?.trim()) return "gemini"
  return "ollama"
}

async function callGroq(userPrompt: string): Promise<string> {
  const key = process.env.GROQ_API_KEY?.trim()
  if (!key) {
    throw new Error(
      "GROQ_API_KEY is not set. Get a free key at https://console.groq.com/ or set BACKEND_URL to use the Python API."
    )
  }
  const model =
    (process.env.GROQ_MODEL ?? "llama-3.1-8b-instant").trim() || "llama-3.1-8b-instant"
  const { system, user } = buildMessages(userPrompt)
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new Error(`Groq API error ${res.status}: ${raw.slice(0, 2000)}`)
  }
  const data = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const text = data.choices?.[0]?.message?.content
  if (!text || typeof text !== "string") {
    throw new Error("Groq returned no message content")
  }
  return text
}

async function callGemini(userPrompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY?.trim()
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY is not set for LLM_PROVIDER=gemini, or set GROQ_API_KEY / BACKEND_URL."
    )
  }
  const model =
    (process.env.GEMINI_MODEL ?? "gemini-2.0-flash").trim() || "gemini-2.0-flash"
  const { system, user } = buildMessages(userPrompt)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2 },
    }),
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${raw.slice(0, 2000)}`)
  }
  const data = JSON.parse(raw) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("")
  if (!text) {
    throw new Error("Gemini returned no text")
  }
  return text
}

async function callOllama(userPrompt: string): Promise<string> {
  const base =
    (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").trim() ||
    "http://127.0.0.1:11434"
  const model = (process.env.OLLAMA_MODEL ?? "llama3.2").trim() || "llama3.2"
  const { system, user } = buildMessages(userPrompt)
  const res = await fetch(`${base.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      options: { temperature: 0.2 },
    }),
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${raw.slice(0, 500)}`)
  }
  const data = JSON.parse(raw) as { message?: { content?: string } }
  const text = data.message?.content
  if (!text) throw new Error("Ollama returned no content")
  return text
}

/**
 * Generate Terraform from a natural-language prompt using env-configured LLM.
 * On Vercel, use GROQ_API_KEY or GEMINI_API_KEY (Ollama only works if the URL is reachable from the runtime).
 */
export async function generateTerraformInline(userPrompt: string): Promise<TerraformAIResult> {
  const provider = resolveProvider()
  let rawText: string
  if (provider === "groq") {
    rawText = await callGroq(userPrompt)
  } else if (provider === "gemini") {
    rawText = await callGemini(userPrompt)
  } else {
    if (process.env.VERCEL) {
      throw new Error(
        "Ollama is not available on Vercel (localhost). Set GROQ_API_KEY or GEMINI_API_KEY in the project Environment Variables."
      )
    }
    rawText = await callOllama(userPrompt)
  }
  return parseModelJson(rawText)
}

export function canUseInlineLlm(): boolean {
  const p = resolveProvider()
  if (p === "groq") return !!process.env.GROQ_API_KEY?.trim()
  if (p === "gemini") return !!process.env.GEMINI_API_KEY?.trim()
  if (process.env.VERCEL) return false
  return true
}
