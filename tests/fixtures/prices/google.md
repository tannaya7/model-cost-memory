> ## AI Agent Context
> - Full documentation index: https://aistudio.google.com/llms.txt
> - Gemini Docs MCP server (consistent live info): https://gemini-api-docs-mcp.dev
> - Coding agent skills & setup guide: https://aistudio.google.com/docs/coding-agents.md

# Gemini Developer API pricing

Start building free of charge with generous limits, then scale up with prepaid
and pay-as-you-go pricing for your production-ready applications. To compare reasoning depth, speed, and cost trade-offs across models, see [Choosing a model](/docs/choosing-a-model).

{% card-grid %}
  {% card title="Free" %}

## Gemini 4 Hydrogen  {% id="gemini-4-hydrogen" %}

{% two-column-layout %}
  {% left-column class="center-vertically" %}
  *[`gemini-4-hydrogen`](/docs/models/gemini-4-hydrogen)*

  {% /left-column %}

  {% right-column class="center-vertically right-align" %}
  {% button href="https://aistudio.google.com/prompts/new_chat?model=gemini-4-hydrogen" variant="ais" %}
  Try it in Google AI Studio

  {% /button %}

  {% /right-column %}

{% /two-column-layout %}

{% hr /%}

Brings cutting-edge intelligence to everyone, with speed and efficiency for
everyday coding and agentic workflows, featuring a unified 1M-token context
window and long-decode generation up to 1M tokens.

{% callout type="note" %}
  Every token the model processes is counted and billed, including thinking tokens and internal tool system instructions and function declarations when using grounding.

{% /callout %}

{% tabs %}
  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Free of charge
  * $1.50

  ---

  * Output price (including thinking tokens)
  * Free of charge
  * $7.50

  ---

  * Context caching price
  * Free of charge
  * $0.075   
  Implicit caching only (explicit caching is not supported).

  ---

  * Grounding with Google Search{% sup %}*{% /sup %}
  * Not available
  * 5,000 free search requests per month (shared across all Gemini 3 and newer models),
  then $14 per 1,000 requests (subject to a [daily cap](/docs/pricing#pricing-for-tools) of 1,500 requests per day).

  ---

  * Grounding with Google Maps
  * Not available
  * 5,000 requests per month (free, shared across all Gemini 3 and newer models), then $14 / 1,000
  search queries.

  ---

  * Used to improve our products
  * [Yes](/docs/terms)
  * [No](/docs/terms)
  {% /table %}

  {% sup %}*{% /sup %} A customer-submitted request to Gemini may result in one or
    more queries to Google Search. You will be charged for each individual search
    query performed.
    

  {% /tab %}

  {% tab title="Batch" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Not available
  * $0.75

  ---

  * Output price (including thinking tokens)
  * Not available
  * $3.75

  ---

  * Context caching price
  * Not available
  * $0.0375   
  Implicit caching only (explicit caching is not supported).

  ---

  * Used to improve our products
  * [Yes](/docs/terms)
  * [No](/docs/terms)
  {% /table %}

  {% /tab %}

  {% tab title="Flex" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Not available
  * $0.75

  ---

  * Output price (including thinking tokens)
  * Not available
  * $3.75

  ---

  * Context caching price
  * Not available
  * $0.0375   
  Implicit caching only (explicit caching is not supported).

  ---

  * Used to improve our products
  * [Yes](/docs/terms)
  * [No](/docs/terms)
  {% /table %}

  {% /tab %}

  {% tab title="Priority" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Free of charge
  * $2.70

  ---

  * Output price (including thinking tokens)
  * Free of charge
  * $13.50

  ---

  * Context caching price
  * Free of charge
  * $0.135   
  Implicit caching only (explicit caching is not supported).

  ---

  * Grounding with Google Search{% sup %}*{% /sup %}
  * Not available
  * 5,000 free search requests per month (shared across all Gemini 3 and newer models),
  then $14 per 1,000 requests (subject to a [daily cap](/docs/pricing#pricing-for-tools) of 1,500 requests per day).

  ---

  * Grounding with Google Maps
  * Not available
  * 5,000 requests per month (free, shared across all Gemini 3 and newer models), then $14 / 1,000
  search queries.

  ---

  * Used to improve our products
  * [Yes](/docs/terms)
  * [No](/docs/terms)
  {% /table %}

  {% sup %}*{% /sup %} A customer-submitted request to Gemini may result in one or
    more queries to Google Search. You will be charged for each individual search
    query performed.
    

  {% /tab %}

  {% tab title="Contributor" %}
  {% callout type="note" %}
  The Gemini API Contributor Tier is offered as a private preview on an
      invite-only basis. Speed and reliability are equivalent to
      [Standard Tier inference](/docs/optimization). Eligible users will be invited by
      email and see a callout in AI Studio.

  {% /callout %}

  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD{% sup %}*{% /sup %}

  ---

  * Input price
  * Free of charge
  * $0.75

  ---

  * Output price (including thinking tokens)
  * Free of charge
  * $3.75

  ---

  * Context caching price
  * Free of charge
  * $0.0375   
  Implicit caching only (explicit caching is not supported).

  ---

  * Used to improve our products
  * [Yes](/docs/terms)
  * [Yes](/docs/logs-policy#contributor-tier)
  {% /table %}

  {% sup %}*{% /sup %} Discounts and model availability are subject to change.
    

  {% /tab %}

{% /tabs %}


## Gemini 3.8 Flash  {% id="gemini-3.8-flash" %}

{% two-column-layout %}
  {% left-column class="center-vertically" %}
  *[`gemini-3.8-flash`](/docs/models/gemini-3.8-flash)*

  {% /left-column %}

  {% right-column class="center-vertically right-align" %}
  {% button href="https://aistudio.google.com/prompts/new_chat?model=gemini-3.8-flash" variant="ais" %}
  Try it in Google AI Studio

  {% /button %}

  {% /right-column %}

{% /two-column-layout %}

{% hr /%}

Our most intelligent Flash model, engineered for long-horizon software
engineering, autonomous agents, and complex enterprise workflows.

{% tabs %}
  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Free of charge
  * $0.75 through December 31, 2026.   
  $1.50 starting January 1, 2027.

  ---

  * Output price (including thinking tokens)
  * Free of charge
  * $3.75 through December 31, 2026.   
  $7.50 starting January 1, 2027.

  ---

  * Context caching price
  * Free of charge
  * $0.075 through December 31, 2026.   
  $0.15 starting January 1, 2027.   
  $0.50 / 1,000,000 tokens per hour (storage price) through December 31, 2026.   
  $1.00 / 1,000,000 tokens per hour (storage price) starting January 1, 2027.

  ---

  * Grounding with Google Search
  * Not available
  * 5,000 free search requests per month (shared across all Gemini 3 and newer models),
  then $14 per 1,000 requests (subject to a [daily cap](/docs/pricing#pricing-for-tools) of 1,500 requests per day).

  ---

  * Grounding with Google Maps
  * Not available
  * 5,000 requests per month (free, shared across all Gemini 3 and newer models), then $14 / 1,000
  search queries.

  ---

  * Used to improve our products
  * [Yes](/docs/terms)
  * [No](/docs/terms)
  {% /table %}

  {% /tab %}

  {% tab title="Batch" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Not available
  * $0.375 through December 31, 2026.   
  $0.75 starting January 1, 2027.

  ---

  * Output price (including thinking tokens)
  * Not available
  * $1.875 through December 31, 2026.   
  $3.75 starting January 1, 2027.

  ---

  * Context caching price
  * Not available
  * $0.0375 through December 31, 2026.   
  $0.075 starting January 1, 2027.   
  $0.50 / 1,000,000 tokens per hour (storage price) through December 31, 2026.   
  $1.00 / 1,000,000 tokens per hour (storage price) starting January 1, 2027.

  ---

  * Used to improve our products
  * [Yes](/docs/terms)
  * [No](/docs/terms)
  {% /table %}

  {% /tab %}

  {% tab title="Flex" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Not available
  * $0.375 through December 31, 2026.   
  $0.75 starting January 1, 2027.

  ---

  * Output price (including thinking tokens)
  * Not available
  * $1.875 through December 31, 2026.   
  $3.75 starting January 1, 2027.

  ---

  * Context caching price
  * Not available
  * $0.0375 through December 31, 2026.   
  $0.075 starting January 1, 2027.   
  $0.50 / 1,000,000 tokens per hour (storage price) through December 31, 2026.   
  $1.00 / 1,000,000 tokens per hour (storage price) starting January 1, 2027.

  ---

  * Used to improve our products
  * [Yes](/docs/terms)
  * [No](/docs/terms)
  {% /table %}

  {% /tab %}

  {% tab title="Priority" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Free of charge
  * $1.35 through December 31, 2026.   
  $2.70 starting January 1, 2027.

  ---

  * Output price (including thinking tokens)
  * Free of charge
  * $6.75 through December 31, 2026.   
  $13.50 starting January 1, 2027.

  ---

  * Context caching price
  * Free of charge
  * $0.135 through December 31, 2026.   
  $0.27 starting January 1, 2027.   
  $0.50 / 1,000,000 tokens per hour (storage price) through December 31, 2026.   
  $1.00 / 1,000,000 tokens per hour (storage price) starting January 1, 2027.

  ---

  * Grounding with Google Search{% sup %}*{% /sup %}
  * Not available{% sup %}**{% /sup %}
  * 5,000 free search requests per month (shared across all Gemini 3 and newer models),
  then $14 per 1,000 requests (subject to a [daily cap](/docs/pricing#pricing-for-tools) of 1,500 requests per day).

  ---

  * Grounding with Google Maps
  * Not available{% sup %}**{% /sup %}
  * 5,000 requests per month (free, shared across all Gemini 3 and newer models), then $14 / 1,000
  search queries.

  ---

  * Used to improve our products
  * [Yes](/docs/terms)
  * [No](/docs/terms)
  {% /table %}

  {% /tab %}

{% /tabs %}


## Gemini 3.5 Transcribe  {% id="gemini-3.5-transcribe" %}

{% two-column-layout %}
  {% left-column %}
  *[`gemini-3.5-transcribe`](/docs/models/gemini-3.5-transcribe)*

  {% /left-column %}

  {% right-column class="center-vertically right-align" %}
  {% button href="https://aistudio.google.com?model=gemini-3.5-transcribe" variant="ais" %}
  Try it in Google AI Studio

  {% /button %}

  {% /right-column %}

{% /two-column-layout %}

{% hr /%}

Our speech-to-text model with automatic language detection, speaker diarization,
word-level timestamps, and custom vocabulary biasing.

{% tabs %}
  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Free of charge
  * $2.00 or $0.003/min{% sup %}*{% /sup %} (audio)

  ---

  * Output price (including thinking tokens)
  * Free of charge
  * $12.00 or $0.002/min{% sup %}*{% /sup %} (text)

  ---

  * Grounding with Google Search
  * Not Supported
  * 

  ---

  * Used to improve our products
  * [Yes](/docs/terms)
  * [No](/docs/terms)
  {% /table %}

  {% /tab %}

{% /tabs %}

{% sup %}*{% /sup %} Estimated pricing is based on 25 audio tokens per second
for input and 175 text tokens per minute for output, for an effective blended
rate of ~$0.005 per min for Transcribe.


## Gemini Imaginary  {% id="gemini-imaginary" %}

No pricing tab here.
