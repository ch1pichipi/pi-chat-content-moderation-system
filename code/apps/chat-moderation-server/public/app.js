/* 实时聊天审核与封禁 —— 原生 JS 前端（零构建） */
"use strict";

const PUNISHMENT_LABELS = {
	none: "不处罚",
	ban_1m: "封禁 1 分钟",
	ban_1h: "封禁 1 小时",
	ban_1d: "封禁 1 天",
	ban_3d: "封禁 3 天",
	permanent: "永久封禁",
};

const state = {
	players: [],
	account: null,
	messages: [],
	/** messageId -> JudgementView */
	judgements: new Map(),
	ban: null,
	serverOffsetMs: 0,
	sse: null,
	sseOnline: false,
	analyzing: false,
	analysisWindowMinutes: 10,
	lastJudgement: null,
	banExpiredHandled: false,
};

const $ = (id) => document.getElementById(id);
const ui = {
	conn: $("connStatus"),
	connText: $("connText"),
	playerList: $("playerList"),
	playerCount: $("playerCount"),
	windowInfo: $("windowInfo"),
	modelInfo: $("modelInfo"),
	refreshBtn: $("refreshBtn"),
	currentNickname: $("currentNickname"),
	currentAccount: $("currentAccount"),
	statusPill: $("statusPill"),
	countdown: $("countdown"),
	unbanBtn: $("unbanBtn"),
	banBanner: $("banBanner"),
	banBannerTitle: $("banBannerTitle"),
	banBannerDetail: $("banBannerDetail"),
	chat: $("chat"),
	analysisPanel: $("analysisPanel"),
	composer: $("composer"),
	input: $("input"),
	charCount: $("charCount"),
	analyzingHint: $("analyzingHint"),
	sendBtn: $("sendBtn"),
	toast: $("toast"),
};

/* ── 工具函数 ─────────────────────────────────────── */

function parseServerTime(value) {
	if (!value) return null;
	const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(
		value.trim(),
	);
	if (!match) {
		const fallback = new Date(value);
		return Number.isNaN(fallback.getTime()) ? null : fallback;
	}
	const [, y, mo, d, h, mi, s, frac] = match;
	return new Date(
		Number(y),
		Number(mo) - 1,
		Number(d),
		Number(h),
		Number(mi),
		Number(s),
		frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0,
	);
}

function serverNow() {
	return Date.now() + state.serverOffsetMs;
}

function syncServerTime(iso) {
	if (!iso) return;
	const parsed = new Date(iso).getTime();
	if (!Number.isNaN(parsed)) state.serverOffsetMs = parsed - Date.now();
}

function formatTime(value) {
	const date = parseServerTime(value);
	if (!date) return "";
	const pad = (n) => String(n).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(totalSeconds) {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	const pad = (n) => String(n).padStart(2, "0");
	return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 剩余秒数；永久封禁返回 null。 */
function banRemaining(ban) {
	if (!ban) return 0;
	if (ban.permanent || !ban.endAt) return null;
	const endAt = parseServerTime(ban.endAt);
	if (!endAt) return null;
	return Math.max(0, Math.ceil((endAt.getTime() - serverNow()) / 1000));
}

function punishmentLabel(punishment) {
	return PUNISHMENT_LABELS[punishment] ?? punishment;
}

let toastTimer = null;
function toast(message, isError = false) {
	ui.toast.textContent = message;
	ui.toast.classList.toggle("error", isError);
	ui.toast.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		ui.toast.hidden = true;
	}, 3200);
}

async function api(path, options = {}) {
	const response = await fetch(path, {
		headers: { "Content-Type": "application/json" },
		...options,
	});
	let body = null;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	if (!response.ok) {
		const error = new Error(body?.message || `请求失败（HTTP ${response.status}）`);
		error.status = response.status;
		error.body = body;
		throw error;
	}
	if (body?.serverTime) syncServerTime(body.serverTime);
	return body;
}

/* ── 渲染 ─────────────────────────────────────────── */

function renderPlayers() {
	ui.playerList.textContent = "";
	ui.playerCount.textContent = `(${state.players.length})`;
	for (const player of state.players) {
		const li = document.createElement("li");
		li.dataset.account = player.account;
		li.classList.toggle("active", player.account === state.account);

		const main = document.createElement("div");
		main.className = "player-main";
		const nick = document.createElement("div");
		nick.className = "player-nick";
		nick.textContent = player.nickname || player.account;
		const acc = document.createElement("div");
		acc.className = "player-acc";
		acc.textContent = `${player.account} · ${player.messageCount} 条`;
		main.append(nick, acc);
		li.append(main);

		if (player.ban) {
			const badge = document.createElement("span");
			badge.className = "player-badge";
			badge.textContent = "封禁中";
			li.append(badge);
		}

		li.addEventListener("click", () => selectPlayer(player.account));
		ui.playerList.append(li);
	}
}

function renderHeader() {
	const player = state.players.find((item) => item.account === state.account);
	ui.currentNickname.textContent = player ? player.nickname || player.account : "未选择玩家";
	ui.currentAccount.textContent = player
		? [player.account, player.areaName, player.serverId].filter(Boolean).join(" · ")
		: "";

	const banned = state.ban !== null;
	ui.statusPill.textContent = banned ? `封禁中：${punishmentLabel(state.ban.punishment)}` : "正常";
	ui.statusPill.classList.toggle("banned", banned);
	ui.unbanBtn.hidden = !banned;
	updateCountdown();
	updateComposerState();
}

function renderBanBanner() {
	if (!state.ban) {
		ui.banBanner.hidden = true;
		return;
	}
	ui.banBanner.hidden = false;
	ui.banBannerTitle.textContent = `该玩家已被${punishmentLabel(state.ban.punishment)}（${state.ban.label}）`;
	const remaining = banRemaining(state.ban);
	const parts = [
		`风险类型：${state.ban.label}（reason=${state.ban.reason}）`,
		`开始：${formatTime(state.ban.startAt)}`,
		state.ban.permanent ? "到期：永久" : `到期：${formatTime(state.ban.endAt)}`,
		remaining === null ? "剩余：永久" : `剩余：${formatDuration(remaining)}`,
	];
	ui.banBannerDetail.textContent = parts.join(" · ");
}

function createMessageNode(message) {
	const node = document.createElement("div");
	node.className = "msg" + (message.account === state.account ? " own" : "");
	node.dataset.messageId = message.id;

	const meta = document.createElement("div");
	meta.className = "msg-meta";
	const who = document.createElement("span");
	who.textContent =
		message.account === state.account
			? "我"
			: `${message.nickname || message.account}`;
	const time = document.createElement("span");
	time.textContent = formatTime(message.createTime);
	meta.append(who, time);

	const judgement = state.judgements.get(message.id);
	if (judgement) {
		const tag = document.createElement("span");
		tag.className = "msg-tag" + (judgement.isRisk ? " risk" : "");
		tag.textContent = judgement.isRisk
			? `${judgement.label} · ${punishmentLabel(judgement.punishment)}`
			: judgement.manualReview
				? "待人工复核"
				: "正常";
		meta.append(tag);
	}

	const content = document.createElement("div");
	content.className = "msg-content";
	content.textContent = message.content;
	node.append(meta, content);
	return node;
}

function renderMessages() {
	ui.chat.textContent = "";
	if (state.messages.length === 0) {
		const empty = document.createElement("div");
		empty.className = "empty";
		empty.textContent = state.account ? "该玩家还没有聊天记录，发一条试试。" : "请选择左侧玩家。";
		ui.chat.append(empty);
		return;
	}
	for (const message of state.messages) ui.chat.append(createMessageNode(message));
	scrollToBottom();
}

function appendMessage(message) {
	const placeholder = ui.chat.querySelector(".empty");
	if (placeholder) placeholder.remove();
	if (state.messages.some((item) => item.id === message.id)) return;
	state.messages.push(message);
	ui.chat.append(createMessageNode(message));
	scrollToBottom();
}

function scrollToBottom() {
	ui.chat.scrollTop = ui.chat.scrollHeight;
}

function renderJudgement(judgement) {
	state.lastJudgement = judgement;
	ui.analysisPanel.hidden = false;
	ui.analysisPanel.textContent = "";
	ui.analysisPanel.classList.toggle("risk", judgement.isRisk);

	const title = document.createElement("div");
	title.className = "analysis-title";
	title.textContent = judgement.isRisk
		? `最近判断：${judgement.label} · ${punishmentLabel(judgement.punishment)}（置信度 ${judgement.confidence.toFixed(2)}）`
		: `最近判断：正常（置信度 ${judgement.confidence.toFixed(2)}）`;
	ui.analysisPanel.append(title);

	if (judgement.adjusted && judgement.requestedPunishment) {
		const adjusted = document.createElement("div");
		adjusted.textContent = `服务端降级：Agent 建议 ${punishmentLabel(judgement.requestedPunishment)}，最终 ${punishmentLabel(judgement.punishment)}`;
		ui.analysisPanel.append(adjusted);
	}
	if (judgement.summary) {
		const summary = document.createElement("div");
		summary.textContent = `说明：${judgement.summary}`;
		ui.analysisPanel.append(summary);
	}
	if (judgement.evidence.length > 0) {
		const evidence = document.createElement("div");
		evidence.textContent = `证据：${judgement.evidence.join(" | ")}`;
		ui.analysisPanel.append(evidence);
	}
	if (judgement.policyNote) {
		const note = document.createElement("div");
		note.className = "analysis-note";
		note.textContent = `策略备注：${judgement.policyNote}`;
		ui.analysisPanel.append(note);
	}
	const meta = document.createElement("div");
	meta.className = "muted";
	meta.textContent = `模型：${judgement.model}${judgement.degraded ? "（降级）" : ""} · 人工复核：${judgement.manualReview ? "需要" : "不需要"}`;
	ui.analysisPanel.append(meta);
}

function setAnalyzing(analyzing) {
	state.analyzing = analyzing;
	ui.analyzingHint.hidden = !analyzing;
}

function updateComposerState() {
	const banned = state.ban !== null;
	ui.input.disabled = banned;
	ui.sendBtn.disabled = banned;
	ui.sendBtn.textContent = banned ? "封禁中" : "发送";
	if (banned) ui.input.placeholder = "该玩家处于封禁中，无法发送消息";
	else ui.input.placeholder = "输入聊天内容，Enter 发送，Shift+Enter 换行";
}

function updateCountdown() {
	if (!state.ban) {
		ui.countdown.textContent = "";
		return;
	}
	const remaining = banRemaining(state.ban);
	ui.countdown.textContent =
		remaining === null ? "永久封禁" : `剩余 ${formatDuration(remaining)}`;
	renderBanBanner();

	if (remaining === 0 && !state.banExpiredHandled) {
		state.banExpiredHandled = true;
		state.ban = null;
		renderHeader();
		renderBanBanner();
		toast("封禁已到期，可以继续发送消息");
		void refreshCurrent();
	}
}

/* ── 数据加载 ─────────────────────────────────────── */

async function loadPlayers() {
	const data = await api("/api/players?limit=200");
	state.players = data.players ?? [];
	renderPlayers();
	if (!state.account && state.players.length > 0) {
		await selectPlayer(state.players[0].account);
	}
}

async function selectPlayer(account) {
	if (!account) return;
	if (account !== state.account) {
		state.account = account;
		state.messages = [];
		state.judgements = new Map();
		state.ban = null;
		state.banExpiredHandled = false;
		state.lastJudgement = null;
		ui.analysisPanel.hidden = true;
		setAnalyzing(false);
	}
	// 同步侧边栏选中态
	for (const li of ui.playerList.children) {
		li.classList.toggle("active", li.dataset.account === account);
	}
	renderHeader();
	await Promise.all([loadMessages(), loadStatus()]);
}

async function loadMessages() {
	if (!state.account) return;
	const data = await api(
		`/api/players/${encodeURIComponent(state.account)}/messages?limit=50`,
	);
	state.messages = data.messages ?? [];
	state.ban = data.ban ?? null;
	state.banExpiredHandled = false;
	renderMessages();
	renderHeader();
	renderBanBanner();
}

async function loadStatus() {
	if (!state.account) return;
	const data = await api(`/api/players/${encodeURIComponent(state.account)}/status`);
	state.ban = data.ban ?? null;
	state.banExpiredHandled = false;
	renderHeader();
	renderBanBanner();
}

async function refreshCurrent() {
	if (!state.account) return;
	await Promise.all([loadMessages(), loadStatus()]);
}

async function loadHealth() {
	try {
		const data = await api("/api/health");
		ui.windowInfo.textContent = `${data.analysis?.windowMinutes ?? "-"} 分钟 / 最多 ${data.analysis?.maxMessages ?? "-"} 条`;
		ui.modelInfo.textContent = data.agentModel ?? "-";
		if (data.analysis?.windowMinutes) {
			state.analysisWindowMinutes = data.analysis.windowMinutes;
		}
	} catch {
		ui.windowInfo.textContent = "不可用";
		ui.modelInfo.textContent = "不可用";
	}
}

/* ── 发送消息 ─────────────────────────────────────── */

async function sendMessage() {
	if (!state.account) {
		toast("请先选择玩家", true);
		return;
	}
	const content = ui.input.value;
	if (content.trim() === "") return;
	if (state.ban) {
		toast("该玩家处于封禁中，无法发送", true);
		return;
	}

	ui.sendBtn.disabled = true;
	try {
		const data = await api(
			`/api/players/${encodeURIComponent(state.account)}/messages`,
			{ method: "POST", body: JSON.stringify({ content }) },
		);
		ui.input.value = "";
		updateCharCount();
		if (data?.message) appendMessage(data.message);
		setAnalyzing(true);
		void loadPlayers().catch(() => {});
	} catch (error) {
		if (error.status === 423 && error.body?.ban) {
			state.ban = error.body.ban;
			state.banExpiredHandled = false;
			renderHeader();
			renderBanBanner();
			toast("该玩家处于封禁中，无法发送", true);
		} else {
			toast(error.message || "发送失败", true);
		}
	} finally {
		updateComposerState();
	}
}

async function unban() {
	if (!state.account) return;
	ui.unbanBtn.disabled = true;
	try {
		const data = await api(
			`/api/players/${encodeURIComponent(state.account)}/unban`,
			{ method: "POST" },
		);
		if (data.unbanned) {
			toast("已提前解封");
		} else {
			toast("当前没有生效封禁");
		}
		state.ban = null;
		state.banExpiredHandled = false;
		renderHeader();
		renderBanBanner();
		void refreshCurrent();
	} catch (error) {
		toast(error.message || "解封失败", true);
	} finally {
		ui.unbanBtn.disabled = false;
	}
}

function updateCharCount() {
	ui.charCount.textContent = `${[...ui.input.value].length} / 2000`;
}

/* ── SSE ──────────────────────────────────────────── */

function setConnection(status) {
	state.sseOnline = status === "online";
	ui.conn.classList.toggle("online", status === "online");
	ui.conn.classList.toggle("offline", status === "offline");
	ui.connText.textContent =
		status === "online" ? "实时连接已建立" : status === "offline" ? "连接断开，重连中…" : "连接中…";
}

function handleServerEvent(type, payload) {
	switch (type) {
		case "message_created":
			if (payload.account === state.account) appendMessage(payload.message);
			break;
		case "analysis_started":
			if (payload.account === state.account) setAnalyzing(true);
			break;
		case "analysis_completed":
			if (payload.account !== state.account) break;
			setAnalyzing(false);
			state.judgements.set(payload.messageId, payload.judgement);
			renderJudgement(payload.judgement);
			if (payload.judgement.ban) {
				state.ban = payload.judgement.ban;
				state.banExpiredHandled = false;
				renderHeader();
				renderBanBanner();
			} else {
				void loadStatus().catch(() => {});
			}
			refreshMessageTag(payload.messageId);
			break;
		case "analysis_failed":
			if (payload.account !== state.account) break;
			setAnalyzing(false);
			toast(`分析失败，未执行封禁：${payload.error}`, true);
			break;
		case "ban_started":
			if (payload.account !== state.account) break;
			state.ban = payload.ban;
			state.banExpiredHandled = false;
			renderHeader();
			renderBanBanner();
			break;
		case "ban_lifted":
		case "ban_expired":
			if (payload.account !== state.account) break;
			state.ban = null;
			state.banExpiredHandled = false;
			renderHeader();
			renderBanBanner();
			break;
		default:
			break;
	}
}

function refreshMessageTag(messageId) {
	const node = ui.chat.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
	if (!node) return;
	const message = state.messages.find((item) => item.id === messageId);
	if (!message) return;
	const replacement = createMessageNode(message);
	node.replaceWith(replacement);
}

function connectSse() {
	if (state.sse) state.sse.close();
	const source = new EventSource("/api/events");
	state.sse = source;
	source.onopen = () => setConnection("online");
	source.onerror = () => setConnection("offline");

	const events = [
		"message_created",
		"analysis_started",
		"analysis_completed",
		"analysis_failed",
		"ban_started",
		"ban_lifted",
		"ban_expired",
	];
	for (const type of events) {
		source.addEventListener(type, (event) => {
			try {
				handleServerEvent(type, JSON.parse(event.data));
			} catch {
				// 忽略单条坏消息，保持连接。
			}
		});
	}
	source.addEventListener("hello", () => setConnection("online"));
}

/* ── 启动 ─────────────────────────────────────────── */

function bindEvents() {
	ui.composer.addEventListener("submit", (event) => {
		event.preventDefault();
		void sendMessage();
	});
	ui.input.addEventListener("input", () => {
		updateCharCount();
		ui.input.style.height = "auto";
		ui.input.style.height = `${Math.min(ui.input.scrollHeight, 140)}px`;
	});
	ui.input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			void sendMessage();
		}
	});
	ui.unbanBtn.addEventListener("click", () => void unban());
	ui.refreshBtn.addEventListener("click", () => {
		void loadPlayers().catch((error) => toast(error.message, true));
	});
	setInterval(updateCountdown, 1000);
	setInterval(() => {
		if (!state.sseOnline) void refreshCurrent().catch(() => {});
	}, 10_000);
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) void refreshCurrent().catch(() => {});
	});
}

async function main() {
	bindEvents();
	updateCharCount();
	setConnection("connecting");
	await loadHealth().catch(() => {});
	try {
		await loadPlayers();
	} catch (error) {
		toast(`加载玩家失败：${error.message}`, true);
	}
	connectSse();
}

void main();
