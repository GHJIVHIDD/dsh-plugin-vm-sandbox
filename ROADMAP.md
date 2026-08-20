# dsh-plugin-vm-sandbox 改进升级路线图

> 状态：草案（v0.3 预览）。本文基于对 `dsh-plugin-vm-sandbox/src/index.js`(3232 行) 与 `src/client.js`(653 行) 的逐段审查，
> 以及 DSH `@deepseek-ai/dsh-host-webserver` 的服务契约核对后整理。供确认后按 P0→P3 分阶段落地。
>
> 代码行号均相对 `dsh-plugin-vm-sandbox/src/index.js` / `src/client.js`。

---

## 1. 现状盘点（v0.2.1）

- **35 个 `vm_*` 模型工具**：生命周期、快照/回滚、文件传输、端口转发、后台任务、审计、共享、策略、网络、cron、模板、热调整、导入导出、指标、服务发现。
- **Web 面板**：「虚拟机 / 快照 / 任务 / 审计 / 网络·共享」五个子页签，托管在 `conversation.view` Slot。
- **自运维**：每 5 分钟闲置扫描、每 30 秒 cron + 自动快照 + 指标采样、全局运行上限 25、每会话上限 8。
- **持久化**：单一 `~/.dsh/vm-sandbox/state.json`（含 machines/snapshots/shares/policies/network/jobs/tunnels/audit/cron/templates/metrics/services）。
- **验证**：仅有 `scripts/{verify,smoke,e2e,ui-test}.mjs` 脚本级验证，无 CI、无单元测试。

功能面已经很全，问题集中在 **安全、状态持久化可靠性、性能、可维护性** 四条线上。

---

## 2. 审查发现（按严重度）

| 编号 | 严重度 | 主题 | 位置 | 一句话结论 |
|---|---|---|---|---|
| S1 | 🔴 P0 | Web API 无鉴权 + 副作用全走 GET + session 可伪造 | `L1513-1518`、路由 `L1595-1922`；对照 `dsh-host-webserver` README（明确“不提供 TLS、认证或来源策略”） | 浏览器内任意页面可用 `<img>`/`<script>` 触发删除 VM/停止任务/恢复快照；本地进程伪造 `session` 参数即可冒充机器主人操作（`canOwner/canManage` 依赖伪造身份） |
| S2 | 🔴 P0 | `allowlist` 直接拼进 root 执行的 iptables 脚本 | `L1315-1322`（拼接）、`L1337`（再 base64） | 结合 S1，`GET /vmsb-api/network` + 伪造 session + 注入项 = 在任意 VM 内以 root 执行任意命令；即使不结合也是严重错误源 |
| R1 | 🔴 P0 | `state.json` 非原子写入，损坏即静默丢全部状态 | `saveState L107-114`、`loadStateFile L78-100` | 写半截崩溃 → 下次解析失败 → 直接回退空状态，机器归属/快照/共享/任务/审计全丢且无告警 |
| S3 | 🟠 P1 | `vm_template` 可读取任意宿主文件 | `resolveTemplate L3081-3082` | `source` 传绝对路径时 `readFileSync` 把 `/etc/passwd` 等宿主文件内容经工具响应泄露给模型 |
| R2 | 🟠 P1 | 全量 state 反复全量序列化 | `touchMachine L294`、`pushAudit`、`readJobStatus`、`sampleAllMetrics L3116` | 每次 vm_exec/指标采样/任务状态变化都整文件 writeFileSync 一次；机器多、审计多时阻塞事件循环 |
| R3 | 🟠 P1 | 指标塞进 state.json，文件无限膨胀 | `pushMetrics L3099-3104` | 每台机器保留 1440 点 × N 台，全部随主状态一起序列化 |
| R4 | 🟠 P1 | 任务探测每任务一次 `orb run` | `readJobStatus L987-1020`、`vm_job_list L2525-2529` | N 个任务 = N 次 SSH/`orb run` 进程，UI 每 8 秒全量轮询进一步放大 |
| M1 | 🟠 P1 | 默认 `idleSleepMinutes: 30` 会误伤长任务 | `sessionPolicy L298-303` | 默认 30 分钟强制休眠，对训练/构建等长会话不友好，且面板提示不足 |
| A1 | 🟡 P2 | 3232 行单文件 monolith | `src/index.js` 全篇 | 难以测试/维护/复用（orb 客户端、状态库、权限模型、各功能模块耦合） |
| U1 | 🟡 P2 | 无交互式终端，UI 纯轮询 | `client.js L277(8s)`、`L299(2s)` | 只能看历史 shell 记录，不能交互；轮询粒度粗 |
| 其他 | ⚪ P2/P3 | 无流式大输出；服务发现靠手工登记；快照不可按文件恢复；uptime 探测无 guest-agent 增强 | 若干 | 见 §6 |

---

## 3. 分级路线总览

```
v0.3.0  (安全 + 可靠性)   S1 S2 R1 + S3 + R2 去抖/拆文件 + R5 单测骨架
v0.3.x  (性能 + 健壮性)   R3 指标拆分 + R4 批量任务探测 + M1 策略默认值
v0.4.0  (能力增强)        U1 交互终端/实时推送 + 表单上传下载 + 流式 exec
v0.5.0  (编排)            集群模板/playbook、服务自动发现、guest 指标
v1.0.0  (架构)            A1 模块化重构 + CI + 兼容性/文档矩阵
```

---

## 4. P0 —— 安全与数据可靠性（v0.3.0 必须）

### 4.1 S1：Web API 鉴权 + 副作用改 POST + 不信任 query 的 session

**目标**：只有 DSH GUI（已登录主体）能变更状态；伪造 `session` 不再提权；不可经 `<img>`/`<script>` 触发副作用。

**理由**：`dsh-host-webserver` 明确“不提供 TLS、认证或来源策略”，而本插件把删除/休眠/恢复/停止都暴露成 **GET**。
一个浏览器里打开的恶意页面即可静默触发；本地可访问 `127.0.0.1:3080` 的进程可伪造任意 `session` 冒充机器主人。

**改动点**（`src/index.js`）：
1. 读接口（`list/info/shell/audit/jobs/tunnels/snapshots/metrics/cron/templates/services/policy`）保持 GET。
2. 所有改状态接口（`create/start/restart/sleep/delete/snapshot?action=…/job?action=…/share?action=…/network(写)`）改为 **POST + JSON body**。
3. 鉴权方案（三选一，推荐 ③）：
   - ① 校验 `Origin`/`Sec-Fetch-Site`：非同源（非 DSH GUI）直接拒；
   - ② 复用 DSH 现有 `cookie`/`connection` 会话，路由内解析出真实 sessionId，**不再信任 query 参数**；
   - ③ 登录/WS 握手时下发随机 CSRF token 到 GUI，写操作必须回带（与 ② 叠加最稳）。
4. 后端身份推导：所有 handler 中需要 sessionId 的地方改为从经过鉴权的主体取得，删除“从 query 取 session 再 `canOwner`”这条信任链。

**验收**：`printf '' | curl -XPOST -H 'Origin: https://evil.example' localhost:3080/vmsb-api/delete?...` → 拒绝；缺失 CSRF token → 401/403；合法 GUI 流程回归全通过。

---

### 4.2 S2：allowlist 注入 → 在任意 VM 内以 root 执行

**目标**：`allowlist` 只能携带 IP/CIDR/域名，任何 shell 元字符输入被拒绝。

**理由**：`L1315-1322` 把用户（模型/Web）输入直接拼进 `iptables`/`getent $(…)` shell 片段，再整体 base64 `L1337` 掩盖——注入发生在编码之前，
`1.1.1.1; reboot`、`x)$(touch /pwn)` 均可生效。与 S1 串联 = 未鉴权服务在任意 VM 内任意 root 执行。

**改动点**（`src/index.js` `applyNetworkPolicyToMachine`）：
1. 追加白名单校验函数：仅允许 `^[0-9a-zA-Z.:\-_/]+$`（本质是 IP/CIDR/域名字符集），否则 `throw`。
2. 更彻底：把 allowlist 数组做 JSON→base64 传给 VM，脚本内用定长参数校验后再拼规则，双保险。
3. 对 `getent` 域名分支改为 `getent ahostsv4 -- "<host>"` 并校验返回值。

**验收**：新增单测覆盖 `1.1.1.1; cmd`、`$(id)`、`%0a reboot` 等 → 全部被拒;

---

### 4.3 R1：`state.json` 原子写入 + 备份回退

**目标**：任何一次崩溃都不丢可恢复的状态；损坏时自动回退最近有效备份并告警。

**理由**：`saveState` 直接 `writeFileSync`，半写即整文件损坏；`loadStateFile` 损坏时静默返回空态，等于静默丢全部元数据。

**改动点**（`src/index.js` L78-114）：
1. 采用 DSH 现成 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic`（同目录随机后缀临时文件 + rename），零依赖、免自造。
2. 写前保留上一版 `.bak`（`cp` 或 rename 链：`state.json → state.json.bak`）。
3. `loadStateFile` 解析失败时自动回退 `.bak`，并在日志/面板置一条 `state_recovered` 审计与告警。
4. 修正 `loadStateFile` 里 version 3/4 不一致的小问题（解析路径返回 3，空态返回 4）。

**验收**：手工写半截文件后重启，自动从 `.bak` 恢复且机器/快照/共享仍在;连续写 200 次无中间态可见。

---

## 5. P1 —— 性能与健壮性（v0.3.x / v0.4）

### 5.1 S3：`vm_template` 文件读取限制在工作区

改为复用 `resolveLocalPath` 的工作区约束；URL 仅允许 `https:`、加 20s 超时与 ≤1MB 大小上限；JSON/YAML 解析失败回退报错而非裸返回。

### 5.2 R2：saveState 去抖 + 状态分区

- `saveState` 加 200–500ms 去抖，进程退出/卸载时兜底 flush；`touchMachine` 改为仅内存置位、由公共保存点统一下盘。
- 审计（`pushAudit`）与指标（`pushMetrics`）拆出：`audit.jsonl`（追加式）+ `metrics.json`（按机器分区），与主 `state.json` 分离。
- 聚合入口统一（一次性批量写），`readJobStatus` 终端态更新不再触发全文件整写。

### 5.3 R4：批量任务探测

`readJobStatus` 改为单次 `orb run` 批量探测：一次进 VM 遍历某机器全部运行中任务的 `dir`（读 `status/end/pid` + `tail out.log`），N 任务从 N 次进程降到 1–2 次；
`vm_job_list`/`/vmsb-api/jobs` 直接复用批量结果。

### 5.4 M1：策略默认值

`idleSleepMinutes` 默认改为 `0`（不开自动休眠，需用户显式开启），并在面板策略区显著提示“当前闲置策略”；避免长任务被误休眠。

### 5.5 R5：单测 + CI 骨架

- 用内置 `node:test` 给纯函数补单测：cron 匹配/nextRun、机器/快照命名、`sizeToBytes/sizeToMiB`、`parseSimpleYaml`、`abbreviate`（拼音表路径）、allowlist 校验（S2 回归）、原子写恢复（R1 回归）、权限矩阵（owner/exec/manage/共享）。
- 新增 GitHub Actions：`verify` + 单测（不拉起真实 VM，安全）；`smoke`/`e2e` 留手工标记。

---

## 6. P2 —— 能力增强（v0.4.0 / v0.5.0）

| 方向 | 说明 | 改动点 |
|---|---|---|
| **U1 交互式 Web 终端** | 在机器详情页嵌入真实终端（xterm.js），经 `webserver.registerUpgrade`（已支持 upgrade route）走 SSH/PTY 到 VM | `src/client.js` 新增终端子页签；host 新增 `/vmsb-api/term` upgrade handler；复用现有 `canExec` 权限 |
| **实时推送降轮询** | 把 shell 日志/任务进度改为 WS/SSE 增量推送，替代 2s/8s 全量轮询（仍是 GET，注意鉴权） | host 新增订阅端点；client 改为流式渲染 |
| **UI 上传/下载** | 面板内拖拽上传、右键下载，而非仅模型工具 | client 文件选择 + `/vmsb-api/upload`(POST) 多部分 |
| **流式/大输出 exec** | 超长命令自动升级为后台 job + tail 流式返回，不再受 16MB maxBuffer 截断 | `vm_exec` 加 `stream:true` 分支 |
| **快照按文件/目录恢复** | `orb pull` 定向拉取快照内指定路径，替代整机回滚 | host `vm_snapshot_file` 工具 |
| **服务自动发现** | 主动扫描 VM 内监听端口，与人工登记合并展示，而非仅靠 `vm_service_register` | host 轮询 + 展示层整合 |

---

## 7. P3 —— 架构与长期（v1.0.0）

### A1 模块化重构（按依赖方向拆分，每模块可独立单测）

```
src/
  orb.js          # orb CLI 封装（注入式命令、超时、日志、并发限制）
  state.js        # 状态库：原子写/去抖/分区/备份回退/版本迁移   ← 承接 R1/R2/R3
  naming.js       # sanitize/unique/abbreviate/拼音表            ← 承接 R5 单测
  acl.js          # owner/exec/manage/share 权限矩阵             ← 承接 S1 身份推导
  netpolicy.js    # iptables 脚本生成 + allowlist 校验           ← 承接 S2
  jobs.js / cron.js / snapshot.js / tunnel.js / transfer.js
  tools.js        # 工具注册表（35 个描述与参数集中定义）
  routes.js       # HTTP 路由（只读 GET / 变更 POST + 鉴权）      ← 承接 S1
  client.js       # 保持不变（Slot UI）
```

其余长期项：宿主机/GUI 双端健康面板、`vm_metrics` 接入 guest-agent 增强指标、跨 VM 私有网络编排、导出镜像的远端对象存储备份、文中暂缓事项留档（cron 表达式仅支持 5 字段数字等，作为已知限制记录）。

---

## 8. 版本节奏与首个落地清单

- **v0.3.0（本轮建议直接做）**：§4 全部（S1 S2 R1）+ §5.1 S3 + §5.2 去抖 + §5.5 单测骨架。
- **v0.3.x**：§5.3 R4 批量探测、§5.4 M1、§5.5 CI。
- **v0.4**：§6（终端/推送/上传下载/流式 exec）。
- **v0.5 / v1.0**：§7。

> 落地顺序建议：先把 S2（allowlist 校验）与 R1（原子写）作为两个最小可回滚 commit 先行——改动面小、收益最高、可独立验证。

---

## 9. 风险与取舍

- **S1 改 POST 会破坏现网旧面板/其他调用方**：需与 `client.js` 同步升级，并保留短暂兼容期或一次性迁移。
- **状态分区（R2/R3）会改变 state.json 结构**：需要 `loadStateFile` 版本迁移 + 兼容旧文件（插件已有 v3→v4 迁移先例）。
- **默认策略改 0（M1）** 属产品取舍：省默认资源 vs 防长任务被休眠，以“显式开启 + 面板提示”为准。
- **交互终端（U1）** 依赖 `registerUpgrade` 契约与 SSH 可用性，属于较大改动，建议独立版本发布。

---

## 10. v0.4+ 升级方向（更贴近用户使用习惯 · 更安全 · 更先进 · 功能更全）

> v0.3.0 已完成安全与可靠性底座。本节面向**下一阶段**：把「模型工具齐全但面板只读轮询」的现状，升级成**用户可直接上手、默认更安全、编排更先进、能力更完整**的体验。
> 编码原则：所有方向继续落在 Cordis 插件内（host 服务 + client Slot + 现有 `/vmsb-api` 契约，S1 的 POST+CSRF 通道直接复用）。

### 10.1 更贴近用户使用习惯（UX / 直接可上手）

| 方向 | 目标 | 现状缺口 | 主要改动点 | 验收 | 版本 |
|---|---|---|---|---|---|
| **A1 交互式 Web 终端** | 在机器详情页嵌入真实终端，能直接输命令（xterm.js + PTY） | 现在只能看历史 shell 记录、靠模型工具操作 | `webserver.registerUpgrade` 新增 `/vmsb-api/term` upgrade 路由走 SSH/PTY；client 加 xterm 子页签；复用 `canExec` ACL；鉴权沿用 S1 token | 面板里打开机器→回车出 shell→能跑 `ls`/`ping`；无 exec 权限会话被拒 | v0.4 |
| **A2 拖拽上传 / 目录双向同步** | 面板内拖文件进 VM、工作区↔VM 目录 watch 同步 | 传输只有 `vm_upload/vm_download` 工具 | client 文件/目录选择 + 新增 `/vmsb-api/upload`(POST, 已加固) + host 端 `orb push`；可选 watch | 拖入文件 5 秒内出现在 VM；同步目录自动追平 | v0.4 |
| **A3 场景化一键创建** | 按模板一键出「就绪环境」（Python 流水线/Node 服务/Docker in VM…） | 只有 `vm_template` 展示+模型发起创建 | client「快速开始」卡片组 → 调 `vm_create(template=...)`；服务端补常用模板质量 | 点一下卡片→几分钟内得到带依赖的可用 VM | v0.4 |
| **A4 更友好的反馈与可撤销** | 大动作二次确认+操作反馈+轻通知 | confirm 只覆盖删除；无结果通知 | 复用 DSH 通知机制：启动完成/任务结束/快照完成冒烟提示；删除/恢复/重启用轻量撤销窗口 | 删除有倒计时撤销；长任务完成有通知 | v0.4 |
| **A5 配额定位于直觉** | 用量/上限/闲置策略一眼可见，按会话 | 面板头部只有台数上限；策略藏在 meta 页 JSON | 顶部加「用量条」（本会话 X/8 · 全局运行 N/25 · 内存/CPU 合计）+ 策略常见问答式说明 | 新用户 5 秒读懂自己还剩多少额度 | v0.5 |
| **A6 多会话协作视图** | 「我看到的 / 共享给我的 / 我共享出去的」清晰分组，一处处建立共享 | share 平铺在 meta | 面板拆分视图 + 一键 `vm_share` 引导 + 来自他人机器加「来源会话」徽标 | 共享关系一眼可辨 | v0.5 |

### 10.2 更安全（纵深防御，从「能加固」到「默认就安全」）

| 方向 | 目标 | 现状缺口 | 主要改动点 | 验收 | 版本 |
|---|---|---|---|---|---|
| **B1 创建即安全基线** | 新 VM 默认执行轻量加固：关 root 密码 SSH/禁止密码登录、禁多余服务、仅回环暴露、安装基础补丁 | 创建时只有 user-data，无基线 | `createMachineWithName` 拼接安全基线 cloud-init（可配置 `harden: true|false`，默认 true）+ `vm_harden` 工具对存量机器检测/加固（对标 CIS-lite 的自检脚本） | 新建 VM `sshd -t` 无密码登录被拒；`vm_harden scan` 报告通过/修复 | v0.4 P0 |
| **B2 密钥与凭据管理** | 明文 secret 不进审计/日志/快照明文可见 | 现在 init_script/cloud_init/env 都是明文，审计还记录 command | `vm_secret set/get/rm`（加密存 `~/.dsh/vm-sandbox/secrets.vault`，可被 init_script/环境变量安全引用 `{{secret:name}}`）；审计脱敏（`token=***`） | 面板/审计无明文 secret；VM 内通过占位符拿到 | v0.4 P0 |
| **B3 网络策略增强** | 支持 IPv6 规则 + 时间窗 + 组级零信任（默认拒绝矩阵） | allowlist 已拒绝元字符，但仅 IPv4 iptables、无 ip6tables、无按主机组策略 | `netpolicy.js`：IPv6 → `ip6tables` 分支；`allowlist` 支持按主机组/时间窗表达式；跨 VM 默认拒绝+显式放行矩阵 | IPv6 域名/IP 放行正确；组策略应用/回滚测试通过 | v0.4 |
| **B4 更强默认** | 新 VM 可选但推荐网络隔离；大文件上传二次确认；exec 输出限流 | 默认全放开；exec 最大回传 16MB 无警告 | 创建向导默认 `isolate_network` 勾选；`vm_upload` >100MB 需 `force`；`vm_exec` 超 8MB 输出改后台任务流式 | 默认态更克制；大输出不再丢 | v0.5 |
| **B5 审计不可篡改 + 敏感脱敏** | 审计 append-only+哈希链；敏感命令脱敏后才入库 | 审计可被直接改 state/文件；记录含命令原文 | `audit.json` 升级为逐条哈希链（prev-hash+vault 签名可选）；写入前对 secret/token 字段脱敏 | 篡改任意一条可被检测；无 token 明文 | v0.5 |
| **B6 供应链锁定** | 模板/镜像来源白名单 + SHA256 校验 | `resolveTemplate` 允许任意 https 拉取 | 默认仅内置+本地工作区模板；远程模板需 `source_url_allowlist` 且校验 sha256 后缓存 | 未知来源模板被拒；缓存命中不重拉 | v1.0 |

### 10.3 更先进（可观测性 / 编排 / 自愈 / IaC）

| 方向 | 目标 | 现状缺口 | 主要改动点 | 验收 | 版本 |
|---|---|---|---|---|---|
| **C1 增强指标 + 阈值告警** | 每核 CPU、IOPS、网络吞吐、进程 Top、磁盘按分区；超阈值通知 | 只有 30s 内存占用率小图 | guest-agent 采样脚本扩展 + 趋势图 + 告警规则（`vm_metrics` 增 `rule`），告警走 DSH 通知 | 面板出现多指标曲线；CPU>90% 会冒烟提醒 | v0.4 |
| **C2 快照内容浏览器/按文件恢复** | 进入快照看文件、按路径定向恢复，而非整机回滚 | 快照只能整体 restore/delete | `orb clone` 出的快照目录以只读挂载浏览（新增 `/vmsb-api/snapshot-browse` GET + `vm_snapshot_file` 提取） | 从快照导出单个文件成功，不触碰原机器 | v0.5 |
| **C3 多机 Playbook 编排** | YAML 定义「角色+步骤+变量」，滚动执行、幂等重放 | `vm_exec` 只有同命令 groups/fail-fast | 新增 `vm_playbook apply/status`：解析 playbook → 复用 groups 顺序执行 → 记录每步哈希支持幂等；`vm_scp` 多机分发 | 10 台滚动部署/回滚一次跑通且重放幂等 | v0.5 |
| **C4 服务自动发现 + 内网小名** | 扫描 VM 监听端口自动登记；`机器.服务` 内网互访引导 | 服务靠人工 register | VM 内周期扫描监听端口 → 汇入 `state.services`；`vm_service_discover` 输出 `m.service@IP` 可直达提示 | 装好 redis 后无需手动登记即在面板可见 | v0.5 |
| **C5 自愈与水位治理** | 探活失败按策略自动重启；磁盘/快照水位告警并自动收敛 | 只有闲置休眠与运行上限 | 每机 `auto_restart/healthcheck` 策略；`enforceRunningCap` 升级为按 CPU·内存·磁盘累计配额 + 优先级队列 | 探活死机自动重启；配额触顶自动休眠最旧并通知 | v1.0 |
| **C6 模板即代码** | 模板 git 化（目录/URL 来源+版本锁定+diff） | 模板只是 state 里的一份 JSON | `vm_template` 支持从目录/仓库清单解析（复用 `parseSimpleYaml`），锁定来源版本；面板 diff 预览 | 模板改动可审阅；来源版本可回退 | v1.0 |

### 10.4 功能更全（补齐高价值缺口）

| 方向 | 目标 | 现状缺口 | 主要改动点 | 版本 |
|---|---|---|---|---|
| **D1 常用工具补齐** | `vm_scp`(批量/多机)、`vm_logs`(统一日志)、`vm_env`(跨 VM 环境变量)、`vm_withdraw`(安全下线并打包导出) | 单文件传输/任务日志分散 | 新增 4 个工具 + 对应 `/vmsb-api`（走 POST 通道）+ 面板入口 | v0.4-v0.5 |
| **D2 生命周期调度 UI** | 定时休眠/唤醒、开机自启名单、每会话用量报表 | 有 cron 工具但无 UI 化调度与报表 | cron 面板化 + `vm_report`(会话级 CPU/内存/时长累计) | v0.5 |
| **D3 导入导出进阶** | 大镜像导出到远端(s3/scp)与分片；导入校验+模板 | 只有本地 `orb export/import` | 导出流式分片 + 目的地选择；导入先 `orb import` 校验再挂模板 | v0.5 |
| **D4 配额治理升级** | 按 CPU·内存累计配额而非仅台数；创建排队 | 只有台数上限 | `vm_policy` 增 `cpu_quota/memory_quota`；创建超限进入等待队列并通知 | v1.0 |

### 10.5 推荐的 v0.4 落地切片（先做最贴近用户 + 最关键安全）

- **v0.4.0（建议这一版）**：A1 交互式 Web 终端 + B1 创建即安全基线 + B2 密钥管理(B1/B2 为 P0) + C1 增强指标告警。两端小步、收益直接、复用既有 S1 POST+CSRF 通道。
- **v0.4.x**：A2 拖拽上传/同步 + B3 网络策略 IPv6/组策略 + D1 工具补齐全。
- **v0.5.0**：A5/A6 配额定位于直觉 + 多会话协作 + C2 快照浏览 + C3 Playbook + D2 调度 UI。
- **v1.0.0**：§7 架构收敛 + B5 审计不可篡改 + B6/C5/C6 供应链·自愈·IaC。

> 与 v0.3.x 待办联动：先在 v0.3.x 收掉 R4（批量任务探测）与 M1（默认不做闲置休眠），再切入 v0.4 终端，避免轮询开销叠加。

### 10.6 风险与取舍（新增）

- **A1 终端**依赖 `registerUpgrade` 契约与 SSH 在目标 VM 可用，是连接型改动，需独立版本发布并做鉴权边界（token + 每连接超时）。
- **B1 默认加固**可能改变部分用户既有「开箱即用全放开」预期 → 提供 `harden:false` 且向导默认勾选（不改默认值之前先给显式开关）。
- **B2 密钥库**新增 vault 文件与加解密，须与 R1 原子写/备份体系一致（密钥文件不入 git、.gitignore 补充）。
- **B5 审计哈希链**会改变 `audit.json` 记录格式，需要版本迁移（沿用 R2 拆分后的文件为新版本起点）。
