# dsh-session-purge

深度删除 DeepSeek Harness 会话的插件：把「只能归档隐藏」变成**真的从磁盘删掉**。

## 为什么需要它

DSH 的侧栏「归档」并不删除任何东西。它只是把一个会话 id 写进
`~/.dsh/storages/workspace.json` 的 `archivedSessionIds`，会话日志仍然
完整地躺在磁盘上，随时可以「取消归档」恢复。持久化层的文档把这一点写成
了设计决定：

> Nothing deletes session files — logs accumulate under `root` until removed
> externally; the seam has no deletion API.

本插件补上这条缺失的维护路径。

## 一次「深度删除」会清掉什么

| 落点 | 处理 |
|---|---|
| `~/.dsh/sessions/<项目目录>/<会话目录>/`（含 `session.v4.jsonl.zstd` 等全部代号文件） | 移入回收站或永久删除 |
| `~/.dsh/storages/session_projcache/sessions/<会话id>.json` | 删除（派生缓存，丢失只会多一次回放） |
| `~/.dsh/storages/workspace.json` 的 `archivedSessionIds` 条目 | 从归档集合移除 |
| 清空后的项目目录 | 自动回收 |
| 侧栏列表 | 删除后立即重新拉取，会话行消失 |

**运行中的会话不会被直接删掉**：持久化后端此时持有它的写句柄，删掉文件会被
下一次写入重新创建。所以删除一个活动会话时，插件会先用归档接缝的
`stopActivity` 停掉它（并等待它离开活动会话表），超时才报错、不碰文件。

## 三种用法

### 1. 侧栏菜单（图形界面）

在**任意**会话行上打开 `⋯` 菜单 → 最后一项 **永久删除**（红色）→ 确认对话框。
默认移入回收站；勾选「同时永久抹除」则直接 unlink。

这一项对每个会话都出现，**不要求先归档**。早先的版本只在已归档会话上显示，
那是个坏设计：已归档行默认被视图过滤掉，等于把维护入口藏在第二步之后。以
「先归档」为前提也不成立，因为删除路径自己就会停止活动会话；确认框会按当前
状态区分文案（已归档 / 未归档可能仍在运行）。

### 2. 斜杠命令 `/purge`

在输入框里直接敲，不产生模型消息：

```
/purge candidates              列出可清理的会话（已归档或冷会话）及可回收空间
/purge list                    列出全部已存储会话（含活动/回收站标记）
/purge delete <id...>          删除，移入回收站（可恢复）
/purge delete <id...> permanent  永久抹除
/purge delete-archived         清理全部已归档/冷会话（默认入回收站）
/purge trash                   列出回收站里的批次
/purge restore <operationId...>  把批次还原回原路径
/purge empty [<operationId...>]  清空回收站（这一步才真正腾出磁盘空间）
```

命令始终拒绝对「正在运行该命令的会话」下手。

### 3. 模型工具 `session_purge`

`action` 为 `list` / `delete` / `trash` / `restore` / `empty`，参数含义与上面一致。

## 回收站（默认兜底）

默认删除是**可恢复**的：会话目录被移动到

```
~/.dsh/sessions/.purge-trash/<时间戳>-<会话id>-<随机>/ 
  ├── manifest.json     # 会话 id、原路径、原始 cwd、大小、删除时间
  └── session/          # 原会话目录整体
```

**注意：移入回收站并不会腾出磁盘空间**——文件只是换了目录，仍在同一个卷上。
要真正回收，必须清空回收站：`/purge empty`，或直接删掉 `.purge-trash` 目录。
回收站清空后如果已无内容，插件会把 `.purge-trash` 目录本身也删掉，不留痕迹。

`manifest.json` 自带全部还原信息，即使不用本插件，手工把 `session/` 挪回
`manifest.json` 里的 `originalSessionDir` 也能恢复。`/purge trash` 与
`/purge restore` 就是围绕它工作的。

不需要回收站时用 `permanent`，或在配置里把 `allowPermanent` 关掉。

## 安装

插件包位于工作区 `dsh-session-purge/`。安装到某个 profile 需要两步：
把包链接（或安装）进该 profile 的 `node_modules`，再在 profile 的
`cordis.patch.yml` 里插入一行。

```powershell
# 1) 链接（Windows）
$profileDir = "$env:USERPROFILE\.dsh\profiles\<profile>"
$pkg = "D:\AgentProject\DSH会话删除\dsh-session-purge"
New-Item -ItemType Directory -Force -Path "$profileDir\node_modules\@dsh-local" | Out-Null
cmd /c mklink /J "$profileDir\node_modules\@dsh-local\dsh-session-purge" "$pkg"

# 2) 在 $profileDir\cordis.patch.yml 顶层数组里加入
#    - insert:
#        - id: session-purge
#          name: '@dsh-local/dsh-session-purge'
```

然后在 **设置 → 插件** 里把它作为普通包安装亦可（包内声明了
`dsh.bundle.patch`），本机已用链接方式装好 desktop profile。

### 两个必须遵守的装载约定（踩过的坑）

**1. 插件必须声明自己的依赖。** 一个链接在 profiles 树之外（或未装进
profile `node_modules`）的插件，DSH 只按一条规则接管它的裸导入：`app-boot` 的
`routeLinked()` 会向上遍历导入者的 `node_modules`，只有在某一层目录的
`package.json` 把该名字写进 **`peerDependencies`** 时才路由到安装自带的副本。
不声明 → 落到原生 Node 解析 → `zod` / `@deepseek-ai/dsh-*` 全部
`ERR_MODULE_NOT_FOUND`，而**入口会被静默判为 inactive**：应用照常启动，插件
不出现，也没有任何可见报错。所以本包声明了：

```json
"peerDependencies": {
  "@deepseek-ai/dsh-tools": "^0.2.0-rc.2",
  "@deepseek-ai/dsh-typert-protocol": "^0.2.0-rc.2",
  "zod": "^4.0.0"
}
```

只有 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 会参与版本比对（不满足会**直接
拒绝该入口**）；区间用 `^0.2.0-rc.2` 这类能被当前运行版本（`0.2.0-rc.2`）满足
的写法即可，`workspace:*` 会被解释成「当前运行版本」。

**2. `Config` 必须接受「整行没有 config」**。Cordis 通过 Standard Schema 的
`Config['~standard'].validate(config)` 校验配置，而**没有 config 的行传的是
`undefined`**。zod 的 `z.object()` 会拒绝 `undefined`：

```
ValidationError: invalid config:
  - Invalid input: expected object, received undefined
```

schemastery 会自动兜底，zod 必须显式写 `.default({})`。另外 zod 的
`.default({})` 只负责「接受缺省」，**不会**把内层字段默认值补上，所以字段默认
值在 `resolveConfig()` 里显式兜底。

### 生效方式（Desktop 端与 CLI 端不同）

**宿主半边**：profile 的 `cordis.patch.yml`、`package.json` 与 home patch 由
`dsh-hmr` 监听，改完约几秒内配置层重新组合，新入口**就地挂载**，不必重启。
本机就是这么生效的（宿主进程未重启，`/purge` 与 `session_purge` 已可用）。

**浏览器半边**：**必须重启 Desktop 应用**，刷新窗口没用。原因有两条，都已
在实现里核实：

1. `dsh-client-modules` 的前端包内容**每个宿主进程只快照一次**。
   `reconcilePackage()` 在 `sourceKey`（只含 Loader 入口名与解析基点，**不含
   文件元数据**）未变时直接早退，所以配置热重载不会重新读取 `lib/client.js`。
   只有进程重启，或把该入口**停用再启用**（表项被删除后重建，才会重新快照），
   才会拿到新内容。
2. Desktop 端不是浏览器：`dsh-desktop-host` 把 Harness 作为独立子进程运行
   （`dsh web --port 19387`），并在 `ready` 时通过 IPC 把带令牌的 URL 与整套
   index 注入行（含 `window.__DSH_BOOT__`）交给 Electron 主进程渲染窗口。
   窗口没有「刷新页面重新取启动图」这条路，也没有 DevTools 可用。

因此 Desktop 端的正确迭代姿势是：改 `lib/index.js`（宿主）→ 热重载即可；
改 `lib/client.js`（浏览器）→ 触发一次**重新快照**。有两条路：

1. **在应用内的「插件」页面把本插件停用再启用**（不必重启应用）。停用会把表项
   从客户端合成表里删除，重新启用时 `reconcilePackage()` 看到表项为空，就会
   重新读取 `lib/client.js`；页面通过 HMR 跟随模块图，新内容直接生效。
   该入口在插件列表里是可寻址的：`listPlugins()` 会把 profile patch 组合后的行按
   id 匹配（本插件为 `id: session-purge`），因此可以切换。
2. **完全退出应用再打开**（一定有效，但慢）。

Desktop 有「关闭到后台」行为，关窗口不等于退出：要用托盘图标右键退出，或菜单
「应用 → 退出」，并确认任务管理器里已无 `DeepSeek Harness` 进程。

### 配置项

| 字段 | 默认 | 含义 |
|---|---:|---|
| `stopTimeoutMs` | `15000` | 请求停止会话后，等待它离开活动表的上限；超时报错而不删文件 |
| `allowPermanent` | `true` | 是否允许 `permanent`（不可恢复）删除 |
| `loadBeacon` | 无 | 调试用：填入文件路径后，宿主端每次加载成功会往里追加一行（含时间与 pid）。DSH Desktop 不留可读日志，这是确认「宿主端到底有没有加载」的最直接手段 |

写在 profile 的同一条 patch 记录里：

```yaml
- insert:
    - id: session-purge
      name: '@dsh-local/dsh-session-purge'
      config:
        stopTimeoutMs: 20000
        allowPermanent: false
        loadBeacon: 'D:\path\to\plugin-load.log'
```

## 客户端插槽的一个坑（本插件踩过）

向 `sidebar.workspaces.session.menu.item` 这类插槽注册条目时，**条目自己的
`inject` 只能通过 `hooks` 提供「可观察源」或「hook 工厂」**。渲染器会把 `hooks`
里的每个值交给 `observableHook()` → `bindSnapshotSelector()`，后者直接调用
`source.subscribe(fn)` 与 `source.getSnapshot()`：

```js
// dsh-client-ui-renderer/lib/client.js
function bindSnapshotSelector(w) {
  const subscribe = (fn) => w.subscribe(fn)
  const getSnapshot = () => w.getSnapshot()
  ...
}
```

所以 `hooks: { archived: new Set(...) }` 这种写法会在**每次渲染**抛
`TypeError: w.getSnapshot is not a function`；该异常被插槽的错误边界
（`SlotErrorBoundary` → `deadCell()`）吞掉，只渲染一个空的
`<div data-slot-error>` —— **没有任何可见症状**，条目就像从没注册过。

另外，外层 `renderSlot("sidebar.workspaces.session.menu.item", …)` 只传
`sessionId` 与 `displayTitle` 两个 props，并用 `{ hookContext }` 绑定时段声明的
hook 工厂（`useMenuOpenState`）。**`useArchived`/`usePinned` 之类是各条目自己
`inject` 的**，不是外层给的；要读归档状态就得自己提供一个真正的可观察源，或者
干脆不依赖它（本插件的菜单项就不依赖，确认框文案对两种情况都成立）。

因此本插件的菜单条目只 `inject` 一个普通名字（`requestDelete`），并把这条契约
写进了自检：`client-test.mjs` 里的 `bindInjectFace()` 复现真实绑定，凡是非
可观察值放进 `hooks` 就报错。

## 对话框不能放在菜单项里（本插件也踩过）

菜单项组件**会随菜单一起卸载**。把确认框渲染在菜单项内部（哪怕用了
`createPortal`，portal 仍属于该组件的 React 子树）意味着：点「永久删除」→
`setMenuOpen(false)` 关闭菜单 → 组件卸载 → 对话框在**同一帧被拆掉**。
表现是**点击后毫无反应**，既不报错也不删除。`ui-workspace` 的源码里写明了这条：

> The dialog lives outside the row menu **because the row unmounts with the menu**.

正确结构（本插件采用）：

- 菜单条目（`sidebar.workspaces.session.menu.item`）只**发起请求**：把
  `{ sessionId, displayTitle }` 写进一个可观察单元，然后关闭菜单；
- 确认框挂在**全局** `shell.overlay` 槽上（本插件的
  `SessionDeleteDialog`），从该单元读取待确认请求，确认后调用 Remote 并清空单元。

回归断言也写进了自检：菜单行渲染结果里**不允许出现 `Modal`**。

## Remote 命名空间不能写进静态 `inject`（本插件踩过的第三个坑）

`ctx.remote.<namespace>` 是一个**独立的服务键**，而 Cordis 的上下文只允许读取
该作用域 `inject` 里声明过的服务。即使已经声明了 `inject: ['remote']`，直接访问
`ctx.remote.sessionManager` 仍会抛：

```
cannot get property "remote.sessionManager" without inject
```

可把它写进插件的静态 `inject` 又会**死锁**：这个命名空间正是插件自己在
`apply()` 里 `$mount` 出来的，静态依赖永远等不到它。

正确做法（`voice-input` 也是这么写的）：**先 mount，再在声明了该命名空间的子
作用域里注册用得到它的 UI**。

```js
// 静态依赖里刻意不含 remote.sessionManager
const inject = ['remote', 'slots', 'locale', 'workspaces', 'sessions']

async function apply(ctx) {
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  const ui = ctx.inject(['remote.sessionManager'], (scope) => {
    // 只有这里的 scope.remote.sessionManager 可读
  })
  await ui
  return async () => { await ui.dispose(); await disposeRemote() }
}
```

自检里同样复现了这条限制：`ctx.remote.sessionManager` **只存在于注入作用域**，
插件自身上下文上没有它——一旦改回 `ctx.remote.sessionManager`，就会像浏览器里
一样立刻报错。

## 活动会话的删除策略

删除一个**仍在本应用中打开**的会话时，插件会先用归档接缝的 `stopActivity`
停掉它的工作，然后等待它离开活动会话表（默认最多 `stopTimeoutMs` = 8 秒）。
但 DSH 不会因为归档就关闭一个已经进入的会话——持久化后端仍持有它的写句柄，
此时删文件会让内存状态与磁盘不一致。所以等待超时后会**明确拒绝**并给出可执行
的下一步（退出应用重开后再删；没被重新打开的会话保持冷状态、可直接删除）。

实践中只有极少数会话是活动的：本机 15 个会话里只有 2 个。批量清理冷会话用
`/purge delete-archived`。

## 宿主端的一个坑：`fs.rm` 删目录必须带 `recursive`

`fs.rm(dir, { recursive: false })` 对目录会抛 `ERR_FS_EISDIR`。本插件原本用这个
写法回收「已清空的项目目录」，异常被同一段 `try/catch` 吞掉，于是**每个被清空的
项目目录都静静地留了下来**，而自检当时只覆盖了「项目目录里还有别的会话」那一路，
所以没暴露。现在改成 `recursive: true`（前面已确认目录为空，递归无害），并且自检
新增了「删掉某项目目录里最后一个会话后，该目录必须消失」的用例。

## 包结构

```
dsh-session-purge/
├── package.json          # bundle / client / typert 三处声明
├── cordis.patch.yml      # bundle 层：插入本插件
└── lib/
    ├── index.js          # 宿主端：SessionPurge 服务 + /purge 命令 + session_purge 工具
    ├── paths.js          # 会话存储布局（编码、定位、扫描）
    ├── typert.host.js    # ./typert 宿主面清单（网关校验用）
    └── client.js         # 浏览器面：侧栏菜单项 + 确认对话框 + 结果提示
```

宿主端只用公开的服务做判断和清理，不复制持久化后端的编码逻辑；唯一从后端
镜像过来的是「会话 id → 目录名」的转义与目录布局，因为接缝本身不发布路径。

## 已验证 / 未验证

自检脚本在仓库的 [`verification/`](../verification) 目录，用运行器一次跑完：

```powershell
node verification/run.mjs
```

运行器会把 `lib/` 暂存进 DSH 运行时树（插件的裸导入靠 `peerDependencies`
路由，必须在树内才能解析），因此脚本不再依赖任何固定路径。各脚本覆盖范围见
[`verification/README.md`](../verification/README.md)。

**已在真实运行的应用里验证**：

- 宿主端全链路——`/purge`、`session_purge` 工具都可用；
- 真实删除——4 个会话被移除，其中 2 个进了回收站、2 个按「同时永久抹除」直接
  unlink；四个会话的投影缓存文档与 `workspace.json` 的归档条目都已清干净；
- 侧栏菜单的**永久删除**与确认框可用（这也是本项目修掉三个客户端插槽 bug 之后
  才成立的）。

**未验证**：DSH 版本升级后的兼容性。`compat-test.mjs` 只判定
`peerDependencies` 区间是否被当前运行版本满足；一旦 DSH 改了插槽、Typert
描述符或客户端合成器的契约，需要按 `verification/` 的报错重新核对。

## 退出与回滚

- 临时停用：在 `cordis.patch.yml` 里把该条改成 `disabled: true`。
- 完全卸载：删掉 `cordis.patch.yml` 里的 insert 条目，再删除
  `profiles\<profile>\node_modules\@dsh-local\dsh-session-purge` 链接。
  插件不写任何自有状态，卸载后磁盘上不会留下残留。

## 许可

[MIT](../LICENSE) © 2026 HaiYu-22。

