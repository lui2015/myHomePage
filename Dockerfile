FROM node:20-slim
# Use Tencent Cloud mirrors for faster apt/npm install on CN network
RUN sed -i 's|deb.debian.org|mirrors.tencentyun.com|g; s|security.debian.org|mirrors.tencentyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null \
 || sed -i 's|deb.debian.org|mirrors.tencentyun.com|g; s|security.debian.org|mirrors.tencentyun.com|g' /etc/apt/sources.list 2>/dev/null || true
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm config set registry https://mirrors.tencent.com/npm/ && npm install --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
EXPOSE 3000
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/toolbox.db
CMD ["node", "server.js"]
