# Verification suite

每个脚本都驱动**真实的 DSH 组件**——Cordis 容器、Typert 注册表与 loader、
客户端模块合成器、profile 运行时解析器——而不是模拟它们。这套脚本在本项目
开发中真的抓到了 bug，所以它们留在这里，供 DSH 升级后复验。

## 前置条件

1. **Node ≥ 20**（`node` 在 PATH 上）。
2. **一份 DSH 运行时树**（需要带 `node_modules`）。两种来源都行：
   - 安装目录里的 `resources/app.asar.unpacked/dsh`；
   - 或从 `app.asar` 解出来：
     ```
     npx @electron/asar extract "<安装目录>\resources\app.asar" .tools/asar
     ```
     默认路径就是 `.tools/asar/dsh`（已被 `.gitignore` 排除）。
3. **Harness home**，即 `%USERPROFILE%\.dsh`（读 profile 与存储路径用）。

## 运行

```powershell
node verification/run.mjs
# 指定运行时 / home / profile：
node verification/run.mjs --runtime "D:\Software\DSH\resources\app.asar.unpacked\dsh" --home "$env:USERPROFILE\.dsh" --profile desktop
# 只跑一个：
node verification/run.mjs --only host-test.mjs
```

运行器会把 `dsh-session-purge/lib/` 暂存到**运行时树内部**
（`<runtime>/purge-harness/`），并据此设置 `DSH_PLUGIN_DIR`。

> **为什么必须暂存到运行时树里**：插件的裸导入（`zod`、`@deepseek-ai/*`）由 DSH
> 安装本身提供，而安装只为**在 `peerDependencies` 里声明过这些依赖**的链接插件
> 提供路由。把插件放在运行时树内，这些导入就能按真实路径解析——这也是唯一能
> 忠实复现宿主装载过程的方式。

各脚本读取的环境变量（都有默认值）见 [`env.mjs`](./env.mjs)。

## 各脚本覆盖什么

| 脚本 | 覆盖 |
|---|---|
| `host-test.mjs` | 宿主删除逻辑：列表、活动会话拒绝、入回收站、还原、永久删除、未知会话报错、批量失败隔离、**空项目目录回收**、**清空回收站**、描述符形状、`apply()` 装配 |
| `integration-test.mjs` | 真实 Typert 注册表接受手写宿主清单、codec 工厂可 materialize、typert 绑定与描述符一致、`/purge` 与 `session_purge` 注册、未知 id 报错而非抛出 |
| `cordis-load-test.mjs` | 真实 Cordis fiber 装载、配置缺省/显式/非法三种情况、`ctx.inject(['commands'/'tools'])` 回调确实触发 |
| `typert-loader-probe.mjs` | `dsh-typert-loader` 是否真的从 `./typert` 导出抓到并注册了宿主描述符（客户端调用的前提） |
| `compat-test.mjs` | 运行版本与各 `peerDependencies` 区间的兼容性判定（不满足会被**直接拒绝入口**） |
| `resolve-test.mjs` | 装上真实 `PluginPackages` 后按 Loader 的方式 import 插件——复现「依赖未声明 → 静默 inactive」那类失败 |
| `client-test.mjs` | 浏览器包装载、`$mount`、两个插槽注册、字典；**断言 `hooks` 里只能放可观察源**、**菜单行不得渲染对话框**、**`remote.sessionManager` 只存在于注入作用域**；并断言包里 `require` 的每个模块都在前端产物真实的平台种子表内 |
| `client-compose-test.mjs` | 真实客户端合成器把插件行放进启动图、bundle 路径存在、并且**服务出来的字节确实是本包的客户端半边** |

## 注意

- `host-test.mjs` 会在自己旁边建 `scratch/` 并清理掉（已在 `.gitignore` 中）。
- `client-test.mjs` / `client-compose-test.mjs` 需要**已构建的前端产物**
  （`dsh-web-frontend/dist/assets`），因为它要从中提取真实的平台种子表。
- 脚本只读取 Harness home，不会改动它。
