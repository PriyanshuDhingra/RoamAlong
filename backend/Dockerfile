FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.5.4 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml ./
RUN uv pip install --system -r pyproject.toml
COPY backend ./backend
COPY protocol ./protocol

CMD ["uvicorn", "backend.gateway.main:app", "--host", "0.0.0.0", "--port", "8000"]
