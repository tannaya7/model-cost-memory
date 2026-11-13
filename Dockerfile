FROM python:3.11-slim

# Which dependency set to install. The sync worker passes ".[embeddings]" (adds the ~2 GB
# embedding model library); every other service keeps the default and stays small.
ARG INSTALL_TARGET="."

WORKDIR /app
COPY pyproject.toml README.md requirements-lock.txt ./
COPY src ./src
# Alembic runs inside this image on the server: `docker compose run --rm api alembic upgrade head`
COPY alembic.ini ./
COPY migrations ./migrations
COPY scripts ./scripts
# The CPU build of PyTorch: the server has no GPU, and the default Linux wheels bring ~5 GB of CUDA
# libraries (the worker image was 6.3 GB). A "+cpu" wheel sorts above the plain one, so pip picks it.
# Every version comes from requirements-lock.txt, so the image runs exactly what CI tested.
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu     -c requirements-lock.txt "${INSTALL_TARGET}"

# Run as an unprivileged user, never root.
RUN useradd --create-home --uid 10001 app
USER app
