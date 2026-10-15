// TEMPORARY: replaced by generated types (npm run gen:types) once Tannaya publishes the OpenAPI file.
export interface Job {
  id: string;
  name: string;
  description?: string;
  check_kind?: "answer_key" | "schema";
  retest_consent?: boolean;
  created_at?: string;
}
