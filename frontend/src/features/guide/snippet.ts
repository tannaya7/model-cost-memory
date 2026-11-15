/** The one example of how an app sends its first AI call. Shown when a project is created and again in the tour. */
export const FIRST_CALL_SNIPPET = `from agent_memory.recorder import RunRecorder, provider_for

with RunRecorder(job="invoice-extract", provider=provider_for(client.base_url)) as rec:
    response = client.chat.completions.create(model="my-model", messages=[...])
    rec.capture(response, prompt=prompt, model="my-model")`;
