# omp-purge

[English](README.md) | 中文

omp 的会话级系统提示词开关。

`/purge` 只影响当前会话：替换或精简宿主系统提示词。默认关闭；安装后不执行 `/purge on`，omp 的行为与未安装时一致。

## 安装

```bash
omp plugin install github:362663496/omp-purge
```

固定版本：

```bash
omp plugin install github:362663496/omp-purge#v1.1.1
```

安装后重启 omp 会话。如果插件被停用：

```text
/plugins enable omp-purge
```

本地源码安装：

```bash
omp plugin install ~/.omp/plugins-src/omp-purge
```

项目级：先 clone，再运行：

```bash
OMP_PURGE_SRC=/path/to/omp-purge /path/to/omp-purge/scripts/install-project.sh /path/to/project
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/purge` | 切换当前会话的开 / 关 |
| `/purge on` / `/purge off` | 显式开关 |
| `/purge status` | 查看模式、人设来源、字符数、上轮切除情况 |
| `/purge mode strict\|replace\|append` | 切换组合模式 |
| `/purge source <路径\|embedded>` | 加载人设文件，或恢复内嵌人设 |

## 模式

| 模式 | 发送的系统提示词 |
| --- | --- |
| `strict`（默认） | 人设 + 仅 `Current working directory: ...` |
| `replace` | 人设 + 去掉宿主身份句和文档指引的宿主提示词 |
| `append` | 人设 + 原宿主提示词，保持原样 |

`replace` 用固定文案定位宿主行；匹配不到时保持原样，避免切错位置。

## 工作原理

- `before_agent_start` 按当前模式生成会话系统提示词。
- `before_provider_request` 改写实际请求。omp 把系统提示词放在顶层 `instructions`；omp-purge 把它搬进 `input` 的 developer 消息，让模型按会话级系统指令处理。模型、provider、endpoint 都保持原样。
- 状态只存在内存里。每次 `session_start` 重置为关闭，不写盘。
- 人设内嵌在 `index.ts`。`/purge source` 可加载本地文件；加载失败会回滚到上一个来源。

开启时 footer 显示 `PURGE ON`；print / RPC 模式没有 footer。

## 测试

```bash
bun test/smoke.test.mjs
```

## License

MIT
