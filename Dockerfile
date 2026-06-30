FROM node:22-slim

WORKDIR /app

# Copy configuration and package files
COPY package.json package-lock.json tsconfig.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY src ./src

# Build TypeScript source to dist/
RUN npm run build

# Prune devDependencies to keep the runtime environment clean and lightweight
RUN npm prune --production

# Entrypoint to run the MCP server over stdio
ENTRYPOINT ["node", "dist/server.js"]
