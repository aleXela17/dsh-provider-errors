# dsh-provider-errors

Readable provider failures for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Providers such as Polza report quota, balance and key problems as raw HTTP
payloads — `402: {...}`, `429: {...}` — and the chat renders that text verbatim.
This plugin listens on the `llm/stream` waterfall, leaves every chunk untouched
except the terminal `finish` chunk, and replaces its `reason.failure.message`
with a short sentence that names the cause and the next step.

Balance and per-key limit failures get their own codes (`PROVIDER_QUOTA`,
`PROVIDER_LIMIT`) on purpose: the chat hides the message for the generic `QUOTA`
code, which would drop the actionable text again.

The mapping is pure — a request never fails because of this plugin — and only
the provider ids listed in `providers` are touched.

## Install

Through the plugin manager, or by hand in `~/.dsh/profiles/desktop/package.json`:

```json
{
  "dependencies": {
    "dsh-provider-errors": "github:aleXela17/dsh-provider-errors"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-provider-errors"]
    }
  }
}
```

then install dependencies (`pnpm install`) and restart DSH.

## Configure

```yaml
- id: provider-errors
  name: dsh-provider-errors
  config:
    providers: [polza]
```

`providers` is optional; without it the plugin covers the provider ids it knows
about. The `id` and `name` have to match the entry, otherwise DSH cannot resolve
the module.

## Notes

- Message text is Russian, because the target user reads Russian. The code,
  ids and structure are language-neutral; a localised variant only needs a
  different map.
- Only the terminal failure chunk is rewritten. Streaming chunks, tool calls and
  successful responses pass through unchanged.
- Known provider error shapes are matched by code first and by message text
  second; anything unrecognised keeps the original message.

## License

MIT
