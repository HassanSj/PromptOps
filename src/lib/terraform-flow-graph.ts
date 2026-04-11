import { MarkerType, type Edge, type Node } from "reactflow"

const RESOURCE_DECL_RE = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g

const REF_RE =
  /\b((?:aws|azurerm|google|random|tls|null)_[a-z0-9_]+)\.([a-zA-Z0-9_.-]+)\b/g

export type FlowNodeCategory =
  | "external"
  | "network"
  | "security"
  | "loadbalancer"
  | "compute"
  | "data"
  | "other"
  | "hint"

const TYPE_LABEL: Record<string, string> = {
  aws_vpc: "VPC",
  aws_subnet: "Subnet",
  aws_security_group: "Security group",
  aws_lb: "Application load balancer",
  aws_alb: "Application load balancer",
  aws_lb_target_group: "Target group",
  aws_lb_listener: "Listener",
  aws_ecs_cluster: "ECS cluster",
  aws_ecs_cluster_capacity_providers: "ECS capacity providers",
  aws_ecs_service: "ECS service",
  aws_ecs_task_definition: "Task definition",
  aws_db_instance: "RDS instance",
  aws_db_subnet_group: "DB subnet group",
  aws_internet_gateway: "Internet gateway",
  aws_nat_gateway: "NAT gateway",
  aws_route_table: "Route table",
  aws_route_table_association: "Route table association",
  aws_eip: "Elastic IP",
}

const LEGEND: { category: FlowNodeCategory; label: string }[] = [
  { category: "external", label: "Traffic entry (users / internet)" },
  { category: "network", label: "Network (VPC, subnets, gateways, routing)" },
  { category: "security", label: "Security groups & access rules" },
  { category: "loadbalancer", label: "Load balancing (ALB, listeners, target groups)" },
  { category: "compute", label: "Compute (ECS, EC2, Lambda, …)" },
  { category: "data", label: "Data stores (RDS, caches, …)" },
  { category: "other", label: "Other resources" },
]

export type DiagramOverview = {
  /** LLM summary — shown at top */
  summary: string
  sections: { heading: string; items: string[] }[]
  legend: { category: FlowNodeCategory; label: string }[]
}

export type TerraformFlowGraph = {
  nodes: Node[]
  edges: Edge[]
  /** Present when real resources were parsed */
  overview: DiagramOverview | null
}

const INTERNET_ID = "flow:internet"

function extractBracedBody(src: string, openBraceIndex: number): { body: string; end: number } {
  let depth = 0
  for (let i = openBraceIndex; i < src.length; i++) {
    const ch = src[i]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        return { body: src.slice(openBraceIndex + 1, i), end: i }
      }
    }
  }
  return { body: src.slice(openBraceIndex + 1), end: src.length }
}

export function resourceKey(type: string, name: string): string {
  return `${type}.${name}`
}

function friendlyTitle(type: string): string {
  return TYPE_LABEL[type] ?? type.replace(/^(aws|azurerm|google)_/, "").replace(/_/g, " ")
}

export function categoryForType(type: string): FlowNodeCategory {
  if (type === INTERNET_ID) return "external"
  if (type === "aws_db_subnet_group") return "data"
  if (
    /^aws_(vpc|subnet|internet_gateway|nat_gateway|egress_only_internet_gateway|vpc_peering_connection)/.test(
      type
    )
  )
    return "network"
  if (/route_table|_route$|^aws_eip$|^aws_eip_association$/.test(type)) return "network"
  if (type === "aws_security_group" || type.includes("network_acl")) return "security"
  if (
    /^aws_(lb|alb)$/.test(type) ||
    type.includes("lb_listener") ||
    type.includes("lb_target_group") ||
    type.includes("listener_rule")
  )
    return "loadbalancer"
  if (
    /^aws_ecs|^aws_ec2_|^aws_instance$|^aws_lambda|^aws_autoscaling|^aws_eks/.test(type) ||
    type.includes("fargate")
  )
    return "compute"
  if (/^aws_db_|^aws_rds|^aws_elasticache|^aws_s3_bucket|^aws_dynamodb_table/.test(type))
    return "data"
  return "other"
}

/** Left → right narrative column (data generally flows this direction). */
function flowRank(type: string): number {
  const c = categoryForType(type)
  const order: Record<FlowNodeCategory, number> = {
    external: 0,
    network: 1,
    security: 2,
    loadbalancer: 3,
    compute: 4,
    data: 5,
    other: 3,
    hint: -2,
  }
  return order[c] ?? 3
}

type Block = { type: string; name: string; body: string; key: string }

function parseBlocks(trimmed: string): Block[] {
  const blocks: Block[] = []
  let m: RegExpExecArray | null
  RESOURCE_DECL_RE.lastIndex = 0
  while ((m = RESOURCE_DECL_RE.exec(trimmed)) !== null) {
    const type = m[1]
    const name = m[2]
    const openIdx = m.index + m[0].length - 1
    const { body, end } = extractBracedBody(trimmed, openIdx)
    blocks.push({ type, name, body, key: resourceKey(type, name) })
    RESOURCE_DECL_RE.lastIndex = end + 1
  }
  return blocks
}

function dependencyEdges(blocks: Block[], keySet: Set<string>): Edge[] {
  const edges: Edge[] = []
  const edgeKeys = new Set<string>()
  for (const b of blocks) {
    REF_RE.lastIndex = 0
    let rm: RegExpExecArray | null
    while ((rm = REF_RE.exec(b.body)) !== null) {
      const refKey = resourceKey(rm[1], rm[2])
      if (!keySet.has(refKey) || refKey === b.key) continue
      const eid = `dep:${refKey}->${b.key}`
      if (edgeKeys.has(eid)) continue
      edgeKeys.add(eid)
      edges.push({
        id: eid,
        source: refKey,
        target: b.key,
        type: "smoothstep",
        animated: false,
        style: {
          stroke: "rgba(148, 163, 184, 0.55)",
          strokeWidth: 1.25,
          strokeDasharray: "4 6",
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(148, 163, 184, 0.7)", width: 16, height: 16 },
        data: { kind: "dependency" as const },
      })
    }
  }
  return edges
}

/** Inferred request / data path (ALB path, TG → ECS, internet → public LB). */
function inferFlowEdges(blocks: Block[], keySet: Set<string>): Edge[] {
  const out: Edge[] = []
  const seen = new Set<string>()
  const add = (
    source: string,
    target: string,
    id: string,
    label?: string
  ) => {
    if (!keySet.has(target)) return
    if (source !== INTERNET_ID && !keySet.has(source)) return
    if (seen.has(id)) return
    seen.add(id)
    out.push({
      id,
      source,
      target,
      type: "smoothstep",
      animated: true,
      label,
      labelStyle: { fill: "#e2e8f8", fontSize: 10 },
      labelBgStyle: { fill: "rgba(15,23,42,0.85)" },
      style: { stroke: "rgba(56, 189, 248, 0.9)", strokeWidth: 2.25 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "rgb(56, 189, 248)", width: 18, height: 18 },
      data: { kind: "flow" as const },
    })
  }

  let anyPublicLb = false
  for (const b of blocks) {
    if (b.type !== "aws_lb" && b.type !== "aws_alb") continue
    const internalTrue = /internal\s*=\s*true/.test(b.body)
    if (!internalTrue) {
      anyPublicLb = true
      add(INTERNET_ID, b.key, `flow:internet->${b.key}`, "HTTPS")
    }
  }

  for (const b of blocks) {
    if (b.type !== "aws_lb_listener" && b.type !== "aws_alb_listener") continue
    const lb = b.body.match(/load_balancer_arn\s*=\s*(aws_lb|aws_alb)\.([a-zA-Z0-9_-]+)\.arn/)
    if (lb) add(resourceKey(lb[1], lb[2]), b.key, `flow:lb->lis:${b.key}`)
    const tg = b.body.match(/target_group_arn\s*=\s*aws_lb_target_group\.([a-zA-Z0-9_-]+)\.arn/)
    if (tg) add(b.key, resourceKey("aws_lb_target_group", tg[1]), `flow:lis->tg:${b.key}`)
  }

  for (const b of blocks) {
    if (b.type !== "aws_ecs_service") continue
    for (const mm of b.body.matchAll(
      /target_group_arn\s*=\s*aws_lb_target_group\.([a-zA-Z0-9_-]+)\.arn/g
    )) {
      add(resourceKey("aws_lb_target_group", mm[1]), b.key, `flow:tg-ecs:${b.key}:${mm[1]}`, "to tasks")
    }
  }

  // RDS / DB ← compute when DB security group allows traffic from an ECS SG (same VPC pattern)
  for (const b of blocks) {
    if (b.type !== "aws_db_instance" && b.type !== "aws_rds_cluster_instance") continue
    const body = b.body
    const ecsServices = blocks.filter((x) => x.type === "aws_ecs_service")
    for (const svc of ecsServices) {
      const ecsSgs = [...svc.body.matchAll(/security_groups\s*=\s*\[([\s\S]*?)\]/g)]
      const flat = ecsSgs.flatMap((x) => x[1].split(",").map((s) => s.trim()))
      for (const expr of flat) {
        const sm = expr.match(/aws_security_group\.([a-zA-Z0-9_-]+)\.id/)
        if (!sm) continue
        const ecsSgKey = resourceKey("aws_security_group", sm[1])
        if (body.includes(ecsSgKey) || body.includes(`aws_security_group.${sm[1]}`)) {
          add(svc.key, b.key, `flow:ecs-db:${svc.key}->${b.key}`, "DB traffic")
          break
        }
      }
    }
  }

  if (anyPublicLb) keySet.add(INTERNET_ID)
  return out
}

function buildOverview(blocks: Block[], explanation: string): DiagramOverview {
  const byCat = new Map<FlowNodeCategory, Block[]>()
  for (const b of blocks) {
    const c = categoryForType(b.type)
    const arr = byCat.get(c) ?? []
    arr.push(b)
    byCat.set(c, arr)
  }
  for (const arr of byCat.values()) {
    arr.sort((a, x) => a.type.localeCompare(x.type) || a.name.localeCompare(x.name))
  }

  const order: FlowNodeCategory[] = [
    "network",
    "security",
    "loadbalancer",
    "compute",
    "data",
    "other",
  ]

  const sections: DiagramOverview["sections"] = order
    .map((cat) => {
      const arr = byCat.get(cat)
      if (!arr?.length) return null
      const heading =
        LEGEND.find((l) => l.category === cat)?.label ??
        cat.charAt(0).toUpperCase() + cat.slice(1)
      const items = arr.map(
        (r) =>
          `${friendlyTitle(r.type)} — resource ${r.type}.${r.name} in your generated Terraform.`
      )
      return { heading, items }
    })
    .filter(Boolean) as DiagramOverview["sections"]

  const flowLines: string[] = [
    "Bright cyan animated edges: inferred request path (for example internet → public ALB → listener → target group → ECS, or ECS → database when the HCL connects them).",
    "Muted gray edges: configuration dependencies (one block references another, such as a subnet referencing a VPC).",
  ]

  return {
    summary: explanation.trim() || "No summary was returned for this generation.",
    sections: [
      {
        heading: "How to read the flow diagram",
        items: flowLines,
      },
      ...sections,
    ],
    legend: [],
  }
}

function layoutNodes(
  blocks: Block[],
  includeInternet: boolean
): { nodes: Node[]; keySet: Set<string> } {
  const keySet = new Set(blocks.map((b) => b.key))
  if (includeInternet) keySet.add(INTERNET_ID)

  const ranks = new Map<number, { key: string; type: string; name: string }[]>()
  const addRank = (rank: number, key: string, type: string, name: string) => {
    const row = ranks.get(rank) ?? []
    row.push({ key, type, name })
    ranks.set(rank, row)
  }

  if (includeInternet) {
    addRank(0, INTERNET_ID, INTERNET_ID, "internet")
  }

  for (const b of blocks) {
    addRank(flowRank(b.type), b.key, b.type, b.name)
  }

  for (const row of ranks.values()) {
    row.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
  }

  const sortedRanks = [...ranks.keys()].sort((a, b) => a - b)
  const NODE_W = 200
  const NODE_H = 88
  const GAP_X = 56
  const GAP_Y = 36

  const nodes: Node[] = []
  for (const rank of sortedRanks) {
    const row = ranks.get(rank) ?? []
    row.forEach((cell, idx) => {
      const isNet = cell.key === INTERNET_ID
      const cat: FlowNodeCategory = isNet ? "external" : categoryForType(cell.type)
      const title = isNet ? "Users / Internet" : friendlyTitle(cell.type)
      const subtitle = isNet ? "Entry point for requests to public load balancers" : cell.name
      nodes.push({
        id: cell.key,
        position: { x: rank * (NODE_W + GAP_X), y: idx * (NODE_H + GAP_Y) },
        type: "flowNode",
        data: { title, subtitle, category: cat },
      })
    })
  }

  return { nodes, keySet }
}

/**
 * Builds a left-to-right flow diagram from Terraform HCL plus structured overview text.
 * @param explanation LLM explanation (shown in Overview tab).
 */
export function buildTerraformFlowGraph(hcl: string, explanation = ""): TerraformFlowGraph {
  const trimmed = hcl.trim()
  if (!trimmed) {
    return {
      nodes: [
        {
          id: "placeholder",
          position: { x: 0, y: 0 },
          type: "flowNode",
          data: {
            title: "No diagram yet",
            subtitle: "Send a prompt in chat to generate Terraform and this flow will appear here.",
            category: "hint" as FlowNodeCategory,
          },
        },
      ],
      edges: [],
      overview: null,
    }
  }

  const blocks = parseBlocks(trimmed)
  if (blocks.length === 0) {
    return {
      nodes: [
        {
          id: "placeholder",
          position: { x: 0, y: 0 },
          type: "flowNode",
          data: {
            title: "No resource blocks",
            subtitle: "This HCL did not contain any resource { ... } blocks to chart.",
            category: "hint",
          },
        },
      ],
      edges: [],
      overview: null,
    }
  }

  const tempKeySet = new Set(blocks.map((b) => b.key))
  const flowEdgesRaw = inferFlowEdges(blocks, tempKeySet)
  const includeInternet = flowEdgesRaw.some((e) => e.source === INTERNET_ID)
  const { nodes, keySet } = layoutNodes(blocks, includeInternet)

  const flowEdges = flowEdgesRaw.filter(
    (e) => keySet.has(e.source) && keySet.has(e.target)
  )

  const depEdges = dependencyEdges(blocks, keySet)
  const flowPair = new Set(flowEdges.map((e) => `${e.source}|${e.target}`))
  const depFiltered = depEdges.filter((e) => !flowPair.has(`${e.source}|${e.target}`))

  const edges: Edge[] = [...depFiltered, ...flowEdges]

  const overview = buildOverview(blocks, explanation)
  overview.legend = [
    { category: "external", label: "Traffic entry (users / internet)" },
    ...LEGEND.filter((l) => l.category !== "external"),
  ]

  return { nodes, edges, overview }
}

/** Legend color dots (match FlowInfraNode palette). */
export const CATEGORY_LEGEND_SWATCH: Record<FlowNodeCategory, string> = {
  external: "bg-sky-500 shadow-[0_0_10px_rgba(56,189,248,0.45)]",
  network: "bg-cyan-500",
  security: "bg-amber-500",
  loadbalancer: "bg-violet-500",
  compute: "bg-emerald-500",
  data: "bg-rose-500",
  other: "bg-zinc-500",
  hint: "bg-zinc-600",
}
