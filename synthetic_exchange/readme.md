# 网关联调协议

GET /manifest 返回关联成员清单。/data/courses 与 /data/enrollments 提供合成字节，摘要按实际响应的 UTF-8 字节计算。成员的 member_version 是供应商版本，schema_revision 是本地约定。

/_requests 提供实际请求记录。可以复制场景并改变返回次数、数据和状态码。监听地址限于 loopback，示例不是在线账号。

    node synthetic_exchange/server.js
    node --test synthetic_exchange/smoke.test.js
