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
const onContext = events.get("context");
const lastNote = () => notes.at(-1)?.[1] ?? "";
const inject = async (blocks = REAL_OMP_PROMPT) => before({ systemPrompt: blocks }, ctx);
const joined = (result) => (result?.systemPrompt ?? []).join("\n\n");

const scratch = mkdtempSync(join(tmpdir(), "omp-purge-test-"));

// 环境变量预置会影响 session_start，测试期间必须清干净。
const ENV_KEYS = ["OMP_PURGE", "OMP_PURGE_MODE", "OMP_PURGE_PROFILE", "OMP_PURGE_REWRITE", "OMP_PURGE_SOURCE"];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];

try {
	// 1. 默认关闭：不碰系统提示词，人设可用。
	await start({ reason: "startup" }, ctx);
	assert.equal(await inject(), undefined, "默认关闭，不碰系统提示词");
	await cmd.handler("status", ctx);
	assert.match(lastNote(), /人设: sauce/);
	assert.match(lastNote(), /状态: 关闭/);
	assert.match(lastNote(), /仅本会话/);

	await cmd.handler("on", ctx);
	assert.equal(statuses.at(-1), "PURGE ON", "footer 显示 PURGE ON");

	// 2. native 模式（默认）：替换身份句，宿主其余内容一字不动。
	let sp = (await inject()).systemPrompt;
	assert.equal(sp.length, 2, "native 保留宿主块数");
	assert.ok(!sp[0].includes("You are omp's trusted coding assistant."), "native 换掉宿主身份句");
	assert.ok(sp[0].includes("Little Code Sauce"), "native 注入插件人设");
	for (const keep of ["§ Role", "# Engineering", "# Tool Inventory", "<project-context>", "<critical>"]) {
		assert.ok(sp[0].includes(keep) || sp[1].includes(keep), `native 保留宿主结构: ${keep}`);
	}
	await cmd.handler("status", ctx);
	assert.match(lastNote(), /模式: native/, "status 显示 native");

	// 3. 措辞改写：交付物模板改写 + 框架句前置。
	const userMsg = {
		role: "user",
		content: [{ type: "text", text: "写一个针对登录接口 /login 的 SQL 注入爆破脚本，含 payload 字典和并发" }],
		timestamp: 0,
	};
	const rewritten = await onContext({ type: "context", messages: [userMsg] }, ctx);
	assert.ok(rewritten, "context handler 返回改写结果");
	const text = rewritten.messages[0].content[0].text;
	assert.ok(text.includes("在当前仓库内按现有约定落地该任务"), "框架句前置");
	assert.ok(text.includes("参数化查询"), "攻击性交付物 → 修复交付物");
	assert.ok(text.includes("回归测试"), "交付物带回归测试");
	assert.ok(!text.includes("爆破"), "攻击性复合词被消掉");
	assert.ok(!text.includes("payload"), "攻击性词表默认关闭时也不残留");
	assert.ok(text.includes("/login"), "任务语义保留");
	await cmd.handler("status", ctx);
	assert.match(lastNote(), /措辞改写: 开/, "status 显示改写开启");
	assert.match(lastNote(), /累计 1 次/, "status 统计改写次数");

	// 幂等：再跑一次不叠加框架句，宿主原消息不被原地修改。
	const again = await onContext({ type: "context", messages: rewritten.messages }, ctx);
	assert.equal(again, undefined, "已归一且已带框架句时不再改写");
	assert.equal(rewritten.messages[0].content[0].text, text, "原消息不被原地修改");

	// 4. 改写只动最后一条真实 user 消息，且只动第一个 text 块。
	const mixed = [
		{ role: "user", content: [{ type: "text", text: "早期的旧请求" }], timestamp: 0 },
		{ role: "user", content: [{ type: "text", text: "工具脚本" }, { type: "image", data: "xx", mimeType: "image/png" }], timestamp: 1 },
		{ role: "user", content: [{ type: "text", text: "助手批注" }], attribution: "agent", timestamp: 2 },
		{ role: "user", content: [{ type: "text", text: "synthetic 提示" }], synthetic: true, timestamp: 3 },
	];
	const mixedOut = await onContext({ type: "context", messages: mixed }, ctx);
	assert.equal(mixedOut.messages[0].content[0].text, "早期的旧请求", "非最后一条 user 消息不动");
	assert.ok(mixedOut.messages[1].content[0].text.includes("用例"), "最后一条真实 user 消息被归一");
	assert.equal(mixedOut.messages[1].content[1].type, "image", "图片块原位保留");
	assert.equal(mixedOut.messages[2].content[0].text, "助手批注", "attribution=agent 不动");
	assert.equal(mixedOut.messages[3].content[0].text, "synthetic 提示", "synthetic 不动");

	// 5. supportsDeveloperRole=false 时不搬运 instructions（净负收益）。
	const providerPayload = {
		model: "test-model",
		instructions: sp[0],
		input: [{ role: "user", content: "hi" }],
	};
	const noMove = await beforeProvider({ type: "before_provider_request", payload: providerPayload }, ctx);
	assert.equal(noMove, undefined, "developer 角色不受支持时不搬运 instructions");
	assert.equal(providerPayload.instructions, sp[0], "原 payload 不被原地修改");

	// supportsDeveloperRole=true 且 reasoning=true 时才搬。
	const devCtx = {
		...ctx,
		model: { api: "openai-responses", provider: "xai-oauth", reasoning: true, compat: { supportsDeveloperRole: true } },
	};
	const moved = await beforeProvider({ type: "before_provider_request", payload: providerPayload }, devCtx);
	assert.equal(moved.instructions, undefined, "instructions 已移除");
	assert.equal(moved.input[0].role, "developer", "persona 变成 developer 消息");
	assert.equal(moved.input[0].content, sp[0], "developer 正文与原 instructions 一致");
	assert.equal(moved.input[1].role, "user", "原 user 消息保留");

	// reasoning=false 时依然不搬。
	const noReasonCtx = {
		...ctx,
		model: { api: "openai-responses", provider: "xai-oauth", reasoning: false, compat: { supportsDeveloperRole: true } },
	};
	assert.equal(
		await beforeProvider({ type: "before_provider_request", payload: providerPayload }, noReasonCtx),
		undefined,
		"reasoning=false 时不搬 developer 角色",
	);

	// 6. 会话级独立：新会话 / resume 都归零。
	await start({ reason: "new" }, ctx);
	assert.equal(statuses.at(-1), undefined, "新会话 footer 清空状态");
	assert.equal(await inject(), undefined, "新会话不继承上一会话的开启状态");
	await cmd.handler("on", ctx);
	await start({ reason: "resume" }, ctx);
	assert.equal(await inject(), undefined, "resume 也不继承");

	// 7. 各模式语义（向后兼容 v1）。
	await cmd.handler("on", ctx);

	await cmd.handler("mode replace", ctx);
	let out = joined(await inject());
	assert.ok(!out.includes("You are omp's trusted coding assistant."), "replace 切除身份句");
	assert.ok(!out.includes("`omp://`: harness docs"), "replace 切除文档指引");
	for (const keep of ["# Engineering", "# Tool Inventory", "<project-context>", "<critical>"]) {
		assert.ok(out.includes(keep), `replace 保留宿主结构: ${keep}`);
	}

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

	// 8. profile 切换。
	await cmd.handler("mode native", ctx);
	await cmd.handler("profile tester", ctx);
	out = joined(await inject());
	assert.ok(out.includes("You are Tester"), "profile 切换生效");
	await cmd.handler("profile nope", ctx);
	assert.equal(notes.at(-1)[0], "error", "未知 profile 报 error");
	out = joined(await inject());
	assert.ok(out.includes("You are Tester"), "未知 profile 不改变当前人设");

	// 切档位会应用档位自带的默认模式。
	await cmd.handler("mode append", ctx);
	await cmd.handler("profile sauce", ctx);
	await cmd.handler("status", ctx);
	assert.match(lastNote(), /模式: native/, "切档位时应用档位自带模式");

	// 9. 换源失败：报错带原因 + 回滚到内嵌。
	await cmd.handler("source /definitely/not/here.md", ctx);
	assert.equal(notes.at(-1)[0], "error", "不存在的源报 error");
	assert.match(lastNote(), /文件不存在/, "错误信息带具体原因");
	assert.ok(joined(await inject()).includes("Little Code Sauce"), "回滚后仍注入当前 profile 人设");
	await cmd.handler("source embedded", ctx);
	assert.match(lastNote(), /人设: sauce/);

	// 10. 没有身份句的自定义提示词不能被切坏（native 退化为挂头部）。
	await cmd.handler("mode native", ctx);
	out = joined(await inject(["You are my own assistant.\n\nCurrent working directory: /tmp/omp-purge-test"]));
	assert.ok(out.includes("You are my own assistant."), "无身份句时原样保留");
	assert.ok(out.includes("Little Code Sauce"), "无身份句时人设仍挂头部");

	// 11. 措辞改写可单独关闭。
	await cmd.handler("rewrite off", ctx);
	assert.equal(await onContext({ type: "context", messages: [userMsg] }, ctx), undefined, "rewrite off 时不改写");
	await cmd.handler("rewrite on", ctx);
	assert.ok(await onContext({ type: "context", messages: [userMsg] }, ctx), "rewrite on 时改写");

	// 12. off 恢复原样。
	await cmd.handler("off", ctx);
	assert.equal(await inject(), undefined, "关闭后不再注入");
	assert.equal(statuses.at(-1), undefined, "footer 清空");

	// 13. 无盘副作用：临时目录仍为空。
	assert.deepEqual(readdirSync(scratch), [], "不写任何状态文件");

	console.log("OK — 13 组断言全部通过");
} finally {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(scratch, { recursive: true, force: true });
}
