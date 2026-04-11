"use client"

import * as React from "react"
import { Handle, Position, type NodeProps } from "reactflow"

import type { FlowNodeCategory } from "@/lib/terraform-flow-graph"

const categoryClass: Record<FlowNodeCategory, string> = {
  external:
    "border-sky-400/80 bg-gradient-to-br from-sky-500/25 to-indigo-600/20 text-sky-50 shadow-[0_0_20px_rgba(56,189,248,0.15)]",
  network:
    "border-cyan-500/70 bg-gradient-to-br from-cyan-600/20 to-teal-700/15 text-cyan-50",
  security:
    "border-amber-400/80 bg-gradient-to-br from-amber-500/25 to-orange-700/20 text-amber-50",
  loadbalancer:
    "border-violet-400/80 bg-gradient-to-br from-violet-600/25 to-fuchsia-700/20 text-violet-50",
  compute:
    "border-emerald-400/80 bg-gradient-to-br from-emerald-600/25 to-green-800/20 text-emerald-50",
  data: "border-rose-400/80 bg-gradient-to-br from-rose-600/25 to-pink-900/20 text-rose-50",
  other: "border-zinc-500/60 bg-gradient-to-br from-zinc-700/30 to-zinc-900/40 text-zinc-100",
  hint: "border-zinc-600 bg-zinc-900/80 text-zinc-300",
}

export type FlowInfraNodeData = {
  title: string
  subtitle: string
  category: FlowNodeCategory
}

function FlowInfraNodeInner({ data, selected }: NodeProps<FlowInfraNodeData>) {
  const cat = data.category in categoryClass ? data.category : "other"
  return (
    <div
      className={[
        "min-w-[148px] max-w-[220px] rounded-xl border-2 px-3 py-2.5 text-left shadow-lg backdrop-blur-sm transition-transform",
        categoryClass[cat],
        selected ? "ring-2 ring-white/40 ring-offset-2 ring-offset-transparent" : "",
      ].join(" ")}
    >
      {cat !== "hint" ? (
        <>
          <Handle
            type="target"
            position={Position.Left}
            className="!size-2.5 !border-2 !border-white/30 !bg-zinc-900"
          />
          <Handle
            type="source"
            position={Position.Right}
            className="!size-2.5 !border-2 !border-white/30 !bg-zinc-900"
          />
        </>
      ) : null}
      <div className="text-[11px] font-semibold leading-tight tracking-tight">{data.title}</div>
      <div className="mt-1 text-[10px] leading-snug opacity-85">{data.subtitle}</div>
    </div>
  )
}

export const FlowInfraNode = React.memo(FlowInfraNodeInner)
