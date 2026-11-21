FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DB_PATH=/data/negocio.db CONFIG_PATH=/data/agente.yaml
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
