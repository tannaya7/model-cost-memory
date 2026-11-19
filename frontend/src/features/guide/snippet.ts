/** The one example of how an app sends its first AI call. Shown when a project is created and again in the tour.
 *  It calls the small `record_ai_call` function the Connect guide gives a developer; nothing needs installing. */
export const FIRST_CALL_SNIPPET = `# After each AI call your app already makes (record_ai_call is in "How to connect your app"):
record_ai_call("invoice-extract", prompt, answer_text, "my-model", response.model, "openai", response.usage)`;
