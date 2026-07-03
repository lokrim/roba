"""Background reasoning model — consults a superior LLM for complex trade-off decisions.

Uses Gemini 2.5 Pro on Vertex AI (same client as the rest of the stack).
Called by VoiceActions.consult_reasoner() via the voice agent's consult_reasoner tool,
and by the daily batch advisor (Forecaster.suggest_day_batches) for structured suggestions.
"""
from __future__ import annotations
import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = (
    "You are an expert restaurant operations advisor. "
    "You receive a specific question from a restaurant manager (via a voice assistant) "
    "and relevant context about current inventory, staff, and menu state. "
    "Your job: give ONE decisive, actionable recommendation in 2-3 sentences that the "
    "voice assistant can read aloud. Be concrete — name specific dishes, ingredients, or "
    "staff actions. Do not hedge with 'it depends' — make a call."
)


def consult(
    question: str,
    context: Optional[str] = None,
    timeout_s: float = 15.0,
) -> Dict[str, Any]:
    """Call the reasoner model and return {recommendation, rationale}.

    Falls back gracefully if Vertex AI is unavailable.
    """
    try:
        from .vertex import build_genai_client, vertex_available
        from .config import GEMINI_REASONER_MODEL

        if not vertex_available():
            return {
                "recommendation": "I'm unable to consult the reasoning model right now — please make the call based on current data.",
                "rationale": "Vertex AI unavailable",
            }

        client = build_genai_client()
        prompt_parts = [f"Question: {question}"]
        if context:
            prompt_parts.append(f"Context:\n{context}")
        prompt_parts.append("Give ONE decisive recommendation (2-3 sentences, concrete, actionable):")
        prompt = "\n\n".join(prompt_parts)

        import concurrent.futures

        def _call():
            return client.models.generate_content(
                model=GEMINI_REASONER_MODEL,
                contents=prompt,
                config={"system_instruction": _SYSTEM_PROMPT, "temperature": 0.3},
            )

        # Run synchronously with timeout (VoiceActions is called via asyncio.to_thread)
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            future = ex.submit(_call)
            try:
                resp = future.result(timeout=timeout_s)
            except concurrent.futures.TimeoutError:
                return {
                    "recommendation": "The reasoning model timed out — please decide based on current data.",
                    "rationale": "timeout",
                }

        text = ""
        if resp and resp.text:
            text = str(resp.text).strip()
        if not text:
            return {
                "recommendation": "No recommendation could be generated — please decide based on current data.",
                "rationale": "empty_response",
            }

        return {"recommendation": text, "rationale": "gemini_2.5_pro"}
    except Exception as exc:  # noqa: BLE001
        logger.warning("consult_reasoner failed: %s", exc)
        return {
            "recommendation": "I hit an error consulting the reasoning model. Please decide based on the available data.",
            "rationale": str(exc),
        }


_BATCH_ADVISOR_SYSTEM = """\
You are an expert restaurant operations AI for a simulation environment.

Your job is to analyse today's batch cook schedule and identify REAL opportunities
to improve profitability or cut waste — such as adding a missing peak-hour batch,
changing a batch time to match demand, or adjusting quantities.

Rules:
- ONLY suggest changes when there is a clear, quantifiable opportunity (cost saving,
  revenue gain, or waste reduction). If the current schedule is already optimal, return
  an empty proposals list.
- Do NOT suggest trivial or cosmetic changes.
- For each proposal include: type, menu_item_id, dish_name, target_window_start (sim-seconds),
  target_qty (integer), forecast_demand (number expected in that window),
  projected_benefit_description (concrete £/unit estimate where possible), and reasoning.
- proposal types: "add_batch" | "retime" | "requantify"
- Return valid JSON only. No markdown fences, no prose outside the JSON.
"""

_BATCH_ADVISOR_SCHEMA = {
    "type": "object",
    "properties": {
        "proposals": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["add_batch", "retime", "requantify"]},
                    "menu_item_id": {"type": "integer"},
                    "dish_name": {"type": "string"},
                    "target_window_start": {"type": "number"},
                    "target_qty": {"type": "integer"},
                    "current_qty": {"type": "integer"},
                    "forecast_demand": {"type": "number"},
                    "projected_benefit_description": {"type": "string"},
                    "reasoning": {"type": "string"},
                },
                "required": ["type", "menu_item_id", "dish_name", "target_window_start",
                             "target_qty", "forecast_demand", "projected_benefit_description", "reasoning"],
            },
        },
        "schedule_assessment": {"type": "string"},
    },
    "required": ["proposals"],
}


def suggest_batch_changes(
    context: Dict[str, Any],
    timeout_s: float = 30.0,
) -> Dict[str, Any]:
    """Ask Gemini 2.5 Pro to analyse today's batch schedule and propose changes.

    Returns a dict with keys:
        proposals: list of proposal dicts (may be empty if schedule is optimal)
        schedule_assessment: brief prose summary
        source: "gemini_2.5_pro" | "vertex_unavailable" | "error"

    Designed to be called via asyncio.to_thread from async code.
    """
    try:
        from .vertex import build_genai_client, vertex_available
        from .config import GEMINI_REASONER_MODEL

        if not vertex_available():
            logger.info("suggest_batch_changes: Vertex AI unavailable, skipping")
            return {"proposals": [], "schedule_assessment": "Vertex AI unavailable.", "source": "vertex_unavailable"}

        client = build_genai_client()
        prompt = (
            "Analyse the following restaurant batch schedule and demand context. "
            "Return your proposals as JSON matching the required schema.\n\n"
            f"Context:\n{json.dumps(context, indent=2, default=str)}"
        )

        import concurrent.futures

        def _call():
            return client.models.generate_content(
                model=GEMINI_REASONER_MODEL,
                contents=prompt,
                config={
                    "system_instruction": _BATCH_ADVISOR_SYSTEM,
                    "temperature": 0.2,
                    "response_mime_type": "application/json",
                    "response_schema": _BATCH_ADVISOR_SCHEMA,
                },
            )

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            future = ex.submit(_call)
            try:
                resp = future.result(timeout=timeout_s)
            except concurrent.futures.TimeoutError:
                logger.warning("suggest_batch_changes: LLM timed out")
                return {"proposals": [], "schedule_assessment": "Reasoning model timed out.", "source": "timeout"}

        if not resp or not resp.text:
            return {"proposals": [], "schedule_assessment": "Empty response.", "source": "empty"}

        try:
            data = json.loads(resp.text)
        except json.JSONDecodeError:
            logger.warning("suggest_batch_changes: non-JSON response: %s", resp.text[:200])
            return {"proposals": [], "schedule_assessment": "Could not parse response.", "source": "parse_error"}

        data.setdefault("proposals", [])
        data.setdefault("schedule_assessment", "")
        data["source"] = "gemini_2.5_pro"
        return data

    except Exception as exc:  # noqa: BLE001
        logger.warning("suggest_batch_changes failed: %s", exc)
        return {"proposals": [], "schedule_assessment": str(exc), "source": "error"}
