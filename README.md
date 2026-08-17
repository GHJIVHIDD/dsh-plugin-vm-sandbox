# dsh-plugin-vm-sandbox

DeepSeek Harness 的**虚拟机沙箱**（Web 部署级插件）。

在会话视图环中新增「虚拟机」页签，为每个会话提供 OrbStack 沙箱虚拟机（debian/alpine，同一会话必要时可多台），支持一键新建/查看/启停/重启/删除、展开查看详细配置、实时 Shell 日志，并提供完整的模型工具集。状态持久化在 `~/.dsh/vm-sandbox/state.json`。

## 功能（v0.1.0）

- **快照与回滚**：`vm_snapshot` / `vm_snapshot_list` / `vm_restore` / `vm_snapshot_delete`，基于 OrbStack 官方 `orb clone` 实现，按需复制不双倍占用磁盘
- **文件传输**：`vm_upload` / `vm_download`，基于 OrbStack 官方 `orb push` / `orb pull`，支持目录递归
- **生命周期管理**：`vm_start` / `vm_stop` / `vm_restart` / `vm_status`
- **端口转发**：`vm_port_forward` / `vm_port_forward_list` / `vm_port_forward_stop`，基于官方 `ssh MACHINE@orb -N -L`
- **后台任务管理**：`vm_job_submit` / `vm_job_list` / `vm_job_status` / `vm_job_stop` / `vm_job_output`，长任务在 VM 内后台运行，不受单次 `vm_exec` 超时影响
- **操作日志与审计**：`vm_audit`，记录谁在何时对哪台机器做了什么、是否成功、错误信息
- **共享协作完善**：`vm_share` / `vm_unshare` / `vm_policy`，明确归属、exec/manage 权限、每会话配额、闲置休眠/自动删除回收策略
- **网络策略**：`vm_network`，控制公网访问、VM 间内网互通，并提供 OrbStack 官方 `isolated` / `isolate_network` 配置
- **自定义资源规格**：`vm_create` 支持 `cpus` / `memory` / `disk`
- **模板/初始化脚本**：`vm_create` 支持 `init_script`（Shell 自动包装为 cloud-init runcmd）与 `cloud_init`（完整 cloud-config 用户数据）
- **多机并行执行**：`vm_exec` 支持 `machines` 数组并发执行同一命令
- **状态查询增强**：`vm_status` 返回 IP、uptime、CPU/内存/磁盘限额与用量、最近 Shell 记录、归属、权限、快照来源
- 原有能力保留：`vm_list` / `vm_create` / `vm_exec` / `vm_delete`、会话视图环「虚拟机」页签、实时 Shell 记录、运行上限 25 台、每会话上限 8 台、闲置自动休眠、归档/删除会话自动清理

## 文件说明

```
├── package.json               # 仓库根即插件包（含 dsh.bundle / dsh.client 声明）
├── scripts/
│   └── prepare.mjs            # 根包 prepare：构建 dsh-plugin-vm-sandbox/lib
└── dsh-plugin-vm-sandbox/
    ├── package.json           # 内层插件包（用于构建 tarball 发布）
    ├── cordis.patch.yml       # 自动插入「虚拟机」页签的 patch 层
    ├── src/
    │   ├── index.js           # Host 侧实现（源文件）
    │   └── client.js          # 浏览器端虚拟机页签实现（源文件）
    ├── lib/                   # prepare 生成的发布入口（已提交，随包发布）
    │   ├── index.js
    │   └── client.js
    └── scripts/
        └── prepare.mjs        # 内层包 prepare：构建 lib/
```

## 安装

从 Releases 下载 tgz 后在插件包/tgz 所在目录执行：

```bash
dsh plugin --profile web add ./dsh-plugin-vm-sandbox-0.1.0.tgz
```

因为本插件同时带有 `dsh.bundle` 声明，`dsh plugin` 会自动把它加入 profile 的 `bundles` 层，并应用 `cordis.patch.yml` 自动插入虚拟机页签。

## 使用

```bash
dsh --profile web
```

打开 Web 界面进入任意会话，点击「虚拟机」即可看到当前环境中的 OrbStack 沙箱虚拟机；会话智能体可通过 `vm_create` / `vm_exec` / `vm_snapshot` / `vm_upload` / `vm_job_submit` / `vm_network` 等工具自动管理沙箱。

## 兼容性

- 面向 DeepSeek Harness `web` profile
- 需要 Web 端已启用 `@deepseek-ai/dsh-client-runtime` 与 `@deepseek-ai/dsh-client-ui-conversation`
- 宿主机需要安装并运行 OrbStack，`orb` 命令位于 `/usr/local/bin/orb`
- 插件版本：0.1.0

## 验证

```bash
# 静态/结构验证：27 个工具 + schema + 语法
npm run verify

# 集成冒烟测试：会创建并删除临时 OrbStack 虚拟机
VMSB_SMOKE_SESSION=<当前会话ID> npm run smoke
```
