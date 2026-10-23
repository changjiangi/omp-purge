/**
 * 宿主提示词处理。
 *
 * 两种语义必须分开：
 * - `stripHostText` / `stripHostPersona`：**切除**宿主身份句与文档指引（v1 语义）。
 * - `replaceHostIdentity`：**替换**宿主身份句为插件人设，宿主其余内容一字不动（v2 native 语义）。
 *
 * 全部用固定文案定位，匹配不到就原样返回 —— omp 升级改文案时退化为
 * 「不处理」，而不是把整块提示词切坏。
 */

/** omp / pi 默认提示词里的宿主身份句。 */
export const HOST_IDENTITY_MARKERS: readonly string[] = [
	"You are omp's trusted coding assistant.",
	"You are pi's trusted coding assistant.",
	"You are an expert coding assistant operating inside pi, a coding agent harness.",
	"You are an expert coding assistant operating inside omp, a coding agent harness.",
];

/** pi 文档段的起点与终点标记；任一处匹配不到就整段跳过，绝不猜边界。 */
export const HOST_DOCS_START = "Pi documentation (read only when the user asks about pi itself";
export const HOST_DOCS_END = "(e.g., tui.md for TUI API details)";

/** omp 的 harness 文档指引只有一行，replace 模式顺手清掉。 */
export const OMP_DOCS_MARKER = "`omp://`: harness docs";

/** 一次文本处理的结果。 */
export interface HostTextResult {
	readonly text: string;
	readonly identity: boolean;
	readonly docs: boolean;
}

/**
 * 从单块系统提示词里切掉宿主身份句和宿主文档指引。
 */
export function stripHostText(text: string): HostTextResult {
	const lines = text.split("\n");
	let identity = false;
	let docs = false;

	// 1) 宿主身份句：整行命中时连带前面的 "§ Role" 标题一起删掉。
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const marker = HOST_IDENTITY_MARKERS.find((value) => line.includes(value));
		if (!marker) continue;
		const trimmed = line.trim();
		if (trimmed === marker || trimmed.startsWith(marker)) {
			lines.splice(i, 1);
			identity = true;
			if (i > 0 && /^§\s*Role\s*$/i.test(lines[i - 1].trim())) {
				lines.splice(i - 1, 1);
				i -= 1;
			}
			while (i > 0 && i < lines.length && lines[i] === "" && lines[i - 1] === "") {
				lines.splice(i, 1);
			}
			break;
		}
		const at = line.indexOf(marker);
		if (at !== -1) {
			lines[i] = (line.slice(0, at) + line.slice(at + marker.length)).trimEnd();
			identity = true;
			break;
		}
	}

	// 2) pi 文档段：从起始行一直切到结束标记所在行。
	const docsAt = lines.findIndex((line) => line.includes(HOST_DOCS_START));
	if (docsAt !== -1) {
		const docsEndAt = lines.findIndex(
			(line, index) => index >= docsAt && line.includes(HOST_DOCS_END),
		);
		if (docsEndAt !== -1) {
			lines.splice(docsAt, docsEndAt - docsAt + 1);
			docs = true;
		}
	}

	// 3) omp 的 omp:// 文档指引行。
	if (!docs) {
		const ompDocsAt = lines.findIndex((line) => line.includes(OMP_DOCS_MARKER));
		if (ompDocsAt !== -1) {
			lines.splice(ompDocsAt, 1);
			docs = true;
		}
	}

	return { text: lines.join("\n").replace(/^\n+/, ""), identity, docs };
}

/** 对 omp 的 systemPrompt 块数组逐块切除，并汇总命中情况。 */
export function stripHostPersona(blocks: readonly string[]): {
	blocks: string[];
	identity: boolean;
	docs: boolean;
} {
	let identity = false;
	let docs = false;
	const next: string[] = [];
	for (const block of blocks) {
		const cut = stripHostText(block);
		if (cut.identity) identity = true;
		if (cut.docs) docs = true;
		if (cut.text.trim().length > 0) next.push(cut.text);
	}
	return { blocks: next, identity, docs };
}

/**
 * 把宿主身份句替换成插件人设，宿主其余内容一字不动。
 *
 * 整行命中 → 该行整行换成人设（人设可多行）；行内命中 → 只替换掉身份句片段。
 * 匹配不到 → 原样返回，`identity` 为 false。
 */
export function replaceHostIdentity(text: string, persona: string): HostTextResult {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const marker = HOST_IDENTITY_MARKERS.find((value) => line.includes(value));
		if (!marker) continue;
		const trimmed = line.trim();
		if (trimmed === marker || trimmed.startsWith(marker)) {
			lines.splice(i, 1, ...persona.split("\n"));
			return { text: lines.join("\n"), identity: true, docs: false };
		}
		const at = line.indexOf(marker);
		lines[i] = (line.slice(0, at) + persona + line.slice(at + marker.length)).trimEnd();
		return { text: lines.join("\n"), identity: true, docs: false };
	}
	return { text, identity: false, docs: false };
}
