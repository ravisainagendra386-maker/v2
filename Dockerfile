FROM mcr.microsoft.com/playwright:v1.59.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV SCRAPE_HEADLESS=true
ENV USER_DATA_DIR=/data/rebel777-profile
ENV SESSION_FILE=/data/rebel777-session.json

RUN mkdir -p /data

EXPOSE 3000

CMD ["npm", "start"]
