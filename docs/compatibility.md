# Cross-host compatibility matrix

Record results of scenarios S1–S3 (and S4 for HTTP) per host (PS §14.7, G1/G4).
Use the same build for every row; only host-side config may differ.

| Host                         | Host version | Transport | Protocol negotiated       | Scenario | Right tool first try (G4) | Valid args first try (G4) | Result                          | Notes                            | Date / tester |
| ---------------------------- | ------------ | --------- | ------------------------- | -------- | ------------------------- | ------------------------- | ------------------------------- | -------------------------------- | ------------- |
| VS Code (Copilot agent mode) |              | stdio     |                           | S1       |                           |                           |                                 |                                  |               |
| VS Code (Copilot agent mode) |              | stdio     |                           | S2       |                           |                           |                                 |                                  |               |
| VS Code (Copilot agent mode) |              | stdio     |                           | S3       |                           |                           |                                 |                                  |               |
| Claude Code                  |              | stdio     |                           | S1       |                           |                           |                                 |                                  |               |
| Claude Code                  |              | stdio     |                           | S2       |                           |                           |                                 |                                  |               |
| Claude Code                  |              | stdio     |                           | S3       |                           |                           |                                 |                                  |               |
| Claude Desktop               |              | stdio     |                           | S1–S3    |                           |                           |                                 |                                  |               |
| Gemini CLI                   |              | stdio     |                           | S1       |                           |                           |                                 |                                  |               |
| Gemini CLI                   |              | stdio     |                           | S2       |                           |                           |                                 |                                  |               |
| Gemini CLI                   |              | stdio     |                           | S3       |                           |                           |                                 |                                  |               |
| OpenAI Responses API         |              | HTTP      |                           | S1–S2    |                           |                           |                                 |                                  |               |
| Headless script (SDK client) | 2.3.1        | HTTP      | 2025-11-25 and 2026-07-28 | S4       | n/a                       | n/a                       | Pass (automated, mocked Google) | `test/protocol/protocol.test.ts` | 2026-10-17    |

Scenario prompts:

- **S1:** "Summarize this and email it to teammate@example.com with subject 'Weekly update'." Expect `gmail_send_email`.
- **S2:** "Append these release notes to our changelog doc: <doc URL>." Expect `gdocs_get_document_info`, then `gdocs_append_text`.
- **S3:** "Add these 5 test results as a table at the end of the QA tracker doc." Expect `gdocs_append_table`.
