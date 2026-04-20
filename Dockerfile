FROM node:20-slim
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --production && rm -rf /root/.npm
COPY server.js ./
COPY public ./public
EXPOSE 3000
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/toolbox.db
CMD ["node", "server.js"]
