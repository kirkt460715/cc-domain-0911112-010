# dataharbor 数据接入

项目使用 Node.js 22 内置模块，不依赖第三方服务。现有领域接口、版本记录、错误处理和回归测试均可离线运行。采集端点的合成服务与业务接收模块分别运行。

## 测试与产品演示

    npm test
    npm run build
    npm run acceptance
    node --test synthetic_exchange/smoke.test.js

## 可复现容器

    docker build -t local/dataharbor .
    docker run --rm --network none local/dataharbor

镜像使用固定摘要，依赖在构建前准备。run_checks.sh 完整执行测试、语法检查及产品演示，正常用时少于 90 秒，使用临时数据目录。联调服务可在同容器中监听 loopback，不需要公网。

## 网关协议

GET /manifest 返回关联成员清单。/data/courses 与 /data/enrollments 提供合成字节，摘要按实际响应的 UTF-8 字节计算。成员的 member_version 是供应商版本，schema_revision 是本地约定。

    node synthetic_exchange/server.js

原有命令帮助：

    node src/main.js help
