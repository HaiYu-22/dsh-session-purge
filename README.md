# dsh-session-purge

**Deep delete for DeepSeek Harness sessions** — remove a session's log, its
projection cache, and its archive entry from disk, instead of only hiding it.

[中文说明在下](#中文说明) · 插件源码在 [`dsh-session-purge/`](./dsh-session-purge) ·
验证套件在 [`verification/`](./verification)

---

## 中文说明

### 它解决什么问题

DSH 侧栏里的「归档」**不删除任何东西**。它只是把一个会话 id 写进
`~/.dsh/storages/workspace.json` 的 `archivedSessionIds`，会话日志仍完整躺在
磁盘上，随时可以「取消归档」恢复。持久化层的文档把这点写成了设计决定：

> Nothing deletes session files — logs accumulate under `root` until removed
> externally; the seam has no deletion API.

所以 DSH 自身没有任何办法回收这些空间。本插件补上这条维护路径。

### 一次删除会清掉什么

| 落点 | 处理 |
|---|---|
| `~/.dsh/sessions/<项目目录>/<会话目录>/`（含该会话全部格式代号的日志文件） | 移入回收站或永久删除 |
| `~/.dsh/storages/session_projcache/sessions/<会话 id>.json` | 删除（派生缓存，丢失只会多一次回放） |
| `~/.dsh/storages/workspace.json` 的 `archivedSessionIds` 条目 | 移除 |
| 清空后的项目目录 | 自动回收 |
| 侧栏列表 | 删除后立即重新拉取，会话行消失 |

### 三种用法

**1. 侧栏菜单**：任意会话行 → `⋯` → **永久删除**（在「归档会话」下面）→ 确认。
不要求先归档。

**2. 斜杠命令** `/purge`（不产生模型消息）：

```
/purge candidates                列出可清理的会话及可回收空间
/purge list                      列出全部已存储会话（含活动/回收站标记）
/purge delete <id...> [permanent]  删除；默认移入回收站，可恢复
/purge delete-archived           清理全部已归档/冷会话
/purge trash                     列出回收站批次
/purge restore <operationId...>  还原批次
/purge empty [<operationId...>]  清空回收站（这一步才真正腾出磁盘空间）
```

**3. 模型工具** `session_purge`：`action` 为
`list` / `delete` / `restore` / `trash` / `empty`。

### 回收站在哪里

```
~/.dsh/sessions/.purge-trash/<时间戳>-<会话id>-<随机>/
  ├── manifest.json     # 会话 id、原始完整路径、原始 cwd、大小、删除时间
  └── session/          # 原会话目录整体
```

**移入回收站并不腾出空间**（只是换目录，仍在同一卷上），要真正回收必须
`/purge empty` 或手工删掉该目录。清空后若无内容，连 `.purge-trash` 目录本身
也会被删掉。

### 设计上的两个安全点

- **活动会话不会被硬删**：后端仍持有它的写句柄，删文件会让内存状态与磁盘不一致。
  插件会先用归档接缝的 `stopActivity` 停掉它的工作并等待；超时则**明确拒绝**
  并给出可执行的下一步。
- **默认可恢复**：不勾「同时永久抹除」就是移入回收站。勾了则直接 unlink，
  不可恢复。

### 安装

```powershell
# 1) 链接进目标 profile 的 node_modules
$profileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
$pkg = "<本仓库路径>\dsh-session-purge"
New-Item -ItemType Directory -Force -Path "$profileDir\node_modules\@dsh-local" | Out-Null
cmd /c mklink /J "$profileDir\node_modules\@dsh-local\dsh-session-purge" "$pkg"

# 2) 在 $profileDir\cordis.patch.yml 顶层数组里加入
#    - insert:
#        - id: session-purge
#          name: '@dsh-local/dsh-session-purge'
```

**注意（最容易踩的一条）**：链接在工作区外的插件，其裸导入（`zod`、
`@deepseek-ai/*`）只有在插件自己的 `package.json` **`peerDependencies`** 里声明过
才会被 DSH 的路由接管；不声明会落到原生解析并**静默判定入口 inactive**——应用
照常启动，插件不出现，也没有任何可见报错。本包已声明。

**生效方式**：宿主半边（`lib/index.js`）由 `dsh-hmr` 监听 profile 配置后就地
挂载；**浏览器半边（`lib/client.js`）的内容每个宿主进程只快照一次**，改完需要
在应用内「插件」页面把本插件**停用再启用**，或完全退出应用重开。

### 已验证

见 [`verification/`](./verification)。八个脚本驱动真实的 Cordis / Typert /
客户端合成器，覆盖删除逻辑、装载、解析、描述符注册、平台种子表、以及三个
客户端插槽契约。运行：

```powershell
node verification/run.mjs
```

插件源码与四个踩坑记录（`peerDependencies` 路由、`Config` 接受缺省、
`hooks` 只放可观察源、对话框不能放进菜单行、`remote.*` 命名空间需注入作用域、
`fs.rm` 删目录必须 `recursive`）都在
[`dsh-session-purge/README.md`](./dsh-session-purge/README.md)。

### 退出与回滚

- 临时停用：在 `cordis.patch.yml` 里把该条改成 `disabled: true`。
- 完全卸载：删掉 insert 条目，再删除 profile 的 `node_modules\@dsh-local\dsh-session-purge`
  链接。插件不写任何自有状态（回收站可手工删除），卸载后磁盘上不留残留。

### 许可

[MIT](./LICENSE) © 2026 HaiYu-22。

仅做本地会话存储维护；删除不可恢复（除非使用默认的回收站路径），请自行确认目标。

