FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./
ENV PORT=8080 HOST=0.0.0.0 DATA_FILE=/data/slack.jsonl
RUN mkdir -p /data
EXPOSE 8080
CMD ["bun", "scripts/demo-server.ts"]
