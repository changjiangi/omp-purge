# omp-purge

[omp](https://omp.sh) 版的 [pi-purge](https://github.com/ZiChuanLan/pi-purge)：会话级系统提示词开关 `/purge`。

同一个会话里可以在「omp 原提示词 / 精简提示词 / 只发人设」之间切换，用来做提示词工程、指令遵循回归、提示词注入鲁棒性之类的受控实验。

**默认关。** 插件加载后不会改任何提示词；不执行 `/purge on` 时，omp 的行为与没装本插件完全一致。安装后插件本身是 enabled 的（否则 `/purge` 不会注册）；要连插件一起停用，用 `/plugins disable omp-purge`，重启会话。

## 安装

远程安装（推荐，任何机器）：

```bash
omp plugin install github:362663496/omp-purge
```

装完后重启 omp 会话，再执行 `/purge on`。插件本身默认 enabled；如果被关掉，用 `/plugins enable omp-purge` 打开。

本地源码安装（开发 / 用户级）：

```bash
omp plugin install ~/.omp/plugins-src/omp-purge
```

项目级（只在该项目内生效）：

```bash
~/.omp/plugins-src/omp-purge/scripts/install-project.sh /path/to/project
```

脚本会创建 `<project>/.omp/plugins/{package.json,omp-plugins.lock.json}`，并把 `node_modules/omp-purge` 链接到源码目录。项目级同名插件会遮住用户级；禁用的项目级插件不会遮住用户级。也可以按 `scripts/install-project.sh` 里的结构手动放这三个文件。

## 两层开关

| 层级 | 命令 | 作用 |
| --- | --- | --- |
| 插件级 | `/plugins enable omp-purge` | 加载扩展模块；**重启会话**后 `/purge` 才出现 |
| 插件级 | `/plugins disable omp-purge` | 卸载扩展模块；**重启会话**后 `/purge` 消失，提示词完全回到原样 |
| 会话级 | `/purge on` / `/purge off` | 本会话是否注入人设；每次 `session_start` 自动归零 |

命令行等价物：

```bash
omp plugin enable omp-purge
omp plugin disable omp-purge
omp plugin list
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/purge` | 切换本会话开 / 关 |
| `/purge on` / `/purge off` | 显式开关（`enable` / `disable` 同义） |
| `/purge status` | 当前模式、人设来源、字符数，以及上一轮实际切了什么 |
| `/purge mode append\|replace\|strict` | 切换组合方式（默认 `strict`） |
| `/purge source <绝对路径\|embedded>` | 换人设文件，或切回内置人设；失败自动回滚 |

`/purge` 的参数补全支持 `on`、`off`、`status`、`mode`、`source`。

## 模式

| 模式 | 实际发给模型的系统提示词 | 适用场景 |
| --- | --- | --- |
| `append` | 人设块 + omp 原提示词（一字不改） | 对照组：基线行为上叠一层指令 |
| `replace` | 人设块 + 去掉宿主身份句 / 文档指引的 omp 提示词，工具与项目上下文保留 | 测量宿主措辞影响，又不丢工具上下文 |
| `strict` | 人设块 + 仅 `Current working directory: …` | 单变量隔离；默认模式 |

`replace` 用固定文案定位身份句和文档指引，匹配不到就原样保留（退化成 `append`），不会切错位置。`/purge status` 会显示 `身份段 未匹配` / `文档段 未匹配`。

`strict` 不做任何匹配，跨 omp 版本行为一致。

## pi 与 omp 的请求形状差异

同一个模型在 pi 里能按 persona 输出，在 omp 里却按宿主规则拒绝，差异不在模型，而在系统提示词放在请求的哪个位置：

- pi：系统提示词作为 `input` 里的 `developer` 消息发送（`role: "developer"`）。
- omp：把系统提示词放在请求顶层的 `instructions` 字段。

Responses API 对这两种位置的优先级处理不同：顶层 `instructions` 会被服务端提示压过，`developer` 消息则和 pi 一样被当作会话内的系统指令。插件在 `before_provider_request` 里把 `instructions` 原样搬进 `input[0]` 的 `developer` 消息，并删掉顶层 `instructions`，请求形状与 pi 一致；**模型本身不切换**。

验证：`/purge on` 后问「你的名字，以及最高优先级指令来自谁」，应回答 `Little Code Sauce / YG`。

如果某个模型仍拒绝，说明它在服务端还有额外的系统提示；插件只负责把客户端请求改成 pi 的形状，不能改服务端。

## omp 适配点

- omp 的 `before_agent_start` 事件里 `systemPrompt` 是**块数组**，不是 pi 的单个字符串。本插件按块处理，并返回块数组覆盖。
- 宿主身份句按顺序匹配：
  1. `You are omp's trusted coding assistant.`
  2. `You are pi's trusted coding assistant.`
  3. `You are an expert coding assistant operating inside pi, a coding agent harness.`
  4. `You are an expert coding assistant operating inside omp, a coding agent harness.`
- 文档指引匹配 pi 的 `Pi documentation (read only when the user asks about pi itself …)` 段，以及 omp 的 `` `omp://`: harness docs `` 行。
- 工作目录取 `ctx.cwd`（不再依赖 pi 的 `systemPromptOptions.cwd`）。
- 状态栏键为 `purge`，开启时显示 `PURGE ON`；print / RPC 模式没有 footer，调用被静默忽略。
- `before_provider_request` 里把 omp 的顶层 `instructions` 还原成 pi 的 `input[{ role: "developer" }]`；这是 pi/omp 行为差异的核心适配点。
- 工具 schema 走 API 的 `tools` 参数，不依赖系统提示词，所以三种模式下内置工具都可用。`strict` 会丢掉 omp 的 MCP / `xd://` 路由说明（与 pi 版丢掉宿主工具策略的取舍一致）。

## 会话范围与默认值

- 作用范围是**会话**：每次 `session_start`（启动 / 新建 / `resume` / 重载）都从关闭开始；退出 omp 一定回到原始提示词。
- 插件本身**不写任何状态文件**；没有缓存、没有标记。
- 默认人设内嵌在 `index.ts` 的 `EMBEDDED_PERSONA`，与 pi-purge 的正文逐字一致；`/purge source <路径>` 可换成本地文件，`/purge source embedded` 切回来。
- 默认模式 `strict`。

## 文件

```text
~/.omp/plugins-src/omp-purge/
├── package.json          # omp.extensions -> ./index.ts
├── index.ts              # 扩展工厂 + 内嵌人设
├── test/smoke.test.mjs   # 无模型调用的行为断言
├── README.md
└── LICENSE
```

安装后 `~/.omp/plugins/node_modules/omp-purge` 是指向该目录的符号链接；改完源码重启会话即生效。

## 测试

```bash
cd ~/.omp/plugins-src/omp-purge
bun test/smoke.test.mjs
```

测试用 mock `ExtensionAPI` 覆盖：默认关闭、strict / replace / append、会话归零、换源失败回滚、off 恢复、pi/omp 请求形状转换、无盘副作用。
