"""What each provider tells us about MCP (tool-server) calls, and what it does not. Checked against each provider's own
documentation on 2026-11-18; the sources are listed so a change can be re-checked. This is a fact table, not a judgement:
where a provider documents nothing we could read, the answer is "unknown", never a guess.

Two things are kept apart everywhere:
  * provider-reported: the provider's own response names the MCP server (Anthropic `mcp_tool_use.server_name`, OpenAI
    `mcp_call.server_label`). That is certain.
  * likely MCP: only the tool's NAME looks like `mcp__server__tool`. Any app can name a tool that way and a real MCP tool
    can be named anything, so this is a hint, and is always labelled "likely".

No provider reports tokens per tool or per server: each reports one usage total for the whole request. So no figure here is
"the tokens this tool used". Request-level totals are shown as that: the usage of the requests that made the call, shared
with everything else in them.
"""

from __future__ import annotations

from dataclasses import dataclass

CHECKED_ON = "2026-11-18"


@dataclass(frozen=True)
class Support:
    key: str
    label: str
    provider_names: frozenset[str]  # what `runs.provider` holds for calls served by this provider itself
    native: str  # supported | partly | unknown
    we_read: tuple[str, ...]
    we_do_not_read: tuple[str, ...]
    not_reported_by_provider: tuple[str, ...]
    limits: tuple[str, ...]
    sources: tuple[str, ...]


SUPPORT: tuple[Support, ...] = (
    Support(
        key="anthropic", label="Anthropic", provider_names=frozenset({"anthropic"}), native="supported",
        we_read=("`mcp_tool_use` blocks: the server's name and the tool's name", "`mcp_tool_result.is_error`, to mark a failed call"),
        we_do_not_read=("`mcp_tool_listing` blocks (the tools a server offered, in the 2026-09-15 beta): not recorded yet, "
                        "so the size of each server's tool list is unknown",),
        not_reported_by_provider=("tokens per tool or per server: the response has one `usage` object for the whole request",),
        limits=("The MCP connector is a beta (`mcp-client-2025-11-20`, `mcp-client-2026-09-15`).",
                "The token-counting endpoint returns an error for requests that use the MCP connector, so the size of such a "
                "request cannot be checked before it is sent; only the response's usage reports it."),
        sources=("https://platform.claude.com/docs/en/agents-and-tools/mcp-connector",
                 "https://platform.claude.com/docs/en/build-with-claude/token-counting"),
    ),
    Support(
        key="openai", label="OpenAI", provider_names=frozenset({"openai"}), native="supported",
        we_read=("`mcp_call` output items: the server's label, the tool's name and whether it failed",),
        we_do_not_read=("`mcp_list_tools` items (the tools a server offered): not recorded yet, so the size of each server's "
                        "tool list is unknown", "`mcp_approval_request` items: they are requests, not calls"),
        not_reported_by_provider=("tokens per tool or per server: only the response's usage totals are reported",),
        limits=("The MCP tool is in the Responses API. The page's usage notes give 1,000 requests a minute on the Build tier "
                "and 2,000 on Launch and Grow.",
                "The page notes a server with dozens of tools can add cost and latency, and suggests `allowed_tools` or deferred "
                "loading to reduce it; it states no per-tool figure."),
        sources=("https://developers.openai.com/api/docs/guides/tools-connectors-mcp",),
    ),
    Support(
        key="google", label="Google (Gemini)", provider_names=frozenset({"gemini", "google"}), native="unknown",
        we_read=("`functionCall` parts of generateContent answers: a plain tool name. MCP is recognised only if the name carries "
                 "the server (`mcp__server__tool`), and is then labelled likely",),
        we_do_not_read=("Interactions API steps, where Remote MCP (`mcp_server` tools) is documented: not recorded yet",),
        not_reported_by_provider=("tokens per tool or per server",
                                  "On the pages checked, a response shape for MCP calls and any per-tool usage are not documented, "
                                  "so they are unknown, not assumed"),
        limits=("Remote MCP is documented for the Interactions API only, over Streamable HTTP; SSE servers are not supported, "
                "and a server name should not contain `-`.",),
        sources=("https://ai.google.dev/gemini-api/docs/function-calling",),
    ),
)
BY_NAME = {name: s for s in SUPPORT for name in s.provider_names}


def support_for(provider: str | None) -> Support | None:
    return BY_NAME.get((provider or "").lower())
