#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request


DEFAULT_MODEL_ID = (
    os.environ.get("HIVEMIND_HARRIER_MODEL_ID")
    or os.environ.get("DEEPLAKE_HARRIER_MODEL_ID")
    or "microsoft/harrier-oss-v1-270m"
)
DEFAULT_API_URL = "https://api.deeplake.ai"
DEFAULT_BATCH_SIZE = 8
DEFAULT_SCAN_BATCH_SIZE = 64
DEFAULT_MAX_LENGTH = 32_768
DEFAULT_TIMEOUT_SECONDS = float(
    os.environ.get("HIVEMIND_QUERY_TIMEOUT_MS")
    or os.environ.get("DEEPLAKE_QUERY_TIMEOUT_MS")
    or "10000"
) / 1000.0
MAX_RETRIES = 3
BASE_DELAY_SECONDS = 0.5
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}
TOOL_INPUT_FIELDS = [
    "command",
    "file_path",
    "path",
    "pattern",
    "prompt",
    "subagent_type",
    "query",
    "url",
    "notebook_path",
    "old_string",
    "new_string",
    "content",
    "skill",
    "args",
    "taskId",
    "status",
    "subject",
    "description",
    "to",
    "message",
    "summary",
    "max_results",
]
TOOL_RESPONSE_DROP = {
    "interrupted",
    "isImage",
    "noOutputExpected",
    "type",
    "structuredPatch",
    "userModified",
    "originalFile",
    "replaceAll",
    "totalDurationMs",
    "totalTokens",
    "totalToolUseCount",
    "usage",
    "toolStats",
    "durationMs",
    "durationSeconds",
    "bytes",
    "code",
    "codeText",
    "agentId",
    "agentType",
    "verificationNudgeNeeded",
    "numLines",
    "numFiles",
    "truncated",
    "statusChange",
    "updatedFields",
    "isAgent",
    "success",
}
ARTIFACT_SCHEMA_VERSION = 1


def eprint(message: str) -> None:
    sys.stderr.write(f"{message}\n")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def compact(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def as_str(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return str(value)


def parse_positive_int(value: str | None, fallback: int) -> int:
    if value is None:
        return fallback
    try:
        parsed = int(value)
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp_path.replace(path)


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def sql_ident(name: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise ValueError(f"Invalid SQL identifier: {name!r}")
    return name


def sql_str(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace("'", "''")
        .replace("\x00", "")
        .translate({codepoint: None for codepoint in list(range(1, 9)) + [11, 12] + list(range(14, 32)) + [127]})
    )


def sql_float4_array(values: list[float]) -> str:
    parts: list[str] = []
    for value in values:
        if value != value or value == float("inf") or value == float("-inf"):
            parts.append("0")
            continue
        parts.append(repr(float(value)))
    return f"ARRAY[{', '.join(parts)}]::float4[]"


@dataclass
class Config:
    token: str
    org_id: str
    org_name: str
    user_name: str
    workspace_id: str
    api_url: str
    memory_table: str
    sessions_table: str


def load_config() -> Config:
    creds_path = Path.home() / ".deeplake" / "credentials.json"
    creds: dict[str, Any] = {}
    if creds_path.exists():
        try:
            creds = json.loads(creds_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"Failed to parse {creds_path}: {exc}") from exc

    env = os.environ
    token = env.get("HIVEMIND_TOKEN") or env.get("DEEPLAKE_TOKEN") or creds.get("token")
    org_id = env.get("HIVEMIND_ORG_ID") or env.get("DEEPLAKE_ORG_ID") or creds.get("orgId")
    if not token or not org_id:
        raise SystemExit("Missing Deeplake credentials. Run `deeplake login` or set HIVEMIND_* env vars.")

    return Config(
        token=token,
        org_id=org_id,
        org_name=creds.get("orgName") or org_id,
        user_name=creds.get("userName") or os.environ.get("USER") or "unknown",
        workspace_id=env.get("HIVEMIND_WORKSPACE_ID") or env.get("DEEPLAKE_WORKSPACE_ID") or creds.get("workspaceId") or "default",
        api_url=env.get("HIVEMIND_API_URL") or env.get("DEEPLAKE_API_URL") or creds.get("apiUrl") or DEFAULT_API_URL,
        memory_table=env.get("HIVEMIND_TABLE") or env.get("DEEPLAKE_TABLE") or "memory",
        sessions_table=env.get("HIVEMIND_SESSIONS_TABLE") or env.get("DEEPLAKE_SESSIONS_TABLE") or "sessions",
    )


class DeeplakeQueryError(RuntimeError):
    pass


class DeeplakeApi:
    def __init__(
        self,
        token: str,
        api_url: str,
        org_id: str,
        workspace_id: str,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self.token = token
        self.api_url = api_url.rstrip("/")
        self.org_id = org_id
        self.workspace_id = workspace_id
        self.timeout_seconds = timeout_seconds

    def query(self, sql: str) -> list[dict[str, Any]]:
        body = json.dumps({"query": sql}).encode("utf-8")
        url = f"{self.api_url}/workspaces/{self.workspace_id}/tables/query"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "X-Activeloop-Org-Id": self.org_id,
        }

        last_error: Exception | None = None
        for attempt in range(MAX_RETRIES + 1):
            req = urllib_request.Request(url, data=body, headers=headers, method="POST")
            try:
                with urllib_request.urlopen(req, timeout=self.timeout_seconds) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                columns = payload.get("columns") or []
                rows = payload.get("rows") or []
                return [dict(zip(columns, row, strict=False)) for row in rows]
            except urllib_error.HTTPError as exc:
                response_body = exc.read().decode("utf-8", errors="replace")
                last_error = DeeplakeQueryError(
                    f"Query failed with HTTP {exc.code}: {response_body[:300]}"
                )
                if exc.code in RETRYABLE_STATUS_CODES and attempt < MAX_RETRIES:
                    time.sleep(BASE_DELAY_SECONDS * (2**attempt))
                    continue
                raise last_error from exc
            except urllib_error.URLError as exc:
                last_error = DeeplakeQueryError(f"Query failed: {exc.reason}")
                if attempt < MAX_RETRIES:
                    time.sleep(BASE_DELAY_SECONDS * (2**attempt))
                    continue
                raise last_error from exc
            except TimeoutError as exc:
                last_error = DeeplakeQueryError(
                    f"Query timeout after {self.timeout_seconds:.1f}s"
                )
                raise last_error from exc

        raise DeeplakeQueryError(str(last_error or "Query failed"))


def ensure_sql_columns(api: DeeplakeApi, table_name: str, specs: list[tuple[str, str]]) -> None:
    table = sql_ident(table_name)
    for column_name, ddl in specs:
        column = sql_ident(column_name)
        try:
            api.query(f'ALTER TABLE "{table}" ADD COLUMN IF NOT EXISTS "{column}" {ddl}')
        except DeeplakeQueryError:
            pass


def ensure_embedding_index(api: DeeplakeApi, table_name: str, column_name: str) -> None:
    table = sql_ident(table_name)
    column = sql_ident(column_name)
    index_name = sql_ident(f"idx_{table_name}_{column_name}".replace("-", "_"))
    try:
        api.query(
            f'CREATE INDEX IF NOT EXISTS "{index_name}" ON "{table}" USING deeplake_index ("{column}")'
        )
    except DeeplakeQueryError:
        pass


def join_sections(sections: list[tuple[str, str]]) -> str:
    return "\n".join(
        f"{label}: {value}"
        for label, value in sections
        if value
    )


def truncate_text(text: str, max_chars: int) -> str:
    normalized = text.strip()
    if len(normalized) <= max_chars:
        return normalized
    omitted = len(normalized) - max_chars
    return f"{normalized[:max_chars].rstrip()}\n[truncated {omitted} chars]"


def try_parse_object(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return value if isinstance(value, dict) else None


def maybe_parse_json(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if not stripped or stripped[0] not in "[{":
        return value
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return value


def snake_case(name: str) -> str:
    return re.sub(r"([A-Z])", r"_\1", name).lower()


def camel_case(name: str) -> str:
    return re.sub(r"_([a-z])", lambda match: match.group(1).upper(), name)


def format_tool_input(raw: Any) -> str:
    payload = maybe_parse_json(raw)
    if not isinstance(payload, dict):
        return str(payload or "")
    parts: list[str] = []
    for key in TOOL_INPUT_FIELDS:
        if key not in payload:
            continue
        value = payload[key]
        parts.append(f"{key}: {value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)}")
    for key in ["glob", "output_mode", "limit", "offset"]:
        if key in payload:
            parts.append(f"{key}: {payload[key]}")
    return "\n".join(parts) if parts else json.dumps(payload, ensure_ascii=False)


def format_tool_response(raw: Any, original_input: Any, tool_name: str | None) -> str:
    payload = maybe_parse_json(raw)
    if not isinstance(payload, dict):
        return str(payload or "")

    if tool_name in {"Edit", "Write", "MultiEdit"}:
        file_path = payload.get("filePath")
        return f"[wrote {file_path}]" if file_path else "[ok]"

    stdout = payload.get("stdout")
    if isinstance(stdout, str):
        stderr = payload.get("stderr")
        return stdout + (f"\nstderr: {stderr}" if stderr else "")

    content = payload.get("content")
    if isinstance(content, str):
        return content

    file_payload = payload.get("file")
    if isinstance(file_payload, dict):
        file_content = file_payload.get("content")
        if isinstance(file_content, str):
            return f"[{file_payload.get('filePath', '')}]\n{file_content}"
        base64_value = file_payload.get("base64")
        if isinstance(base64_value, str):
            return f"[binary {file_payload.get('filePath', '')}: {len(base64_value)} base64 chars]"

    for key in ("filenames", "matches", "results"):
        value = payload.get(key)
        if isinstance(value, list):
            if key == "results":
                rendered = [
                    item if isinstance(item, str)
                    else item.get("title") or item.get("url") or json.dumps(item, ensure_ascii=False)
                    for item in value
                ]
            else:
                rendered = [item if isinstance(item, str) else json.dumps(item, ensure_ascii=False) for item in value]
            return "\n".join(rendered)

    input_payload = maybe_parse_json(original_input)
    kept: dict[str, Any] = {}
    for key, value in payload.items():
        if key in TOOL_RESPONSE_DROP:
            continue
        if value in ("", False, None):
            continue
        if isinstance(input_payload, dict):
            if key in input_payload and json.dumps(input_payload[key], sort_keys=True, ensure_ascii=False) == json.dumps(value, sort_keys=True, ensure_ascii=False):
                continue
            snake = snake_case(key)
            if snake in input_payload and json.dumps(input_payload[snake], sort_keys=True, ensure_ascii=False) == json.dumps(value, sort_keys=True, ensure_ascii=False):
                continue
            camel = camel_case(key)
            if camel in input_payload and json.dumps(input_payload[camel], sort_keys=True, ensure_ascii=False) == json.dumps(value, sort_keys=True, ensure_ascii=False):
                continue
        kept[key] = value

    return json.dumps(kept, ensure_ascii=False) if kept else "[ok]"


def format_tool_call(payload: dict[str, Any]) -> str:
    return (
        f"[tool:{payload.get('tool_name', '?')}]\n"
        f"input: {format_tool_input(payload.get('tool_input'))}\n"
        f"response: {format_tool_response(payload.get('tool_response'), payload.get('tool_input'), as_str(payload.get('tool_name')) or None)}"
    )


def normalize_content(path: str, raw: str) -> str:
    if "/sessions/" not in path:
        return raw
    if not raw or raw[0] != "{":
        return raw
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return raw

    if isinstance(obj, dict) and (isinstance(obj.get("turns"), list) or isinstance(obj.get("dialogue"), list)):
        return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"

    def strip_recalled(text: str) -> str:
        start = text.find("<recalled-memories>")
        if start == -1:
            return text
        end = text.rfind("</recalled-memories>")
        if end == -1 or end < start:
            return text
        head = text[:start]
        tail = text[end + len("</recalled-memories>"):]
        return re.sub(r"\n{3,}", "\n\n", (head + tail).lstrip())

    out: str | None = None
    if isinstance(obj, dict) and obj.get("type") == "user_message":
        out = f"[user] {strip_recalled(as_str(obj.get('content')))}"
    elif isinstance(obj, dict) and obj.get("type") == "assistant_message":
        agent_type = as_str(obj.get("agent_type"))
        agent_suffix = f" (agent={agent_type})" if agent_type else ""
        out = f"[assistant{agent_suffix}] {strip_recalled(as_str(obj.get('content')))}"
    elif isinstance(obj, dict) and obj.get("type") == "tool_call":
        out = format_tool_call(obj)

    if out is None:
        return raw
    trimmed = out.strip()
    if (
        not trimmed
        or trimmed in {"[user]", "[assistant]"}
        or re.fullmatch(r"\[tool:[^\]]*\]\s+input:\s+\{\}\s+response:\s+\{\}", trimmed)
    ):
        return raw
    return out


def extract_transcript_text(message: Any) -> str:
    payload = try_parse_object(message)
    if not payload:
        return ""
    turns = payload.get("turns")
    if not isinstance(turns, list):
        turns = payload.get("dialogue")
    if not isinstance(turns, list) or not turns:
        return ""

    intro = join_sections(
        [
            ("Session path", compact(payload.get("source_path"))),
            ("Conversation", compact(payload.get("conversation_id"))),
            (
                "Date",
                compact(payload.get("date_time"))
                or compact(payload.get("date")),
            ),
        ]
    )
    rendered_turns: list[str] = []
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        speaker = (
            compact(turn.get("speaker"))
            or compact(turn.get("role"))
            or compact(turn.get("author"))
            or "speaker"
        )
        text = (
            compact(turn.get("text"))
            or compact(turn.get("content"))
            or compact(turn.get("utterance"))
        )
        if text:
            rendered_turns.append(f"[{speaker}] {text}")
    transcript = "\n".join(rendered_turns)
    return "\n".join(part for part in [intro, transcript] if part)


def fallback_session_text(path: str, message: Any) -> str:
    transcript_text = extract_transcript_text(message)
    if transcript_text:
        return transcript_text

    if isinstance(message, str):
        return normalize_content(path or "/sessions/unknown.jsonl", message)
    if isinstance(message, dict):
        return normalize_content(path or "/sessions/unknown.jsonl", json.dumps(message, ensure_ascii=False))
    return ""


def build_memory_embedding_text(row: dict[str, Any], max_chars: int) -> str:
    return truncate_text(
        join_sections(
            [
                ("Path", compact(row.get("path"))),
                ("Filename", compact(row.get("filename"))),
                ("Project", compact(row.get("project"))),
                ("Description", compact(row.get("description"))),
                ("Summary", compact(row.get("summary"))),
            ]
        ),
        max_chars,
    )


def build_session_embedding_text(row: dict[str, Any], max_chars: int) -> str:
    text = compact(row.get("text"))
    turn_summary = compact(row.get("turn_summary"))
    fallback = ""
    if not text and not turn_summary:
        fallback = compact(fallback_session_text(as_str(row.get("path")), row.get("message")))
    turn_index_value = row.get("turn_index")
    turn_index = ""
    if isinstance(turn_index_value, (int, float)) and int(turn_index_value) == turn_index_value:
        turn_index = str(int(turn_index_value))
    return truncate_text(
        join_sections(
            [
                ("Path", compact(row.get("path"))),
                ("Event", compact(row.get("event_type"))),
                ("Speaker", compact(row.get("speaker"))),
                ("Source time", compact(row.get("source_date_time"))),
                ("Turn index", turn_index),
                ("Text", text),
                ("Turn summary", turn_summary),
                ("Content", fallback),
            ]
        ),
        max_chars,
    )


def stable_embedding_source_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def import_numpy():
    try:
        import numpy as np
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency `numpy`. Install `scripts/requirements-harrier-embeddings.txt` first."
        ) from exc
    return np


def import_torch_and_transformers():
    try:
        import torch
        import torch.nn.functional as torch_f
        from transformers import AutoModel, AutoTokenizer
    except ImportError as exc:
        raise SystemExit(
            "Missing Python ML dependencies. Install `scripts/requirements-harrier-embeddings.txt` first."
        ) from exc
    return torch, torch_f, AutoModel, AutoTokenizer


def resolve_device(torch_module: Any, requested: str) -> str:
    if requested != "auto":
        return requested
    if getattr(torch_module.backends, "mps", None) and torch_module.backends.mps.is_available():
        return "mps"
    if torch_module.cuda.is_available():
        return "cuda"
    return "cpu"


def resolve_torch_dtype(torch_module: Any, requested: str, device: str) -> Any:
    normalized = requested.lower()
    if normalized == "auto":
        if device == "mps":
            return torch_module.float32
        return "auto"
    aliases = {
        "fp16": torch_module.float16,
        "float16": torch_module.float16,
        "half": torch_module.float16,
        "fp32": torch_module.float32,
        "float32": torch_module.float32,
        "float": torch_module.float32,
        "bf16": torch_module.bfloat16,
        "bfloat16": torch_module.bfloat16,
    }
    if normalized not in aliases:
        raise SystemExit(f"Unsupported --dtype value: {requested}")
    return aliases[normalized]


class HarrierEmbedder:
    def __init__(
        self,
        model_id: str,
        device: str,
        dtype: str,
        max_length: int,
        local_files_only: bool,
        cache_dir: str | None,
    ) -> None:
        self.model_id = model_id
        self.requested_device = device
        self.requested_dtype = dtype
        self.max_length = max_length
        self.local_files_only = local_files_only
        self.cache_dir = cache_dir
        self._np = None
        self._torch = None
        self._torch_f = None
        self._tokenizer = None
        self._model = None
        self.device = "cpu"
        self.vector_dim = 0
        self.dtype_name = "auto"

    def load(self) -> None:
        if self._model is not None and self._tokenizer is not None:
            return

        if self.cache_dir:
            os.environ.setdefault("HF_HOME", self.cache_dir)
            os.environ.setdefault("TRANSFORMERS_CACHE", self.cache_dir)

        np = import_numpy()
        torch, torch_f, AutoModel, AutoTokenizer = import_torch_and_transformers()

        device = resolve_device(torch, self.requested_device)
        torch_dtype = resolve_torch_dtype(torch, self.requested_dtype, device)
        tokenizer = AutoTokenizer.from_pretrained(
            self.model_id,
            local_files_only=self.local_files_only,
        )
        model_kwargs: dict[str, Any] = {
            "local_files_only": self.local_files_only,
        }
        if torch_dtype == "auto":
            model_kwargs["torch_dtype"] = "auto"
            self.dtype_name = "auto"
        else:
            model_kwargs["torch_dtype"] = torch_dtype
            self.dtype_name = str(torch_dtype).split(".")[-1]
        model = AutoModel.from_pretrained(self.model_id, **model_kwargs)
        model.eval()
        model.to(device)

        self._np = np
        self._torch = torch
        self._torch_f = torch_f
        self._tokenizer = tokenizer
        self._model = model
        self.device = device
        self.vector_dim = int(getattr(model.config, "hidden_size"))
        eprint(
            f"[harrier] loaded {self.model_id} on {self.device} "
            f"(dtype={self.dtype_name}, dim={self.vector_dim})"
        )

    def _last_token_pool(self, last_hidden_states: Any, attention_mask: Any) -> Any:
        torch = self._torch
        assert torch is not None
        left_padding = bool((attention_mask[:, -1].sum() == attention_mask.shape[0]).item())
        if left_padding:
            return last_hidden_states[:, -1]
        sequence_lengths = attention_mask.sum(dim=1) - 1
        batch_size = last_hidden_states.shape[0]
        indices = torch.arange(batch_size, device=last_hidden_states.device)
        return last_hidden_states[indices, sequence_lengths]

    def embed_documents(self, texts: list[str]) -> Any:
        if not texts:
            np = import_numpy()
            return np.zeros((0, self.vector_dim or 0), dtype=np.float32)
        self.load()
        assert self._tokenizer is not None
        assert self._model is not None
        assert self._torch is not None
        assert self._torch_f is not None
        assert self._np is not None

        batch = self._tokenizer(
            texts,
            max_length=self.max_length,
            padding=True,
            truncation=True,
            return_tensors="pt",
        )
        batch = {key: value.to(self.device) for key, value in batch.items()}
        with self._torch.no_grad():
            outputs = self._model(**batch)
            embeddings = self._last_token_pool(outputs.last_hidden_state, batch["attention_mask"])
            embeddings = self._torch_f.normalize(embeddings, p=2, dim=1)
        output = embeddings.detach().to("cpu", dtype=self._torch.float32).numpy()
        if not self._np.isfinite(output).all():
            raise RuntimeError(
                f"Non-finite embeddings generated by {self.model_id} on "
                f"device={self.device} dtype={self.dtype_name}. "
                "Retry with --dtype fp32 or --device cpu."
            )
        return output


def slugify(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text.strip("/")) or "artifact"


def default_artifact_root(table: str, model_id: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return Path("tmp") / "harrier-backfill" / f"{table}-{slugify(model_id)}-{stamp}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Two-phase Harrier embedding backfill: generate local vectors.npy first, then upload to Deeplake."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_table_options(cmd: argparse.ArgumentParser) -> None:
        cmd.add_argument("--table", choices=["memory", "sessions", "all"], default="all")
        cmd.add_argument("--memory-table", default=None)
        cmd.add_argument("--sessions-table", default=None)
        cmd.add_argument("--artifact-dir", default=None)
        cmd.add_argument("--embedding-column", default="embedding")
        cmd.add_argument("--embedding-model-column", default="embedding_model")
        cmd.add_argument("--embedding-source-hash-column", default="embedding_source_hash")
        cmd.add_argument("--embedding-updated-at-column", default="embedding_updated_at")

    def add_embed_options(cmd: argparse.ArgumentParser) -> None:
        add_table_options(cmd)
        cmd.add_argument("--model-id", default=DEFAULT_MODEL_ID)
        cmd.add_argument("--start-offset", type=int, default=0)
        cmd.add_argument("--max-rows", type=int, default=None)
        cmd.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
        cmd.add_argument("--scan-batch-size", type=int, default=DEFAULT_SCAN_BATCH_SIZE)
        cmd.add_argument("--memory-max-chars", type=int, default=8000)
        cmd.add_argument("--sessions-max-chars", type=int, default=8000)
        cmd.add_argument("--max-length", type=int, default=DEFAULT_MAX_LENGTH)
        cmd.add_argument("--device", default="auto")
        cmd.add_argument("--dtype", default="auto")
        cmd.add_argument("--force", action="store_true")
        cmd.add_argument("--local-files-only", action="store_true")
        cmd.add_argument("--cache-dir", default=None)
        cmd.add_argument("--resume", action="store_true")
        cmd.add_argument("--rebuild-plan", action="store_true")

    def add_upload_options(cmd: argparse.ArgumentParser) -> None:
        add_table_options(cmd)
        cmd.add_argument("--upload-batch-size", type=int, default=32)
        cmd.add_argument("--resume", action="store_true")

    embed_cmd = subparsers.add_parser("embed", help="Plan remaining rows and generate vectors.npy locally.")
    add_embed_options(embed_cmd)

    upload_cmd = subparsers.add_parser("upload", help="Upload vectors from a completed artifact into Deeplake.")
    add_upload_options(upload_cmd)

    run_cmd = subparsers.add_parser("run", help="Run embed, then upload after vectors.npy is complete.")
    add_embed_options(run_cmd)
    run_cmd.add_argument("--upload-batch-size", type=int, default=32)

    return parser.parse_args()


def table_name_for_kind(config: Config, args: argparse.Namespace, table_kind: str) -> str:
    if table_kind == "memory":
        return args.memory_table or config.memory_table
    if table_kind == "sessions":
        return args.sessions_table or config.sessions_table
    raise ValueError(f"Unsupported table kind: {table_kind}")


def artifact_dir_for_table(args: argparse.Namespace, table_kind: str) -> Path:
    if args.artifact_dir:
        root = Path(args.artifact_dir)
    else:
        root = default_artifact_root(args.table, getattr(args, "model_id", DEFAULT_MODEL_ID))
    if args.table == "all":
        return root / table_kind
    return root


def manifest_paths(artifact_dir: Path) -> tuple[Path, Path, Path]:
    return (
        artifact_dir / "manifest.json",
        artifact_dir / "rows.jsonl",
        artifact_dir / "vectors.npy",
    )


def remaining_scan_limit(args: argparse.Namespace, offset: int) -> int:
    if args.max_rows is None:
        return args.scan_batch_size
    remaining = max(0, (args.start_offset + args.max_rows) - offset)
    return min(args.scan_batch_size, remaining)


def fetch_memory_rows(api: DeeplakeApi, args: argparse.Namespace, table_name: str, offset: int) -> list[dict[str, Any]]:
    limit = remaining_scan_limit(args, offset)
    if limit <= 0:
        return []
    table = sql_ident(table_name)
    return api.query(
        "SELECT id, path, filename, summary, description, project, "
        f'"{sql_ident(args.embedding_source_hash_column)}" AS embedding_source_hash, '
        f'"{sql_ident(args.embedding_model_column)}" AS embedding_model '
        f'FROM "{table}" ORDER BY path ASC LIMIT {limit} OFFSET {offset}'
    )


def fetch_session_rows(
    api: DeeplakeApi,
    args: argparse.Namespace,
    table_name: str,
    offset: int,
    include_metadata: bool,
) -> list[dict[str, Any]]:
    limit = remaining_scan_limit(args, offset)
    if limit <= 0:
        return []
    table = sql_ident(table_name)
    select_columns = [
        "id",
        "path",
        "event_type",
        "speaker",
        "text",
        "turn_summary",
        "source_date_time",
        "turn_index",
        "message",
    ]
    if include_metadata:
        select_columns.extend(
            [
                f'"{sql_ident(args.embedding_source_hash_column)}" AS embedding_source_hash',
                f'"{sql_ident(args.embedding_model_column)}" AS embedding_model',
            ]
        )
    return api.query(
        f'SELECT {", ".join(select_columns)} '
        f'FROM "{table}" '
        f"ORDER BY path ASC, turn_index ASC, creation_date ASC LIMIT {limit} OFFSET {offset}"
    )


def plan_artifact(
    api: DeeplakeApi,
    config: Config,
    args: argparse.Namespace,
    table_kind: str,
    artifact_dir: Path,
) -> dict[str, Any]:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    manifest_path, rows_path, vectors_path = manifest_paths(artifact_dir)
    table_name = table_name_for_kind(config, args, table_kind)
    planned_rows: list[dict[str, Any]] = []
    scanned_rows = 0
    skipped_empty = 0
    skipped_existing = 0
    metadata_supported = True
    used_metadata = table_kind == "memory"

    offset = max(0, args.start_offset)
    while True:
        if table_kind == "memory":
            rows = fetch_memory_rows(api, args, table_name, offset)
        else:
            try:
                rows = fetch_session_rows(api, args, table_name, offset, include_metadata=metadata_supported)
                used_metadata = metadata_supported
            except DeeplakeQueryError:
                if metadata_supported:
                    metadata_supported = False
                    eprint("[sessions] metadata scan failed; falling back to scans without existing-hash checks")
                    rows = fetch_session_rows(api, args, table_name, offset, include_metadata=False)
                    used_metadata = False
                else:
                    raise

        if not rows:
            break

        scanned_rows += len(rows)
        for row in rows:
            text = (
                build_memory_embedding_text(row, args.memory_max_chars)
                if table_kind == "memory"
                else build_session_embedding_text(row, args.sessions_max_chars)
            )
            if not text:
                skipped_empty += 1
                continue
            source_hash = stable_embedding_source_hash(text)
            existing_hash = compact(row.get("embedding_source_hash"))
            existing_model = compact(row.get("embedding_model"))
            if not args.force and used_metadata and existing_hash == source_hash and existing_model == args.model_id:
                skipped_existing += 1
                continue
            planned_rows.append(
                {
                    "id": as_str(row.get("id")),
                    "path": as_str(row.get("path")),
                    "source_hash": source_hash,
                    "text": text,
                }
            )
        eprint(
            f"[{table_kind}] planned {len(planned_rows)} rows after scanning {scanned_rows} rows "
            f"(skipped_empty={skipped_empty}, skipped_existing={skipped_existing})"
        )
        offset += args.scan_batch_size

    manifest = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "table_kind": table_kind,
        "table_name": table_name,
        "model_id": args.model_id,
        "artifact_created_at": now_iso(),
        "artifact_updated_at": now_iso(),
        "rows_file": rows_path.name,
        "vectors_file": vectors_path.name,
        "embedding_column": args.embedding_column,
        "embedding_model_column": args.embedding_model_column,
        "embedding_source_hash_column": args.embedding_source_hash_column,
        "embedding_updated_at_column": args.embedding_updated_at_column,
        "start_offset": args.start_offset,
        "max_rows": args.max_rows,
        "planned_rows": len(planned_rows),
        "scanned_rows": scanned_rows,
        "skipped_empty": skipped_empty,
        "skipped_existing": skipped_existing,
        "skip_existing_supported": bool(used_metadata),
        "completed_vectors": 0,
        "completed_uploads": 0,
        "vector_dim": None,
        "status": "planned",
        "upload_complete": False,
    }
    write_jsonl(rows_path, planned_rows)
    write_json_atomic(manifest_path, manifest)
    return manifest


def load_or_plan_artifact(
    api: DeeplakeApi,
    config: Config,
    args: argparse.Namespace,
    table_kind: str,
    artifact_dir: Path,
) -> tuple[dict[str, Any], Path, Path, Path]:
    manifest_path, rows_path, vectors_path = manifest_paths(artifact_dir)
    if manifest_path.exists() and rows_path.exists() and not args.rebuild_plan:
        manifest = load_json(manifest_path)
        if manifest.get("table_kind") != table_kind:
            raise SystemExit(f"Artifact at {artifact_dir} is for {manifest.get('table_kind')}, not {table_kind}")
        if not args.resume and manifest.get("status") in {"embedding", "complete"}:
            raise SystemExit(
                f"Artifact already exists at {artifact_dir}. Use --resume or --rebuild-plan."
            )
        return manifest, manifest_path, rows_path, vectors_path

    manifest = plan_artifact(api, config, args, table_kind, artifact_dir)
    return manifest, manifest_path, rows_path, vectors_path


def embed_artifact(args: argparse.Namespace, manifest: dict[str, Any], manifest_path: Path, rows_path: Path, vectors_path: Path) -> dict[str, Any]:
    np = import_numpy()
    records = read_jsonl(rows_path)
    total_rows = len(records)
    completed_vectors = int(manifest.get("completed_vectors") or 0)
    if completed_vectors > total_rows:
        raise SystemExit("Manifest completed_vectors exceeds rows.jsonl length")

    if total_rows == 0:
        if not vectors_path.exists():
            np.save(vectors_path, np.zeros((0, 0), dtype=np.float32))
        manifest["status"] = "complete"
        manifest["vector_dim"] = 0
        manifest["completed_vectors"] = 0
        manifest["artifact_updated_at"] = now_iso()
        write_json_atomic(manifest_path, manifest)
        eprint(f"[{manifest['table_kind']}] nothing to embed")
        return manifest

    embedder = HarrierEmbedder(
        model_id=manifest["model_id"],
        device=args.device,
        dtype=args.dtype,
        max_length=args.max_length,
        local_files_only=args.local_files_only,
        cache_dir=args.cache_dir,
    )
    embedder.load()
    vector_dim = embedder.vector_dim

    if vectors_path.exists():
        vectors = np.load(vectors_path, mmap_mode="r+")
        if tuple(vectors.shape) != (total_rows, vector_dim):
            raise SystemExit(
                f"Existing vectors.npy shape {tuple(vectors.shape)} does not match planned shape {(total_rows, vector_dim)}"
            )
    else:
        vectors = np.lib.format.open_memmap(
            vectors_path,
            mode="w+",
            dtype=np.float32,
            shape=(total_rows, vector_dim),
        )

    if completed_vectors == 0:
        manifest["status"] = "embedding"
        manifest["vector_dim"] = vector_dim
        manifest["artifact_updated_at"] = now_iso()
        write_json_atomic(manifest_path, manifest)

    for start in range(completed_vectors, total_rows, args.batch_size):
        end = min(total_rows, start + args.batch_size)
        batch_records = records[start:end]
        batch_vectors = embedder.embed_documents([record["text"] for record in batch_records])
        vectors[start:end] = batch_vectors
        if hasattr(vectors, "flush"):
            vectors.flush()
        manifest["completed_vectors"] = end
        manifest["vector_dim"] = vector_dim
        manifest["status"] = "embedding" if end < total_rows else "complete"
        manifest["artifact_updated_at"] = now_iso()
        write_json_atomic(manifest_path, manifest)
        eprint(f"[{manifest['table_kind']}] embedded {end}/{total_rows}")

    manifest["status"] = "complete"
    manifest["artifact_updated_at"] = now_iso()
    write_json_atomic(manifest_path, manifest)
    return manifest


def update_embedding_row(
    api: DeeplakeApi,
    manifest: dict[str, Any],
    row_id: str,
    vector: list[float],
    source_hash: str,
) -> None:
    table = sql_ident(manifest["table_name"])
    updated_at = now_iso()
    api.query(
        f'UPDATE "{table}" SET '
        f'"{sql_ident(manifest["embedding_column"])}" = {sql_float4_array(vector)}, '
        f'"{sql_ident(manifest["embedding_model_column"])}" = \'{sql_str(manifest["model_id"])}\', '
        f'"{sql_ident(manifest["embedding_source_hash_column"])}" = \'{sql_str(source_hash)}\', '
        f'"{sql_ident(manifest["embedding_updated_at_column"])}" = \'{sql_str(updated_at)}\' '
        f"WHERE id = '{sql_str(row_id)}'"
    )


def update_embedding_rows_batch(
    api: DeeplakeApi,
    manifest: dict[str, Any],
    rows: list[tuple[str, list[float], str]],
) -> None:
    if not rows:
        return
    table = sql_ident(manifest["table_name"])
    updated_at = now_iso()
    values_sql = ", ".join(
        (
            f"('{sql_str(row_id)}', {sql_float4_array(vector)}, '{sql_str(source_hash)}')"
        )
        for row_id, vector, source_hash in rows
    )
    api.query(
        f'UPDATE "{table}" AS target SET '
        f'"{sql_ident(manifest["embedding_column"])}" = source.embedding, '
        f'"{sql_ident(manifest["embedding_model_column"])}" = \'{sql_str(manifest["model_id"])}\', '
        f'"{sql_ident(manifest["embedding_source_hash_column"])}" = source.source_hash, '
        f'"{sql_ident(manifest["embedding_updated_at_column"])}" = \'{sql_str(updated_at)}\' '
        f"FROM (VALUES {values_sql}) AS source(id, embedding, source_hash) "
        f"WHERE target.id = source.id"
    )


def upload_artifact(
    api: DeeplakeApi,
    args: argparse.Namespace,
    manifest: dict[str, Any],
    manifest_path: Path,
    rows_path: Path,
    vectors_path: Path,
) -> dict[str, Any]:
    np = import_numpy()
    records = read_jsonl(rows_path)
    total_rows = len(records)
    if int(manifest.get("completed_vectors") or 0) < total_rows:
        raise SystemExit(
            f"Artifact {manifest_path.parent} is incomplete: embedded "
            f"{manifest.get('completed_vectors', 0)}/{total_rows} rows."
        )

    ensure_sql_columns(
        api,
        manifest["table_name"],
        [
            (manifest["embedding_column"], "float4[]"),
            (manifest["embedding_model_column"], "TEXT NOT NULL DEFAULT ''"),
            (manifest["embedding_source_hash_column"], "TEXT NOT NULL DEFAULT ''"),
            (manifest["embedding_updated_at_column"], "TEXT NOT NULL DEFAULT ''"),
        ],
    )

    vectors = np.load(vectors_path, mmap_mode="r")
    if len(vectors) != total_rows:
        raise SystemExit(
            f"vectors.npy row count {len(vectors)} does not match rows.jsonl count {total_rows}"
        )

    completed_uploads = int(manifest.get("completed_uploads") or 0)
    if completed_uploads > total_rows:
        raise SystemExit("Manifest completed_uploads exceeds rows.jsonl length")
    if completed_uploads and not args.resume:
        raise SystemExit(
            f"Upload already started for {manifest_path.parent}. Use --resume to continue."
        )

    for start in range(completed_uploads, total_rows, args.upload_batch_size):
        end = min(total_rows, start + args.upload_batch_size)
        batch_rows: list[tuple[str, list[float], str]] = []
        for index in range(start, end):
            record = records[index]
            vector = vectors[index].astype("float32")
            if not np.isfinite(vector).all():
                raise SystemExit(
                    f"Artifact contains non-finite values at row {index} "
                    f"(id={record['id']}). Regenerate vectors before uploading."
                )
            batch_rows.append(
                (
                    record["id"],
                    vector.tolist(),
                    record["source_hash"],
                )
            )
        update_embedding_rows_batch(api, manifest, batch_rows)
        manifest["completed_uploads"] = end
        manifest["upload_complete"] = end >= total_rows
        manifest["artifact_updated_at"] = now_iso()
        write_json_atomic(manifest_path, manifest)
        eprint(f"[{manifest['table_kind']}] uploaded {end}/{total_rows}")

    ensure_embedding_index(api, manifest["table_name"], manifest["embedding_column"])
    manifest["upload_complete"] = True
    manifest["artifact_updated_at"] = now_iso()
    write_json_atomic(manifest_path, manifest)
    return manifest


def table_kinds(args: argparse.Namespace) -> list[str]:
    if args.table == "all":
        return ["memory", "sessions"]
    return [args.table]


def run_embed_command(api: DeeplakeApi, config: Config, args: argparse.Namespace) -> list[Path]:
    artifact_dirs: list[Path] = []
    for table_kind in table_kinds(args):
        artifact_dir = artifact_dir_for_table(args, table_kind)
        manifest, manifest_path, rows_path, vectors_path = load_or_plan_artifact(
            api,
            config,
            args,
            table_kind,
            artifact_dir,
        )
        embed_artifact(args, manifest, manifest_path, rows_path, vectors_path)
        artifact_dirs.append(artifact_dir)
        eprint(f"[{table_kind}] artifact ready at {artifact_dir}")
    return artifact_dirs


def run_upload_command(api: DeeplakeApi, args: argparse.Namespace) -> None:
    if not args.artifact_dir:
        raise SystemExit("--artifact-dir is required for upload")
    for table_kind in table_kinds(args):
        artifact_dir = artifact_dir_for_table(args, table_kind)
        manifest_path, rows_path, vectors_path = manifest_paths(artifact_dir)
        if not manifest_path.exists() or not rows_path.exists() or not vectors_path.exists():
            raise SystemExit(f"Incomplete artifact directory: {artifact_dir}")
        manifest = load_json(manifest_path)
        upload_artifact(api, args, manifest, manifest_path, rows_path, vectors_path)
        eprint(f"[{table_kind}] upload complete from {artifact_dir}")


def main() -> int:
    args = parse_args()
    config = load_config()
    api = DeeplakeApi(
        token=config.token,
        api_url=config.api_url,
        org_id=config.org_id,
        workspace_id=config.workspace_id,
    )

    if args.command == "embed":
        run_embed_command(api, config, args)
        return 0
    if args.command == "upload":
        run_upload_command(api, args)
        return 0
    if args.command == "run":
        run_embed_command(api, config, args)
        upload_args = argparse.Namespace(**vars(args))
        upload_args.resume = True
        run_upload_command(api, upload_args)
        return 0
    raise SystemExit(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
