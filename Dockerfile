# @zoom/rtms ships a native binary that currently requires GLIBCXX_3.4.31+.
# Debian bookworm-based node:22-slim only provides GLIBCXX_3.4.30, so use trixie.
FROM node:22-trixie-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm", "start"]
