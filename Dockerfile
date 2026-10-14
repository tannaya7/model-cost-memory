FROM python:3.11-slim

# Which dependency set to install. The sync worker passes ".[embeddings]" (adds the ~2 GB
# embedding model library); every other service keeps the default and stays small.
ARG INSTALL_TARGET="."

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir "${INSTALL_TARGET}"

# Run as an unprivileged user, never root.
RUN useradd --create-home --uid 10001 app
USER app
