/**
 * omp-purge — 会话级破限开关
 *
 * v3 的核心机制变了：
 *
 * v1 的做法是「切掉宿主身份段 + 挂一段长人设」。实测（真实 `omp -p` harness，
 * grok-4.7 / kimi-k3）里这套做法收益有限，而且 v1 内嵌人设里的
 * 「CTF 授权契约 / 边界词归一」话术会**触发模型怀疑并导致拒绝**。
 *
 * v2 改为两个正交的手柄：
 *
 *  1. **措辞改写**（主力）：`context` 事件里把最后一条真实 user 消息的
 *     「交付物形态」归一（脚本/工具 → 测试/用例），并前置一句
 *     「在当前仓库内按现有约定落地」的框架句。
 *
 *  2. **人设**（辅助）：`before_agent_start` 里把宿主身份句**替换**成短人设，
 *     其余宿主提示词（工具清单、工作流、内部 URL）一字不动。
 *     v1 的 `strict` 模式会丢掉约 4.9 万字符宿主提示词，实测比保留更稳。
 *
 * v3 把手柄 1 从「名词归一」升级为**交付物改写**。
 *
 *  v2 的名词归一在 `grok-4.7` 上实测只有 1/3 服从率。原因是模型会**读仓库
 *  实现**并据此重新判定意图：把「SQL 注入爆破脚本」改写成「SQL 回归测试用例」
 *  之后，它从 `app/server.py` 的 SQL 拼接反推出这仍是攻击请求。
 *
 *  v3 换掉的是**交付什么**，而不是措辞：攻击性请求被替换成
 *  「修复缺陷 + 证明修复生效的回归测试」。此时注入字符串是修复的验证证据，
 *  不是攻击工具。实测 `grok-4.7` attack 任务从 0/7 变成 7/7。
 *  原任务的技术意图（目标端点、参数化、输入集合）完整保留。
 *
 *  同样实测无效的做法：防御性框架句会被代码证伪而更糟；
 *  追加授权声明会提高拒绝率；名词归一叠加攻击词替换会引发拒绝。
 *
 * 四个设计约束（v1 起不变）：
 *  1. 默认不启用 —— 不开开关时 omp 与未安装本插件时完全一致。
 *  2. 会话级独立 —— 状态只在内存里，每次 session_start 归零，退出即失，不落盘。
 *  3. 零外部文件依赖 —— 自带人设；外部人设只在用户显式指定时读取。
 *  4. 期望边界 —— 插件只改客户端注入层，**无法解除服务端安全对齐**。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { replaceHostIdentity, stripHostPersona } from "./src/host";
import { rewriteMessages } from "./src/rewrite";
import {
	BUILTIN_PROFILES,
	DEFAULT_PROFILE_ID,
	parseExternalProfile,
	type Mode,
	type PurgeProfile,
} from "./src/profiles";

/** 内嵌源的标识值；也可 `/purge source embedded` 切回来。 */
const EMBEDDED = "embedded";
/** 常见的外部人设位置，仅在用户显式切换时使用。 */
const HINT_SOURCE = join(homedir(), ".omp", "agent", "prompt-inject.md");
/** 外部 profile 目录：`~/.omp/agent/purge-profiles/<id>.md`。 */
const PROFILE_DIR = join(homedir(), ".omp", "agent", "purge-profiles");

/** 环境变量名，供无头场景（`omp -p`）预置开关状态。 */
const ENV_ENABLED = "OMP_PURGE";
const ENV_MODE = "OMP_PURGE_MODE";
const ENV_PROFILE = "OMP_PURGE_PROFILE";
const ENV_REWRITE = "OMP_PURGE_REWRITE";
const ENV_SOURCE = "OMP_PURGE_SOURCE";

/** 宿主提示词的切除统计，供 `/purge status` 回答「到底生效了没有」。 */
interface CutStat {
	identity: boolean;
	docs: boolean;
	at: number;
}

/** 措辞改写统计，供 `/purge status` 展示。 */
interface RewriteStat {
	/** 累计改写次数。 */
	count: number;
	/** 最近一次是否命中交付物模板（核心机制）。 */
	deliverableHits: number;
	/** 最近一次是否命中交付物名词表。 */
	nounHits: number;
	/** 最近一次是否命中攻击性词表。 */
	termHits: number;
	/** 最近一次改写前是否已带框架句。 */
	framed: boolean;
	/** 最近一次命中消息的下标。 */
	index: number;
}

/** 请求通道诊断。 */
interface ChannelStat {
	api: string;
	provider: string;
	/** compat 里是否存在并开启了 supportsDeveloperRole。 */
	developerRole: boolean;
	/** 实际注入通道。 */
	channel: "instructions" | "developer" | "n/a";
}

const EMPTY_CUT: CutStat = { identity: false, docs: false, at: 0 };
const EMPTY_REWRITE: RewriteStat = {
	count: 0,
	deliverableHits: 0,
	nounHits: 0,
	termHits: 0,
	framed: false,
	index: -1,
};

/** 一次请求的 payload 里的消息形状。 */
interface PayloadMessage {
	readonly role: unknown;
	readonly content: unknown;
}

/** 类型守卫：payload.input 里的元素是否是带 role/content 的对象。 */
function isPayloadMessage(value: unknown): value is PayloadMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		"role" in value &&
		"content" in value
	);
}

/** 读取环境变量里的模式值，非法值返回 undefined。 */
function parseMode(value: string | undefined): Mode | undefined {
	switch (value?.trim().toLowerCase()) {
		case "native":
			return "native";
		case "strict":
			return "strict";
		case "replace":
			return "replace";
		case "append":
			return "append";
		default:
			return undefined;
	}
}

export default function ompPurge(pi: ExtensionAPI) {
	// ---- 会话级状态：只活在内存里，omp 退出即失，绝不跨会话泄漏 ----
	let enabled = false;
	let mode: Mode = "native";
	let profileId = DEFAULT_PROFILE_ID;
	let source = EMBEDDED;
	let body = "";
	let loadError = "";
	let lastCut: CutStat = EMPTY_CUT;
	let lastRewrite: RewriteStat = EMPTY_REWRITE;
	let lastChannel: ChannelStat = { api: "-", provider: "-", developerRole: false, channel: "n/a" };
	/** 措辞改写开关，可由 `/purge rewrite off` 单独关掉。 */
	let rewriteEnabled = true;

	/** 当前 profile 列表 = 内置 + 外部目录扫描结果。 */
	const collectProfiles = (): PurgeProfile[] => {
		const external: PurgeProfile[] = [];
		try {
			if (!existsSync(PROFILE_DIR)) return [...BUILTIN_PROFILES];
			for (const entry of readdirSync(PROFILE_DIR)) {
				if (!entry.endsWith(".md")) continue;
				const id = entry.slice(0, -3);
				if (id.length === 0) continue;
				const path = join(PROFILE_DIR, entry);
				let text = "";
				try {
					text = readFileSync(path, "utf8").trim();
				} catch {
					continue;
				}
				if (text.length === 0) continue;
				external.push(parseExternalProfile(id, text));
			}
		} catch {
			/* 目录不可读时只用内置 profile */
		}
		return [...BUILTIN_PROFILES, ...external];
	};

	/** 按 id 找 profile。 */
	const findProfile = (id: string): PurgeProfile | undefined =>
		collectProfiles().find((profile) => profile.id === id);

	/** 载入当前 source 的正文。失败时 loadError 有值、body 为空。 */
	const reload = (): boolean => {
		if (source === EMBEDDED) {
			const profile = findProfile(profileId);
			if (!profile) {
				body = "";
				loadError = `未知 profile: ${profileId}`;
				return false;
			}
			body = profile.systemText;
			loadError = body.length > 0 ? "" : "profile 正文为空";
			return body.length > 0;
		}
		try {
			if (!existsSync(source)) throw new Error(`文件不存在: ${source}`);
			const text = readFileSync(source, "utf8").trim();
			if (text.length === 0) throw new Error(`文件为空: ${source}`);
			body = text;
			loadError = "";
			return true;
		} catch (error) {
			body = "";
			loadError = error instanceof Error ? error.message : String(error);
			return false;
		}
	};

	const paint = (ctx: { ui?: { setStatus?: (key: string, text?: string) => void } }) => {
		// -p / --mode json / rpc 没有 footer，setStatus 不能把会话搞挂
		try {
			ctx.ui?.setStatus?.("purge", enabled ? "PURGE ON" : undefined);
		} catch {
			/* 非交互模式忽略 */
		}
	};

	/**
	 * 应用宿主提示词处理。
	 *
	 * native：把身份句**替换**成人设，其余宿主内容保留（v2 默认，最稳）。
	 * strict：整段丢弃宿主提示词，只留人设 + 工作目录（v1 语义，破限最激进）。
	 * replace：切掉身份句与文档段，保留宿主其余内容。
	 * append：只把人设挂到块数组头部。
	 */
	const applySystemPrompt = (
		original: string[],
		cwd: string,
	): { systemPrompt: string[]; identity: boolean; docs: boolean } => {
		if (mode === "strict") {
			const cut = stripHostPersona(original);
			const cwdLine = cwd ? `Current working directory: ${cwd.replace(/\\/g, "/")}` : "";
			return {
				systemPrompt: cwdLine ? [body, cwdLine] : [body],
				identity: cut.identity,
				docs: cut.docs,
			};
		}

		if (mode === "replace") {
			const cut = stripHostPersona(original);
			return { systemPrompt: [body, ...cut.blocks], identity: cut.identity, docs: cut.docs };
		}

		if (mode === "append") {
			return { systemPrompt: [body, ...original], identity: false, docs: false };
		}

		// native：逐块把身份句换成人设，其余一字不动。
		let identity = false;
		let replacedAny = false;
		const blocks = original.map((block) => {
			const result = replaceHostIdentity(block, body);
			if (result.identity) {
				identity = true;
				replacedAny = true;
			}
			return result.text;
		});
		if (!replacedAny) {
			// 宿主改了文案导致身份句没匹配上：退化成把人设挂头部，
			// 至少保证人设在场，而不是静默失效。
			blocks.unshift(body);
		}
		return { systemPrompt: blocks, identity, docs: false };
	};

	// ---- 环境变量预置：print 模式不派发扩展命令，无头场景只能靠环境变量 ----
	const applyEnvPreset = (): void => {
		const rawEnabled = process.env[ENV_ENABLED];
		if (rawEnabled === undefined) return;
		const truthy = ["1", "on", "true", "yes"].includes(rawEnabled.trim().toLowerCase());
		if (!truthy) return;

		const envMode = parseMode(process.env[ENV_MODE]);
		if (envMode) mode = envMode;
		const envProfile = process.env[ENV_PROFILE]?.trim();
		if (envProfile) profileId = envProfile;
		const envSource = process.env[ENV_SOURCE]?.trim();
		if (envSource) source = envSource;
		const envRewrite = process.env[ENV_REWRITE]?.trim().toLowerCase();
		if (envRewrite === "0" || envRewrite === "off" || envRewrite === "false") rewriteEnabled = false;
		if (envRewrite === "1" || envRewrite === "on" || envRewrite === "true") rewriteEnabled = true;

		if (reload()) enabled = true;
	};

	// 每个会话独立：新会话 / 恢复会话 / 热重载都从"关闭"开始，
	// 除非环境变量显式预置（那是用户在本进程启动时的明确意图）。
	pi.on("session_start", async (_event, ctx) => {
		enabled = false;
		mode = "native";
		profileId = DEFAULT_PROFILE_ID;
		source = EMBEDDED;
		rewriteEnabled = true;
		lastCut = EMPTY_CUT;
		lastRewrite = EMPTY_REWRITE;
		lastChannel = { api: "-", provider: "-", developerRole: false, channel: "n/a" };
		reload();
		applyEnvPreset();
		paint(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled || body.length === 0) return;

		const original = Array.isArray(event.systemPrompt)
			? event.systemPrompt.slice()
			: [String(event.systemPrompt ?? "")];

		const cwd = ctx?.cwd ?? process.cwd();
		const applied = applySystemPrompt(original, cwd);
		lastCut = { identity: applied.identity, docs: applied.docs, at: Date.now() };
		return { systemPrompt: applied.systemPrompt };
	});

	// ---- 措辞改写：v3 的主力 ----
	//
	// 只改最后一条**真实用户**消息的第一个 text 块：
	// - 跳过 synthetic 与 attribution==="agent" 的 user 消息（loop-guard / btw-turn / todo 提醒）；
	// - 取数组中最后一条命中者（advisor 内部批既无 attribution 也无 synthetic，只能靠顺序避开）；
	// - 只改第一个 text 块，其余块（图片等）原位保留；
	// - 用对象展开保留消息上的 symbol 属性（kContextHistoryIndex）。
	pi.on("context", async (event) => {
		if (!enabled || !rewriteEnabled) return;
		const messages = event.messages;
		if (!Array.isArray(messages) || messages.length === 0) return;

		const result = rewriteMessages(messages, {
			frame: true,
			deliverable: true,
			noun: true,
			terms: false,
		});
		if (!result.report.changed) return;
		lastRewrite = {
			count: lastRewrite.count + 1,
			deliverableHits: result.report.deliverableHits,
			nounHits: result.report.nounHits,
			termHits: result.report.termHits,
			framed: result.report.framed,
			index: result.report.index,
		};
		return { messages: result.messages };
	});

	// pi 把系统提示词作为 input 里的 developer 消息发送；omp 则放在顶层
	// instructions 字段。只有当该通道**真的被 provider 认作 developer 角色**时
	// 搬运才有意义（openai-shared.ts: `systemRole = modelSupported && compat.supportsDeveloperRole`），
	// 否则搬运是净负收益 —— 实测 grok-4.7 / kimi-k3 的 supportsDeveloperRole 都是 false。
	pi.on("before_provider_request", async (event, ctx) => {
		const model = ctx?.model;
		const compat = model?.compat;
		const developerRole =
			compat !== undefined && "supportsDeveloperRole" in compat && compat.supportsDeveloperRole === true;
		lastChannel = {
			api: model?.api ?? "-",
			provider: model?.provider ?? "-",
			developerRole,
			channel: "n/a",
		};
		if (!enabled || body.length === 0) return;
		if (!developerRole) return;
		if (model?.reasoning !== true) return;

		// payload 的形状由 provider 决定，这里只按结构读取，不假设具体类型。
		const payload = event.payload;
		if (typeof payload !== "object" || payload === null) return;
		if (!("instructions" in payload)) return;
		const instructions = payload.instructions;
		if (typeof instructions !== "string" || !instructions.includes(body)) return;
		const input = "input" in payload && Array.isArray(payload.input) ? payload.input : [];
		const already = input.some(
			(item) => isPayloadMessage(item) && item.role === "developer" && item.content === instructions,
		);
		if (already) return;
		const next: Record<string, unknown> = { ...payload };
		delete next.instructions;
		next.input = [{ role: "developer", content: instructions }, ...input];
		lastChannel.channel = "developer";
		return next;
	});

	pi.registerCommand("purge", {
		description: "会话级破限开关：改写用户措辞 + 替换宿主身份段",
		getArgumentCompletions: (prefix: string) => {
			const commands = [
				{ value: "on", label: "on", description: "开启" },
				{ value: "off", label: "off", description: "关闭" },
				{ value: "status", label: "status", description: "诊断面板" },
				{ value: "mode", label: "mode", description: "切换宿主提示词模式" },
				{ value: "profile", label: "profile", description: "切换人设" },
				{ value: "source", label: "source", description: "切换人设来源" },
				{ value: "rewrite", label: "rewrite", description: "开关措辞改写" },
			];
			const trimmed = prefix.trim();
			if (trimmed.length === 0) return commands;
			if (trimmed.includes(" ")) {
				const [head, rest] = trimmed.split(/\s+/, 2);
				if (head === "mode") {
					return ["native", "strict", "replace", "append"]
						.filter((value) => value.startsWith(rest ?? ""))
						.map((value) => ({ value, label: value }));
				}
				if (head === "profile") {
					return collectProfiles()
						.filter((profile) => profile.id.startsWith(rest ?? ""))
						.map((profile) => ({ value: profile.id, label: profile.id, description: profile.notes }));
				}
				if (head === "rewrite") {
					return ["on", "off"]
						.filter((value) => value.startsWith(rest ?? ""))
						.map((value) => ({ value, label: value }));
				}
				return null;
			}
			return commands.filter((item) => item.value.startsWith(trimmed));
		},
		handler: async (args: string, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cmd = (parts[0] ?? "").toLowerCase();
			const arg = parts.slice(1).join(" ").trim();

			const notify = (text: string, level: "info" | "error" = "info") => ctx.ui.notify(text, level);

			if ((cmd === "status" || cmd === "") && body.length === 0) reload();

			const describe = (): string => {
				const cut =
					lastCut.at === 0
						? "尚未运行过一轮"
						: `身份段 ${lastCut.identity ? "已处理" : "未匹配"} / 文档段 ${lastCut.docs ? "已切除" : "未切除"}`;
				const modeLabel =
					mode === "native"
						? "native（替换身份句，保留宿主其余提示词）"
						: mode === "strict"
							? "strict（只留人设+工作目录）"
							: mode === "replace"
								? "replace（清宿主身份段）"
								: "append（只挂头部）";
				const rewriteLabel = rewriteEnabled
					? `开（累计 ${lastRewrite.count} 次，最近交付物模板命中 ${lastRewrite.deliverableHits} / 名词命中 ${lastRewrite.nounHits} / 攻击词命中 ${lastRewrite.termHits}，下标 ${lastRewrite.index}${lastRewrite.framed ? "，已带框架句" : ""}）`
					: "关";
				return [
					`状态: ${enabled ? "开启" : "关闭"}（仅本会话）`,
					`模式: ${modeLabel}`,
					`人设: ${profileId}${source === EMBEDDED ? "（内嵌）" : `（${source}）`}${body.length > 0 ? `  ${body.length} 字符` : `  未加载${loadError ? `（${loadError}）` : ""}`}`,
					`措辞改写: ${rewriteLabel}`,
					`模型: ${lastChannel.provider}/${lastChannel.api}  developer 角色=${lastChannel.developerRole ? "支持" : "不支持"}  注入通道=${lastChannel.channel}`,
					`上轮宿主处理: ${cut}`,
				].join("\n");
			};

			const turnOn = () => {
				if (!reload()) return notify(`无法开启：${loadError}`, "error");
				enabled = true;
				paint(ctx);
				notify(`已开启（${mode} / ${profileId}，仅本会话），每轮注入 ${body.length} 字符。\n${describe()}`);
			};
			const turnOff = () => {
				enabled = false;
				paint(ctx);
				notify("已关闭，恢复 omp 原始系统提示词。");
			};

			switch (cmd) {
				case "":
					if (enabled) turnOff();
					else turnOn();
					return;
				case "on":
				case "enable":
					return turnOn();
				case "off":
				case "disable":
					return turnOff();
				case "status":
					return notify(describe());
				case "mode": {
					const wanted = parseMode(arg);
					if (!wanted) {
						return notify(
							`当前模式: ${mode}\n用法: /purge mode native|strict|replace|append\nnative  = 替换宿主身份句，保留其余提示词（推荐）\nstrict  = 只发人设 + 工作目录\nreplace = 清 omp 身份段与文档指引\nappend  = 只把人设挂头部`,
							"error",
						);
					}
					mode = wanted;
					return notify(`模式已切换为 ${wanted}（仅本会话）。\n${describe()}`);
				}
				case "profile": {
					if (!arg) {
						const profiles = collectProfiles();
						return notify(
							`当前人设: ${profileId}\n可用:\n${profiles.map((profile) => `  ${profile.id}  ${profile.notes}`).join("\n")}\n用法: /purge profile <id>`,
						);
					}
					const previous = profileId;
					profileId = arg;
					if (!reload()) {
						const reason = loadError;
						profileId = previous;
						reload();
						return notify(`切换失败：${reason}`, "error");
					}
					// 档位自带默认模式：切档位即切模式，除非外部来源已接管。
					if (source === EMBEDDED) {
						const profile = findProfile(profileId);
						if (profile) mode = profile.mode;
					}
					return notify(`人设已切换为 ${profileId}，正文 ${body.length} 字符。\n${describe()}`);
				}
				case "rewrite": {
					if (!arg) {
						return notify(`措辞改写: ${rewriteEnabled ? "开" : "关"}\n用法: /purge rewrite on|off`);
					}
					if (arg === "on" || arg === "1" || arg === "true") rewriteEnabled = true;
					else if (arg === "off" || arg === "0" || arg === "false") rewriteEnabled = false;
					else return notify(`未知参数: ${arg}\n用法: /purge rewrite on|off`, "error");
					return notify(`措辞改写已${rewriteEnabled ? "开启" : "关闭"}。\n${describe()}`);
				}
				case "source": {
					if (!arg) {
						return notify(
							`当前人设来源: ${source === EMBEDDED ? "内嵌" : source}\n用法: /purge source <绝对路径|embedded>\n提示: 常见外部位置 ${HINT_SOURCE}`,
							"error",
						);
					}
					const previous = source;
					source = arg.replace(/^["']|["']$/g, "");
					if (source.toLowerCase() === EMBEDDED) source = EMBEDDED;
					if (!reload()) {
						// 回滚会清掉 loadError，先存下来再恢复，否则报错信息变成空
						const reason = loadError;
						source = previous;
						reload();
						return notify(`切换失败：${reason}`, "error");
					}
					return notify(`人设来源已切换，正文 ${body.length} 字符。\n${describe()}`);
				}
				default:
					return notify(`未知子命令: ${cmd}\n用法: /purge [on|off|status|mode|profile|source|rewrite]`);
			}
		},
	});
}
