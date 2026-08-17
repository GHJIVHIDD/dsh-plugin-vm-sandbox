# dsh-plugin-vm-sandbox

DeepSeek Harness 的**虚拟机沙箱**（Web 部署级插件）。

在会话视图环中新增「虚拟机」页签，为每个会话提供 OrbStack 沙箱虚拟机（debian/alpine，同一会话必要时可多台），支持一键新建/查看/启停/删除、展开查看详细配置，并提供 `vm_list` / `vm_create` / `vm_exec` / `vm_delete` 模型工具（支持 `machine` 参数，必要情况下可跨会话使用）。状态持久化在 `~/.dsh/vm-sandbox/state.json`。

## 功能

- 会话视图环中新增「虚拟机」页签
- 同一会话可创建多台 OrbStack 沙箱虚拟机（必要时），支持 debian（默认）与 alpine；`vm_exec` 省略 `machine` 时复用本会话默认机器
- 跨会话使用：通过 `vm_exec` / `vm_create` 的 `machine` 参数可指定并执行其他会话的虚拟机（删除仍仅限归属会话）
- 实时展示所有沙箱：名称、发行版、状态、归属会话
- 展开查看机器 ID、CPU/内存/磁盘限额、网络/SSH 配置、IP 等详情
- 展开后实时查看该虚拟机的 Shell 执行记录：命令、运行状态、耗时与输出结果（折叠式展示）
- 面板支持一键新建（debian/alpine）、启动、休眠、删除（删除需二次确认）
- 模型工具：`vm_list` / `vm_create` / `vm_exec` / `vm_delete`（`vm_create` / `vm_exec` / `vm_delete` 均支持 `machine` 参数）
- 资源治理：全局运行上限 25 台、每会话上限 8 台、闲置 30 分钟自动休眠、归档/删除会话自动清理

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

> 安装包（`tgz` / `zip`）通过 **GitHub Releases** 发布，不存放在源码仓库中。

## 安装

### 方式 A：使用 dsh plugin 安装预构建 tarball（推荐，需要已安装 pnpm）

从 Releases 下载 tgz 后，在插件包/tgz 所在目录执行：

```bash
# 下载地址：https://github.com/GHJIVHIDD/dsh-plugin-vm-sandbox/releases
dsh plugin --profile web add ./dsh-plugin-vm-sandbox-0.0.3.tgz
```

因为本插件同时带有 `dsh.bundle` 声明，`dsh plugin` 会自动把它加入 profile 的 `bundles` 层，并应用 `cordis.patch.yml` 自动插入虚拟机页签。

## 使用

安装后重启/刷新：

```bash
dsh --profile web
```

打开 Web 界面进入任意会话，在会话视图环中点击「虚拟机」即可看到当前环境中的 OrbStack 沙箱虚拟机；会话智能体也可以通过 `vm_exec` / `vm_create` 等工具自动创建和使用沙箱。

## 更新内容

### v0.0.3（最新）

- 同一会话可创建多台虚拟机（必要时）：
  - `vm_create` 每次调用创建一台新机器，可用 `machine` 参数指定名称（仅小写字母/数字，≤8 位，缺省自动生成）
  - `vm_exec` 省略 `machine` 时复用本会话默认（最近使用）机器，仅在没有任何机器时自动创建，避免重复建机
  - `vm_delete` 增加 `machine` 参数，可删除本会话指定机器；省略时删除默认机器
- 全局运行上限从 5 台提升至 **25 台**；新增每会话上限 8 台（防磁盘耗尽，可在配置常量中调整）
- 跨会话使用：`vm_exec` / `vm_create` 传入其他会话的机器名称时可直接使用（必要情况下跨会话），返回结果带 `ownerSession` / `crossSession` 标识；删除仍仅限归属会话
- 「虚拟机」页签新增「＋ Debian / ＋ Alpine」一键新建按钮，头部展示总台数、运行数、上限与「本会话 N 台」
- 点击新建后立即显示「创建中…」待建行（机器名 + 发行版 + 预计耗时），约 1-3 分钟建好后自动变为正常行；超过 10 分钟未出现则自动消失
- 修复面板新建静默失败：`execFile` 的 `signal` 选项不再传入 `null`（会抛 `ERR_INVALID_ARG_TYPE` 导致后台建机瞬间失败）
- 新旧版本混合运行兼容：客户端按宿主返回的 `cap` 字段门控新能力、`own` 兼容旧版单条记录格式，宿主未重启时刷新页面不会报错或出现无效按钮
- 状态文件 `~/.dsh/vm-sandbox/state.json` 迁移为按会话多台记录（旧单台记录自动兼容迁移）
- 新增 Host 接口：`GET /vmsb-api/create?session=<id>&distro=<debian|alpine>`（异步创建，立即返回）

### v0.0.2

- 新增虚拟机 Shell 实时执行记录：
  - 记录 `vm_exec` 执行的命令、开始/结束时间、耗时、退出码、stdout/stderr 和运行状态
  - 在「虚拟机」页签中展开任意虚拟机，可实时查看该机器的 Shell 记录
  - 每条命令以折叠卡片展示，点击可展开查看完整输出
- 新增 Host 接口：`GET /vmsb-api/shell?name=<machine>`
- 前端每 2 秒自动刷新当前展开虚拟机的 Shell 记录
- 删除虚拟机或对账清理时同步清理对应的 Shell 日志
- UI 风格参考「轨迹 / 对话 / 终端」的折叠式命令记录样式

## 兼容性

- 面向 DeepSeek Harness `web` profile
- 需要 Web 端已启用 `@deepseek-ai/dsh-client-runtime` 与 `@deepseek-ai/dsh-client-ui-conversation`（标准 web profile 自带）
- 宿主机需要安装并运行 OrbStack，`orb` 命令位于 `/usr/local/bin/orb`
- 插件版本：0.0.3
