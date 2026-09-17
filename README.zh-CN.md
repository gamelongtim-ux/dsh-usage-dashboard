# dsh-usage-dashboard

DeepSeek Harness（`dsh`）的**用量仪表盘插件**。解析 `~/.dsh/sessions` 下的 zstd 会话日志，把 GitHub 风格的用量总览直接嵌进 **dsh 自带的 Web UI** —— 无需额外服务，同源可用。

![Settings](docs/screenshot-settings.png)

安装后 **Settings → Plugins** 左侧导航会出现 **Usage dashboard**，点开即见实时仪表盘：

![Dashboard](docs/screenshot-dashboard.png)

（[English README](README.md)）

## 功能

- **每日 Token 趋势图**：按模型分线平滑曲线，近 7 日 / 近 30 日切换，悬浮看每日明细
- **模型用量环图**：所选范围内各模型占比
- **活跃度**：累计 Token、峰值、累计使用时长、当前/最长连续天数，53 周 **热力图**（每日/每周/累计着色）
- **用量趋势**：Cache 命中率、Token 总量与日均（对比上一等长周期）；堆叠柱状图支持 **模型/工具 × Token/费用估算**（单价表 ¥/百万 tokens，存浏览器本地可编辑）
- **系统健康度**：各模型高峰期均 **Decode 速度**（tokens/s，从日志流式时间戳增量重建）

## 环境要求

- `dsh` 0.1.5-rc.1+，使用 **web** profile
- `dsh` 运行环境内 Node.js ≥ 22.15 / 24（内置 zstd 解压）
- `pnpm`（`dsh plugin` 命令转发给 pnpm）

## 安装

在运行 `dsh` 的环境里（WSL/Linux/macOS）：

```bash
# 如需先装 pnpm
npm install -g pnpm

# 从本仓库的检出安装
dsh plugin --profile web add file:/path/to/dsh-usage-dashboard

# 或直接从 GitHub 安装
dsh plugin --profile web add github:<your-name>/dsh-usage-dashboard

# 重启 Web UI（bundle 在启动时加载）
dsh web
```

打开 Web UI → **Settings → Plugins**：Global plugins 列表里有 `usage-dashboard/plugin (Enabled)`，侧边栏出现仪表盘入口；也可以直接访问 **http://127.0.0.1:3080/usage-dashboard/**。

更新插件：拉新代码后重跑同一条 add 命令（file/git 安装是拷贝），再重启 `dsh web`。

卸载：`dsh plugin --profile web remove dsh-usage-dashboard`。

### 独立模式（不装 dsh 插件机制）

```bash
node server.js            # http://localhost:7900 （PORT 环境变量可改）
```

同样的解析器和前端，零 npm 依赖。

## 实现原理

dsh 基于 cordis 风格插件体系，插件是声明了如下字段的 npm 包：

```jsonc
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },  // 宿主半边
    "client": { "platform": "web", "inject": [] } // 浏览器半边
  }
}
```

- **宿主半边**（`lib/plugin.js`，由 `cordis.patch.yml` 挂载）：`inject: ['webServer']`，通过 `ctx.webServer.register({ kind: 'prefix', path, handler })` 把仪表盘挂到 dsh 自己的 Web 服务上，提供静态资源与 `/api/data`（每次请求实时解析日志，按 mtime/size 增量缓存，正在进行的会话刷新即见）。
- **浏览器半边**（`lib/client.js`，经 `dsh.client` 扫描后以 `/plugins/??dsh-usage-dashboard/client.js` 服务）：注册 `settings.section` slot，即在 Settings 侧边栏加入口并在右侧 iframe 内嵌仪表盘。组件无依赖、无 hooks，与壳子自带 React 安全共存。

### 数据口径（逆向 dsh 0.1.5-rc.1 日志得出）

- 日志：`~/.dsh/sessions/<项目>/<会话>/session(.v3)?.jsonl.zstd`，多帧 zstd 按魔数 `28 B5 2F FD` 切帧。
- 同目录并存 v3 时**只解析 v3**（v3 是全量重写，防双计）。
- usage：旧版在 `assistant/chunk`（`chunk.type==='usage'`），v3 在 `assistant/message` 的 `data.usage`；`totalTokens = input + output + cacheRead`（input 不含缓存命中，reasoning 含在 output 内）。
- Cache 命中率 = `cacheRead / (input + cacheRead)`。
- Decode 速度：v3 用 `data.stream` 的 `time0+dt[]` 增量时间戳重建流式跨度；旧版用同 `(turn,step)` chunk 时间跨度；<200ms 不计。
- 时长：会话内相邻事件间隔 5 分钟封顶；连续天数按"当日 tokens>0"。
- 个别旧文件有 `time≈0` 脏事件，2020-01-01 前一律丢弃（`/api/data` 的 `dirty` 字段可诊断）。

## 目录结构

```
package.json          dsh.bundle + dsh.client 声明
cordis.patch.yml      插入 usage-dashboard 行（挂载路径在此改）
lib/plugin.js         宿主半边：webServer 前缀路由 + 静态资源 + API
lib/aggregate.js      日志解析与聚合（插件/独立模式共用）
lib/client.js         浏览器半边：Settings 分区 + iframe 内嵌
public/               仪表盘前端（原生 HTML/CSS/JS，手写 SVG 图表）
server.js, start.cmd  独立模式（7900 端口）
```

## License

[MIT](LICENSE)
