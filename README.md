# dsh-plugin-vm-sandbox

DeepSeek Harness 的**虚拟机沙箱**（Web 部署级插件）。

在会话视图环中新增「虚拟机」页签，为每个会话提供 OrbStack 沙箱虚拟机（debian/alpine），支持查看/启停/删除、展开查看详细配置，并提供 `vm_list` / `vm_create` / `vm_exec` / `vm_delete` 模型工具。状态持久化在 `~/.dsh/vm-sandbox/state.json`。

## 功能

- 会话视图环中新增「虚拟机」页签
- 每会话一台 OrbStack 沙箱虚拟机，支持 debian（默认）与 alpine
- 实时展示所有沙箱：名称、发行版、状态、归属会话
- 展开查看机器 ID、CPU/内存/磁盘限额、网络/SSH 配置、IP 等详情
- 支持启动、休眠、删除（删除需二次确认）
- 模型工具：`vm_list` / `vm_create` / `vm_exec` / `vm_delete`
- 资源治理：全局运行上限 5 台、闲置 30 分钟自动休眠、归档/删除会话自动清理

## 文件说明

```
├── package.json               # 仓库根即插件包（含 dsh.bundle / dsh.client 声明）
├── scripts/
│   └── prepare.mjs            # 根包 prepare：构建 dsh-plugin-vm-sandbox/lib
├── install.sh                 # 免 pnpm 安装脚本
└── dsh-plugin-vm-sandbox/
    ├── package.json           # 内层插件包（用于 tarball / 手动安装）
    ├── cordis.patch.yml       # 自动插入「虚拟机」页签的 patch 层
    ├── src/
    │   ├── index.js           # Host 侧实现（源文件）
    │   └── client.js          # 浏览器端虚拟机页签实现（源文件）
    ├── lib/                   # prepare 生成的发布入口（已提交，便于手动安装）
    │   ├── index.js
    │   └── client.js
    └── scripts/
        └── prepare.mjs        # 内层包 prepare：构建 lib/
```

> 安装包（`tgz` / `zip`）已一并保留在仓库中，也可同时上传到 **GitHub Releases** 发布。
> 仓库根目录本身也是可安装的 bundle，因此也支持 `dsh plugin add github:...` 源码安装。

## 安装

### 方式 A：使用 dsh plugin 安装预构建 tarball（推荐，需要已安装 pnpm）

从 Releases 下载 tgz 后，在插件包/tgz 所在目录执行：

```bash
# 下载地址：https://github.com/GHJIVHIDD/dsh-plugin-vm-sandbox/releases
dsh plugin --profile web add ./dsh-plugin-vm-sandbox-0.0.1.tgz
```

因为本插件同时带有 `dsh.bundle` 声明，`dsh plugin` 会自动把它加入 profile 的 `bundles` 层，并应用 `cordis.patch.yml` 自动插入虚拟机页签。

### 方式 B：从 GitHub 源码直接安装（`dsh plugin add github:...`）

仓库根目录已经是标准的 DeepSeek Harness 组合包（bundle），可以直接从 GitHub 源码安装：

```bash
dsh plugin --profile web add github:GHJIVHIDD/dsh-plugin-vm-sandbox
```

pnpm 拉取源码后会执行本仓库的 `prepare` 脚本，自动把 `src/` 构建到 `lib/`。

> **pnpm ≥ 10 构建授权**：pnpm 10 默认拒绝运行 git 依赖的 `prepare` 脚本。第一次执行上面的命令如果失败，请把 pnpm 提示的包键加入该 profile 的 `pnpm-workspace.yaml`：

```yaml
# 文件位置：~/.dsh/profiles/web/pnpm-workspace.yaml
allowBuilds:
  "@deepseek-ai/dsh-plugin-vm-sandbox": true
```

然后重新执行：

```bash
dsh plugin --profile web add github:GHJIVHIDD/dsh-plugin-vm-sandbox
```

建议同时锁定 commit，避免后续推送悄悄改变实际安装的代码：

```bash
dsh plugin --profile web add github:GHJIVHIDD/dsh-plugin-vm-sandbox#<commit-sha>
```

### 方式 C：免 pnpm 手动安装

克隆源码后，在仓库根目录运行：

```bash
git clone https://github.com/GHJIVHIDD/dsh-plugin-vm-sandbox.git
cd dsh-plugin-vm-sandbox
./install.sh
```

脚本会：

1. 将插件文件复制到 `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-plugin-vm-sandbox`
2. 若 `~/.dsh/profiles/web/cordis.patch.yml` 还没有 `ui-vm-sandbox`，则自动追加 patch 条目

也可以用环境变量指定自定义位置：

```bash
DSH_HOME=/path/to/.dsh DSH_PROFILE=web ./install.sh
```

### 方式 D：手动复制 + patch

```bash
# 1. 复制插件包到 profile 的 node_modules
mkdir -p ~/.dsh/profiles/web/node_modules/@deepseek-ai
cp -R dsh-plugin-vm-sandbox ~/.dsh/profiles/web/node_modules/@deepseek-ai/

# 2. 确认 ~/.dsh/profiles/web/cordis.patch.yml 中包含：
# - insert:
#     - id: ui-vm-sandbox
#       name: '@deepseek-ai/dsh-plugin-vm-sandbox'
```

## 使用

安装后重启/刷新：

```bash
dsh --profile web
```

打开 Web 界面进入任意会话，在会话视图环中点击「虚拟机」即可看到当前环境中的 OrbStack 沙箱虚拟机；会话智能体也可以通过 `vm_exec` / `vm_create` 等工具自动创建和使用沙箱。

## 兼容性

- 面向 DeepSeek Harness `web` profile
- 需要 Web 端已启用 `@deepseek-ai/dsh-client-runtime` 与 `@deepseek-ai/dsh-client-ui-conversation`（标准 web profile 自带）
- 宿主机需要安装并运行 OrbStack，`orb` 命令位于 `/usr/local/bin/orb`
- 插件版本：0.0.1
