"use client"

import * as React from "react"
import ReactFlow, { Background, Controls, type ReactFlowInstance } from "reactflow"
import "reactflow/dist/style.css"
import { Copy, Download, Send } from "lucide-react"

import { FlowInfraNode } from "@/components/dashboard/FlowInfraNode"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import {
  buildTerraformFlowGraph,
  CATEGORY_LEGEND_SWATCH,
  type FlowNodeCategory,
} from "@/lib/terraform-flow-graph"

type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
}

type GenerateResult = {
  hcl_code: string
  explanation: string
  job_id?: string | null
}

type EngineEvent =
  | { type: "log"; message: string }
  | {
      type: "status"
      state?: string
      ok?: boolean
      message?: string
      error?: string
    }

type LogLine = {
  id: string
  level: "info" | "warn" | "error"
  message: string
}

const initialMessages: ChatMessage[] = [
  {
    id: "m1",
    role: "assistant",
    content:
      "Describe the infrastructure you want (provider, region, resources). I’ll generate Terraform and stream execution logs here.",
  },
]

const initialLogs: LogLine[] = [
  { id: "l1", level: "info", message: "Ready. Generate to enqueue a job…" },
]

const flowNodeTypes = { flowNode: FlowInfraNode }

export function PromptOpsDashboard() {
  const [messages, setMessages] = React.useState<ChatMessage[]>(initialMessages)
  const [draft, setDraft] = React.useState("")

  const [activeRightPane, setActiveRightPane] = React.useState<
    "flow" | "overview" | "terraform"
  >("flow")
  const [latestTerraform, setLatestTerraform] = React.useState<GenerateResult | null>(null)
  const [isGenerating, setIsGenerating] = React.useState(false)
  const [streamingJobId, setStreamingJobId] = React.useState<string | null>(null)

  const [logs, setLogs] = React.useState<LogLine[]>(initialLogs)
  const wsRef = React.useRef<WebSocket | null>(null)
  const logScrollRef = React.useRef<HTMLDivElement>(null)
  const reactFlowRef = React.useRef<ReactFlowInstance | null>(null)

  const { nodes, edges, overview } = React.useMemo(
    () =>
      buildTerraformFlowGraph(
        latestTerraform?.hcl_code ?? "",
        latestTerraform?.explanation ?? ""
      ),
    [latestTerraform?.hcl_code, latestTerraform?.explanation]
  )

  const [copiedTf, setCopiedTf] = React.useState(false)
  const copyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const onFlowInit = React.useCallback((instance: ReactFlowInstance) => {
    reactFlowRef.current = instance
    requestAnimationFrame(() => {
      instance.fitView({ padding: 0.2, maxZoom: 1.25, duration: 200 })
    })
  }, [])

  React.useEffect(() => {
    const inst = reactFlowRef.current
    if (!inst) return
    requestAnimationFrame(() => {
      inst.fitView({ padding: 0.2, maxZoom: 1.25, duration: 200 })
    })
  }, [nodes, edges])

  React.useEffect(() => {
    const el = logScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [logs])

  const appendLog = React.useCallback((level: LogLine["level"], message: string) => {
    setLogs((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, level, message },
    ])
  }, [])

  const copyTerraform = React.useCallback(async () => {
    const hcl = latestTerraform?.hcl_code
    if (!hcl) return
    try {
      await navigator.clipboard.writeText(hcl)
      setCopiedTf(true)
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => setCopiedTf(false), 2000)
    } catch {
      appendLog("error", "Could not copy to clipboard (browser permission).")
    }
  }, [latestTerraform?.hcl_code, appendLog])

  const downloadTerraform = React.useCallback(() => {
    const hcl = latestTerraform?.hcl_code
    if (!hcl) return
    const blob = new Blob([hcl], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "main.tf"
    a.click()
    URL.revokeObjectURL(url)
  }, [latestTerraform?.hcl_code])

  React.useEffect(() => {
    if (!streamingJobId) return

    const base = process.env.NEXT_PUBLIC_ENGINE_WS_URL ?? "ws://127.0.0.1:8080/ws"
    const url = `${base}${base.includes("?") ? "&" : "?"}job_id=${encodeURIComponent(streamingJobId)}`

    wsRef.current?.close()
    appendLog("info", `WebSocket: subscribing to job ${streamingJobId}`)

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as EngineEvent
        if (msg.type === "log" && msg.message) {
          appendLog("info", msg.message)
          return
        }
        if (msg.type === "status") {
          if (msg.state === "running" && msg.message) {
            appendLog("info", msg.message)
            return
          }
          if (msg.state === "done") {
            appendLog(
              msg.ok ? "info" : "error",
              msg.message ?? (msg.ok ? "Job finished." : "Job failed.")
            )
            return
          }
          if (msg.state === "failed") {
            appendLog("error", msg.error ?? msg.message ?? "Job failed.")
          }
        }
      } catch {
        appendLog("warn", String(ev.data))
      }
    }

    ws.onerror = () => {
      appendLog("error", "WebSocket error (is the Go engine running on :8080?)")
    }

    return () => {
      ws.close()
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [streamingJobId, appendLog])

  async function onSend() {
    const content = draft.trim()
    if (!content) return

    const userMsg: ChatMessage = {
      id: `${Date.now()}-u`,
      role: "user",
      content,
    }
    setMessages((prev) => [...prev, userMsg])
    setDraft("")

    setIsGenerating(true)
    setStreamingJobId(null)
    appendLog(
      "info",
      "Calling /api/generate (LLM). First response can take 10–60s — enable Redis + Go engine later for live Terraform logs."
    )

    const pendingId = `${Date.now()}-a-pending`
    setMessages((prev) => [
      ...prev,
      { id: pendingId, role: "assistant", content: "Generating Terraform…" },
    ])

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: content, enqueue_execution: false }),
      })
      if (!res.ok) {
        const errText = await res.text()
        throw new Error(errText || `HTTP ${res.status}`)
      }

      const data = (await res.json()) as GenerateResult
      setLatestTerraform(data)
      setActiveRightPane("flow")
      appendLog("info", "Generation complete — see Flow for the live diagram and Overview for a written walkthrough.")

      if (data.job_id) {
        setStreamingJobId(data.job_id)
      } else {
        appendLog("warn", "No job_id returned — is Redis running and backend configured?")
      }

      setMessages((prev) => prev.filter((m) => m.id !== pendingId).concat({
        id: `${Date.now()}-a`,
        role: "assistant",
        content:
          `${data.explanation}\n\n` +
          `Terraform generated. Open Flow for the diagram, Overview for the explanation, Terraform to copy or download main.tf.`,
      }))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      appendLog("error", `Generation failed: ${message}`)
      setMessages((prev) =>
        prev.filter((m) => m.id !== pendingId).concat({
          id: `${Date.now()}-a-error`,
          role: "assistant",
          content:
            "Generation failed. Check backend on :8000, Groq/Ollama/Gemini env in backend/.env, and Redis if enqueue is enabled.",
        })
      )
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <div className="h-[100dvh] w-full bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-4 p-4">
        <header className="flex items-center justify-between">
          <div className="flex flex-col">
            <div className="text-lg font-semibold">PromptOps</div>
            <div className="text-sm text-muted-foreground">
              Chat-to-Infrastructure
            </div>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[420px_1fr]">
          <Card className="min-h-0 overflow-hidden">
            <div className="flex h-full flex-col">
              <div className="px-4 py-3 text-sm font-medium">Chat</div>
              <Separator />
              <ScrollArea className="min-h-0 flex-1 p-4">
                <div className="flex flex-col gap-3">
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={[
                        "max-w-[95%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap",
                        m.role === "user"
                          ? "ml-auto bg-primary text-primary-foreground"
                          : "bg-muted text-foreground",
                      ].join(" ")}
                    >
                      {m.content}
                    </div>
                  ))}
                </div>
              </ScrollArea>
              <Separator />
              <div className="p-3">
                <div className="flex gap-2">
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="E.g. AWS us-east-1: VPC + ECS service + RDS Postgres, private subnets, HTTPS ALB…"
                    className="min-h-[46px] resize-none"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        onSend()
                      }
                    }}
                  />
                  <Button
                    onClick={onSend}
                    className="h-[46px] shrink-0 px-3"
                    disabled={isGenerating}
                  >
                    <Send className="size-4" />
                    <span className="sr-only">Send</span>
                  </Button>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Press <span className="font-medium">Ctrl</span>+
                  <span className="font-medium">Enter</span> to send.
                </div>
              </div>
            </div>
          </Card>

          <Card className="min-h-0 overflow-hidden">
            <div className="flex h-full flex-col">
              <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-medium">Resource Canvas</div>
                  <div className="flex flex-wrap items-center gap-1 rounded-full bg-muted p-1 text-xs">
                    <button
                      type="button"
                      className={[
                        "rounded-full px-2.5 py-1 transition-colors",
                        activeRightPane === "flow"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      ].join(" ")}
                      onClick={() => setActiveRightPane("flow")}
                    >
                      Flow
                    </button>
                    <button
                      type="button"
                      className={[
                        "rounded-full px-2.5 py-1 transition-colors",
                        activeRightPane === "overview"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      ].join(" ")}
                      onClick={() => setActiveRightPane("overview")}
                    >
                      Overview
                    </button>
                    <button
                      type="button"
                      className={[
                        "rounded-full px-2.5 py-1 transition-colors",
                        activeRightPane === "terraform"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      ].join(" ")}
                      onClick={() => setActiveRightPane("terraform")}
                    >
                      Terraform
                    </button>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {activeRightPane === "flow"
                    ? "Live diagram · request path + dependencies"
                    : activeRightPane === "overview"
                      ? "What the diagram means"
                      : "Copy or download main.tf"}
                </div>
              </div>
              <Separator />
              <div className="min-h-0 flex-1">
                {activeRightPane === "flow" ? (
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={flowNodeTypes}
                    onInit={onFlowInit}
                    fitView
                    minZoom={0.08}
                    maxZoom={1.5}
                    defaultEdgeOptions={{ type: "smoothstep" }}
                  >
                    <Background gap={18} size={1} />
                    <Controls />
                  </ReactFlow>
                ) : activeRightPane === "overview" ? (
                  <ScrollArea className="h-full">
                    <div className="space-y-6 p-4">
                      {!overview ? (
                        <p className="text-sm text-muted-foreground">
                          Generate Terraform from chat to see an explanation of the diagram and each
                          resource group.
                        </p>
                      ) : (
                        <>
                          <section>
                            <h3 className="text-sm font-semibold tracking-tight">
                              What you asked for
                            </h3>
                            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                              {overview.summary}
                            </p>
                          </section>
                          <section>
                            <h3 className="text-sm font-semibold tracking-tight">Node colors</h3>
                            <ul className="mt-3 space-y-2">
                              {overview.legend.map((row) => (
                                <li key={row.category} className="flex items-start gap-2 text-sm">
                                  <span
                                    className={[
                                      "mt-1.5 size-2.5 shrink-0 rounded-full",
                                      CATEGORY_LEGEND_SWATCH[row.category as FlowNodeCategory] ??
                                        "bg-zinc-500",
                                    ].join(" ")}
                                    aria-hidden
                                  />
                                  <span className="text-muted-foreground">{row.label}</span>
                                </li>
                              ))}
                            </ul>
                          </section>
                          {overview.sections.map((sec) => (
                            <section key={sec.heading}>
                              <h3 className="text-sm font-semibold tracking-tight">{sec.heading}</h3>
                              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
                                {sec.items.map((item, i) => (
                                  <li key={`${sec.heading}-${i}`} className="leading-relaxed">
                                    {item}
                                  </li>
                                ))}
                              </ul>
                            </section>
                          ))}
                        </>
                      )}
                    </div>
                  </ScrollArea>
                ) : (
                  <ScrollArea className="h-full">
                    <div className="space-y-4 p-4">
                      {!latestTerraform ? (
                        <p className="text-sm text-muted-foreground">
                          No Terraform yet. Send a prompt in chat to generate HCL here.
                        </p>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-medium">main.tf</div>
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="gap-1.5"
                                onClick={() => void copyTerraform()}
                              >
                                <Copy className="size-3.5" aria-hidden />
                                {copiedTf ? "Copied" : "Copy"}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="gap-1.5"
                                onClick={downloadTerraform}
                              >
                                <Download className="size-3.5" aria-hidden />
                                Download
                              </Button>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Select text with the mouse or use Ctrl+A inside the box to copy
                            manually.
                          </p>
                          <pre
                            tabIndex={0}
                            className="max-h-[min(70vh,720px)] overflow-auto select-text rounded-lg border border-border bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-100 outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {latestTerraform.hcl_code}
                          </pre>
                        </>
                      )}
                    </div>
                  </ScrollArea>
                )}
              </div>
            </div>
          </Card>
        </div>

        <Card className="min-h-0 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <div className="text-sm font-medium">Terminal</div>
            <div className="text-xs text-muted-foreground">
              {streamingJobId
                ? `Live logs · job ${streamingJobId.slice(0, 8)}…`
                : "Generate to connect (Redis → Go engine → WS)"}
            </div>
          </div>
          <Separator />
          <div
            ref={logScrollRef}
            className="h-[200px] overflow-y-auto scroll-smooth border-t border-border/40"
          >
            <div className="space-y-1 p-3 font-mono text-xs">
              {logs.map((l) => (
                <div key={l.id} className="flex gap-2">
                  <span
                    className={
                      l.level === "error"
                        ? "text-destructive"
                        : l.level === "warn"
                          ? "text-amber-500"
                          : "text-emerald-500"
                    }
                  >
                    {l.level.toUpperCase()}
                  </span>
                  <span className="text-muted-foreground">{l.message}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}

