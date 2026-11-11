# dataharbor 数据接入

项目使用 Node.js 22 内置模块，不依赖第三方服务。现有领域接口、版本记录、错误处理和回归测试均可离线运行。采集端点的合成服务与业务接收模块分别运行。

## 测试与产品演示

    npm test
    npm run build
    npm run acceptance
    node --test synthetic_exchange/smoke.test.js

## 关联发布组（release bundle）

供应商用一份 release manifest 同时声明课程字典与报名明细等关联成员，每个成员给出
`sha256`、`bytes`、`schema_revision` 和精确的依赖 `member_version`。DataHarbor 把整组
作为一个不可分割的发布单元处理，避免先导入报名数据却引用上一版课程编码的事故。

工作流分四步，均提供无副作用的预览：

1. `bundle-preview` / `bundle-plan`：解析清单，做依赖环（Kahn 拓扑排序）、缺失成员、
   schema revision 与本地外键一致性、steward 权限检查；规划时快照 schema 哈希、活动版本
   指针与授权状态。
2. `bundle-ingest`：按拓扑序下载，逐成员校验字节数与 sha256，再在库内完成类型、外键与
   质量门校验。报名成员的外键只绑定本次发布产出的具体字典版本（冻结引用），不跟随当前
   活动指针。已校验字节和已导入版本可在暂停恢复时复用，但每次恢复都重算摘要并重新检测漂移。
3. `bundle-activate`：仅当全组通过且规划快照未发生漂移时，按权限一次性原子切换全部
   current 指针；任一成员不兼容则保留 quarantine 诊断证据，旧产品继续服务。
4. `bundle-status` / `bundles` / `bundle-trace`：查看组状态、漂移与每个成员的质量报告，
   并在 release 与每份课程/报名版本之间双向追溯（版本带 `provenance` 来源记录）。

同一 release 的同一逻辑成员若再次出现却指向不同字节，会以 `bundle_byte_conflict` 隔离，
不会静默合并。期间 schema、依赖授权或活动版本变化时，旧计划返回 `bundle_replan_required`
而不会覆盖现网。CLI 与本地 HTTP API（`/bundles/*`、`/bundle`、`/bundle/trace`）均可用，
写操作支持 `If-Match` 乐观代际校验。

## 可复现容器

    docker build -t local/dataharbor .
    docker run --rm --network none local/dataharbor

镜像使用固定摘要，依赖在构建前准备。run_checks.sh 完整执行测试、语法检查及产品演示，正常用时少于 90 秒，使用临时数据目录。联调服务可在同容器中监听 loopback，不需要公网。

## 网关协议

GET /manifest 返回关联成员清单。/data/courses 与 /data/enrollments 提供合成字节，摘要按实际响应的 UTF-8 字节计算。成员的 member_version 是供应商版本，schema_revision 是本地约定。

    node synthetic_exchange/server.js

原有命令帮助：

    node src/main.js help
