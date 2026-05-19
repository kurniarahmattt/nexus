FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      curl \
      libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Install CPU-only torch first so sentence-transformers (pulled by the
# rest of requirements.txt) sees torch already satisfied and does NOT
# bring in the multi-GB CUDA wheels (nvidia-cublas, cudnn, nccl, etc.).
# Mem0's embedder runs on CPU here, so CUDA buys us nothing.
RUN pip install --upgrade pip \
 && pip install --index-url https://download.pytorch.org/whl/cpu \
      'torch==2.5.1+cpu' \
 && pip install -r requirements.txt

COPY app ./app

EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:4100/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4100"]
