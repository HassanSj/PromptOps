import json
import os
import re
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage
from langchain_core.output_parsers import PydanticOutputParser
from langchain_core.prompts import ChatPromptTemplate

from .schemas import TerraformAIResult


_FENCE_RE = re.compile(r"^```(?:hcl|terraform|tf)?\s*|\s*```$", re.MULTILINE)
# Fenced blocks: optional language tag, body until closing ```
_FENCED_BLOCK_RE = re.compile(
    r"```(?:hcl|terraform|tf)\s*\r?\n?(.*?)```",
    re.IGNORECASE | re.DOTALL,
)
_GENERIC_FENCE_RE = re.compile(r"```\w*\s*\r?\n?(.*?)```", re.IGNORECASE | re.DOTALL)


def _strip_code_fences(s: str) -> str:
    return _FENCE_RE.sub("", s).strip()


def _message_text(msg: BaseMessage) -> str:
    c = msg.content
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts: list[str] = []
        for p in c:
            if isinstance(p, dict) and p.get("type") == "text":
                parts.append(str(p.get("text", "")))
            elif isinstance(p, str):
                parts.append(p)
        return "\n".join(parts)
    return str(c)


def _looks_like_hcl(s: str) -> bool:
    low = s.lower()
    return any(
        needle in low
        for needle in ("resource ", "provider ", "module ", "terraform {", "data ", "variable ")
    )


def _largest_hcl_fence(raw: str) -> str | None:
    blocks = [b.strip() for b in _FENCED_BLOCK_RE.findall(raw)]
    if not blocks:
        blocks = [b.strip() for b in _GENERIC_FENCE_RE.findall(raw) if _looks_like_hcl(b)]
    hcl_blocks = [b for b in blocks if _looks_like_hcl(b)]
    pool = hcl_blocks or blocks
    if not pool:
        return None
    return max(pool, key=len)


def _explanation_from_preamble(raw: str) -> str:
    idx = raw.find("```")
    head = raw[:idx].strip() if idx != -1 else raw.strip()
    head = re.sub(r"\s+", " ", head)
    if not head:
        return "Recovered Terraform from markdown output (model did not return JSON)."
    return head[:1200] + ("…" if len(head) > 1200 else "")


def _fallback_from_text(raw: str) -> TerraformAIResult | None:
    """When the model ignores JSON instructions and returns prose + ```hcl```."""
    raw = raw.strip()
    if not raw:
        return None
    hcl = _largest_hcl_fence(raw)
    if hcl:
        return TerraformAIResult(hcl_code=hcl, explanation=_explanation_from_preamble(raw))
    start, end = raw.find("{"), raw.rfind("}")
    if start != -1 and end > start:
        try:
            obj = json.loads(raw[start : end + 1])
        except (json.JSONDecodeError, TypeError, ValueError):
            obj = None
        if isinstance(obj, dict) and "hcl_code" in obj:
            return TerraformAIResult(
                hcl_code=str(obj.get("hcl_code", "")),
                explanation=str(obj.get("explanation", "")).strip() or "Generated Terraform.",
            )
    return None


def _resolve_provider() -> str:
    explicit = os.getenv("LLM_PROVIDER", "").strip().lower()
    if explicit in ("gemini", "groq", "ollama"):
        return explicit
    if os.getenv("GROQ_API_KEY"):
        return "groq"
    if os.getenv("USE_OLLAMA", "").strip() in ("1", "true", "yes"):
        return "ollama"
    if os.getenv("GEMINI_API_KEY"):
        return "gemini"
    return "ollama"  # default: no paid key required — run Ollama locally


def _build_chat_model() -> BaseChatModel:
    provider = _resolve_provider()

    if provider == "groq":
        from langchain_groq import ChatGroq

        key = os.getenv("GROQ_API_KEY")
        if not key:
            raise RuntimeError(
                "LLM_PROVIDER=groq (or GROQ_API_KEY set) but GROQ_API_KEY is empty. "
                "Get a free key at https://console.groq.com/"
            )
        model = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant").strip() or "llama-3.1-8b-instant"
        return ChatGroq(model=model, temperature=0.2, groq_api_key=key)

    if provider == "ollama":
        from langchain_ollama import ChatOllama

        base = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").strip() or "http://127.0.0.1:11434"
        model = os.getenv("OLLAMA_MODEL", "llama3.2").strip() or "llama3.2"
        return ChatOllama(model=model, temperature=0.2, base_url=base)

    # gemini
    from langchain_google_genai import ChatGoogleGenerativeAI

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "LLM_PROVIDER=gemini but GEMINI_API_KEY is not set. "
            "For zero-cost local dev set LLM_PROVIDER=ollama and run Ollama, "
            "or set GROQ_API_KEY for free cloud inference."
        )
    model = os.getenv("GEMINI_MODEL", "gemini-2.0-flash").strip() or "gemini-2.0-flash"
    return ChatGoogleGenerativeAI(
        model=model,
        temperature=0.2,
        google_api_key=api_key,
    )


def build_generator():
    llm: BaseChatModel = _build_chat_model()

    parser = PydanticOutputParser(pydantic_object=TerraformAIResult)

    system = (
        "You are a senior cloud infrastructure engineer. "
        "Convert the user's request into Terraform configuration.\n\n"
        "Hard rules:\n"
        "- Output MUST be valid JSON that matches the provided schema.\n"
        "- Reply with that JSON object only — no preamble, no ``` fences around the whole answer.\n"
        "- The field `hcl_code` MUST contain only Terraform HCL, no Markdown fences.\n"
        "- Use Terraform best practices: least privilege, secure defaults, and clear naming.\n"
        "- Prefer widely-used official providers.\n"
        "- If the user omits critical info (region, names), choose safe defaults and mention them in `explanation`.\n"
    )

    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", system),
            ("system", "Return JSON in this exact schema:\n{format_instructions}"),
            ("human", "{user_prompt}"),
        ]
    ).partial(format_instructions=parser.get_format_instructions())

    llm_chain: Any = prompt | llm

    def invoke(user_prompt: str) -> TerraformAIResult:
        msg = llm_chain.invoke({"user_prompt": user_prompt})
        text = _message_text(msg)
        try:
            result = parser.parse(text)
        except Exception as parse_err:
            recovered = _fallback_from_text(text)
            if recovered is None:
                raise RuntimeError(
                    "LLM output was not valid JSON and no Terraform ```hcl``` block could be recovered."
                ) from parse_err
            result = recovered
        result.hcl_code = _strip_code_fences(result.hcl_code)
        return result

    return invoke
