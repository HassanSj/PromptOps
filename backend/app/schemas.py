from typing import Optional

from pydantic import BaseModel, Field


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, description="Natural language infrastructure request")
    enqueue_execution: bool = Field(
        default=False,
        description="If true and REDIS_ENABLED=1, push a Terraform job to Redis for the Go engine",
    )


class TerraformAIResult(BaseModel):
    """LLM output only (used by LangChain parser)."""

    hcl_code: str = Field(description="Terraform HCL code (typically a main.tf)")
    explanation: str = Field(description="Short summary of what will be deployed")


class GenerateResponse(TerraformAIResult):
    job_id: Optional[str] = Field(
        default=None,
        description="Set when enqueue_execution=true and Redis enqueue succeeds",
    )

