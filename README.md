# dsh-plugin-vm-sandbox

DeepSeek Harness 的**虚拟机沙箱**（Web 部署级插件）。

在会话视图环中新增「虚拟机」页签，为每个会话提供 OrbStack 沙箱虚拟机（debian/alpine，同一会话必要时可多台）。状态持久化在 `~/.dsh/vm-sandbox/`（`state.json` + `audit.json` + `metrics.json` + `secrets.vault.json`）。

## 功能（v0.4.0）

### v0.4.0 增强：体验 · 安全 · 编排 · 完整

- **A1 交互式 Web 终端**：机器详情内嵌 xterm.js 终端（CDN 按需加载），基于 OrbStack `orb run -s` 交互 shell，输出走 SSE 流、输入回传走 POST（复用 CSRF 通道）；空闲自动回收。
- **A3 场景化一键创建**：面板「快速开始」卡片一键出「就绪环境」（基础 / Python 分析 / Node 服务 / Web 脚手架 / Docker in VM）；`/vmsb-api/create` 支持 `template`。
- **A4 大动作可撤销 + 完成通知**：面板删除默认先打 `undo-before-delete` 快照，一键「撤销删除」恢复；VM 创建完成、指标告警触发以 toast 通知。
- **A5 配额一眼可见**：面板顶部配额进度条（机器 / CPU / 内存 用量·限额）+ 排队数。
- **A6 多会话协作分组视图**：机器列表按「本会话 / 共享给我 / 其他会话」分组，来源徽标。
- **B1 创建即安全基线 + `vm_harden`**：新 VM 默认加固（禁 SSH 密码登录 / root 仅密钥 + 标记）；scan/apply/status；OrbStack 无 sshd 时自适应 `na`。
- **B2 密钥库 `vm_secret`**：AES-256-GCM 加密存 `secrets.vault.json`（key 0600）；`{{secret:name}}`/`{{env:name}}` 占位符注入 init 脚本；审计/日志自动脱敏。
- **C1 增强指标 + 阈值告警 `vm_alert`**：每核 CPU% / 网络 / IO 速率 / 进程 Top（相邻采样差分）；阈值规则（cpu|mem|disk|load|netRx|netTx|io，gt|gte|lt|lte|eq，冷却）命中即审计 + `/vmsb-api/alerts` 通知。
- **D1 补工具**：`vm_scp`（批量/多机分发）、`vm_logs`（统一日志）、`vm_env`（环境变量库）、`vm_withdraw`（安全下线：停任务/停隧道/撤销共享/可选快照/删除）。
- **D2 调度 UI + 用量报表 `vm_report`**：meta 页签定时任务管理（增/启停/删）；会话级用量报表（机型平均 CPU%/内存%、规格、采样跨度、累计创建、排队）。
- **D3 导出分片/远端**：`vm_export slice_mb` 分片到 `<path>.parts/`（可无损拼接）；`remote_machine` 推到另一台 VM 备份。
- **D4 累计配额 + 创建排队**：`vm_policy cpu_quota/memory_quota`；`vm_create(queue:true)` 超配额排队，配额释放自动推进（`vm_queue` 查看/取消）。

### v0.3.0 增强：安全与可靠性

- **面板 API 加固 (S1)**：所有状态变更接口改为 **POST + 同源校验 + 按 session 绑定的 CSRF token**（`GET /vmsb-api/token` 下发），删除 / 休眠 / 恢复快照 / 停止任务等不再可被任意网页的 GET 触发（`<img>`/`<script>` CSRF 被阻断）；后端不再信任 query 中的 session 作为提权依据。
- **allowlist 注入防护 (S2)**：`vm_network` 的 `allowlist` 仅允许 IP / CIDR / 域名（`^[0-9a-zA-Z.:\-_/]+$`），带 shell 元字符的项一律拒绝；写入策略与应用策略两处均校验。
- **state.json 原子写入 + 备份回退 (R1)**：`tmp + rename` 原子替换，保留 `state.json.bak`；主文件损坏时自动回退并告警。
- **模板路径限制 (S3)**：`vm_template` 本地文件读取限制在工作区内；URL 模板仅允许 https 且 ≤1MB。
- **保存去抖 + 独立存储 (R2)**：保存去抖（300ms）/ 周期兜底 / 卸载落盘；审计与指标拆到独立的 `audit.json`、`metrics.json`，不再随 `state.json` 无限膨胀。
- **单元测试骨架 (R5)**：`npm test`（node:test）覆盖 cron、命名、大小解析、YAML、allowlist、原子写回退、同源/CSRF 校验；CI 运行 verify + 单测。

### Web UI

- 「虚拟机」页签内新增子页签：**虚拟机 / 快照 / 任务 / 审计 / 网络·共享**（变更操作均走后端加固的 POST 通道）
- 快照：列表、创建、恢复、删除
- 后台任务：状态、日志尾部查看
- 审计：操作记录列表（按时间/机器/操作过滤）
- 网络/共享：查看策略、模板、定时任务、服务发现

### 模型工具

- 快照与回滚：`vm_snapshot` / `vm_snapshot_list` / `vm_restore` / `vm_snapshot_delete`
- 文件传输：`vm_upload` / `vm_download`
- 生命周期：`vm_start` / `vm_stop` / `vm_restart` / `vm_status`
- 端口转发：`vm_port_forward` / `vm_port_forward_list` / `vm_port_forward_stop`
- 后台任务：`vm_job_submit` / `vm_job_list` / `vm_job_status` / `vm_job_stop` / `vm_job_output` / `vm_job_log`(轮转/归档)
- 审计：`vm_audit`（UI 支持 CSV/JSON 导出）
- 共享协作：`vm_share` / `vm_unshare` / `vm_policy`
- 网络策略：`vm_network`（含 allowlist）
- 自定义资源：`vm_create(cpus/memory/disk)`
- 模板/初始化：`vm_create(template/init_script/cloud_init)`
- 多机并行：`vm_exec(machines/groups/strategy)`
- 状态增强：`vm_status`
- 定时任务：`vm_cron`
- 模板库：`vm_template`
- 热调整资源：`vm_resize`
- 导入导出：`vm_export` / `vm_import`
- 指标历史：`vm_metrics`
- 服务发现：`vm_service_discover` / `vm_service_register`

### P1 自动运维

- `vm_cron`：VM 内定时任务（5 字段 cron 表达式，启停、下次运行时间）
- `vm_policy` 增加 `snapshot_interval_hours` / `snapshot_retention`：自动快照 + 保留策略

### P2 模板与规格

- 内置模板：python / node / docker / cuda；支持本地 JSON/YAML 或 GitHub raw URL
- `vm_resize`：基于 `orb config set` 运行时调整 CPU/内存/磁盘
- `vm_export` / `vm_import`：基于 `orb export` / `orb import` 的镜像导入导出

### P3 可观测性与编排

- `vm_metrics`：每 30 秒采样 CPU/内存/磁盘，保留 1440 点，UI 可查询
- `vm_exec` 新增 `groups`、`strategy(fail-fast/continue)`
- `vm_network` 新增 `allowlist`（IP/CIDR/域名白名单）
- `vm_service_discover` / `vm_service_register`：VM 间服务发现

## 验证

```bash
# 静态/结构验证
npm run verify

# 单元测试(不依赖 OrbStack)
npm test

# 快速冒烟
VMSB_SMOKE_SESSION=<当前会话ID> npm run smoke

# 全量 E2E：所有工具模块 + 真实 OrbStack 虚拟机
VMSB_SMOKE_SESSION=<当前会话ID> npm run e2e

# UI 路由层：所有 /vmsb-api 端点
VMSB_SMOKE_SESSION=<当前会话ID> npm run ui-test
```

## 兼容性

- DeepSeek Harness `web` profile
- 需要 `@deepseek-ai/dsh-client-runtime` 与 `@deepseek-ai/dsh-client-ui-conversation`
- 宿主机安装并运行 OrbStack，`orb` 位于 `/usr/local/bin/orb`

### License

This project is licensed under the Apache License 2.0.
See the full license at https://www.apache.org/licenses/LICENSE-2.0.
