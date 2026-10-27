"""Meta Model API access (OpenAI-compatible Responses API at api.meta.ai)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
from openai import AsyncOpenAI

SPARK_MODEL = "muse-spark-1.3"  # standard tier: inputs are not used for training
SAM_MODEL = "sam-3.1"
DEFAULT_BASE_URL = "https://api.meta.ai/v1"
REQUEST_TIMEOUT_S = 120.0

_REPO_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class MetaSettings:
    api_key: str
    base_url: str

    def __repr__(self) -> str:  # never leak the key into logs
        return f"MetaSettings(base_url={self.base_url!r}, api_key=***)"


def load_settings(env_file: Path | None = None) -> MetaSettings:
    """Read META_API_KEY / META_API_BASE from the environment or the repo's .env file."""
    load_dotenv(env_file or _REPO_ROOT / ".env", override=False)
    api_key = os.environ.get("META_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("META_API_KEY is not set. Put it in .env at the repo root (see .env.example).")
    return MetaSettings(api_key=api_key, base_url=os.environ.get("META_API_BASE", DEFAULT_BASE_URL).rstrip("/"))


def async_client(settings: MetaSettings) -> AsyncOpenAI:
    return AsyncOpenAI(base_url=settings.base_url, api_key=settings.api_key, timeout=REQUEST_TIMEOUT_S)
