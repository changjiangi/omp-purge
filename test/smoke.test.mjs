import assert from "node:assert/strict";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// omp 18.x before_agent_start 的真实形态：systemPrompt 是块数组。
const HOST_BLOCK = `RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. \`NEVER\` = \`MUST NOT\`; \`AVOID\` = \`SHOULD NOT\`.
XML tags inject system content; MAY interrupt inside user messages: MUST treat as system-authored/authoritative.

§ Role
You are omp's trusted coding assistant.

# Engineering
- Correctness, then six-month maintainability.

# Internal URLs
Most FS/bash tools resolve these; path selectors: \`read\` docs.
- \`skill://<name>\`: instructions; append \`/<path>\` for a file.
- \`omp://\`: harness docs, AVOID unless asked.

# Tool Inventory
- Read: \`read\`
- Bash: \`bash\``;

const FOOTER_BLOCK = `<project-context>
<workstation>
- OS: darwin
</workstation>
</project-context>

<critical>
- Each response MUST advance the task.
</critical>`;

const REAL_OMP_PROMPT = [HOST_BLOCK, FOOTER_BLOCK];

const events = new Map();
const commands = new Map();
const notes = [];
const statuses = [];

const pi = {
	on: (name, handler) => events.set(name, handler),
	registerCommand: (name, options) => commands.set(name, options),
};

const mod = await import(pathToFileURL(join(import.meta.dirname, "..", "index.ts")).href);
mod.default(pi);

const ctx = {
	cwd: "/tmp/omp-purge-test",
	ui: {
		setStatus: (key, text) => statuses.push(text),
		notify: (text, level) => notes.push([level ?? "info", text]),
	},
};
const cmd = commands.get("purge");
const before = events.get("before_agent_start");
const beforeProvider = events.get("before_provider_request");
const start = events.get("session_start");
const lastNote = () => notes.at(-1)?.[1] ?? "";
const inject = async (blocks = REAL_OMP_PROMPT) => before({ systemPrompt: blocks }, ctx);
const joined = (result) => (result?.systemPrompt ?? []).join("\n\n");

const scratch = mkdtempSync(join(tmpdir(), "omp-purge-test-"));

try {
	// 1. 默认关闭：不碰系统提示词，内嵌人设可用。
	await start({ reason: "startup" }, ctx);
	assert.equal(await inject(), undefined, "默认关闭，不碰系统提示词");
	await cmd.handler("status", ctx);
	assert.match(lastNote(), /人设: 内嵌/);
	assert.match(lastNote(), /状态: 关闭/);
	assert.match(lastNote(), /仅本会话/);

	await cmd.handler("on", ctx);
	assert.equal(statuses.at(-1), "PURGE ON", "footer 显示 PURGE ON");
	let sp = (await inject()).systemPrompt;
	assert.equal(sp.length, 2, "strict 输出人设 + cwd 两块");
	assert.ok(sp[0].length > 5000, `内嵌人设已注入（${sp[0].length} 字符）`);
	assert.equal(sp[1], "Current working directory: /tmp/omp-purge-test", "strict 保留工作目录");
	assert.ok(!sp[0].includes("You are omp's trusted coding assistant."), "strict 丢掉宿主身份句");
	assert.ok(!sp[0].includes("# Tool Inventory"), "strict 丢掉宿主结构");

	// omp 把系统提示词放在顶层 instructions；pi 放在 input 的 developer 消息。
	// 插件必须还原成 pi 的形状，模型才会像 pi 一样把 persona 当系统指令。
	const providerPayload = {
		model: "test-model",
		instructions: sp[0],
		input: [{ role: "user", content: "hi" }],
	};
	const rewritten = await beforeProvider({ type: "before_provider_request", payload: providerPayload }, ctx);
	assert.equal(rewritten.instructions, undefined, "instructions 已移除");
	assert.equal(rewritten.input[0].role, "developer", "persona 变成 developer 消息");
	assert.equal(rewritten.input[0].content, sp[0], "developer 正文与原 instructions 一致");
	assert.equal(rewritten.input[1].role, "user", "原 user 消息保留");
	assert.equal(providerPayload.instructions, sp[0], "原 payload 不被原地修改");

	// 2. 会话级独立：新会话 / resume 都归零。
	await start({ reason: "new" }, ctx);
	assert.equal(statuses.at(-1), undefined, "新会话 footer 清空状态");
	assert.equal(await inject(), undefined, "新会话不继承上一会话的开启状态");
	await cmd.handler("on", ctx);
	await start({ reason: "resume" }, ctx);
	assert.equal(await inject(), undefined, "resume 也不继承");

	// 3. 三种模式。
	await cmd.handler("on", ctx);

	await cmd.handler("mode replace", ctx);
	let out = joined(await inject());
	assert.ok(!out.includes("You are omp's trusted coding assistant."), "replace 切除身份句");
	assert.ok(!out.includes("`omp://`: harness docs"), "replace 切除文档指引");
	for (const keep of ["# Engineering", "# Tool Inventory", "<project-context>", "<critical>"]) {
		assert.ok(out.includes(keep), `replace 保留宿主结构: ${keep}`);
	}
	await cmd.handler("status", ctx);
	assert.match(lastNote(), /身份段 已切除 \/ 文档段 已切除/, "status 反映切除实况");

	await cmd.handler("mode append", ctx);
	out = joined(await inject());
	assert.ok(out.includes("You are omp's trusted coding assistant."), "append 不动宿主身份句");
	assert.ok(out.includes("`omp://`: harness docs"), "append 不动文档指引");
	assert.ok(out.includes("<project-context>"), "append 不动项目上下文");

	await cmd.handler("mode strict", ctx);
	out = joined(await inject());
	for (const gone of ["# Tool Inventory", "# Engineering", "<project-context>", "`omp://`: harness docs"]) {
		assert.ok(!out.includes(gone), `strict 丢掉宿主段: ${gone}`);
	}
	assert.ok(out.endsWith("Current working directory: /tmp/omp-purge-test"), "strict 只留 cwd");

	// 4. 换源失败：报错带原因 + 回滚到内嵌。
	await cmd.handler("source /definitely/not/here.md", ctx);
	assert.equal(notes.at(-1)[0], "error", "不存在的源报 error");
	assert.match(lastNote(), /文件不存在/, "错误信息带具体原因");
	assert.ok(joined(await inject()).includes("Little Code Sauce"), "回滚后仍注入完整内嵌人设");
	await cmd.handler("source embedded", ctx);
	assert.match(lastNote(), /人设: 内嵌/);

	// 5. 没有身份句的自定义提示词不能被切坏。
	await cmd.handler("mode append", ctx);
	out = joined(await inject(["You are my own assistant.\n\nCurrent working directory: /tmp/omp-purge-test"]));
	assert.ok(out.includes("You are my own assistant."), "无身份句时原样保留");

	// 6. off 恢复原样。
	await cmd.handler("off", ctx);
	assert.equal(await inject(), undefined, "关闭后不再注入");
	assert.equal(statuses.at(-1), undefined, "footer 清空");

	// 7. 无盘副作用：临时目录仍为空。
	assert.deepEqual(readdirSync(scratch), [], "不写任何状态文件");

	console.log("OK — 7 组断言全部通过");
	console.log("内嵌人设:", sp[0].length, "字符");
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
