# Contributing

## Branches

Work happens on short-lived branches named for the kind of change, cut from `POC`:

| Prefix | Use |
|---|---|
| `feat/` | a new capability, for example `feat/run-ingest` |
| `fix/` | a bug fix |
| `chore/` | tooling, configuration, clean-up |
| `docs/` | documentation only |
| `test/` | tests only |

Pull requests target `POC`. A maintainer reviews and merges them; do not merge your own.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, in the
imperative, with the body explaining *why*.

```
feat(ingest): create jobs and record runs idempotently with a transactional outbox write
fix(db): drop the unneeded pgcrypto extension from the schema
```

Types: `feat`, `fix`, `chore`, `docs`, `test`, `build`, `ci`, `refactor`, `perf`.

Aim for a few focused commits per branch, each one passing the tests on its own.

## Sign-off and signatures

Every commit must carry a [Developer Certificate of Origin](https://developercertificate.org/) sign-off
and be signed, so GitHub shows it as Verified:

```bash
git commit -s -S -m "feat(scope): summary"
```

`-s` adds the `Signed-off-by:` line. Configure signing once (`gpg.format`, `user.signingkey`,
`commit.gpgsign true`) so `-S` is the default.

## Before you push

```bash
pytest          # starts its own Postgres; no Docker or database account needed
ruff check .
```

If you change a response model in `src/agent_memory/schemas.py` or add an endpoint, regenerate the API
contract and commit it with the change:

```bash
python scripts/export_openapi.py
```

A test fails when `contract/` is out of date.

## Changing the database

The schema changes only through Alembic migrations in `migrations/versions/`. `db/schema.sql` is the
reference snapshot and a test fails if it disagrees with the migrations or the models.
