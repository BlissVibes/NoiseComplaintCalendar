# Token Log

A running tally of how many AI tokens it has taken to build this site, because
it is genuinely funny to know.

**Running total: 177,385 tokens** across 4 sessions. Last updated 2026-08-19.

| # | Date | Work | Tokens | Cumulative |
| --- | --- | --- | --- | --- |
| 1 | 2026-08-19 | Initial build: calendar heat map, timestamp extraction, quiet-hours logic, video panel, month list, Drive tooling | 127,385 | 127,385 |
| 2 | 2026-08-19 | Heat ramp recolour (yellow→orange→red→magenta→deep purple), configurable public title, v2_plan.md | 25,000 | 152,385 |
| 3 | 2026-08-19 | Pin incident times to the record's own time zone so they never shift with the viewer | 16,000 | 168,385 |
| 4 | 2026-08-19 | Show the raw scraped timestamp verbatim on each card and in the CSV | 9,000 | 177,385 |

## How to add an entry

Claude Code reports a remaining-token budget during a session. Note it at the
start and the end, then:

```bash
node tools/log-tokens.mjs --start 15000000 --end 14872615 --note "What you did"
```

Or log the difference directly:

```bash
node tools/log-tokens.mjs --spent 122982 --note "What you did"
```

The script inserts the row and rewrites the running total above the table.

## Method, such as it is

The number is the drop in the session's reported remaining-token budget, which
covers everything in the loop: reading files, writing them, tool output, test
runs, screenshots, and the model's own reasoning. It is not a billing figure
and does not separate input from output tokens. It is an honest measure of
"how much machine thinking went into this," rounded to whatever precision the
harness happens to report.

For scale: session 1 produced roughly 1,900 lines across HTML, CSS, seven
JavaScript modules, and three Node scripts.
