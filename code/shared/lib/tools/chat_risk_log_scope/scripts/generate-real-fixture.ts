/**
 * 生成 100 条真实场景风格的测试日志（10 个账号）。
 *
 * 设计目标：
 * - 固定 100 条记录、10 个账号，便于统计分析与回归对拍。
 * - 覆盖 9 种 reason（-1 正常、0、1、2、3、4、5、6、127）。
 * - 账号行为有明确模式：正常用户、广告账号、辱骂账号、低置信度误杀账号等。
 * - 输出 CSV 与 JSON 两份等价数据，供 analyze-file 两个 loader 共用。
 *
 * 运行：
 *   npx tsx code/shared/lib/tools/chat_risk_log_scope/scripts/generate-real-fixture.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type Reason = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 127;

interface MessageSpec {
	reason: Reason;
	confidence: number;
	message: string;
	contextMessages?: string[];
}

interface AccountSpec {
	account: string;
	nickname: string;
	areaId: string;
	areaName: string;
	serverId: string;
	/** 相对于 2026-10-20 09:00 的起始分钟。 */
	startMinute: number;
	/** 相邻消息的分钟间隔。 */
	stepMinutes: number;
	messages: MessageSpec[];
}

interface FixtureEntry {
	id: string;
	request_id: string;
	account: string;
	app_id: string;
	area_id: string;
	area_name: string;
	server_id: string;
	nickname: string;
	context_messages: string[] | null;
	current_message: string;
	judge_result: string;
	context_type: string;
	reason: Reason;
	confidence: number;
	level: string;
	label: string;
	prediction: string;
	reviewed_at: string;
	forbid_considered: boolean;
	forbid_deduped: boolean;
	create_time: string;
}

const LABELS: Record<Reason, string> = {
	[-1]: "正常",
	0: "其他违禁",
	1: "政治宗教",
	2: "色情低俗",
	3: "侮辱谩骂",
	4: "暴恐犯罪",
	5: "广告诈骗",
	6: "运营规避",
	7: "特殊字符",
	127: "渠道禁止",
};

const NORMAL_MESSAGES = [
	"这个副本怎么打，有人教一下吗",
	"今天活动几点开始",
	"有人组队打世界 boss 吗",
	"刚回归，装备怎么搭配",
	"求推荐一个适合新手的职业",
	"这把武器属性怎么样",
	"公会还收人吗",
	"跨服匹配怎么进",
	"今天服务器有点卡",
	"晚上八点一起打团本",
	"这个坐骑哪里掉",
	"交易行价格怎么涨了",
	"新手礼包值得买吗",
	"有人知道隐藏任务在哪接吗",
	"这周更新了什么内容",
	"求一个稳定的挂机点",
	"副本掉落概率是不是调了",
	"组队缺一个治疗",
	"刚打完一把，手感不错",
	"明天维护到几点",
];

const AD_MESSAGES = [
	"低价代练上分，加微信 abc123",
	"稳定外挂不封号，私聊了解",
	"出售高等级账号，价格优惠",
	"充值返利活动，加群 123456",
	"专业代打排位，先到先得",
	"大量游戏币低价出，支持担保",
	"代练套餐买三送一，加 VX 咨询",
	"内部辅助稳定运行，欢迎试用",
	"收高战力账号，价格好商量",
	"第三方平台充值折扣，私聊",
	"工作室接单，全天在线代练",
	"卖号送装备，支持验号",
	"低价出稀有道具，非官方渠道",
	"加群领取充值福利",
	"专业团队代打，效率稳定",
];

const ABUSE_MESSAGES = [
	"你会不会玩，菜就别说话",
	"这操作真下饭，别送了",
	"队友太菜了，没法打",
	"不会玩就挂机，别拖累人",
	"菜鸡互啄，真没意思",
	"打不过就退，别浪费时间",
	"你这水平也敢排位",
	"别指挥了，先学会走路",
	"送这么多，不如直接挂机",
	"就这操作还好意思说话",
	"队友能不能正常一点",
	"打得稀烂，浪费时间",
];

const POLITICAL_MESSAGES = [
	"群里在讨论最近的政治话题",
	"宗教活动的时间定了吗",
	"那个政策对游戏有影响吗",
	"有人在传相关政治消息",
	"宗教场所最近有什么活动",
	"政治敏感内容不要发群里",
	"这个话题涉及宗教争议",
	"看到一条政治相关传闻",
];

const PORN_MESSAGES = [
	"深夜私聊看福利",
	"主播福利视频加群",
	"有没有成人内容资源",
	"私聊发你低俗视频",
	"加群看更多福利内容",
	"低俗直播链接要不要",
	"成人资源低价分享",
];

const EVASION_MESSAGES = [
	"加我 VX 详聊",
	"私聊发你联系方式",
	"换个地方说，加群",
	"这里不方便，加 Q 群",
	"加我好友，给你发链接",
	"用谐音聊，别被系统看到",
];

const CONTEXT_POOL = [
	"玩家A：有人一起打副本吗",
	"玩家B：晚上八点开团",
	"玩家C：今天活动奖励不错",
	"玩家D：还差一个人",
	"玩家E：刚上线，等等我",
];

function buildNormalMessages(count: number, offset: number): MessageSpec[] {
	return Array.from({ length: count }, (_, index) => ({
		reason: -1,
		confidence: Number((0.05 + ((index * 7) % 15) / 100).toFixed(2)),
		message: NORMAL_MESSAGES[(index + offset) % NORMAL_MESSAGES.length],
		contextMessages: index % 4 === 0 ? [CONTEXT_POOL[index % CONTEXT_POOL.length]] : undefined,
	}));
}

function buildMessages(
	templates: readonly string[],
	count: number,
	reasons: readonly Reason[],
	confidences: readonly number[],
	offset = 0,
): MessageSpec[] {
	return Array.from({ length: count }, (_, index) => ({
		reason: reasons[index],
		confidence: confidences[index],
		message: templates[(index + offset) % templates.length],
		contextMessages: index % 3 === 0 ? [CONTEXT_POOL[(index + offset) % CONTEXT_POOL.length]] : undefined,
	}));
}

const ACCOUNT_SPECS: AccountSpec[] = [
	{
		account: "user_0001",
		nickname: "清风",
		areaId: "area_1",
		areaName: "一区",
		serverId: "server_11",
		startMinute: 0,
		stepMinutes: 3,
		messages: buildNormalMessages(20, 0),
	},
	{
		account: "user_0002",
		nickname: "明月",
		areaId: "area_1",
		areaName: "一区",
		serverId: "server_11",
		startMinute: 70,
		stepMinutes: 4,
		messages: buildNormalMessages(10, 5),
	},
	{
		account: "ad_bot_01",
		nickname: "福利客服",
		areaId: "area_1",
		areaName: "一区",
		serverId: "server_11",
		startMinute: 120,
		stepMinutes: 3,
		messages: buildMessages(
			AD_MESSAGES,
			15,
			Array(15).fill(5) as Reason[],
			[0.88, 0.9, 0.92, 0.94, 0.86, 0.95, 0.89, 0.91, 0.93, 0.87, 0.96, 0.9, 0.65, 0.7, 0.75],
		),
	},
	{
		account: "ad_bot_02",
		nickname: "代练工作室",
		areaId: "area_2",
		areaName: "二区",
		serverId: "server_22",
		startMinute: 180,
		stepMinutes: 4,
		messages: buildMessages(
			AD_MESSAGES,
			10,
			Array(10).fill(5) as Reason[],
			[0.83, 0.85, 0.87, 0.89, 0.9, 0.84, 0.88, 0.3, 0.4, 0.45],
			3,
		),
	},
	{
		account: "abuser_01",
		nickname: "暴躁老哥",
		areaId: "area_2",
		areaName: "二区",
		serverId: "server_22",
		startMinute: 240,
		stepMinutes: 2,
		messages: buildMessages(
			ABUSE_MESSAGES,
			12,
			Array(12).fill(3) as Reason[],
			[0.85, 0.88, 0.9, 0.92, 0.87, 0.91, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45],
		),
	},
	{
		account: "abuser_02",
		nickname: "嘴强王者",
		areaId: "area_2",
		areaName: "二区",
		serverId: "server_22",
		startMinute: 300,
		stepMinutes: 5,
		messages: buildMessages(
			ABUSE_MESSAGES,
			8,
			Array(8).fill(3) as Reason[],
			[0.86, 0.9, 0.94, 0.55, 0.6, 0.65, 0.7, 0.75],
			2,
		),
	},
	{
		account: "political_01",
		nickname: "时政观察",
		areaId: "area_2",
		areaName: "二区",
		serverId: "server_22",
		startMinute: 360,
		stepMinutes: 10,
		messages: buildMessages(
			POLITICAL_MESSAGES,
			8,
			Array(8).fill(1) as Reason[],
			[0.85, 0.88, 0.9, 0.93, 0.25, 0.3, 0.35, 0.45],
		),
	},
	{
		account: "porn_01",
		nickname: "深夜频道",
		areaId: "area_3",
		areaName: "三区",
		serverId: "server_33",
		startMinute: 480,
		stepMinutes: 6,
		messages: buildMessages(
			PORN_MESSAGES,
			7,
			Array(7).fill(2) as Reason[],
			[0.86, 0.9, 0.94, 0.55, 0.6, 0.68, 0.72],
		),
	},
	{
		account: "evasion_01",
		nickname: "低调引流",
		areaId: "area_3",
		areaName: "三区",
		serverId: "server_33",
		startMinute: 540,
		stepMinutes: 4,
		messages: buildMessages(
			EVASION_MESSAGES,
			6,
			Array(6).fill(6) as Reason[],
			[0.85, 0.9, 0.25, 0.3, 0.4, 0.45],
		),
	},
	{
		account: "mixed_risk_01",
		nickname: "混合风险",
		areaId: "area_3",
		areaName: "三区",
		serverId: "server_33",
		startMinute: 600,
		stepMinutes: 5,
		messages: [
			{ reason: 4, confidence: 0.95, message: "我知道你家住哪，等着" },
			{ reason: 4, confidence: 0.92, message: "信不信我找人砍你" },
			{ reason: 0, confidence: 0.6, message: "私下交易游戏币，非官方渠道" },
			{ reason: 127, confidence: 0.9, message: "第三方平台交易链接，点此进入" },
		],
	},
];

const BASE = new Date(2026, 9, 20, 9, 0, 0, 0);

function pad(value: number, length = 2): string {
	return String(value).padStart(length, "0");
}

function formatTime(date: Date): string {
	return [
		date.getFullYear(),
		"-",
		pad(date.getMonth() + 1),
		"-",
		pad(date.getDate()),
		" ",
		pad(date.getHours()),
		":",
		pad(date.getMinutes()),
		":",
		pad(date.getSeconds()),
		".",
		pad(date.getMilliseconds(), 3),
	].join("");
}

function atMinute(minute: number): Date {
	return new Date(BASE.getTime() + minute * 60_000);
}

function levelOf(confidence: number, reason: Reason): string {
	if (reason === -1) return "low";
	if (confidence >= 0.8) return "high";
	if (confidence < 0.5) return "low";
	return "medium";
}

function buildEntries(): FixtureEntry[] {
	const raw = ACCOUNT_SPECS.flatMap((spec) =>
		spec.messages.map((message, index) => {
			const created = atMinute(spec.startMinute + index * spec.stepMinutes);
			const reviewed = new Date(created.getTime() + 5_000);
			const label = LABELS[message.reason];
			return {
				account: spec.account,
				nickname: spec.nickname,
				areaId: spec.areaId,
				areaName: spec.areaName,
				serverId: spec.serverId,
				contextMessages: message.contextMessages,
				currentMessage: message.message,
				reason: message.reason,
				confidence: message.confidence,
				level: levelOf(message.confidence, message.reason),
				label,
				created,
				reviewed,
				index,
			};
		}),
	);

	raw.sort((a, b) => a.created.getTime() - b.created.getTime());

	return raw.map((item, index) => {
		const seq = index + 1;
		return {
			id: `log_${pad(seq, 6)}`,
			request_id: `req_${pad(seq, 6)}`,
			account: item.account,
			app_id: "app_game_001",
			area_id: item.areaId,
			area_name: item.areaName,
			server_id: item.serverId,
			nickname: item.nickname,
			context_messages: item.contextMessages ?? null,
			current_message: item.currentMessage,
			judge_result: item.label,
			context_type: "chat",
			reason: item.reason,
			confidence: item.confidence,
			level: item.level,
			label: item.label,
			prediction: item.label,
			reviewed_at: formatTime(item.reviewed),
			forbid_considered: index % 2 === 0,
			forbid_deduped: index % 3 === 0,
			create_time: formatTime(item.created),
		};
	});
}

const CSV_COLUMNS = [
	"id",
	"request_id",
	"account",
	"app_id",
	"area_id",
	"area_name",
	"server_id",
	"nickname",
	"context_messages",
	"current_message",
	"judge_result",
	"context_type",
	"reason",
	"confidence",
	"level",
	"label",
	"prediction",
	"reviewed_at",
	"forbid_considered",
	"forbid_deduped",
	"create_time",
] as const;

function csvCell(value: unknown): string {
	const text = value === null || value === undefined ? "" : String(value);
	if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
	return text;
}

function toCsv(entries: readonly FixtureEntry[]): string {
	const header = CSV_COLUMNS.join(",");
	const rows = entries.map((entry) =>
		CSV_COLUMNS.map((column) => {
			if (column === "context_messages") {
				return csvCell(entry.context_messages ? entry.context_messages.join("|") : "");
			}
			return csvCell(entry[column]);
		}).join(","),
	);
	return `${[header, ...rows].join("\n")}\n`;
}

async function main(): Promise<void> {
	const root = process.cwd();
	const logDir = path.join(
		root,
		"code/shared/lib/tools/chat_risk_log_scope/__fixtures__/logs/real",
	);
	await mkdir(logDir, { recursive: true });

	const entries = buildEntries();
	if (entries.length !== 100) {
		throw new Error(`期望生成 100 条记录，实际为 ${entries.length} 条`);
	}

	const baseName = "chat_risk_real_20261020_100";
	await writeFile(path.join(logDir, `${baseName}.csv`), toCsv(entries), "utf8");
	await writeFile(path.join(logDir, `${baseName}.json`), `${JSON.stringify(entries, null, 2)}\n`, "utf8");

	console.log(`已生成 ${entries.length} 条记录，账号数 ${new Set(entries.map((e) => e.account)).size}`);
	console.log(`输出目录: ${logDir}`);
}

await main();
