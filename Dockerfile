FROM node:18-alpine

WORKDIR /app

# 先装依赖（sqlite3 在 Linux 上重新编译原生模块）
COPY package.json package-lock.json* ./
RUN npm install --production

# 再拷贝源码（.dockerignore 已排除 node_modules / 数据库等）
COPY . .

# Render 会通过 PORT 环境变量注入端口；server.js 已读取 process.env.PORT
EXPOSE 3000

# 若数据库不存在则先初始化种子数据，再启动服务
CMD ["sh", "-c", "[ -f trailgo.db ] || node initDb.js; node server.js"]
