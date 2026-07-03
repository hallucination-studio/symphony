FROM node:22-bookworm-slim AS web-build

WORKDIR /app/packages/podium/web
COPY packages/podium/web/package*.json ./
RUN npm ci

COPY packages/podium/web ./
RUN npm run build

FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY packages/performer-api ./packages/performer-api
COPY packages/podium ./packages/podium
COPY --from=web-build /app/packages/podium/src/podium/static ./packages/podium/src/podium/static

RUN python -m pip install --upgrade pip \
    && python -m pip install ./packages/performer-api ./packages/podium

RUN useradd --create-home --shell /usr/sbin/nologin podium
USER podium

EXPOSE 8090
CMD ["podium", "api", "--host", "0.0.0.0", "--port", "8090"]
