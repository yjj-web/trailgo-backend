FROM node:18-alpine

WORKDIR /app

# 先装依赖（pg 为纯 JS，无需编译原生模块）
COPY package.json package-lock.json* ./
RUN npm install --production

# 再拷贝源码
COPY . .

# Render 会通过 PORT 环境变量注入端口；server.js 已读取 process.env.PORT
EXPOSE 3000

# 启动时先建表/写种子（幂等，已有数据会跳过），再启动服务
CMD ["sh", "-c", "node initDb.js && node server.js"]
