FROM node:22-alpine

LABEL org.opencontainers.image.title="OpenAthlete Bulk Editor" \
      org.opencontainers.image.description="Unofficial bulk editor and Garmin history importer for self-hosted OpenAthlete" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    OA_API_URL=http://api:3000

WORKDIR /app
COPY app/ /app/

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:8080/api/me || exit 1

CMD ["node", "server.js"]
