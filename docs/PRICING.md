# Pricing

## Which models ship with prices

Pricing is versioned data (`src/pricing/tables/`), one file per provider, each keeping its
own capture date:

| Table                  | Models                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `anthropic-2026-10-23` | Fable 5.1 / 5, Mythos 5.1 / 5, Opus 5.5 / 5 / 4.8 / 4.7 / 4.6, Sonnet 5.5 / 5 / 4.6, Haiku 5.5 / 4.5 |
| `openai-2026-09-16`    | gpt-6-astra, gpt-5.6-sol / terra / luna / cyber                                                      |

Haiku 5.5 has two rate cards: a request whose prompt (input, cache reads and cache writes
together) is over 100,000 tokens pays 5× the short-prompt rates. Each stored turn is one
request, so each is priced on its own prompt.

They are composed into one table, reported by `ai-usage status` as `builtin-<date>` with
every provider's provenance behind it. Two tables may not price the same model id — that
raises an error at build time rather than silently applying one vendor's rates to another's
tokens.

A Claude model released after that capture date is normally priced within a day anyway --
see the next section. Anything that neither covers has no estimate, and the reports say so
explicitly rather than showing `$0`. Add it yourself with an override.

## New models are priced automatically

A pricing table captured on one date cannot price a model released on the next, so every
Claude Code turn on a new model used to report its cost as unavailable until a release caught
up. Now the MCP server downloads [LiteLLM's community price
list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) in
the background, at most once a day, and uses it for the Claude models the built-in table does
not have yet:

- **It only fills gaps.** A model the built-in table prices keeps the built-in price; the
  community list never changes a number this package ships.
- **It takes a model only if every rate is there** -- input, output, cache read, both
  cache-write TTLs. A missing rate is not borrowed from a default, because newer models are
  exactly where the defaults go wrong (Opus 5.5 reads cache at 0.05×, not 0.1×). A model
  with a long-context price tier is left unpriced: what LiteLLM counts as the prompt for its
  tier is not documented, and a built-in table or your override states it explicitly.
- **It is labelled.** Estimates it contributes to cite a table version like
  `builtin-2026-09-26+litellm-2026-10-02`, and `ai-usage status` lists the models it priced:

  ```text
  Pricing table:  builtin-2026-09-26+litellm-2026-10-02  (Anthropic first-party ...; plus 1 model(s) ...)
    Community:     1 model(s) the built-in tables lack, from LiteLLM's price list fetched 2026-10-02: claude-opus-6
  ```

- **Earlier turns are priced too.** Records stored as unavailable before a price existed are
  priced as soon as one does -- from the community list, a release, or your own override --
  on the next sync, with no `sync --full` needed. Only `unavailable` records change; a cost a
  client reported itself is never touched.

It is one plain GET of a public ~3 MB file, carrying no usage data and no identifier. The
converted prices are cached in `<config dir>/pricing-community.json`; a failed download keeps
the previous copy. The CLI's `ai-usage sync` refreshes it as well. Turn it off with
`AI_USAGE_NO_PRICING_REFRESH=1` (or `AI_USAGE_NO_UPDATE_CHECK=1`, which turns off both network
requests); prices are then exactly the built-in tables plus your override.
`AI_USAGE_PRICING_URL` points it at a mirror.

The OpenAI numbers are the **Standard tier, short context** rates. OpenAI also publishes
long-context, Batch, Flex and Fast-mode rates, and nothing in a stored record says which
applied — so a long-context turn is _understated_ rather than guessed at. Providers whose
published pricing this table cannot express exactly (DeepSeek, for instance, bills different
rates at peak and off-peak hours) are deliberately not shipped; supply them yourself, with
whichever rate is true for you.

## Adding or correcting prices yourself

Drop a JSON file at:

```text
~/.config/ai-usage-mcp/pricing.json      # or $AI_USAGE_PRICING_FILE
```

It is **overlaid onto the built-in table**, keyed by model id — so adding one model keeps
every built-in price. (Before 0.8.0 it replaced the table wholesale, which meant the only
way to add a missing provider was to lose every price you already had.)

```jsonc
{
  // Required. Names YOUR table; this is the string reports will cite.
  "version": "my-prices-2026-09-16",

  // Optional. Shown by `ai-usage status`, with the built-in provenance appended.
  "provenance": "DeepSeek off-peak list pricing, captured 2026-09-16",

  // Optional. The default cache rates for models that do not carry their own.
  // Omit to inherit the built-in defaults (read 0.1, write5m 1.25, write1h 2.0).
  "cacheMultipliers": { "read": 0.1, "write5m": 1.25, "write1h": 2.0 },

  // Required. Keyed by the model id EXACTLY as your client records it --
  // `ai-usage models` lists the ids actually present in your database.
  "models": {
    "deepseek-v4-pro": {
      "input": 0.66, // USD per 1,000,000 input tokens
      "output": 1.98, // USD per 1,000,000 output tokens

      // Optional: premium rates, applied when the source recorded `speed: "fast"`.
      // Only Claude Code records a speed at all.
      "fast": { "input": 1.32, "output": 3.96 },

      // Optional: cache rates for THIS model, when the provider's differ from the
      // table default. DeepSeek's cache-hit rate is 0.02x its input rate, not 0.1x.
      "cache": { "read": 0.0333, "write5m": 1.0, "write1h": 1.0 },

      // Optional: a second rate card for a request whose prompt (input + cache
      // read + cache write) is OVER aboveTokens. The cache multipliers apply to
      // whichever input rate the request gets. Fast-mode rates ignore it.
      "longContext": { "aboveTokens": 200000, "input": 1.32, "output": 3.96 },
    },
  },
}
```

**Units.** `input` and `output` are USD **per 1,000,000 tokens** — the same unit every
provider's pricing page publishes, so you can copy the number straight across. The three
`cache*` values are **multipliers of that model's input rate**, not prices: `read: 0.1`
means a cache read costs a tenth of an input token. If your provider publishes an absolute
cached-input price, divide it by the input price to get the multiplier.

**What is required.** `version` and `models`; within each model, `input` and `output`.
Everything else is optional. `currency` and `unit` are ignored if present — USD per million
tokens is the only supported combination, and accepting a value that does nothing would be
worse than ignoring it.

**Replacing rather than overlaying.** Set `"replace": true` to discard the built-in table
entirely. That form additionally _requires_ `cacheMultipliers.{read,write5m,write1h}`,
because there is no built-in default left to inherit.

An override entry replaces that model's price **wholesale**, not field by field: if the
built-in entry has `fast` rates and yours does not, the model has no fast rates. A
half-inherited price is a figure nobody could reason about.

A malformed override **raises an error naming the offending field** rather than silently
falling back — quietly using different prices than you think are in effect would be worse
than failing:

```text
Pricing override at /home/you/.config/ai-usage-mcp/pricing.json is invalid:
models["deepseek-v4-pro"].output must be a number >= 0 (USD per 1,000,000 tokens).
```

For the same reason, an `AI_USAGE_PRICING_FILE` that points at a file which does not exist is
an error, not a fallback to built-in prices — otherwise a typo in the path would look exactly
like the override working. Only the default `~/.config/ai-usage-mcp/pricing.json` may be
absent, because not having one is the normal case.

`ai-usage status` always shows which table is in force, and whether it is built-in, an
overlay, or a full replacement.
