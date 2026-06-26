# using nodejs alpine image
FROM node:22-alpine

# install python,pip and virtualenv tools
RUN apk add --no-cache python3 py3-pip python3-dev build-base

# setting up virtual env and installing dep.
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

RUN pip install --no-cache-dir chat-downloader "yt-dlp[default]" yt-dlp-ejs

# setting up node working dir
WORKDIR /app

# Set Node options to increase heap limit for TypeScript build
ENV NODE_OPTIONS="--max-old-space-size=1800"

# copy packages files
COPY package.json pnpm-lock.yaml* ./


# Install node dependencies using corepack to avoid memory overhead of global npm install
RUN corepack enable && \
    (pnpm install --frozen-lockfile --child-concurrency 1 || \
     NODE_OPTIONS="--max-old-space-size=1024" npm install)

# Copy source code
COPY . .

# Build the TypeScript project
RUN pnpm run build || npm run build

# Expose port 5000
EXPOSE 5000
ENV PORT=5000
ENV OLLAMA_HOST=http://ollama:11434
ENV NODE_ENV=production

# Start application
CMD ["pnpm", "start"]
