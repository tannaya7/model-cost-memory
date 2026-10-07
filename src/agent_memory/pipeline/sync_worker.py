"""Sync worker: claims outbox rows with SELECT ... FOR UPDATE SKIP LOCKED, embeds each run and
writes lineage. Idempotent by run_id; retries with backoff, then INGESTION_FAILED. Week 5."""
