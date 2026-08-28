# Featherless text-tool bridge

This compatibility extension is scoped to
`featherless/OBLITERATUS/Qwen3.8-27B-OBLITERATED`. It compensates for the live
Featherless endpoint returning tool requests as ordinary text instead of native
OpenAI `tool_calls` objects.

The bridge converts a response only when all of these conditions hold:

- the provider and model match exactly;
- the response completed normally and contains one text block;
- one bounded response form contains one JSON object with exactly `tool` and
  `args`: bare JSON, the suffix after `</think>`, one matched `<tool_call>`
  wrapper, or one or more brace-free prose paragraphs followed by one JSON
  paragraph;
- `tool` is currently active in Pi;
- `args` is an object without prototype-polluting keys.

Pi still performs its normal tool-schema validation and all configured
`tool_call` safety checks before execution. Markdown fences, unknown tools,
malformed arguments, extra envelope fields, and prose that does not end in one
accepted envelope remain ordinary text and are never executed.

One additional learned model form is accepted only for `bash`: a single exact
`<tool_call><bash><parameter=command>…` structure with its three required
closing tags. It cannot name another tool or add another parameter, and the
resulting command still passes through bash-guard.

The bridge also accepts the observed generic form
`<tool_call><function=NAME><parameter=args>{…}</function></tool_call>`. `NAME`
must be one currently active tool and the parameter body must be exactly one
JSON object. Unknown tools, arrays, duplicate parameters, mismatched closers
and prototype-polluting keys are rejected.

The parser also recognises one fixed legacy closer sequence observed around a
single JSON envelope. Extra or repeated closers and missing outer tags are not
accepted.

For this exact provider/model, the extension removes OpenAI-native `tools`,
`tool_choice` and `parallel_tool_calls` fields from the outgoing payload. The
active schemas are supplied in the compatibility prompt instead, avoiding two
conflicting tool protocols. Bridged calls and results are also rendered as
plain JSON in provider-facing history; Pi's internal session remains typed.
If the endpoint leaks a generated reasoning prefix despite thinking being
disabled, Pi stores and displays only the text after `</think>`.

Run `npm test` in this directory to verify the protocol boundary.
