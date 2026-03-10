# 1. 使用完整的 Node 22 Debian 镜像，适合在容器内直接调试和执行项目命令
FROM node:22-bookworm

# 2. 明确安装 agent 工作流强依赖的基础工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ripgrep \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 3. 设置工作目录
WORKDIR /app

# 4. 复制完整仓库，保留源码、测试和 .git 元数据
COPY . .

# 5. 安装全量依赖（包括 devDependencies，这对代码分析和测试很重要）
# 以及他会启动 build
# --unsafe-perm 是为了防止某些 node 脚本在 root 下安装失败
RUN npm install --unsafe-perm

# 6. 让容器内本地 CLI 可直接执行
ENV PATH="/app/node_modules/.bin:${PATH}"

# 7. 暴露端口
EXPOSE 3000

# 8. 开发镜像默认保持常驻，真正的 npm 命令由 agent 或人工显式触发
CMD ["sleep", "infinity"]
