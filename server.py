"""HTTP routes for ShowMe graph-aware teaching assistance."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import shlex
import shutil
import subprocess
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest

try:
    import aiohttp
    from aiohttp import web
    from server import PromptServer
except ImportError:  # pragma: no cover - ComfyUI provides these at runtime.
    aiohttp = None
    web = None
    PromptServer = None


MAX_QUESTION_CHARS = 1000
MAX_NODES = 350
MAX_SLOTS = 64
MAX_WIDGETS = 80
MAX_OLLAMA_MODELS = 80
MAX_LINKS = MAX_NODES * MAX_SLOTS
MAX_ANNOTATIONS = MAX_NODES * 3
MAX_PLAN_ITEMS = 40
MAX_DRAW_CONNECTIONS = 80
MAX_CONTEXT_NODES = 32
MAX_CONTEXT_CONNECTIONS = 80
MAX_CONNECTION_SUGGESTION_NODES = 96
MAX_LOOKUP_CONNECTIONS = 48
MAX_LOOKUP_WIDGETS = 24
MAX_LOOKUP_SLOTS = 24
MAX_UI_ALERTS = 20
EVERY_NODE_BATCH_SIZE = 16
MAX_EVERY_NODE_BATCH_CONNECTIONS = 96
MAX_EVERY_NODE_BOUNDARY_NODES = 48
MAX_EVERY_NODE_WIDGETS = 24
MAX_PROVIDER_ERROR_CHARS = 2000
DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_TIMEOUT_SECONDS = 180.0
DEFAULT_OLLAMA_KEEP_ALIVE: str | int = 0
NETWORK_OVERHEAD_MS = 30_000
DEFAULT_BUILTIN_CLI_TIMEOUT_SECONDS = 90.0
DEFAULT_DEEP_CLI_TIMEOUT_SECONDS = 180.0
DEFAULT_CUSTOM_CLI_TIMEOUT_SECONDS = 45.0
INTENT_ANSWER_ONLY = "answer_only"
INTENT_OVERVIEW = "overview"
INTENT_DRAW_STEPS = "draw_steps"
INTENT_DRAW_ALL_NODES = "draw_all_nodes"
INTENT_DRAW_CONNECTIONS = "draw_connections"
INTENT_DIAGNOSTICS = "diagnostics"
INTENT_LOOKUP_FOCUS = "lookup_focus"
DRAW_INTENTS = {
    INTENT_DRAW_STEPS,
    INTENT_DRAW_ALL_NODES,
    INTENT_DRAW_CONNECTIONS,
    INTENT_DIAGNOSTICS,
    INTENT_LOOKUP_FOCUS,
}
VALID_MODES = {
    "freeform",
    "tutorial_flow",
    "connections",
    "deep_explain",
    INTENT_ANSWER_ONLY,
    INTENT_OVERVIEW,
    INTENT_DRAW_STEPS,
    INTENT_DRAW_ALL_NODES,
    INTENT_DRAW_CONNECTIONS,
    INTENT_DIAGNOSTICS,
    INTENT_LOOKUP_FOCUS,
}
DEFAULT_CLAUDE_MODEL = "haiku"
DEFAULT_CODEX_MODEL = "gpt-5.4-mini"
LOGGER = logging.getLogger("ShowMe")
DIAGNOSTIC_INVALID_NUMERIC_WIDGET_VALUES = {
    "nan": "not a valid number",
    "inf": "infinite",
    "+inf": "infinite",
    "-inf": "infinite",
    "infinity": "infinite",
    "+infinity": "infinite",
    "-infinity": "infinite",
}
DIAGNOSTIC_MISSING_WIDGET_VALUE_PATTERNS = (
    r"\bno (?:(?:visible|exposed) )?value\b",
    r"\bmissing (?:(?:visible|exposed) )?value\b",
    r"\bempty (?:(?:visible|exposed) )?value\b",
    r"\bvalue (?:is )?(?:missing|empty|not set|unset)\b",
    r"\b(?:has|with) no (?:(?:visible|exposed) )?value\b",
    r"\bno (?:(?:visible|exposed) )?value set\b",
)
DIAGNOSTIC_WIDGET_VALUE_CONTRADICTION_PATTERNS = (
    *DIAGNOSTIC_MISSING_WIDGET_VALUE_PATTERNS,
    r"\bno .{0,40}value (?:is )?exposed\b",
    r"\bvalue (?:is )?not exposed\b",
    r"\b(?:input|widget|parameter|choice|setting) (?:is )?(?:unlinked|not linked|not connected|disconnected)\b",
    r"\b(?:unlinked|not linked|not connected|disconnected).{0,60}\b(?:input|widget|parameter|choice|setting)\b",
)
DIAGNOSTIC_MESSAGE_PREFIX_PATTERNS = (
    r"^\s*(?:current\s+)?(?:comfyui\s+)?ui\s+alerts?\s+(?:says?|reports?)\s*[:;,\-.]?\s*",
    r"^\s*comfyui\s+(?:says?|reports?)\s*[:;,\-.]?\s*",
    r"^\s*the\s+interface\s+reports?\s*[:;,\-.]?\s*",
    r"^\s*interface\s+reports?\s*[:;,\-.]?\s*",
)
DIAGNOSTIC_GENERIC_MESSAGE_PATTERNS = (
    r"\b(?:ui alert|ui alerts|comfyui reports|interface reports)\b",
    r"\brequired models? (?:is|are)? missing\b",
    r"\brequired models? appears? to\b",
    r"\brequired .{0,30}appears? to be missing\b",
    r"\bappears? to be missing\b",
    r"\bmissing models?\b",
)
DIAGNOSTIC_OPTIONAL_INPUT_NAMES = {
    "",
    "optional",
    "mask",
    "noise_mask",
    "control",
    "control_net",
    "controlnet",
    "gligen",
    "style_model",
    "clip_vision",
}
DIAGNOSTIC_REQUIRED_INPUT_NAMES = {
    "model",
    "clip",
    "vae",
    "samples",
    "latent",
    "latent_image",
    "positive",
    "negative",
    "conditioning",
    "image",
    "images",
}
DIAGNOSTIC_REQUIRED_INPUT_TYPES = {
    "model",
    "clip",
    "vae",
    "latent",
    "conditioning",
    "image",
}
BUILTIN_CLI_PROVIDERS = {
    "claude": {
        "label": "Claude",
        "programs": ("claude.cmd", "claude"),
        "args": ("-p", "--output-format", "text"),
        "modelArg": "--model",
        "defaultModel": DEFAULT_CLAUDE_MODEL,
        "models": (
            {"id": DEFAULT_CLAUDE_MODEL, "label": "Haiku"},
            {"id": "sonnet", "label": "Sonnet"},
            {"id": "opus", "label": "Opus"},
        ),
    },
    "codex": {
        "label": "Codex",
        "programs": ("codex.cmd", "codex"),
        "args": (
            "exec",
            "-c",
            'model_reasoning_effort="low"',
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--color",
            "never",
        ),
        "promptArg": "-",
        "modelArg": "-m",
        "defaultModel": DEFAULT_CODEX_MODEL,
        "models": (
            {"id": DEFAULT_CODEX_MODEL, "label": "GPT-5.4 Mini"},
            {"id": "gpt-5.3-codex-spark", "label": "GPT-5.3 Codex Spark"},
            {"id": "gpt-5.4", "label": "GPT-5.4"},
            {"id": "gpt-5.5", "label": "GPT-5.5"},
        ),
    },
}


def _text(value: Any, limit: int = 160) -> str:
    if value is None:
        return ""
    return str(value).strip()[:limit]


def _norm(value: Any) -> str:
    return _text(value, 240).lower()


def _search_text(value: Any) -> str:
    return _norm(value)


def _terms(value: Any) -> set[str]:
    return {term for term in re.split(r"\W+", _search_text(value)) if term}


def _matches_any(value: str, patterns: tuple[str, ...]) -> bool:
    return any(re.search(pattern, value) for pattern in patterns)


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _debug_enabled() -> bool:
    return os.environ.get("SHOWME_DEBUG", "").strip().lower() in {"1", "true", "yes", "on"}


def _debug_log(message: str, **data: Any) -> None:
    if not _debug_enabled():
        return
    try:
        payload = json.dumps(data, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        payload = repr(data)
    LOGGER.info("[ShowMe] %s %s", message, payload)


def _mode(value: Any) -> str:
    mode = _text(value, 40)
    return mode if mode in VALID_MODES else "freeform"


def _ollama_base_url() -> str:
    configured = os.environ.get("SHOWME_OLLAMA_URL", "").strip()
    return (configured or DEFAULT_OLLAMA_URL).rstrip("/")


def _ollama_timeout_seconds() -> float:
    raw = os.environ.get("SHOWME_OLLAMA_TIMEOUT", "").strip()
    try:
        return float(raw) if raw else DEFAULT_OLLAMA_TIMEOUT_SECONDS
    except ValueError:
        return DEFAULT_OLLAMA_TIMEOUT_SECONDS


def _default_cli_timeout_seconds(provider: str, graph: dict[str, Any] | None = None) -> float:
    if provider in BUILTIN_CLI_PROVIDERS:
        if graph and graph.get("mode") == "deep_explain":
            return DEFAULT_DEEP_CLI_TIMEOUT_SECONDS
        return DEFAULT_BUILTIN_CLI_TIMEOUT_SECONDS
    return DEFAULT_CUSTOM_CLI_TIMEOUT_SECONDS


def _cli_timeout_seconds(provider: str, graph: dict[str, Any] | None = None) -> float:
    default_timeout = _default_cli_timeout_seconds(provider, graph)
    raw = os.environ.get("SHOWME_LLM_TIMEOUT")
    try:
        return float(raw) if raw else default_timeout
    except ValueError:
        LOGGER.warning("Invalid SHOWME_LLM_TIMEOUT=%r, falling back to %s", raw, default_timeout)
        return default_timeout


def _ask_fetch_timeout_ms() -> int:
    longest_provider_timeout = max(
        _ollama_timeout_seconds(),
        _cli_timeout_seconds("claude", {"mode": "deep_explain"}),
        _cli_timeout_seconds("codex", {"mode": "deep_explain"}),
    )
    return int(longest_provider_timeout * 1000) + NETWORK_OVERHEAD_MS


def _ollama_keep_alive() -> str | int:
    # Ollama keeps models in VRAM by default; ShowMe unloads immediately unless configured.
    # Accepted formats: seconds ("30"), durations ("5m", "1h"), -1 forever, 0 immediately.
    raw = os.environ.get("SHOWME_OLLAMA_KEEP_ALIVE", "").strip()
    if not raw:
        return DEFAULT_OLLAMA_KEEP_ALIVE
    try:
        return int(raw)
    except ValueError:
        return raw


def _ollama_thinking_enabled() -> bool:
    # Reasoning models can add private reasoning text around JSON; keep it off by default.
    return os.environ.get("SHOWME_OLLAMA_THINK", "").strip().lower() in {"1", "true", "yes", "on"}


def _ollama_unload_on_cancel() -> bool:
    raw = os.environ.get("SHOWME_OLLAMA_UNLOAD_ON_CANCEL", "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _http_json(path: str, payload: dict[str, Any] | None = None, timeout: float = 5.0) -> dict[str, Any]:
    data = None
    headers = {"Accept": "application/json"}
    method = "GET"
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = "POST"
    base_url = _ollama_base_url()
    req = urlrequest.Request(f"{base_url}{path}", data=data, headers=headers, method=method)
    try:
        with urlrequest.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urlerror.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(f"Ollama request failed at {base_url}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError("Ollama returned invalid JSON") from exc


def _ollama_models(timeout: float = 1.5) -> list[dict[str, str]]:
    payload = _http_json("/api/tags", timeout=timeout)
    models = []
    raw_models = payload.get("models")
    if not isinstance(raw_models, list):
        return models
    for model in raw_models[:MAX_OLLAMA_MODELS]:
        if not isinstance(model, dict):
            continue
        name = _text(model.get("name") or model.get("model"), 160)
        if name and "embed" not in name.lower():
            models.append({"id": name, "label": name})
    return models


def _resolve_program(candidates: tuple[str, ...]) -> str | None:
    for candidate in candidates:
        if shutil.which(candidate):
            return candidate
    return None


def _link_key(value: Any) -> str:
    return _text(value, 80)


def _slot_index(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _to_float(value: Any, default: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(result) or math.isinf(result):
        return default
    return result


def _sanitize_slot(raw: Any, index: int, io: str) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    slot = {
        "name": _text(raw.get("name") or raw.get("type"), 80),
        "type": _text(raw.get("type"), 80),
        "index": _slot_index(raw.get("index"), index),
    }
    if io == "input":
        slot["link"] = _link_key(raw.get("link"))
    else:
        slot["links"] = [_link_key(link) for link in _list(raw.get("links"))[:MAX_SLOTS] if _link_key(link)]
    return slot


def _sanitize_widget(raw: Any) -> dict[str, str] | None:
    if not isinstance(raw, dict):
        return None
    return {
        "name": _text(raw.get("name") or raw.get("label") or raw.get("type"), 80),
        "type": _text(raw.get("type"), 80),
        "value": _text(raw.get("value"), 120),
    }


def _sanitize_node(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    node_id = raw.get("id")
    if node_id is None:
        return None
    pos = raw.get("pos") if isinstance(raw.get("pos"), list) else [0, 0]
    size = raw.get("size") if isinstance(raw.get("size"), list) else [180, 80]
    return {
        "id": node_id,
        "type": _text(raw.get("type"), 120),
        "title": _text(raw.get("title"), 160),
        "pos": [_to_float(pos[0], 0.0), _to_float(pos[1], 0.0)] if len(pos) >= 2 else [0.0, 0.0],
        "size": [_to_float(size[0], 180.0), _to_float(size[1], 80.0)] if len(size) >= 2 else [180.0, 80.0],
        "inputs": [
            slot
            for index, raw_slot in enumerate(_list(raw.get("inputs"))[:MAX_SLOTS])
            if (slot := _sanitize_slot(raw_slot, index, "input"))
        ],
        "outputs": [
            slot
            for index, raw_slot in enumerate(_list(raw.get("outputs"))[:MAX_SLOTS])
            if (slot := _sanitize_slot(raw_slot, index, "output"))
        ],
        "widgets": [
            widget
            for raw_widget in _list(raw.get("widgets"))[:MAX_WIDGETS]
            if (widget := _sanitize_widget(raw_widget))
        ],
    }


def _sanitize_link(raw: Any) -> dict[str, Any] | None:
    if isinstance(raw, list):
        raw = {
            "id": raw[0] if len(raw) > 0 else "",
            "origin_id": raw[1] if len(raw) > 1 else None,
            "origin_slot": raw[2] if len(raw) > 2 else -1,
            "target_id": raw[3] if len(raw) > 3 else None,
            "target_slot": raw[4] if len(raw) > 4 else -1,
            "type": raw[5] if len(raw) > 5 else "",
        }
    if not isinstance(raw, dict):
        return None
    origin_id = raw.get("origin_id")
    target_id = raw.get("target_id")
    if origin_id is None or target_id is None:
        return None
    return {
        "id": _link_key(raw.get("id")),
        "origin_id": origin_id,
        "origin_slot": _slot_index(raw.get("origin_slot"), -1),
        "target_id": target_id,
        "target_slot": _slot_index(raw.get("target_slot"), -1),
        "type": _text(raw.get("type"), 80),
    }


def _sanitize_annotation(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    source = _text(raw.get("source"), 20)
    if source and source != "ai":
        return None
    item: dict[str, Any] = {
        "type": _text(raw.get("type"), 30),
        "role": _text(raw.get("role"), 40),
        "text": _text(raw.get("text") or raw.get("label"), 220),
    }
    if raw.get("nodeId") is not None:
        item["nodeId"] = raw.get("nodeId")
    try:
        step_index = int(raw.get("stepIndex"))
    except (TypeError, ValueError):
        step_index = 0
    if step_index > 0:
        item["stepIndex"] = step_index
    return item if item.get("type") or item.get("nodeId") or item.get("stepIndex") else None


def _sanitize_graph(raw: Any, mode: str) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    nodes = []
    for node in _list(raw.get("nodes"))[:MAX_NODES]:
        clean = _sanitize_node(node)
        if clean:
            nodes.append(clean)
    links = []
    for link in _list(raw.get("links"))[:MAX_LINKS]:
        clean_link = _sanitize_link(link)
        if clean_link:
            links.append(clean_link)
    selected = raw.get("selectedNodeIds")
    if not isinstance(selected, list):
        selected = []
    annotations = []
    for annotation in _list(raw.get("annotations"))[:MAX_ANNOTATIONS]:
        clean_annotation = _sanitize_annotation(annotation)
        if clean_annotation:
            annotations.append(clean_annotation)
    ui_alerts = [
        _text(alert, 260)
        for alert in _list(raw.get("uiAlerts"))[:MAX_UI_ALERTS]
        if _text(alert, 260)
    ]
    return {
        "mode": mode,
        "requestedMode": mode,
        "nodes": nodes,
        "selectedNodeIds": selected[:MAX_NODES],
        "links": links,
        "annotations": annotations,
        "uiAlerts": ui_alerts,
    }


def _node_label(node: dict[str, Any]) -> str:
    return _text(node.get("title") or node.get("type"), 80) or f"Node {node.get('id')}"


def _slot_label(slot: dict[str, Any]) -> str:
    return _text(slot.get("name") or slot.get("type"), 80)


def _slot_by_index(slots: list[Any], index: int, slot_type: str = "") -> dict[str, Any]:
    for slot in slots:
        if isinstance(slot, dict) and _slot_index(slot.get("index"), -2) == index:
            return slot
    if 0 <= index < len(slots) and isinstance(slots[index], dict):
        return slots[index]
    return {"name": slot_type, "type": slot_type, "index": index}


def _node_by_id(graph: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(node.get("id")): node for node in graph.get("nodes", [])}


def _connection_from_slots(
    source: dict[str, Any],
    output_slot: dict[str, Any],
    target: dict[str, Any],
    input_slot: dict[str, Any],
) -> dict[str, Any]:
    return {
        "fromNodeId": source.get("id"),
        "fromSlot": _slot_label(output_slot),
        "toNodeId": target.get("id"),
        "toSlot": _slot_label(input_slot),
        "label": f"{_node_label(source)} -> {_node_label(target)}",
    }


def _dedupe_connections(connections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = set()
    unique = []
    for connection in connections:
        key = (
            str(connection.get("fromNodeId")),
            connection.get("fromSlot"),
            str(connection.get("toNodeId")),
            connection.get("toSlot"),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(connection)
    return unique


def _actual_connections(graph: dict[str, Any]) -> list[dict[str, Any]]:
    nodes = _node_by_id(graph)
    connections = []
    for link in _list(graph.get("links")):
        source = nodes.get(str(link.get("origin_id")))
        target = nodes.get(str(link.get("target_id")))
        if not source or not target:
            continue
        output_slot = _slot_by_index(_list(source.get("outputs")), _slot_index(link.get("origin_slot"), -1), link.get("type"))
        input_slot = _slot_by_index(_list(target.get("inputs")), _slot_index(link.get("target_slot"), -1), link.get("type"))
        connections.append(_connection_from_slots(source, output_slot, target, input_slot))

    input_by_link: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
    for target in graph.get("nodes", []):
        for input_slot in _list(target.get("inputs")):
            if isinstance(input_slot, dict) and _link_key(input_slot.get("link")):
                input_by_link[_link_key(input_slot.get("link"))] = (target, input_slot)
    for source in graph.get("nodes", []):
        for output_slot in _list(source.get("outputs")):
            if not isinstance(output_slot, dict):
                continue
            for link_key in _list(output_slot.get("links")):
                target_pair = input_by_link.get(_link_key(link_key))
                if target_pair:
                    target, input_slot = target_pair
                    connections.append(_connection_from_slots(source, output_slot, target, input_slot))
    return _dedupe_connections(connections)


def _connection_node_ids(connection: dict[str, Any]) -> tuple[str, str]:
    return str(connection.get("fromNodeId")), str(connection.get("toNodeId"))


def _node_slot_types(node: dict[str, Any]) -> set[str]:
    values = set()
    for key in ("inputs", "outputs"):
        for slot in _list(node.get(key)):
            if isinstance(slot, dict):
                values.update(_terms(slot.get("type")))
                values.update(_terms(slot.get("name")))
    return values


def _node_importance(node: dict[str, Any]) -> int:
    text = _terms(f"{node.get('title')} {node.get('type')}")
    slots = _node_slot_types(node)
    score = 0
    if "image" in slots:
        score += 12
    if "latent" in slots:
        score += 10
    if "conditioning" in slots:
        score += 8
    if "model" in slots:
        score += 6
    if "clip" in slots:
        score += 6
    if "vae" in slots:
        score += 6
    if text & {"sampler", "ksampler", "sample", "sampling"}:
        score += 10
    if text & {"decode", "vae"}:
        score += 8
    if text & {"save", "preview", "output"}:
        score += 7
    if text & {"prompt", "text", "encode"}:
        score += 6
    if text & {"load", "loader", "model"}:
        score += 4
    return score


def _node_position_key(node: dict[str, Any]) -> tuple[float, float, str]:
    pos = node.get("pos") if isinstance(node.get("pos"), list) else [0, 0]
    return (
        _to_float(pos[0], 0.0) if len(pos) > 0 else 0.0,
        _to_float(pos[1], 0.0) if len(pos) > 1 else 0.0,
        str(node.get("id")),
    )


def _every_node_order(graph: dict[str, Any]) -> list[str]:
    nodes = _node_by_id(graph)
    node_ids = set(nodes)
    if not node_ids:
        return []
    outgoing: dict[str, set[str]] = {node_id: set() for node_id in node_ids}
    incoming_count: dict[str, int] = {node_id: 0 for node_id in node_ids}
    for connection in _actual_connections(graph):
        from_id, to_id = _connection_node_ids(connection)
        if from_id not in node_ids or to_id not in node_ids or to_id in outgoing[from_id]:
            continue
        outgoing[from_id].add(to_id)
        incoming_count[to_id] += 1

    def position_key(node_id: str) -> tuple[float, float, str]:
        return _node_position_key(nodes.get(node_id, {}))

    queue = sorted([node_id for node_id, count in incoming_count.items() if count == 0], key=position_key)
    ordered = []
    queued = set(queue)
    while queue:
        node_id = queue.pop(0)
        queued.discard(node_id)
        if node_id in ordered:
            continue
        ordered.append(node_id)
        for next_id in sorted(outgoing.get(node_id, []), key=position_key):
            incoming_count[next_id] -= 1
            if incoming_count[next_id] <= 0 and next_id not in queued:
                queue.append(next_id)
                queued.add(next_id)
    ordered.extend(sorted(node_ids - set(ordered), key=position_key))
    return ordered


def _every_node_batches(graph: dict[str, Any], batch_size: int = EVERY_NODE_BATCH_SIZE) -> list[list[str]]:
    ordered_ids = _every_node_order(graph)
    return [ordered_ids[index:index + batch_size] for index in range(0, len(ordered_ids), batch_size)]


CONNECTION_INCOMING_PATTERNS = (
    r"\binputs?\b",
    r"\binput sources?\b",
    r"\bfeed(?:s|ing)? into\b",
    r"\breceive(?:s)?\b",
    r"\bsources?\b",
)

CONNECTION_OUTGOING_PATTERNS = (
    r"\boutputs?\b",
    r"\boutput targets?\b",
    r"\boutputs? go(?:es)?\b",
    r"\bgoes to\b",
    r"\btargets?\b",
)

CONNECTION_SUGGESTION_PATTERNS = (
    r"\bhow (?:to|should i) connect\b",
    r"\bwhere to connect\b",
    r"\bwhat to connect\b",
    r"\bconnect (?:all|every|these|nodes?|workflow)\b",
    r"\b(?:wire|hook|link) (?:all|up|nodes?|workflow)\b",
)

CONNECTION_LOOKUP_PATTERNS = (
    r"\bconnections?\b",
    r"\binput sources?\b",
    r"\boutput targets?\b",
    r"\boutputs? go(?:es)?\b",
    r"\bfeeds? into\b",
    r"\bwhere selected outputs?\b",
    r"\bwhere does selected\b",
)

DIAGNOSTIC_QUERY_PATTERNS = (
    r"\bdiagnostics?\b",
    r"\binvalid(?: (?:setting|value))?\b",
    r"\b(?:error|errors|failed|failure|broken|issue|issues|warning|warnings)\b",
    r"\bwhat(?:'s| is) wrong\b",
    r"\bwhy (?:broken|failing)\b",
    r"\b(?:does not work|not working)\b",
    r"\bmissing (?:node|nodes|link|links)\b",
    r"\bshow missing\b",
)


def _connection_direction(question: str) -> str:
    q = _search_text(question)
    if _matches_any(q, CONNECTION_INCOMING_PATTERNS):
        return "incoming"
    if _matches_any(q, CONNECTION_OUTGOING_PATTERNS):
        return "outgoing"
    return "any"


def _question_asks_connection_suggestion(question: str) -> bool:
    q = _search_text(question)
    terms = _terms(question)
    return _matches_any(q, CONNECTION_SUGGESTION_PATTERNS) or bool(
        {"connect", "wire", "wireup", "rewire", "hook", "link"} & terms
        and {"node", "nodes", "workflow"} & terms
    )


def _question_asks_diagnostics(question: str) -> bool:
    return _matches_any(_search_text(question), DIAGNOSTIC_QUERY_PATTERNS)


def _connections_for_mode(question: str, graph: dict[str, Any]) -> list[dict[str, Any]]:
    connections = _actual_connections(graph)
    selected = {str(node_id) for node_id in graph.get("selectedNodeIds", [])}
    if not selected:
        return connections[:MAX_PLAN_ITEMS]
    direction = _connection_direction(question)
    if direction == "incoming":
        return [connection for connection in connections if _connection_node_ids(connection)[1] in selected][:MAX_PLAN_ITEMS]
    if direction == "outgoing":
        return [connection for connection in connections if _connection_node_ids(connection)[0] in selected][:MAX_PLAN_ITEMS]
    return [connection for connection in connections if set(_connection_node_ids(connection)) & selected][:MAX_PLAN_ITEMS]


def _empty_plan() -> dict[str, list[dict[str, Any]]]:
    return {"steps": [], "connections": [], "focus": [], "warnings": []}


def _debug_graph_snapshot(graph: dict[str, Any]) -> dict[str, Any]:
    nodes = graph.get("nodes", [])
    return {
        "intent": graph.get("intent"),
        "mode": graph.get("mode"),
        "selectedNodeIds": graph.get("selectedNodeIds", []),
        "linkCount": len(graph.get("links", [])),
        "nodeCount": len(nodes),
        "nodes": [
            {
                "id": node.get("id"),
                "type": node.get("type"),
                "title": node.get("title"),
                "pos": node.get("pos"),
                "size": node.get("size"),
                "selected": node.get("selected"),
                "inputs": [
                    {"index": slot.get("index"), "name": slot.get("name"), "type": slot.get("type"), "link": slot.get("link")}
                    for slot in _list(node.get("inputs"))[:12]
                    if isinstance(slot, dict)
                ],
                "outputs": [
                    {"index": slot.get("index"), "name": slot.get("name"), "type": slot.get("type"), "links": slot.get("links", [])[:12]}
                    for slot in _list(node.get("outputs"))[:12]
                    if isinstance(slot, dict)
                ],
                "widgets": [
                    {
                        "index": index,
                        "name": widget.get("name"),
                        "type": widget.get("type"),
                        "value": _text(widget.get("value"), 120),
                    }
                    for index, widget in enumerate(_list(node.get("widgets"))[:12])
                    if isinstance(widget, dict)
                ],
            }
            for node in nodes[:MAX_NODES]
            if isinstance(node, dict)
        ],
    }


def _debug_plan_counts(plan: dict[str, Any]) -> dict[str, int]:
    return {
        "steps": len(_list(plan.get("steps"))),
        "connections": len(_list(plan.get("connections"))),
        "focus": len(_list(plan.get("focus"))),
        "warnings": len(_list(plan.get("warnings"))),
    }


def _legacy_mode_for_intent(intent: str) -> str:
    return {
        INTENT_DRAW_STEPS: "tutorial_flow",
        INTENT_DRAW_ALL_NODES: "deep_explain",
        INTENT_DRAW_CONNECTIONS: "connections",
        INTENT_DIAGNOSTICS: "diagnostics",
    }.get(intent, "freeform")


def _classify_intent(question: str, requested_mode: str, graph: dict[str, Any]) -> str:
    requested = _mode(requested_mode)
    requested_map = {
        INTENT_ANSWER_ONLY: INTENT_ANSWER_ONLY,
        INTENT_OVERVIEW: INTENT_OVERVIEW,
        INTENT_DRAW_STEPS: INTENT_DRAW_STEPS,
        INTENT_DRAW_ALL_NODES: INTENT_DRAW_ALL_NODES,
        INTENT_DRAW_CONNECTIONS: INTENT_DRAW_CONNECTIONS,
        INTENT_DIAGNOSTICS: INTENT_DIAGNOSTICS,
        INTENT_LOOKUP_FOCUS: INTENT_LOOKUP_FOCUS,
        "tutorial_flow": INTENT_DRAW_STEPS,
        "deep_explain": INTENT_DRAW_ALL_NODES,
        "connections": INTENT_DRAW_CONNECTIONS,
        "diagnostics": INTENT_DIAGNOSTICS,
    }
    if requested in requested_map:
        return requested_map[requested]

    q = _search_text(question)
    if _question_asks_diagnostics(question) or _matches_any(q, (r"\b(?:suspicious|disconnected|redundant)\b",)):
        return INTENT_DIAGNOSTICS
    if _question_asks_connection_suggestion(question):
        return INTENT_DRAW_CONNECTIONS
    if _matches_any(q, CONNECTION_LOOKUP_PATTERNS):
        return INTENT_DRAW_CONNECTIONS
    if _matches_any(
        q,
        (
            r"\b(?:every|all|each) nodes?\b",
            r"\bexplain every\b",
        ),
    ):
        return INTENT_DRAW_ALL_NODES
    if _matches_any(
        q,
        (
            r"\bstep by step\b",
            r"\bbuild(?:ing)? order\b",
            r"\btutorial\b",
            r"\btrace the path\b",
            r"\bmain path\b",
            r"\bgeneration path\b",
        ),
    ):
        return INTENT_DRAW_STEPS
    if _matches_any(
        q,
        (
            r"\bworkflow does\b",
            r"\bexplain (?:this )?workflow\b",
            r"\bidentify the main\b",
            r"\bwhat this workflow does\b",
        ),
    ):
        return INTENT_DRAW_STEPS
    if _matches_any(
        q,
        (
            r"\bwhere (?:is|are)\b",
            r"\bfind\b",
            r"\blocate\b",
            r"\bhighlight\b",
            r"\bfocus\b",
            r"\bshow(?: me)?\b",
        ),
    ):
        return INTENT_LOOKUP_FOCUS
    if _matches_any(q, (r"\boverview\b", r"\bsummary\b")):
        return INTENT_OVERVIEW
    return INTENT_ANSWER_ONLY


def _set_graph_intent(graph: dict[str, Any], intent: str) -> dict[str, Any]:
    graph["intent"] = intent
    graph["mode"] = _legacy_mode_for_intent(intent)
    return graph


def _draw_policy_for_intent(intent: str, plan: dict[str, Any] | None = None) -> str:
    if intent not in DRAW_INTENTS:
        return "none"
    plan = plan or {}
    if any(_list(plan.get(key)) for key in ("steps", "connections", "focus", "warnings")):
        return "local" if intent in {INTENT_DRAW_ALL_NODES, INTENT_DRAW_CONNECTIONS, INTENT_DIAGNOSTICS, INTENT_LOOKUP_FOCUS} else "final"
    return "none"


def _client_error_message(exc: BaseException) -> str:
    text = _text(exc, 200)
    lowered = text.lower()
    if "timed out" in lowered or "timeout" in lowered:
        return "Provider timed out"
    if "ollama" in lowered and ("failed" in lowered or "request" in lowered or "invalid" in lowered):
        return "Ollama request failed"
    if "no models" in lowered or "model is not available" in lowered or "no ai provider" in lowered:
        return text
    if "command was not found" in lowered or "is not configured" in lowered or "is empty" in lowered:
        return text
    if "did not return a showme plan" in lowered or "did not return a json" in lowered:
        return text
    if "every-node batch" in lowered or "incomplete" in lowered:
        return text
    return "Provider failed"


def _response(
    answer: str,
    plan: dict[str, Any],
    provider: str,
    model: str | None = None,
    *,
    intent: str | None = None,
    draw_policy: str | None = None,
) -> dict[str, Any]:
    safe_intent = intent or INTENT_ANSWER_ONLY
    result = {
        "status": "ok",
        "provider": provider,
        "intent": safe_intent,
        "drawPolicy": draw_policy or _draw_policy_for_intent(safe_intent, plan),
        "answer": _text(answer, 600),
        "plan": plan,
    }
    if model:
        result["model"] = model
    return result


def _input_is_linked(slot: dict[str, Any]) -> bool:
    return bool(_link_key(slot.get("link")))


def _input_likely_required(node: dict[str, Any], slot: dict[str, Any]) -> bool:
    name = _norm(slot.get("name"))
    slot_type = _norm(slot.get("type"))
    node_terms = _terms(f"{node.get('title')} {node.get('type')}")
    if not name and not slot_type:
        return False
    if name in DIAGNOSTIC_OPTIONAL_INPUT_NAMES or slot_type in DIAGNOSTIC_OPTIONAL_INPUT_NAMES:
        return False
    if "optional" in name or "optional" in slot_type:
        return False
    if node_terms & {"ksampler", "sampler", "samplercustom"}:
        return name in {"model", "positive", "negative", "latent_image", "latent"} or slot_type in {"model", "conditioning", "latent"}
    if node_terms & {"decode", "vaedecode"}:
        return name in {"samples", "vae"} or slot_type in {"latent", "vae"}
    if node_terms & {"encode", "cliptextencode", "text"}:
        return name == "clip" or slot_type == "clip"
    if node_terms & {"save", "preview", "output"}:
        return name in {"image", "images"} or slot_type == "image"
    if name in DIAGNOSTIC_REQUIRED_INPUT_NAMES or slot_type in DIAGNOSTIC_REQUIRED_INPUT_TYPES:
        return True
    return False


def _local_missing_input_warnings(graph: dict[str, Any]) -> list[dict[str, Any]]:
    warnings = []
    for node in graph.get("nodes", []):
        for slot in _list(node.get("inputs")):
            if not isinstance(slot, dict) or _input_is_linked(slot) or not _input_likely_required(node, slot):
                continue
            slot_name = _slot_label(slot) or "input"
            warnings.append(
                {
                    "nodeId": node.get("id"),
                    "widget": "",
                    "message": f"{_node_label(node)}: required input '{slot_name}' is not connected.",
                    "label": f"Unlinked {slot_name}",
                }
            )
    return warnings[:MAX_PLAN_ITEMS]


def _local_diagnostics(graph: dict[str, Any]) -> dict[str, Any] | None:
    if graph.get("intent") != INTENT_DIAGNOSTICS:
        return None
    plan = _empty_plan()
    ui_alerts = [_text(alert, 180) for alert in _list(graph.get("uiAlerts")) if _text(alert, 180)]
    for node in graph.get("nodes", []):
        for widget in _list(node.get("widgets")):
            if not isinstance(widget, dict):
                continue
            value = _text(widget.get("value"), 120)
            reason = DIAGNOSTIC_INVALID_NUMERIC_WIDGET_VALUES.get(value.lower())
            if not reason:
                continue
            widget_name = _text(widget.get("name") or widget.get("type"), 80) or "value"
            plan["focus"].append({"nodeId": node.get("id"), "widget": widget_name, "label": f"{widget_name}: {value}"})
            plan["warnings"].append(
                {
                    "nodeId": node.get("id"),
                    "widget": widget_name,
                    "message": f"{_node_label(node)}: {widget_name} is {value} ({reason}).",
                }
            )
    for warning in _local_missing_input_warnings(graph):
        plan["warnings"].append(warning)
        plan["focus"].append(
            {
                "nodeId": warning.get("nodeId"),
                "widget": "",
                "label": warning.get("label") or "Unlinked input",
            }
        )
    if plan["warnings"]:
        alert_suffix = f" UI alert: {ui_alerts[0]}" if ui_alerts else ""
        return _response(f"Found {len(plan['warnings'])} local issue(s).{alert_suffix}", plan, "local", intent=INTENT_DIAGNOSTICS)
    if ui_alerts:
        return _response(f"ComfyUI reports: {ui_alerts[0]}", _empty_plan(), "local", intent=INTENT_DIAGNOSTICS)
    return None


def _local_connections(question: str, graph: dict[str, Any]) -> dict[str, Any] | None:
    if graph.get("intent") != INTENT_DRAW_CONNECTIONS:
        return None
    if _question_asks_connection_suggestion(question):
        return None
    plan = _empty_plan()
    plan["connections"] = _connections_for_mode(question, graph)
    if not plan["connections"]:
        return _response("No matching connections found on the graph.", _empty_plan(), "local", intent=INTENT_DRAW_CONNECTIONS)
    return _response("Showing existing workflow connections from the graph.", plan, "local", intent=INTENT_DRAW_CONNECTIONS)


def _annotation_step_node_id(graph: dict[str, Any], step_index: int) -> Any | None:
    for item in _list(graph.get("annotations")):
        if not isinstance(item, dict):
            continue
        try:
            current = int(item.get("stepIndex"))
        except (TypeError, ValueError):
            current = 0
        if current == step_index and item.get("nodeId") is not None:
            return item.get("nodeId")
    return None


def _lookup_step_index(question: str) -> int | None:
    q = _search_text(question).replace(".", " ")
    patterns = (
        r"step\s*(\d{1,4})",
        r"(\d{1,4})\s*step",
    )
    for pattern in patterns:
        match = re.search(pattern, q)
        if match:
            value = int(match.group(1))
            return value if value > 0 else None
    return None


def _local_lookup_focus(question: str, graph: dict[str, Any]) -> dict[str, Any] | None:
    if graph.get("intent") != INTENT_LOOKUP_FOCUS:
        return None
    plan = _empty_plan()
    nodes = _node_by_id(graph)
    step_index = _lookup_step_index(question)
    if step_index:
        node_id = _annotation_step_node_id(graph, step_index)
        if node_id is not None and _node_id_exists(graph, node_id):
            node = nodes[str(node_id)]
            plan["focus"].append({"nodeId": node_id, "label": f"Step {step_index}: {_node_label(node)}", "role": "lookup"})
            return _response(f"Step {step_index} is {_node_label(node)}.", plan, "local", intent=INTENT_LOOKUP_FOCUS, draw_policy="local")
        return _response(f"Step {step_index} is not in the current ShowMe drawing.", plan, "local", intent=INTENT_LOOKUP_FOCUS, draw_policy="none")
    return None


def _cli_model_options(config: dict[str, Any]) -> list[dict[str, str]]:
    models = []
    for model in config.get("models", ()):
        if not isinstance(model, dict):
            continue
        model_id = _text(model.get("id"), 160)
        if model_id:
            models.append({"id": model_id, "label": _text(model.get("label"), 160) or model_id})
    return models


def _selected_cli_model(config: dict[str, Any], model: str) -> str:
    models = _cli_model_options(config)
    model_ids = {item["id"] for item in models}
    chosen = _text(model, 160) or _text(config.get("defaultModel"), 160)
    if chosen and model_ids and chosen not in model_ids:
        raise RuntimeError(f"{config['label']} model is not available: {chosen}")
    return chosen


def _providers() -> list[dict[str, Any]]:
    providers = []
    try:
        ollama_models = _ollama_models(timeout=2.5)
    except RuntimeError as exc:
        LOGGER.debug("Ollama unavailable: %s", exc)
        ollama_models = []
    providers.append(
        {
            "id": "ollama",
            "label": "Ollama",
            "available": bool(ollama_models),
            "kind": "local-llm",
            "modelRequired": True,
            "models": ollama_models,
            "defaultModel": ollama_models[0]["id"] if ollama_models else "",
        }
    )
    for provider_id, config in BUILTIN_CLI_PROVIDERS.items():
        program = _resolve_program(config["programs"])
        if program:
            models = _cli_model_options(config)
            providers.append(
                {
                    "id": provider_id,
                    "label": config["label"],
                    "available": True,
                    "kind": "builtin-cli",
                    "modelRequired": False,
                    "models": models,
                    "defaultModel": _selected_cli_model(config, ""),
                }
            )
    command = os.environ.get("SHOWME_LLM_COMMAND", "").strip()
    if command:
        providers.append({"id": "cli", "label": "Configured CLI", "available": True, "kind": "cli"})
    return providers


def _question_needs_widget_values(question: str) -> bool:
    q = _norm(question)
    return any(term in q for term in ("prompt", "positive", "negative", "text", "caption"))


def _node_is_prompt_like(node: dict[str, Any]) -> bool:
    return bool(_terms(f"{node.get('title')} {node.get('type')}") & {"prompt", "text", "encode", "clip"})


def _node_is_output_like(node: dict[str, Any]) -> bool:
    return bool(_terms(f"{node.get('title')} {node.get('type')}") & {"save", "preview", "output"})


def _node_role_hint(node: dict[str, Any]) -> str:
    terms = _terms(f"{node.get('title')} {node.get('type')}")
    if "checkpoint" in terms or terms & {"checkpointloader", "checkpointloadersimple", "loadcheckpoint"}:
        return "checkpoint loader: provides MODEL, CLIP, and VAE"
    if terms & {"ksampler", "sampler", "samplercustom"}:
        return "sampler: combines model, conditioning, latent, seed, steps, cfg, and denoise"
    if ("clip" in terms and "encode" in terms) or terms & {"cliptextencode"}:
        return "prompt encoder: turns text into CONDITIONING"
    if "latent" in terms and (terms & {"empty", "image"}):
        return "latent source: creates the starting LATENT image"
    if "vae" in terms and "decode" in terms:
        return "decoder: converts LATENT samples to IMAGE using VAE"
    if _node_is_output_like(node):
        return "output node: writes or previews final IMAGE data"
    return ""


def _connection_adjacency(connections: list[dict[str, Any]]) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    incoming: dict[str, list[str]] = {}
    outgoing: dict[str, list[str]] = {}
    for connection in connections:
        from_id, to_id = _connection_node_ids(connection)
        outgoing.setdefault(from_id, []).append(to_id)
        incoming.setdefault(to_id, []).append(from_id)
    return incoming, outgoing


def _expand_context_ids(
    seeds: set[str],
    graph: dict[str, Any],
    connections: list[dict[str, Any]],
    limit: int,
    *,
    prefer_upstream: bool = False,
) -> set[str]:
    nodes = _node_by_id(graph)
    incoming, outgoing = _connection_adjacency(connections)

    def position_key(node_id: str) -> tuple[float, float, str]:
        return _node_position_key(nodes.get(node_id, {}))

    wanted = {node_id for node_id in seeds if node_id in nodes}
    queue = sorted(wanted, key=position_key)
    visited = set(queue)
    while queue and len(wanted) < limit:
        current = queue.pop(0)
        groups = (incoming.get(current, []), outgoing.get(current, [])) if prefer_upstream else (outgoing.get(current, []), incoming.get(current, []))
        for group in groups:
            for next_id in sorted(group, key=position_key):
                if next_id in visited or next_id not in nodes:
                    continue
                visited.add(next_id)
                wanted.add(next_id)
                queue.append(next_id)
                if len(wanted) >= limit:
                    break
            if len(wanted) >= limit:
                break
    return wanted


def _prompt_context_node_ids(question: str, graph: dict[str, Any], limit: int = MAX_CONTEXT_NODES) -> set[str]:
    nodes = _node_by_id(graph)
    all_node_ids = set(nodes)
    if graph.get("intent") == INTENT_DRAW_STEPS and len(all_node_ids) <= limit:
        return all_node_ids
    selected = {str(node_id) for node_id in graph.get("selectedNodeIds", []) if str(node_id) in nodes}
    wanted = set(selected)
    question_terms = _terms(question)
    connections = _actual_connections(graph)
    output_ids = {str(node.get("id")) for node in graph.get("nodes", []) if _node_is_output_like(node)}
    match_ids = {
        str(node.get("id"))
        for node in graph.get("nodes", [])
        if question_terms & _terms(f"{node.get('title')} {node.get('type')}")
    }
    if _question_needs_widget_values(question):
        match_ids |= {str(node.get("id")) for node in graph.get("nodes", []) if _node_is_prompt_like(node)}
    wanted |= match_ids | set(list(output_ids)[:4])
    if graph.get("intent") == INTENT_DRAW_STEPS and wanted:
        return _expand_context_ids(wanted, graph, connections, limit, prefer_upstream=not selected)
    if not wanted:
        ranked = sorted(
            [str(node.get("id")) for node in graph.get("nodes", [])],
            key=lambda node_id: (
                -_node_importance(nodes.get(node_id, {})),
                nodes.get(node_id, {}).get("pos", [0, 0])[0],
                nodes.get(node_id, {}).get("pos", [0, 0])[1],
            ),
        )
        wanted |= set(ranked[: min(limit, 12)])

    for connection in connections:
        from_id, to_id = _connection_node_ids(connection)
        if from_id in wanted or to_id in wanted:
            wanted.add(from_id)
            wanted.add(to_id)
        if len(wanted) >= limit:
            break
    return set(list(wanted)[:limit])


def _compact_prompt_node(
    node: dict[str, Any],
    *,
    include_widget_values: bool,
    include_all_widget_values: bool = False,
) -> dict[str, Any]:
    prompt_like = _node_is_prompt_like(node)
    compact = {
        "id": node["id"],
        "type": node["type"],
        "title": node["title"],
        "roleHint": _node_role_hint(node),
        "inputs": [
            {"name": slot["name"], "type": slot["type"], "index": slot["index"]}
            for slot in _list(node.get("inputs"))
        ],
        "outputs": [
            {"name": slot["name"], "type": slot["type"], "index": slot["index"]}
            for slot in _list(node.get("outputs"))
        ],
        "widgets": [],
    }
    for widget in _list(node.get("widgets"))[:12]:
        if not isinstance(widget, dict):
            continue
        item = {
            "name": _text(widget.get("name") or widget.get("type"), 80),
            "type": _text(widget.get("type"), 80),
        }
        if include_widget_values and (prompt_like or include_all_widget_values):
            item["value"] = _text(widget.get("value"), 240)
        compact["widgets"].append(item)
    return compact


def _compact_lookup_node(node: dict[str, Any]) -> dict[str, Any]:
    """Small workflow index entry for AI lookup decisions."""
    compact = {
        "id": node["id"],
        "type": _text(node.get("type"), 80),
        "title": _text(node.get("title"), 80),
    }
    for key in ("inputs", "outputs"):
        items = []
        for slot in _list(node.get(key))[:MAX_LOOKUP_SLOTS]:
            if not isinstance(slot, dict):
                continue
            name = _text(slot.get("name"), 48)
            slot_type = _text(slot.get("type"), 48)
            items.append(f"{name}:{slot_type}" if slot_type else name)
        if items:
            compact[key] = items
    widgets = []
    for widget in _list(node.get("widgets"))[:MAX_LOOKUP_WIDGETS]:
        if not isinstance(widget, dict):
            continue
        name = _text(widget.get("name") or widget.get("type"), 48)
        widget_type = _text(widget.get("type"), 48)
        widgets.append(f"{name}:{widget_type}" if widget_type else name)
    if widgets:
        compact["widgets"] = widgets
    return compact


def _compact_lookup_connection(connection: dict[str, Any]) -> dict[str, Any]:
    return {
        "fromNodeId": connection.get("fromNodeId"),
        "fromSlot": _text(connection.get("fromSlot"), 48),
        "toNodeId": connection.get("toNodeId"),
        "toSlot": _text(connection.get("toSlot"), 48),
    }


def _compact_every_node(node: dict[str, Any]) -> dict[str, Any]:
    compact = {
        "id": node["id"],
        "type": _text(node.get("type"), 100),
        "title": _text(node.get("title"), 120),
        "inputs": [
            {"name": _text(slot.get("name"), 64), "type": _text(slot.get("type"), 64), "index": slot.get("index")}
            for slot in _list(node.get("inputs"))
            if isinstance(slot, dict)
        ],
        "outputs": [
            {"name": _text(slot.get("name"), 64), "type": _text(slot.get("type"), 64), "index": slot.get("index")}
            for slot in _list(node.get("outputs"))
            if isinstance(slot, dict)
        ],
        "widgets": [],
    }
    for widget in _list(node.get("widgets"))[:MAX_EVERY_NODE_WIDGETS]:
        if not isinstance(widget, dict):
            continue
        compact["widgets"].append({
            "name": _text(widget.get("name") or widget.get("type"), 80),
            "type": _text(widget.get("type"), 80),
            "value": _text(widget.get("value"), 120),
        })
    return compact


def _compact_boundary_node(node: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": node.get("id"),
        "type": _text(node.get("type"), 100),
        "title": _text(node.get("title"), 120),
    }


def _node_type_summary(graph: dict[str, Any], limit: int = 24) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for node in graph.get("nodes", []):
        key = _text(node.get("type") or node.get("title") or "unknown", 80) or "unknown"
        counts[key] = counts.get(key, 0) + 1
    return [
        {"type": key, "count": count}
        for key, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]
    ]


def _every_node_batch_context(
    question: str,
    graph: dict[str, Any],
    batch_ids: list[str],
    batch_index: int,
    batch_count: int,
) -> dict[str, Any]:
    nodes = _node_by_id(graph)
    batch_set = set(batch_ids)
    boundary_ids = set()
    scoped_connections = []
    for connection in _actual_connections(graph):
        from_id, to_id = _connection_node_ids(connection)
        if from_id not in batch_set and to_id not in batch_set:
            continue
        scoped_connections.append(_compact_lookup_connection(connection))
        if from_id not in batch_set:
            boundary_ids.add(from_id)
        if to_id not in batch_set:
            boundary_ids.add(to_id)
        if len(scoped_connections) >= MAX_EVERY_NODE_BATCH_CONNECTIONS:
            break
    boundary_nodes = [
        _compact_boundary_node(nodes[node_id])
        for node_id in sorted(boundary_ids, key=lambda node_id: _node_position_key(nodes.get(node_id, {})))[:MAX_EVERY_NODE_BOUNDARY_NODES]
        if node_id in nodes
    ]
    return {
        "question": question,
        "intent": INTENT_DRAW_ALL_NODES,
        "nodeCount": len(graph["nodes"]),
        "batchIndex": batch_index,
        "batchCount": batch_count,
        "targetBatchNodeIds": batch_ids,
        "targetNodes": [
            _compact_every_node(nodes[node_id])
            for node_id in batch_ids
            if node_id in nodes
        ],
        "boundaryNodes": boundary_nodes,
        "actualConnections": scoped_connections,
        "selectedNodeIds": graph["selectedNodeIds"],
        "workflowTypeSummary": _node_type_summary(graph),
    }


def _compact_workflow(question: str, graph: dict[str, Any]) -> dict[str, Any]:
    intent = graph.get("intent") or INTENT_ANSWER_ONLY
    connections = _actual_connections(graph)
    ui_alerts = _list(graph.get("uiAlerts"))[:MAX_UI_ALERTS]
    if intent == INTENT_LOOKUP_FOCUS:
        node_ids = {str(node.get("id")) for node in graph["nodes"]}
        scoped_connections = [
            _compact_lookup_connection(connection)
            for connection in connections
            if set(_connection_node_ids(connection)) & node_ids
        ][:MAX_LOOKUP_CONNECTIONS]
        return {
            "question": question,
            "intent": intent,
            "nodeCount": len(graph["nodes"]),
            "shownNodeCount": len(node_ids),
            "nodes": [_compact_lookup_node(node) for node in graph["nodes"]],
            "selectedNodeIds": graph["selectedNodeIds"],
            "actualConnections": scoped_connections,
            "uiAlerts": ui_alerts,
        }
    if intent == INTENT_DRAW_ALL_NODES:
        node_ids = {str(node.get("id")) for node in graph["nodes"]}
        return {
            "question": question,
            "intent": intent,
            "nodeCount": len(graph["nodes"]),
            "shownNodeCount": len(node_ids),
            "nodes": [
                _compact_prompt_node(node, include_widget_values=False)
                for node in graph["nodes"]
            ],
            "selectedNodeIds": graph["selectedNodeIds"],
            "actualConnections": connections[:MAX_DRAW_CONNECTIONS],
            "uiAlerts": ui_alerts,
        }
    if intent == INTENT_DIAGNOSTICS:
        node_ids = {str(node.get("id")) for node in graph["nodes"]}
        return {
            "question": question,
            "intent": intent,
            "nodeCount": len(graph["nodes"]),
            "shownNodeCount": len(node_ids),
            "nodes": [
                _compact_prompt_node(
                    node,
                    include_widget_values=True,
                    include_all_widget_values=True,
                )
                for node in graph["nodes"]
            ],
            "selectedNodeIds": graph["selectedNodeIds"],
            "actualConnections": connections[:MAX_CONTEXT_CONNECTIONS],
            "uiAlerts": ui_alerts,
        }
    if intent == INTENT_DRAW_CONNECTIONS and _question_asks_connection_suggestion(question):
        ordered_ids = _every_node_order(graph)[:MAX_CONNECTION_SUGGESTION_NODES]
        node_ids = set(ordered_ids)
        return {
            "question": question,
            "intent": intent,
            "connectionTask": "suggest_missing_connections",
            "nodeCount": len(graph["nodes"]),
            "shownNodeCount": len(node_ids),
            "nodes": [
                _compact_prompt_node(node, include_widget_values=True)
                for node in graph["nodes"]
                if str(node.get("id")) in node_ids
            ],
            "selectedNodeIds": graph["selectedNodeIds"],
            "actualConnections": connections[:MAX_DRAW_CONNECTIONS],
            "uiAlerts": ui_alerts,
        }
    else:
        node_ids = _prompt_context_node_ids(question, graph)
    connection_limit = MAX_DRAW_CONNECTIONS if intent == INTENT_DRAW_STEPS else MAX_CONTEXT_CONNECTIONS
    include_all_values = intent == INTENT_DIAGNOSTICS
    include_values = include_all_values or (intent != INTENT_LOOKUP_FOCUS and _question_needs_widget_values(question))
    scoped_connections = [
        connection
        for connection in connections
        if set(_connection_node_ids(connection)) & node_ids
    ][:connection_limit]
    return {
        "question": question,
        "intent": intent,
        "nodeCount": len(graph["nodes"]),
        "shownNodeCount": len(node_ids),
        "nodes": [
            _compact_prompt_node(
                node,
                include_widget_values=include_values,
                include_all_widget_values=include_all_values,
            )
            for node in graph["nodes"]
            if str(node.get("id")) in node_ids
        ],
        "selectedNodeIds": graph["selectedNodeIds"],
        "actualConnections": scoped_connections,
        "annotations": _list(graph.get("annotations"))[:MAX_ANNOTATIONS] if intent == INTENT_LOOKUP_FOCUS else [],
        "uiAlerts": ui_alerts,
    }


def _build_llm_prompt(question: str, graph: dict[str, Any], *, repair_answer: str = "") -> str:
    intent = graph.get("intent") or INTENT_ANSWER_ONLY
    if intent in {INTENT_ANSWER_ONLY, INTENT_OVERVIEW}:
        schema: dict[str, Any] = {"answer": "direct answer shown in the panel"}
    elif intent == INTENT_DRAW_STEPS:
        schema = {
            "answer": "short panel summary",
            "steps": [{"nodeId": "existing node id", "title": "concise title", "note": "explanation"}],
            "connections": [{"fromNodeId": "id", "fromSlot": "slot", "toNodeId": "id", "toSlot": "slot", "label": "short label"}],
        }
    elif intent == INTENT_DRAW_CONNECTIONS:
        schema = {
            "answer": "short panel summary",
            "connections": [{"fromNodeId": "id", "fromSlot": "existing output slot name", "toNodeId": "id", "toSlot": "existing input slot name", "label": "short reason"}],
        }
    elif intent == INTENT_DRAW_ALL_NODES:
        schema = {
            "answer": "short batch summary",
            "steps": [{"nodeId": "existing node id", "title": "concise title", "note": "what this exact node does"}],
        }
    elif intent == INTENT_LOOKUP_FOCUS:
        schema = {
            "answer": "short panel summary",
            "focus": [{"nodeId": "existing node id", "widget": "optional widget name", "label": "why this node/widget matches"}],
        }
    elif intent == INTENT_DIAGNOSTICS:
        schema = {
            "answer": "short panel summary",
            "focus": [{"nodeId": "existing node id", "widget": "optional widget name", "label": "where the issue is"}],
            "warnings": [{"nodeId": "existing node id", "widget": "optional widget name", "message": "specific issue"}],
        }
    else:
        schema = {"answer": "direct answer shown in the panel"}
    tutorial_extra = ""
    if intent == INTENT_DRAW_STEPS:
        q = _search_text(question)
        overview_like = _matches_any(q, (r"\boverview\b", r"\bsummary\b", r"\bhigh[- ]level\b", r"\b3[- ]?5 stages?\b"))
        build_like = _matches_any(q, (r"\bbuild(?:ing)? order\b", r"\bexecution order\b", r"\bstep by step\b", r"\bdependency order\b", r"\bnumber\b"))
        tutorial_extra = (
            "In draw_steps intent, return only steps and connections needed for the requested visual teaching path. "
            "Use standard ComfyUI roles for known nodes: checkpoint loaders provide MODEL/CLIP/VAE, CLIP Text Encode nodes provide positive/negative CONDITIONING, KSampler is the main sampler, Empty Latent Image provides the starting LATENT, VAE Decode converts LATENT to IMAGE, and Save Image writes the output. "
            "Each step note must describe what the node contributes using only its title, type, widgets, slots, and observed links. "
            "Return connections only when they exist in actualConnections. Do not return focus or warnings. "
        )
        if overview_like:
            tutorial_extra += (
                "Overview map: return 3 to 5 stage steps that summarize the main generation path. "
                "Prefer representative stage nodes over every upstream helper; skip minor parameter nodes, duplicate branches, and side controls unless they define the visible output. "
                "It is acceptable for one stage label to represent a small linked group.\n"
            )
        elif build_like:
            tutorial_extra += (
                "Build order: return a concrete numbered dependency sequence from model/text/image inputs through processing to final output. "
                "Include each node that materially creates or transforms MODEL, CLIP, VAE, CONDITIONING, LATENT, or IMAGE data, but do not add diagnostic side notes. "
                "Do not collapse linked processing nodes into broad stage summaries.\n"
            )
        else:
            tutorial_extra += (
                "Main path: include the ordered upstream path into the final output nodes and keep the visual concise. "
                "Do not include unrelated side controls unless they feed the selected or final path.\n"
            )
    if intent == INTENT_DRAW_ALL_NODES:
        tutorial_extra = (
            "In draw_all_nodes intent, explain every node provided in workflow data. "
            "Return one step for every node id in workflow data and no extra node ids. "
            "Each note must describe what that exact node contributes using its title, type, widgets, slots, and links. "
            "Do not return focus, warnings, or mechanical coverage text such as Covered X/Y.\n"
        )
    connection_extra = ""
    if intent == INTENT_DRAW_CONNECTIONS:
        if _question_asks_connection_suggestion(question):
            connection_extra = (
                "Connection task: suggest how to wire the visible workflow. "
                "Return plausible missing connections using only existing node ids and exact existing slot names. "
                "Prefer matching slot types, left-to-right dataflow, and standard ComfyUI semantics such as MODEL to model, CLIP to clip, CONDITIONING to positive/negative, LATENT to latent/samples, VAE to vae, and IMAGE to images. "
                "If multiple nodes could feed the same input, choose the most semantically likely one and keep the answer brief. "
                "Do not create nodes, widgets, coordinates, or connections to slots that are not listed.\n"
            )
        else:
            connection_extra = (
                "Connection task: show existing workflow links only. "
                "Return connections from actualConnections and do not invent missing links.\n"
            )
    lookup_extra = ""
    if intent == INTENT_LOOKUP_FOCUS:
        lookup_extra = (
            "Lookup task: inspect node type/title, widget names/types, slots, and links. "
            "Workflow nodes list inputs, outputs, and widgets as name:type strings. "
            "The user's words can name a concept, parameter, widget, slot, or node; do not require an exact node title. "
            "Treat singular and plural as equivalent, for example step may match a steps widget or scheduler/sampler step parameter. "
            "Return every relevant node or widget as focus; do not pick only one unless the user clearly asks for one. "
            "If the answer names any node id, that node id must also appear in focus. "
            "For widget targets such as steps, cfg, seed, width, prompt, or denoise, set widget to the matching widget name. "
            "Never return steps, connections, warnings, annotations, or coordinates.\n"
        )
        if repair_answer:
            lookup_extra += (
                "Your previous response was not drawable because focus was empty. "
                f"Previous answer: {_text(repair_answer, 360)!r}. "
                "Return the same answer only if needed, but include a drawable focus array. "
                "If no existing node/widget matches after inspecting workflow data, return focus as [] and say no matching workflow location was found.\n"
            )
    node_count = len(graph.get("nodes", []))
    diagnostics_extra = ""
    if intent == INTENT_DIAGNOSTICS:
        diagnostics_extra = (
            "Diagnostics task: inspect UI alerts, unlinked required inputs, invalid widget values, suspicious settings, and mismatched or missing workflow links. "
            "If workflow data includes uiAlerts, treat them as current ComfyUI warnings/errors visible in the interface. "
            "Do not start any warning or focus label with phrases like 'Current UI alert says', 'UI alert says', or 'ComfyUI reports'; write the actual issue directly. "
            "Widget objects include a value field when ComfyUI exposes a value; values such as 0, 1, 1.00, false, true, and file/model names count as set values. "
            "Never warn that a widget has no visible value, missing value, or unset value when that widget's value field is non-empty. "
            "Never warn that a widget input is unlinked, disconnected, or has no exposed value when that widget has a non-empty value; local widget values are valid fallback settings. "
            "Return warnings only for concrete issues supported by workflow data or uiAlerts.\n"
        )
    if intent in {INTENT_ANSWER_ONLY, INTENT_OVERVIEW}:
        drawing_rule = "This intent is answer-only. Do not return steps, connections, focus, warnings, annotations, or drawing instructions.\n"
    elif intent == INTENT_DRAW_CONNECTIONS and _question_asks_connection_suggestion(question):
        drawing_rule = (
            "This intent may draw only the schema fields listed below. "
            "You may suggest missing links, but only between existing node ids and listed slots.\n"
        )
    else:
        drawing_rule = "This intent may draw only the schema fields listed below. Do not invent node ids or links.\n"
    return (
        "You are ShowMe, a ComfyUI workflow teaching assistant.\n"
        f"User asked: {json.dumps(question, ensure_ascii=True)}\n"
        f"Intent: {intent}.\n"
        f"{drawing_rule}"
        f"This workflow has {node_count} nodes. "
        "Use only the compact workflow data provided. If exact behavior is unclear, say so briefly instead of inventing behavior.\n"
        "Return exactly one JSON object. Do not use markdown. Do not return drawing coordinates.\n"
        "You plan what should be taught; ShowMe will draw using real graph geometry.\n"
        "Only reference node ids, slots, and widgets present in workflow data.\n"
        "When a node has roleHint, use it only as an interpretation aid together with the observed links and slots.\n"
        f"{tutorial_extra}"
        f"{connection_extra}"
        f"{lookup_extra}"
        f"{diagnostics_extra}"
        f"{'Each step title is at most 6 words; each note is at most 20 words. ' if intent in {INTENT_DRAW_STEPS, INTENT_DRAW_ALL_NODES} else ''}"
        f"Schema example: {json.dumps(schema, ensure_ascii=True)}\n\n"
        f"Workflow data: {json.dumps(_compact_workflow(question, graph), ensure_ascii=True)}"
    )


def _build_every_node_batch_prompt(
    question: str,
    graph: dict[str, Any],
    batch_ids: list[str],
    batch_index: int,
    batch_count: int,
    *,
    repair_answer: str = "",
    missing_ids: list[str] | None = None,
) -> str:
    context = _every_node_batch_context(question, graph, batch_ids, batch_index, batch_count)
    schema = {
        "answer": "short summary for this batch",
        "steps": [{"nodeId": "one targetBatchNodeIds id", "title": "concise title", "note": "what this exact node does"}],
    }
    missing_text = f" Missing node ids from the previous response: {json.dumps(missing_ids or [], ensure_ascii=True)}." if missing_ids else ""
    repair_text = ""
    if repair_answer:
        repair_text = (
            "The previous response was incomplete for this batch. "
            f"{missing_text} Previous response: {_text(repair_answer, 800)!r}. "
            "Return the full batch again with one valid step for every targetBatchNodeIds id.\n"
        )
    return (
        "You are ShowMe, a ComfyUI workflow teaching assistant.\n"
        f"User asked: {json.dumps(question, ensure_ascii=True)}\n"
        f"Intent: {INTENT_DRAW_ALL_NODES}. Batch {batch_index}/{batch_count}.\n"
        "Task: explain every target node in this batch, one by one. "
        "Do not summarize the batch as sections. Do not skip any target node. Do not add nodes outside targetBatchNodeIds.\n"
        f"Return exactly {len(batch_ids)} steps, one for each targetBatchNodeIds id, preferably in the listed order. "
        "Each note must explain that exact node using its type, title, widgets, slots, and observed links. "
        "If behavior is unclear, explain what can be inferred from the node metadata instead of omitting it.\n"
        "Return exactly one JSON object. Do not use markdown. Do not return drawing coordinates, focus, warnings, or connections.\n"
        f"{repair_text}"
        "Each step title is at most 6 words; each note is at most 24 words. "
        f"Schema example: {json.dumps(schema, ensure_ascii=True)}\n\n"
        f"Workflow batch data: {json.dumps(context, ensure_ascii=True)}"
    )


def _extract_json_object(text: str) -> Any:
    stripped = text.strip()
    if stripped.startswith("{") and stripped.endswith("}"):
        return json.loads(stripped)
    span = _find_balanced_object(stripped)
    if span is not None:
        return json.loads(span)
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start >= 0 and end > start:
        return json.loads(stripped[start : end + 1])
    raise ValueError("Provider did not return a JSON object")


def _find_balanced_object(text: str) -> str | None:
    depth = 0
    start = -1
    in_string = False
    escape = False
    for index, char in enumerate(text):
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            continue
        if char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}":
            if depth == 0:
                continue
            depth -= 1
            if depth == 0 and start >= 0:
                return text[start : index + 1]
    return None


def _partial_array_items(text: str, key: str) -> list[dict[str, Any]]:
    match = re.search(rf'"{re.escape(key)}"\s*:\s*\[', text)
    if not match:
        return []
    decoder = json.JSONDecoder()
    index = match.end()
    items = []
    while index < len(text):
        while index < len(text) and text[index] in " \r\n\t,":
            index += 1
        if index >= len(text) or text[index] == "]":
            break
        if text[index] != "{":
            index += 1
            continue
        try:
            item, offset = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            break
        if isinstance(item, dict):
            items.append(item)
        index += offset
    return items


def _node_id_exists(graph: dict[str, Any], node_id: Any) -> bool:
    return str(node_id) in _node_by_id(graph)


def _slot_exists(graph: dict[str, Any], node_id: Any, slot_name: str, io: str) -> bool:
    if not slot_name:
        return True
    node = _node_by_id(graph).get(str(node_id))
    if not node:
        return False
    slots = node.get("outputs" if io == "output" else "inputs", [])
    wanted = _norm(slot_name)
    return any(wanted in {_norm(slot.get("name")), _norm(slot.get("type"))} for slot in _list(slots) if isinstance(slot, dict))


def _widget_exists(graph: dict[str, Any], node_id: Any, widget_name: str) -> bool:
    return _resolve_widget_name(graph, node_id, widget_name) is not None


def _node_widget_value(graph: dict[str, Any], node_id: Any, widget_name: str) -> str:
    resolved = _resolve_widget_name(graph, node_id, widget_name)
    if not resolved:
        return ""
    node = _node_by_id(graph).get(str(node_id))
    if not node:
        return ""
    wanted = _norm(resolved)
    for widget in _list(node.get("widgets")):
        if not isinstance(widget, dict):
            continue
        candidates = {_norm(widget.get("name")), _norm(widget.get("type"))}
        if wanted in candidates:
            return _text(widget.get("value"), 120)
    return ""


def _diagnostic_message_mentions_set_widget(graph: dict[str, Any], node_id: Any, message: str) -> bool:
    node = _node_by_id(graph).get(str(node_id))
    if not node:
        return False
    message_terms = _diagnostic_terms_from_parts(message)
    if not message_terms:
        return False
    for widget in _list(node.get("widgets")):
        if not isinstance(widget, dict) or not _text(widget.get("value"), 120):
            continue
        widget_terms = _diagnostic_terms_from_parts(widget.get("name"), widget.get("type"))
        if widget_terms and message_terms & widget_terms:
            return True
    return False


def _clean_diagnostic_message(message: Any) -> str:
    text = _text(message, 180)
    for pattern in DIAGNOSTIC_MESSAGE_PREFIX_PATTERNS:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE).strip()
    if text:
        text = text[0].upper() + text[1:]
    return text


def _diagnostic_terms_from_parts(*parts: Any) -> set[str]:
    terms = set()
    for part in parts:
        for term in _terms(part):
            if len(term) < 3:
                continue
            terms.add(term)
            if len(term) > 3 and term.endswith("s"):
                terms.add(term[:-1])
    return terms


def _diagnostic_graph_term_counts(graph: dict[str, Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for node in graph.get("nodes", []):
        if not isinstance(node, dict):
            continue
        node_terms = _diagnostic_target_terms(graph, node.get("id"))
        for term in node_terms:
            counts[term] = counts.get(term, 0) + 1
    return counts


def _diagnostic_target_terms(graph: dict[str, Any], node_id: Any, widget_name: str = "") -> set[str]:
    node = _node_by_id(graph).get(str(node_id))
    if not node:
        return set()
    parts = [node.get("title"), node.get("type"), widget_name]
    for key in ("inputs", "outputs"):
        for slot in _list(node.get(key)):
            if not isinstance(slot, dict):
                continue
            parts.extend([slot.get("name"), slot.get("type")])
    for widget in _list(node.get("widgets")):
        if not isinstance(widget, dict):
            continue
        parts.extend([widget.get("name"), widget.get("type")])
    return _diagnostic_terms_from_parts(*parts)


def _diagnostic_warning_mentions_target(graph: dict[str, Any], node_id: Any, widget_name: str, message: str) -> bool:
    message_terms = _diagnostic_terms_from_parts(message)
    if not message_terms:
        return True
    target_terms = _diagnostic_target_terms(graph, node_id, widget_name)
    if not target_terms:
        return False
    if message_terms & target_terms:
        return True
    graph_counts = _diagnostic_graph_term_counts(graph)
    graph_mentions = {term for term in message_terms if term in graph_counts}
    return not graph_mentions


def _diagnostic_warning_is_supported(graph: dict[str, Any], node_id: Any, widget_name: str, message: str) -> bool:
    if not _text(message, 180):
        return False
    if not _diagnostic_warning_mentions_target(graph, node_id, widget_name, message):
        return False
    if _matches_any(_search_text(message), DIAGNOSTIC_WIDGET_VALUE_CONTRADICTION_PATTERNS):
        if widget_name and _node_widget_value(graph, node_id, widget_name):
            return False
        if _diagnostic_message_mentions_set_widget(graph, node_id, message):
            return False
    return True


def _diagnostic_message_score(message: str, widget_name: str = "") -> int:
    text = _search_text(message)
    score = min(80, len(text) // 4)
    if widget_name and _norm(widget_name) in text:
        score += 40
    if _matches_any(text, DIAGNOSTIC_GENERIC_MESSAGE_PATTERNS):
        score -= 80
    return score


def _resolve_widget_name(graph: dict[str, Any], node_id: Any, widget_name: str) -> str | None:
    if not widget_name:
        return ""
    node = _node_by_id(graph).get(str(node_id))
    if not node:
        return None
    wanted = _norm(widget_name)
    wanted_stem = wanted[:-1] if wanted.endswith("s") else wanted
    for widget in _list(node.get("widgets")):
        if not isinstance(widget, dict):
            continue
        actual = _text(widget.get("name") or widget.get("type"), 80)
        candidates = {_norm(widget.get("name")), _norm(widget.get("type"))}
        for candidate in candidates:
            candidate_stem = candidate[:-1] if candidate.endswith("s") else candidate
            if wanted == candidate or wanted_stem == candidate_stem:
                return actual
            if wanted and candidate and (wanted in candidate or candidate in wanted):
                return actual
    return None


def _lookup_focus_from_answer(answer: str, graph: dict[str, Any]) -> list[dict[str, Any]]:
    if not answer:
        return []
    nodes = _node_by_id(graph)
    focus = []
    seen = set()
    for match in re.finditer(r"(?:\bid\s*[:#]?\s*|#)(\d+)\b", answer, flags=re.IGNORECASE):
        node_id = match.group(1)
        if node_id not in nodes or node_id in seen:
            continue
        seen.add(node_id)
        focus.append({
            "nodeId": node_id,
            "widget": "",
            "label": _text(answer, 100),
        })
        if len(focus) >= MAX_PLAN_ITEMS:
            break
    return focus


def _normalize_every_node_batch_plan(
    payload: Any,
    graph: dict[str, Any],
    batch_ids: list[str],
    global_start_index: int,
) -> tuple[str, dict[str, Any], list[str]]:
    if not isinstance(payload, dict):
        raise ValueError("Provider did not return a batch plan object")
    nodes = _node_by_id(graph)
    required = [str(node_id) for node_id in batch_ids if str(node_id) in nodes]
    required_set = set(required)
    seen = set()
    plan = _empty_plan()
    for item in _list(payload.get("steps")):
        if not isinstance(item, dict):
            continue
        node_id = str(item.get("nodeId"))
        if node_id not in required_set or node_id in seen:
            continue
        note = _text(item.get("note"), 180)
        if not note:
            continue
        seen.add(node_id)
        local_index = required.index(node_id)
        plan["steps"].append(
            {
                "nodeId": nodes[node_id].get("id"),
                "stepIndex": global_start_index + local_index + 1,
                "title": _text(item.get("title"), 80) or _node_label(nodes[node_id]),
                "note": note,
            }
        )
    missing = [node_id for node_id in required if node_id not in seen]
    return _text(payload.get("answer"), 600), plan, missing


def _normalize_plan(payload: Any, graph: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    if not isinstance(payload, dict):
        raise ValueError("Provider did not return a plan object")
    intent = graph.get("intent") or INTENT_ANSWER_ONLY
    if intent in {INTENT_ANSWER_ONLY, INTENT_OVERVIEW}:
        return _text(payload.get("answer"), 600), _empty_plan()
    plan = _empty_plan()
    item_limit = MAX_NODES if intent == INTENT_DRAW_ALL_NODES else MAX_PLAN_ITEMS
    connection_limit = MAX_DRAW_CONNECTIONS if intent in {INTENT_DRAW_CONNECTIONS, INTENT_DRAW_STEPS} else MAX_PLAN_ITEMS
    seen_step_ids = set()
    if intent in {INTENT_DRAW_STEPS, INTENT_DRAW_ALL_NODES}:
        for item in _list(payload.get("steps"))[:item_limit]:
            if not isinstance(item, dict) or not _node_id_exists(graph, item.get("nodeId")):
                continue
            node_id = str(item.get("nodeId"))
            if node_id in seen_step_ids:
                continue
            seen_step_ids.add(node_id)
            plan["steps"].append(
                {
                    "nodeId": item.get("nodeId"),
                    "title": _text(item.get("title"), 80),
                    "note": _text(item.get("note"), 140),
                }
            )

    if intent in {INTENT_DRAW_CONNECTIONS, INTENT_DRAW_STEPS}:
        for item in _list(payload.get("connections"))[:connection_limit]:
            if not isinstance(item, dict):
                continue
            from_id = item.get("fromNodeId")
            to_id = item.get("toNodeId")
            from_slot = _text(item.get("fromSlot"), 80)
            to_slot = _text(item.get("toSlot"), 80)
            if not (_node_id_exists(graph, from_id) and _node_id_exists(graph, to_id)):
                continue
            if intent == INTENT_DRAW_CONNECTIONS and (not from_slot or not to_slot):
                continue
            if not (_slot_exists(graph, from_id, from_slot, "output") and _slot_exists(graph, to_id, to_slot, "input")):
                continue
            if intent == INTENT_DRAW_STEPS and plan["steps"]:
                step_ids = {str(step.get("nodeId")) for step in plan["steps"]}
                if set(_connection_node_ids(item)) - step_ids:
                    continue
            plan["connections"].append(
                {
                    "fromNodeId": from_id,
                    "fromSlot": from_slot,
                    "toNodeId": to_id,
                    "toSlot": to_slot,
                    "label": _text(item.get("label"), 100),
                }
            )
    answer = _text(payload.get("answer"), 600)
    focus_limit = MAX_PLAN_ITEMS
    for item in _list(payload.get("focus"))[:focus_limit]:
        if not isinstance(item, dict) or not _node_id_exists(graph, item.get("nodeId")):
            continue
        widget = _text(item.get("widget"), 80)
        resolved_widget = _resolve_widget_name(graph, item.get("nodeId"), widget)
        if widget and resolved_widget is None:
            continue
        label = _text(item.get("label"), 100)
        if intent == INTENT_DIAGNOSTICS:
            label = _clean_diagnostic_message(label)
            if not _diagnostic_warning_is_supported(graph, item.get("nodeId"), resolved_widget or "", label):
                continue
        plan["focus"].append(
            {
                "nodeId": item.get("nodeId"),
                "widget": resolved_widget or "",
                "label": label,
            }
        )
    if intent == INTENT_LOOKUP_FOCUS and not plan["focus"]:
        plan["focus"].extend(_lookup_focus_from_answer(answer, graph))
    dropped_diagnostic_warnings = 0
    if intent == INTENT_DIAGNOSTICS:
        warning_by_node: dict[str, tuple[int, dict[str, Any]]] = {}
        for item in _list(payload.get("warnings"))[:MAX_PLAN_ITEMS]:
            if not isinstance(item, dict) or not _node_id_exists(graph, item.get("nodeId")):
                continue
            widget = _text(item.get("widget"), 80)
            if widget and not _widget_exists(graph, item.get("nodeId"), widget):
                continue
            message = _clean_diagnostic_message(item.get("message"))
            if not _diagnostic_warning_is_supported(graph, item.get("nodeId"), widget, message):
                dropped_diagnostic_warnings += 1
                continue
            warning = {
                "nodeId": item.get("nodeId"),
                "widget": widget,
                "message": message,
            }
            node_key = str(item.get("nodeId"))
            score = _diagnostic_message_score(message, widget)
            previous = warning_by_node.get(node_key)
            if previous is None or score > previous[0]:
                warning_by_node[node_key] = (score, warning)
        plan["warnings"] = [entry[1] for entry in warning_by_node.values()]
        warning_node_ids = {str(item.get("nodeId")) for item in plan["warnings"]}
        if warning_node_ids:
            plan["focus"] = [item for item in plan["focus"] if str(item.get("nodeId")) not in warning_node_ids]
        if dropped_diagnostic_warnings and not plan["warnings"]:
            plan["focus"] = []
            answer = "No concrete diagnostics warning was supported by the workflow data."
    return answer, plan


def _lookup_needs_focus_repair(intent: str, plan: dict[str, Any]) -> bool:
    return intent == INTENT_LOOKUP_FOCUS and not _list(plan.get("focus"))


def _command_for_provider(provider: str, model: str = "") -> list[str]:
    if provider == "cli":
        command = os.environ.get("SHOWME_LLM_COMMAND", "").strip()
        if not command:
            raise RuntimeError("SHOWME_LLM_COMMAND is not configured")
        args = shlex.split(command)
        if not args:
            raise RuntimeError("SHOWME_LLM_COMMAND is empty")
        return args

    config = BUILTIN_CLI_PROVIDERS.get(provider)
    if not config:
        raise RuntimeError(f"Unknown provider: {provider}")
    program = _resolve_program(config["programs"])
    if not program:
        raise RuntimeError(f"{config['label']} command was not found")
    args = [program, *config["args"]]
    selected_model = _selected_cli_model(config, model)
    if selected_model and config.get("modelArg"):
        args.extend([config["modelArg"], selected_model])
    if config.get("promptArg"):
        args.append(config["promptArg"])
    return args


def _answer_with_cli(question: str, graph: dict[str, Any], provider: str, model: str = "") -> dict[str, Any]:
    selected_model = _selected_cli_model(BUILTIN_CLI_PROVIDERS[provider], model) if provider in BUILTIN_CLI_PROVIDERS else ""
    args = _command_for_provider(provider, selected_model)
    timeout = _cli_timeout_seconds(provider, graph)
    prompt = _build_llm_prompt(question, graph)
    try:
        proc = subprocess.run(
            args,
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"{provider} timed out after {timeout:g}s") from exc
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "Provider failed").strip()[:MAX_PROVIDER_ERROR_CHARS])
    try:
        answer, plan = _normalize_plan(_extract_json_object(proc.stdout), graph)
    except (json.JSONDecodeError, ValueError) as exc:
        raise RuntimeError(f"{provider} answered, but did not return a ShowMe plan JSON") from exc
    intent = graph.get("intent") or INTENT_ANSWER_ONLY
    if _lookup_needs_focus_repair(intent, plan):
        try:
            proc = subprocess.run(
                args,
                input=_build_llm_prompt(question, graph, repair_answer=answer or proc.stdout),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"{provider} timed out after {timeout:g}s") from exc
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "Provider failed").strip()[:MAX_PROVIDER_ERROR_CHARS])
        try:
            answer, plan = _normalize_plan(_extract_json_object(proc.stdout), graph)
        except (json.JSONDecodeError, ValueError) as exc:
            raise RuntimeError(f"{provider} answered, but did not return a ShowMe plan JSON") from exc
    return _response(answer or "Provider returned a response.", plan, provider, selected_model, intent=intent)


def _ollama_generate(model: str, prompt: str, timeout: float, *, json_mode: bool) -> str:
    request_payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.15},
        "keep_alive": _ollama_keep_alive(),
    }
    if not _ollama_thinking_enabled():
        request_payload["think"] = False
    if json_mode:
        request_payload["format"] = "json"
    payload = _http_json("/api/generate", request_payload, timeout=timeout)
    return _text(payload.get("response"), 10000)


def _ollama_unload_model(model: str) -> None:
    if not model or not _ollama_unload_on_cancel():
        return
    try:
        _http_json(
            "/api/generate",
            {"model": model, "prompt": "", "stream": False, "keep_alive": 0},
            timeout=10.0,
        )
        _debug_log("ollama unload requested", model=model)
    except RuntimeError as exc:
        LOGGER.debug("ShowMe could not unload Ollama model %s: %s", model, exc)


def _answer_with_ollama(question: str, graph: dict[str, Any], model: str) -> dict[str, Any]:
    models = _ollama_models(timeout=3.0)
    model_ids = {item["id"] for item in models}
    if not model:
        model = models[0]["id"] if models else ""
    if not model:
        raise RuntimeError("Ollama has no models. Pull a model first, then reload ShowMe.")
    if model_ids and model not in model_ids:
        raise RuntimeError(f"Ollama model is not available: {model}")

    timeout = _ollama_timeout_seconds()
    prompt = _build_llm_prompt(question, graph)
    try:
        raw_answer = _ollama_generate(model, prompt, timeout, json_mode=True)
        if not raw_answer:
            raw_answer = _ollama_generate(model, prompt, timeout, json_mode=False)
        answer, plan = _normalize_plan(_extract_json_object(raw_answer), graph)
        intent = graph.get("intent") or INTENT_ANSWER_ONLY
        if _lookup_needs_focus_repair(intent, plan):
            repair_prompt = _build_llm_prompt(question, graph, repair_answer=answer or raw_answer)
            raw_answer = _ollama_generate(model, repair_prompt, timeout, json_mode=True)
            if not raw_answer:
                raw_answer = _ollama_generate(model, repair_prompt, timeout, json_mode=False)
            answer, plan = _normalize_plan(_extract_json_object(raw_answer), graph)
    except (json.JSONDecodeError, ValueError) as exc:
        raise RuntimeError("Ollama answered, but did not return a ShowMe plan JSON") from exc
    return _response(answer or "Ollama returned a response.", plan, "ollama", model, intent=intent)


def _local_answer(question: str, graph: dict[str, Any], *, allow_diagnostics: bool = True) -> dict[str, Any] | None:
    return (
        (_local_diagnostics(graph) if allow_diagnostics else None)
        or _local_connections(question, graph)
        or _local_lookup_focus(question, graph)
    )


def _answer(question: str, graph: dict[str, Any], provider: str, model: str) -> dict[str, Any]:
    local = _local_answer(question, graph, allow_diagnostics=not bool(provider))
    if local:
        return local
    if provider == "ollama":
        return _answer_with_ollama(question, graph, model)
    if provider == "cli" or provider in BUILTIN_CLI_PROVIDERS:
        return _answer_with_cli(question, graph, provider, model)
    raise RuntimeError("No AI provider is selected. Choose an available provider or use a graph preset.")


async def _ollama_stream_tokens(model: str, prompt: str, timeout: float, *, json_mode: bool):
    if aiohttp is None:
        raise RuntimeError("aiohttp is unavailable; streaming requires aiohttp.ClientSession")
    payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "stream": True,
        "options": {"temperature": 0.15},
        "keep_alive": _ollama_keep_alive(),
    }
    if not _ollama_thinking_enabled():
        payload["think"] = False
    if json_mode:
        payload["format"] = "json"
    base_url = _ollama_base_url()
    timeout_obj = aiohttp.ClientTimeout(total=timeout)
    completed = False
    try:
        async with aiohttp.ClientSession(timeout=timeout_obj) as session:
            async with session.post(f"{base_url}/api/generate", json=payload) as resp:
                if resp.status != 200:
                    detail = (await resp.text()).strip()[:MAX_PROVIDER_ERROR_CHARS]
                    raise RuntimeError(f"Ollama HTTP {resp.status}: {detail or 'no body'}")
                async for line in resp.content:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    token = chunk.get("response") or ""
                    if token:
                        yield token
                    if chunk.get("done"):
                        completed = True
                        return
    except asyncio.TimeoutError as exc:
        raise RuntimeError(f"Ollama timed out after {timeout:g}s") from exc
    except aiohttp.ClientError as exc:
        raise RuntimeError(f"Ollama request failed at {base_url}: {exc}") from exc
    finally:
        if not completed:
            await asyncio.to_thread(_ollama_unload_model, model)


async def _cli_stream_tokens(args: list[str], prompt: str, timeout: float, label: str):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    process = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stderr_task = asyncio.create_task(_read_limited_stream(process.stderr, MAX_PROVIDER_ERROR_CHARS * 4)) if process.stderr else None
    try:
        if process.stdin is not None:
            try:
                process.stdin.write(prompt.encode("utf-8"))
                await process.stdin.drain()
            finally:
                process.stdin.close()
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                process.kill()
                raise RuntimeError(f"{label} timed out after {timeout:g}s")
            try:
                chunk = await asyncio.wait_for(process.stdout.read(512), timeout=remaining)
            except asyncio.TimeoutError as exc:
                process.kill()
                raise RuntimeError(f"{label} timed out after {timeout:g}s") from exc
            if not chunk:
                break
            yield chunk.decode("utf-8", errors="replace")
        await process.wait()
        stderr_data = await stderr_task if stderr_task else b""
        if process.returncode != 0:
            message = stderr_data.decode("utf-8", errors="replace").strip()[:MAX_PROVIDER_ERROR_CHARS]
            raise RuntimeError(message or f"{label} failed with exit code {process.returncode}")
    finally:
        if process.returncode is None:
            try:
                process.kill()
                await process.wait()
            except (ProcessLookupError, OSError) as exc:
                LOGGER.debug("ShowMe CLI process kill failed: %s", exc)
        if stderr_task and not stderr_task.done():
            try:
                await stderr_task
            except Exception as exc:
                LOGGER.debug("ShowMe CLI stderr drain failed: %s", exc)


async def _read_limited_stream(stream: asyncio.StreamReader | None, limit: int) -> bytes:
    if stream is None:
        return b""
    chunks = []
    total = 0
    while True:
        chunk = await stream.read(512)
        if not chunk:
            break
        if total < limit:
            keep = chunk[:limit - total]
            chunks.append(keep)
            total += len(keep)
    return b"".join(chunks)


async def _collect_ollama_json(model: str, prompt: str, timeout: float) -> tuple[Any, str]:
    buffer = ""
    async for token in _ollama_stream_tokens(model, prompt, timeout, json_mode=True):
        buffer += token
    if not buffer:
        async for token in _ollama_stream_tokens(model, prompt, timeout, json_mode=False):
            buffer += token
    return _extract_json_object(buffer), buffer


async def _collect_cli_json(args: list[str], prompt: str, timeout: float, label: str) -> tuple[Any, str]:
    buffer = ""
    async for chunk in _cli_stream_tokens(args, prompt, timeout, label):
        buffer += chunk
    return _extract_json_object(buffer), buffer


def _every_node_batch_response(
    answer: str,
    plan: dict[str, Any],
    provider: str,
    model: str,
    *,
    batch_index: int,
    batch_count: int,
    node_start: int,
    node_end: int,
    total_nodes: int,
) -> dict[str, Any]:
    result = _response(
        answer or f"Explained nodes {node_start}-{node_end}.",
        plan,
        provider,
        model,
        intent=INTENT_DRAW_ALL_NODES,
        draw_policy="append_batch",
    )
    result.update({
        "batchIndex": batch_index,
        "batchCount": batch_count,
        "nodeStart": node_start,
        "nodeEnd": node_end,
        "totalNodes": total_nodes,
    })
    return result


def _every_node_step_responses(
    answer: str,
    plan: dict[str, Any],
    provider: str,
    model: str,
    *,
    batch_index_start: int,
    total_nodes: int,
) -> list[tuple[int, dict[str, Any]]]:
    responses: list[tuple[int, dict[str, Any]]] = []
    batch_index = batch_index_start
    for step in _list(plan.get("steps")):
        if not isinstance(step, dict):
            continue
        step_plan = _empty_plan()
        step_plan["steps"].append(step)
        batch_index += 1
        step_index = step.get("stepIndex")
        try:
            node_index = max(1, min(total_nodes, int(step_index)))
        except (TypeError, ValueError):
            node_index = min(total_nodes, batch_index)
        responses.append((
            batch_index,
            _every_node_batch_response(
                answer,
                step_plan,
                provider,
                model,
                batch_index=batch_index,
                batch_count=total_nodes,
                node_start=node_index,
                node_end=node_index,
                total_nodes=total_nodes,
            ),
        ))
    return responses


def _plan_has_items(plan: dict[str, Any]) -> bool:
    return any(_list(plan.get(key)) for key in ("steps", "connections", "focus", "warnings"))


def _streamable_plan_keys(intent: str) -> tuple[str, ...]:
    if intent == INTENT_DRAW_CONNECTIONS:
        return ("connections",)
    if intent == INTENT_DRAW_STEPS:
        return ("steps", "connections")
    if intent == INTENT_LOOKUP_FOCUS:
        return ("focus",)
    if intent == INTENT_DIAGNOSTICS:
        return ("focus", "warnings")
    return ()


def _plan_item_signature(item: dict[str, Any]) -> str:
    return json.dumps(item, ensure_ascii=True, sort_keys=True, default=str)


def _new_plan_delta(plan: dict[str, Any], emitted: dict[str, set[str]]) -> dict[str, list[dict[str, Any]]]:
    delta = _empty_plan()
    for key, items in plan.items():
        if key not in delta:
            continue
        emitted_for_key = emitted.setdefault(key, set())
        for item in _list(items):
            if not isinstance(item, dict):
                continue
            signature = _plan_item_signature(item)
            if signature in emitted_for_key:
                continue
            clean_item = dict(item)
            if key == "steps":
                try:
                    step_index = int(clean_item.get("stepIndex"))
                except (TypeError, ValueError):
                    step_index = 0
                if step_index <= 0:
                    clean_item["stepIndex"] = len(emitted_for_key) + 1
            emitted_for_key.add(signature)
            delta[key].append(clean_item)
    return delta


def _incremental_plan_delta(buffer: str, graph: dict[str, Any], emitted: dict[str, set[str]]) -> dict[str, list[dict[str, Any]]]:
    intent = graph.get("intent") or INTENT_ANSWER_ONLY
    delta = _empty_plan()
    for key in _streamable_plan_keys(intent):
        for raw_item in _partial_array_items(buffer, key):
            try:
                _, single_plan = _normalize_plan({key: [raw_item]}, graph)
            except (TypeError, ValueError):
                continue
            next_delta = _new_plan_delta(single_plan, emitted)
            for plan_key, items in next_delta.items():
                delta[plan_key].extend(items)
    return delta


def _stream_plan_batch_response(
    plan: dict[str, Any],
    provider: str,
    model: str,
    intent: str,
    batch_index: int,
) -> dict[str, Any]:
    draw_policy = "overlay" if intent == INTENT_LOOKUP_FOCUS else "append_batch"
    result = _response(
        "Drawing as the provider streams.",
        plan,
        provider,
        model,
        intent=intent,
        draw_policy=draw_policy,
    )
    result["batchIndex"] = batch_index
    return result


def _split_plan_delta(plan: dict[str, Any]) -> list[dict[str, list[dict[str, Any]]]]:
    batches = []
    for key in ("steps", "connections", "focus", "warnings"):
        for item in _list(plan.get(key)):
            batch = _empty_plan()
            batch[key].append(item)
            batches.append(batch)
    return batches


def _every_node_incomplete_error(batch_index: int, batch_count: int, missing_ids: list[str]) -> RuntimeError:
    preview = ", ".join(missing_ids[:12])
    suffix = "..." if len(missing_ids) > 12 else ""
    return RuntimeError(f"Every-node batch {batch_index}/{batch_count} incomplete; missing node ids: {preview}{suffix}")


async def _stream_every_node_batches(question: str, graph: dict[str, Any], provider: str, model: str):
    batches = _every_node_batches(graph)
    total_nodes = sum(len(batch) for batch in batches)
    if not total_nodes:
        yield ("done", _response("No nodes found in this workflow.", _empty_plan(), "local", intent=INTENT_DRAW_ALL_NODES, draw_policy="none"))
        return

    if provider == "ollama":
        models = await asyncio.to_thread(_ollama_models, 3.0)
        model_ids = {item["id"] for item in models}
        chosen = model or (models[0]["id"] if models else "")
        if not chosen:
            raise RuntimeError("Ollama has no models. Pull a model first, then reload ShowMe.")
        if model_ids and chosen not in model_ids:
            raise RuntimeError(f"Ollama model is not available: {chosen}")
        timeout = _ollama_timeout_seconds()
        batch_count = len(batches)
        draw_batch_index = 0
        for batch_index, batch_ids in enumerate(batches, start=1):
            node_start = (batch_index - 1) * EVERY_NODE_BATCH_SIZE + 1
            node_end = node_start + len(batch_ids) - 1
            yield ("status", {"message": f"Explaining nodes {node_start}-{node_end} / {total_nodes} with {chosen}..."})
            prompt = _build_every_node_batch_prompt(question, graph, batch_ids, batch_index, batch_count)
            payload, raw_answer = await _collect_ollama_json(chosen, prompt, timeout)
            answer, plan, missing = _normalize_every_node_batch_plan(payload, graph, batch_ids, node_start - 1)
            if missing:
                yield ("status", {"message": f"Repairing nodes {node_start}-{node_end} / {total_nodes} with {chosen}..."})
                repair_prompt = _build_every_node_batch_prompt(
                    question,
                    graph,
                    batch_ids,
                    batch_index,
                    batch_count,
                    repair_answer=raw_answer,
                    missing_ids=missing,
                )
                payload, raw_answer = await _collect_ollama_json(chosen, repair_prompt, timeout)
            answer, plan, missing = _normalize_every_node_batch_plan(payload, graph, batch_ids, node_start - 1)
            if missing:
                raise _every_node_incomplete_error(batch_index, batch_count, missing)
            for draw_batch_index, response in _every_node_step_responses(
                answer,
                plan,
                "ollama",
                chosen,
                batch_index_start=draw_batch_index,
                total_nodes=total_nodes,
            ):
                yield ("batch", response)
                await asyncio.sleep(0.04)
        yield ("done", _response(f"Explained {total_nodes}/{total_nodes} nodes.", _empty_plan(), "ollama", chosen, intent=INTENT_DRAW_ALL_NODES, draw_policy="none"))
        return

    if provider == "cli" or provider in BUILTIN_CLI_PROVIDERS:
        selected_model = _selected_cli_model(BUILTIN_CLI_PROVIDERS[provider], model) if provider in BUILTIN_CLI_PROVIDERS else ""
        args = _command_for_provider(provider, selected_model)
        timeout = _cli_timeout_seconds(provider, graph)
        label = BUILTIN_CLI_PROVIDERS.get(provider, {}).get("label", provider)
        model_label = f" ({selected_model})" if selected_model else ""
        batch_count = len(batches)
        draw_batch_index = 0
        for batch_index, batch_ids in enumerate(batches, start=1):
            node_start = (batch_index - 1) * EVERY_NODE_BATCH_SIZE + 1
            node_end = node_start + len(batch_ids) - 1
            yield ("status", {"message": f"Explaining nodes {node_start}-{node_end} / {total_nodes} with {label}{model_label}..."})
            prompt = _build_every_node_batch_prompt(question, graph, batch_ids, batch_index, batch_count)
            payload, raw_answer = await _collect_cli_json(args, prompt, timeout, label)
            answer, plan, missing = _normalize_every_node_batch_plan(payload, graph, batch_ids, node_start - 1)
            if missing:
                yield ("status", {"message": f"Repairing nodes {node_start}-{node_end} / {total_nodes} with {label}{model_label}..."})
                repair_prompt = _build_every_node_batch_prompt(
                    question,
                    graph,
                    batch_ids,
                    batch_index,
                    batch_count,
                    repair_answer=raw_answer,
                    missing_ids=missing,
                )
                payload, raw_answer = await _collect_cli_json(args, repair_prompt, timeout, label)
            answer, plan, missing = _normalize_every_node_batch_plan(payload, graph, batch_ids, node_start - 1)
            if missing:
                raise _every_node_incomplete_error(batch_index, batch_count, missing)
            for draw_batch_index, response in _every_node_step_responses(
                answer,
                plan,
                provider,
                selected_model,
                batch_index_start=draw_batch_index,
                total_nodes=total_nodes,
            ):
                yield ("batch", response)
                await asyncio.sleep(0.04)
        yield ("done", _response(f"Explained {total_nodes}/{total_nodes} nodes.", _empty_plan(), provider, selected_model, intent=INTENT_DRAW_ALL_NODES, draw_policy="none"))
        return

    raise RuntimeError("No AI provider is selected. Choose an available provider or use a graph preset.")


async def _stream_token_source(question: str, graph: dict[str, Any], provider: str, model: str):
    intent = graph.get("intent") or INTENT_ANSWER_ONLY
    if intent == INTENT_DRAW_ALL_NODES:
        async for event in _stream_every_node_batches(question, graph, provider, model):
            yield event
        return
    prompt = _build_llm_prompt(question, graph)
    if provider == "ollama":
        models = await asyncio.to_thread(_ollama_models, 3.0)
        model_ids = {item["id"] for item in models}
        chosen = model or (models[0]["id"] if models else "")
        if not chosen:
            raise RuntimeError("Ollama has no models. Pull a model first, then reload ShowMe.")
        if model_ids and chosen not in model_ids:
            raise RuntimeError(f"Ollama model is not available: {chosen}")
        timeout = _ollama_timeout_seconds()
        status_message = f"Inspecting workflow with {chosen}..." if intent == INTENT_LOOKUP_FOCUS else f"Streaming from {chosen}..."
        yield ("status", {"message": status_message})
        buffer = ""
        emitted: dict[str, set[str]] = {}
        batch_index = 0
        async def consume(json_mode: bool):
            nonlocal buffer, batch_index
            last_status_chars = len(buffer)
            async for token in _ollama_stream_tokens(chosen, prompt, timeout, json_mode=json_mode):
                buffer += token
                delta = _incremental_plan_delta(buffer, graph, emitted)
                if _plan_has_items(delta):
                    for delta_batch in _split_plan_delta(delta):
                        batch_index += 1
                        yield ("batch", _stream_plan_batch_response(delta_batch, "ollama", chosen, intent, batch_index))
                        await asyncio.sleep(0.04)
                if intent == INTENT_LOOKUP_FOCUS and len(buffer) - last_status_chars >= 1200:
                    last_status_chars = len(buffer)
                    yield ("status", {"message": f"Inspecting workflow with {chosen}... receiving answer"})

        async for event in consume(json_mode=True):
            yield event
        if not buffer:
            async for event in consume(json_mode=False):
                yield event

        try:
            answer, plan = _normalize_plan(_extract_json_object(buffer), graph)
        except (json.JSONDecodeError, ValueError) as exc:
            raise RuntimeError("Ollama answered, but did not return a ShowMe JSON response") from exc
        final_delta = _new_plan_delta(plan, emitted)
        if _plan_has_items(final_delta):
            for delta_batch in _split_plan_delta(final_delta):
                batch_index += 1
                yield ("batch", _stream_plan_batch_response(delta_batch, "ollama", chosen, intent, batch_index))
                await asyncio.sleep(0.04)
        if _lookup_needs_focus_repair(intent, plan):
            yield ("status", {"message": f"Inspecting workflow with {chosen}... asking for focus"})
            repair_prompt = _build_llm_prompt(question, graph, repair_answer=answer or buffer)
            buffer = ""
            async for token in _ollama_stream_tokens(chosen, repair_prompt, timeout, json_mode=True):
                buffer += token
                delta = _incremental_plan_delta(buffer, graph, emitted)
                if _plan_has_items(delta):
                    for delta_batch in _split_plan_delta(delta):
                        batch_index += 1
                        yield ("batch", _stream_plan_batch_response(delta_batch, "ollama", chosen, intent, batch_index))
                        await asyncio.sleep(0.04)
            if not buffer:
                async for token in _ollama_stream_tokens(chosen, repair_prompt, timeout, json_mode=False):
                    buffer += token
                    delta = _incremental_plan_delta(buffer, graph, emitted)
                    if _plan_has_items(delta):
                        for delta_batch in _split_plan_delta(delta):
                            batch_index += 1
                            yield ("batch", _stream_plan_batch_response(delta_batch, "ollama", chosen, intent, batch_index))
                            await asyncio.sleep(0.04)
            try:
                answer, plan = _normalize_plan(_extract_json_object(buffer), graph)
            except (json.JSONDecodeError, ValueError) as exc:
                raise RuntimeError("Ollama answered, but did not return a ShowMe JSON response") from exc
            final_delta = _new_plan_delta(plan, emitted)
            if _plan_has_items(final_delta):
                for delta_batch in _split_plan_delta(final_delta):
                    batch_index += 1
                    yield ("batch", _stream_plan_batch_response(delta_batch, "ollama", chosen, intent, batch_index))
                    await asyncio.sleep(0.04)
        done_plan = _empty_plan() if batch_index else plan
        done_policy = "none" if batch_index else None
        yield ("done", _response(answer or "Ollama returned a response.", done_plan, "ollama", chosen, intent=intent, draw_policy=done_policy))
        return

    if provider == "cli" or provider in BUILTIN_CLI_PROVIDERS:
        selected_model = _selected_cli_model(BUILTIN_CLI_PROVIDERS[provider], model) if provider in BUILTIN_CLI_PROVIDERS else ""
        args = _command_for_provider(provider, selected_model)
        timeout = _cli_timeout_seconds(provider, graph)
        label = BUILTIN_CLI_PROVIDERS.get(provider, {}).get("label", provider)
        model_label = f" ({selected_model})" if selected_model else ""
        status_message = (
            f"Inspecting workflow with {label}{model_label}..."
            if intent == INTENT_LOOKUP_FOCUS
            else f"Streaming from {label}{model_label}..."
        )
        yield ("status", {"message": status_message})

        buffer = ""
        emitted: dict[str, set[str]] = {}
        batch_index = 0
        last_status_chars = 0
        async for chunk in _cli_stream_tokens(args, prompt, timeout, label):
            buffer += chunk
            delta = _incremental_plan_delta(buffer, graph, emitted)
            if _plan_has_items(delta):
                for delta_batch in _split_plan_delta(delta):
                    batch_index += 1
                    yield ("batch", _stream_plan_batch_response(delta_batch, provider, selected_model, intent, batch_index))
                    await asyncio.sleep(0.04)
            if intent == INTENT_LOOKUP_FOCUS and len(buffer) - last_status_chars >= 1200:
                last_status_chars = len(buffer)
                yield ("status", {"message": f"Inspecting workflow with {label}{model_label}... receiving answer"})

        try:
            answer, plan = _normalize_plan(_extract_json_object(buffer), graph)
        except (json.JSONDecodeError, ValueError) as exc:
            raise RuntimeError(f"{label} answered, but did not return a ShowMe JSON response") from exc
        final_delta = _new_plan_delta(plan, emitted)
        if _plan_has_items(final_delta):
            for delta_batch in _split_plan_delta(final_delta):
                batch_index += 1
                yield ("batch", _stream_plan_batch_response(delta_batch, provider, selected_model, intent, batch_index))
                await asyncio.sleep(0.04)
        if _lookup_needs_focus_repair(intent, plan):
            yield ("status", {"message": f"Inspecting workflow with {label}{model_label}... asking for focus"})
            repair_prompt = _build_llm_prompt(question, graph, repair_answer=answer or buffer)
            buffer = ""
            async for chunk in _cli_stream_tokens(args, repair_prompt, timeout, label):
                buffer += chunk
                delta = _incremental_plan_delta(buffer, graph, emitted)
                if _plan_has_items(delta):
                    for delta_batch in _split_plan_delta(delta):
                        batch_index += 1
                        yield ("batch", _stream_plan_batch_response(delta_batch, provider, selected_model, intent, batch_index))
                        await asyncio.sleep(0.04)
            try:
                answer, plan = _normalize_plan(_extract_json_object(buffer), graph)
            except (json.JSONDecodeError, ValueError) as exc:
                raise RuntimeError(f"{label} answered, but did not return a ShowMe JSON response") from exc
            final_delta = _new_plan_delta(plan, emitted)
            if _plan_has_items(final_delta):
                for delta_batch in _split_plan_delta(final_delta):
                    batch_index += 1
                    yield ("batch", _stream_plan_batch_response(delta_batch, provider, selected_model, intent, batch_index))
                    await asyncio.sleep(0.04)
        done_plan = _empty_plan() if batch_index else plan
        done_policy = "none" if batch_index else None
        yield ("done", _response(answer or "Provider returned a response.", done_plan, provider, selected_model, intent=intent, draw_policy=done_policy))
        return

    raise RuntimeError("No AI provider is selected. Choose an available provider or use a graph preset.")


def _register_routes() -> None:
    if web is None or PromptServer is None or PromptServer.instance is None:
        LOGGER.warning(
            "ShowMe HTTP routes were not registered (PromptServer not ready at import). "
            "/showme/providers, /showme/ask, and /showme/ask/stream will be unavailable."
        )
        return

    @PromptServer.instance.routes.get("/showme/providers")
    async def showme_providers(_request):
        providers = await asyncio.to_thread(_providers)
        return web.json_response({"providers": providers, "askTimeoutMs": _ask_fetch_timeout_ms()})

    @PromptServer.instance.routes.post("/showme/ask")
    async def showme_ask(request):
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"error": "Invalid JSON"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"error": "JSON body must be an object"}, status=400)

        question = _text(body.get("question"), MAX_QUESTION_CHARS)
        if not question:
            return web.json_response({"error": "Question is required"}, status=400)

        mode = _mode(body.get("mode"))
        graph = _sanitize_graph(body.get("graph"), mode)
        intent = _classify_intent(question, mode, graph)
        _set_graph_intent(graph, intent)
        provider = _text(body.get("provider"), 40)
        model = _text(body.get("model"), 160)
        _debug_log(
            "ask request",
            question=question,
            mode=mode,
            intent=intent,
            provider=provider,
            model=model,
            graph=_debug_graph_snapshot(graph),
        )

        try:
            result = await asyncio.to_thread(_answer, question, graph, provider, model)
            _debug_log(
                "ask result",
                provider=result.get("provider"),
                model=result.get("model"),
                answer=_text(result.get("answer"), 600),
                planCounts=_debug_plan_counts(result.get("plan", {})),
                plan=result.get("plan"),
            )
            return web.json_response(result)
        except Exception as exc:
            LOGGER.exception("ShowMe ask failed (mode=%s, provider=%s)", mode, provider)
            _debug_log("ask error", error=str(exc), mode=mode, provider=provider, model=model)
            return web.json_response({"error": _client_error_message(exc)}, status=500)

    @PromptServer.instance.routes.post("/showme/ask/stream")
    async def showme_ask_stream(request):
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"error": "Invalid JSON"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"error": "JSON body must be an object"}, status=400)

        question = _text(body.get("question"), MAX_QUESTION_CHARS)
        if not question:
            return web.json_response({"error": "Question is required"}, status=400)

        mode = _mode(body.get("mode"))
        graph = _sanitize_graph(body.get("graph"), mode)
        intent = _classify_intent(question, mode, graph)
        _set_graph_intent(graph, intent)
        provider = _text(body.get("provider"), 40)
        model = _text(body.get("model"), 160)
        _debug_log(
            "ask stream request",
            question=question,
            mode=mode,
            intent=intent,
            provider=provider,
            model=model,
            graph=_debug_graph_snapshot(graph),
        )

        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )
        await response.prepare(request)

        async def emit(event_type: str, data: dict[str, Any]) -> None:
            payload = json.dumps(data, ensure_ascii=False)
            chunk = f"event: {event_type}\ndata: {payload}\n\n".encode("utf-8")
            await response.write(chunk)

        try:
            local = _local_answer(question, graph, allow_diagnostics=not bool(provider))
            if local:
                await emit("done", local)
                return response
            async for event_type, data in _stream_token_source(question, graph, provider, model):
                await emit(event_type, data)
        except ConnectionResetError:
            _debug_log("ask stream client disconnected", mode=mode, provider=provider, model=model)
            if provider == "ollama":
                await asyncio.to_thread(_ollama_unload_model, model)
        except asyncio.CancelledError:
            _debug_log("ask stream cancelled", mode=mode, provider=provider, model=model)
            if provider == "ollama":
                await asyncio.to_thread(_ollama_unload_model, model)
            raise
        except Exception as exc:
            LOGGER.exception("ShowMe ask stream failed (mode=%s, provider=%s)", mode, provider)
            _debug_log("ask stream error", error=str(exc), mode=mode, provider=provider, model=model)
            try:
                await emit("error", {"error": _client_error_message(exc)})
            except (ConnectionResetError, asyncio.CancelledError):
                pass
        finally:
            try:
                await response.write_eof()
            except (ConnectionResetError, asyncio.CancelledError):
                pass
        return response


_register_routes()
