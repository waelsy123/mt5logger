FROM node:20-alpine AS builder
WORKDIR /app
ARG NEXT_PUBLIC_MT5_API_URL
ENV NEXT_PUBLIC_MT5_API_URL=$NEXT_PUBLIC_MT5_API_URL
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
