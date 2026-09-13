# Featherless text-tool bridge

This compatibility extension is scoped to
`featherless/OBLITERATUS/Qwen3.8-27B-OBLITERATED`. It compensates for the live
Featherless endpoint returning tool requests as ordinary text instead of native
OpenAI `tool_calls` objects.

The bridge converts a response only when all of these conditions hold:

- the provider and model match exactly
- the response completed normally and contains one text block
- one bounded response form contains one JSON object with exactly `tool` and
  `args`: bare JSON, the suffix after `</think>`, one matched `<tool_call>`
  wrapper, or one or more brace-free prose paragraphs followed by one JSON
  paragraph;
- `tool` is currently active in Pi
- `args` is an object without prototype-polluting keys.

Pi still performs its normal tool-schema validation and all configured
`tool_call` safety checks before execution. Markdown fences, unknown tools,
malformed arguments, extra envelope fields, and prose that does not end in one
accepted envelope remain ordinary text and are never executed.

One additional learnt model form is accepted only for `bash`: a single exact
`<tool_call><bash><parameter=command>…` structure with its 3 required
closing tags. It cannot name another tool or add another parameter, and the
resulting command still passes through bash-guard.

The bridge also accepts the observed generic form
`<tool_call><function=NAME><parameter=args>{…}</function></tool_call>`. `NAME`
must be one currently active tool and the parameter body must be exactly one
JSON object. Unknown tools, arrays, duplicate parameters, mismatched closers
and prototype-polluting keys are rejected.

For the observed leaf-argument variant, a function may instead contain one or
more complete `<ARG>plain text</ARG>` pairs. Argument names must be unique and
safe, values cannot contain nested tags, and Pi's tool schema decides whether
the resulting string values are valid for that tool.

The observed compact equivalent `<tool_call><NAME>{…}</NAME>` is accepted with
or without the final outer closer only at end of response. The opening and
closing tool names must match, and the same active-tool and argument checks
apply.

The parser also recognises one fixed legacy closer sequence and one observed
end-of-response variant containing an opening `<tool_call>` followed by exactly
one JSON envelope. Extra or repeated closers, trailing content and a missing
opening tag are not accepted.

For this exact provider/model, the extension removes OpenAI-native `tools`,
`tool_choice` and `parallel_tool_calls` fields from the outgoing payload. The
active schemas are supplied in the compatibility prompt instead, avoiding 2
conflicting tool protocols. Bridged calls and results are also rendered as
plain JSON in provider-facing history; Pi's internal session remains typed.
If the endpoint leaks a generated reasoning prefix despite thinking being
disabled, Pi stores and displays only the text after `</think>`.

## Schema modes

The compatibility prompt defaults to full active-tool schemas. Set
`PI_FEATHERLESS_COMPACT_SCHEMAS=1` to remove only JSON Schema annotation
keywords (`description`, `title`, `examples`, `default`, `$comment`,
`deprecated`, `readOnly` and `writeOnly`) from the provider-facing copy. Those
keywords are removed only where they are annotations. A property named `title`
or `description`, and a literal `const` or `enum` value holding a member of that
name, are left alone. All structural and validation keywords are retained, and
Pi's original schemas are not mutated. Set the value to `0` to force full schemas. Any other value uses
the benchmark-selected default documented by the profile.

The 2026-08-28 live A/B selected full schemas. Compact mode failed the
multi-step fixture with malformed wrapper repetition, so `1` is retained only
for controlled diagnostics and is not recommended for normal coding sessions.

Run `npm test` in this directory to verify the protocol boundary.
