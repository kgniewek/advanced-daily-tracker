import {
	App,
	Editor,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownView,
	Menu,
	MenuItem,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	moment,
	setIcon,
} from "obsidian";

type DateFormat = "mdy" | "dmy" | "ymd";
type DateParts = "full" | "month-day" | "day";
type DateSeparator = "." | "/" | "-" | " ";
type TrackerMode = "unlocked" | "limited" | "locked";
type BlockKind = "code" | "table";
type LimitedRange = "today" | "two" | "week";
type MonthHeadings = "none" | "gap" | "month" | "month-year";
type GraphHeader = "none" | "name" | "name-days";
type MonthAlign = "far-left" | "left" | "center";
type HighlightStyle = "none" | "bold" | "italic" | "underline" | "accent";
type Orientation = "vertical" | "horizontal";

interface DailyTrackerSettings {
	snippetTrackers: boolean;
	tableTrackers: boolean;
	chartSnippets: boolean;
	limitedRange: LimitedRange;
	allUnlocked: boolean;
	autoAddDays: boolean;
	orientation: Orientation;
	cellSize: number;
	gapHorizontal: number;
	gapVertical: number;
	textSize: number;
	marginTop: number;
	marginBottom: number;
	graphHeader: GraphHeader;
	stickyLabelsVertical: boolean;
	weekendStyle: HighlightStyle;
	todayStyle: HighlightStyle;
	monthHeadings: MonthHeadings;
	gapSize: number;
	monthAlign: MonthAlign;
	dateFormat: DateFormat;
	dateSeparator: DateSeparator;
	dateParts: DateParts;
	romanMonths: boolean;
}

const DEFAULT_SETTINGS: DailyTrackerSettings = {
	snippetTrackers: true,
	tableTrackers: true,
	chartSnippets: true,
	limitedRange: "two",
	allUnlocked: false,
	autoAddDays: false,
	orientation: "vertical",
	cellSize: 26,
	gapHorizontal: 18,
	gapVertical: 18,
	textSize: 17,
	marginTop: 50,
	marginBottom: 50,
	graphHeader: "name-days",
	stickyLabelsVertical: true,
	weekendStyle: "bold",
	todayStyle: "bold",
	monthHeadings: "month-year",
	gapSize: 15,
	monthAlign: "left",
	dateFormat: "dmy",
	dateSeparator: "-",
	dateParts: "full",
	romanMonths: false,
};

const HIGHLIGHT_STYLES: HighlightStyle[] = ["bold", "italic", "underline", "accent"];

const ROMAN_MONTHS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

const MODES: { id: TrackerMode; label: string; icon: string }[] = [
	{ id: "unlocked", label: "Unlocked", icon: "unlock" },
	{ id: "limited", label: "Limited", icon: "calendar-check" },
	{ id: "locked", label: "Locked", icon: "lock" },
];

const SYMBOLS: Record<BlockKind, { on: string; off: string }> = {
	code: { on: "1", off: "0" },
	table: { on: "\u2705", off: "" },
};

const LIMITED_DAYS: Record<LimitedRange, number> = { today: 1, two: 2, week: 7 };

const MAX_FILL_DAYS = 3660;

const ON_VALUES = new Set(["1", "x", "true", "\u2705", "\u2713", "\u2714", "\u2611"]);

interface TrackerRow {
	date: string;
	cells: string[];
}

interface DayInfo {
	date: Date | null;
	iso: string | null;
	monthStart: Date | null;
	spaced: boolean;
	canEdit: boolean;
}

interface TrackerModel {
	head0: string;
	columns: string[];
	rows: TrackerRow[];
}


const MAX_LEVELS = 10;

const MAX_NUMBER = 99;

type ColumnKind = "check" | "levels" | "number" | "time" | "duration";

const DEFAULT_LEVELS = 5;

const MAX_DURATION = 99 * 60 + 59;

const HEADER_SUFFIX = /\((\d+|#|time|dur)\)\s*$/i;

const isTextKind = (k: ColumnKind): k is "time" | "duration" => k === "time" || k === "duration";

const COLUMN_TYPES: { kind: ColumnKind; label: string; icon: string; hint: string }[] = [
	{ kind: "check", label: "Checkbox", icon: "check", hint: "Name" },
	{ kind: "levels", label: "Shades", icon: "palette", hint: "Name (shades)" },
	{ kind: "number", label: "Number", icon: "hash", hint: "Name (number)" },
	{ kind: "time", label: "Time of day", icon: "clock", hint: "Name (time)" },
	{ kind: "duration", label: "Duration", icon: "timer", hint: "Name (duration)" },
];

type SubmenuItem = MenuItem & { setSubmenu: () => Menu };
const canSubmenu = (): boolean => typeof (MenuItem.prototype as unknown as { setSubmenu?: unknown }).setSubmenu === "function";

function parseColumn(raw: string): { name: string; max: number; kind: ColumnKind } {
	const m = /^(.*?)\s*\((\d+|#|time|dur)\)\s*$/i.exec(raw.trim());
	if (!m || !m[1]) return { name: raw, max: 1, kind: "check" };
	const tag = m[2].toLowerCase();
	if (tag === "#") return { name: m[1], max: MAX_NUMBER, kind: "number" };
	if (tag === "time") return { name: m[1], max: 1, kind: "time" };
	if (tag === "dur") return { name: m[1], max: 1, kind: "duration" };
	const max = Math.min(Math.max(Number(m[2]), 1), MAX_LEVELS);
	return { name: m[1], max, kind: max === 1 ? "check" : "levels" };
}

function levelOf(v: string | undefined, max: number, kind: ColumnKind = "levels"): number {
	const s = (v ?? "").trim().toLowerCase();
	if (/^\d+$/.test(s)) return Math.min(Number(s), max);
	if (kind === "number") return 0;
	return ON_VALUES.has(s) ? max : 0;
}

function normalizeTime(raw: string): string | null {
	let s = raw.trim().toLowerCase().replace(/\s+/g, "");
	let pm: boolean | null = null;
	const ap = /(am|pm)$/.exec(s);
	if (ap) {
		pm = ap[1] === "pm";
		s = s.slice(0, -2);
	}
	let h: number;
	let mi: number;
	const colon = /^(\d{1,2})[:.h](\d{1,2})$/.exec(s);
	if (colon) {
		h = Number(colon[1]);
		mi = Number(colon[2]);
	} else if (/^\d{1,2}$/.test(s)) {
		h = Number(s);
		mi = 0;
	} else if (/^\d{3,4}$/.test(s)) {
		h = Number(s.slice(0, -2));
		mi = Number(s.slice(-2));
	} else return null;
	if (pm !== null) {
		if (h < 1 || h > 12) return null;
		h = (h % 12) + (pm ? 12 : 0);
	}
	if (h > 23 || mi > 59) return null;
	return `${pad2(h)}:${pad2(mi)}`;
}

function parseDuration(raw: string): number | null {
	const s = raw.trim().toLowerCase().replace(/,/g, ".");
	if (!s) return null;
	const clock = /^(\d+):(\d{1,2})$/.exec(s);
	if (clock) return Number(clock[2]) > 59 ? null : Number(clock[1]) * 60 + Number(clock[2]);
	const m = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*(?:m|min|mins|minutes?)?)?$/.exec(s);
	if (!m || (m[1] === undefined && m[2] === undefined)) return null;
	return Math.round(Number(m[1] ?? 0) * 60) + Number(m[2] ?? 0);
}

function formatDuration(min: number, long: boolean): string {
	const h = Math.floor(min / 60);
	const m = min % 60;
	const parts: string[] = [];
	if (h) parts.push(`${h}h`);
	if (m || !h) parts.push(long ? `${m}min` : `${m}m`);
	return parts.join(" ");
}

const compactHours = (min: number): string => String(Math.round(min / 6) / 10);

function parseValue(kind: "time" | "duration", raw: string): string | null {
	if (!raw.trim()) return "";
	if (kind === "time") return normalizeTime(raw);
	const n = parseDuration(raw);
	if (n === null) return null;
	return n > 0 ? String(Math.min(n, MAX_DURATION)) : "";
}

const cleanValue = (kind: "time" | "duration", raw: string): string => parseValue(kind, raw) ?? "";

function headerFor(name: string, kind: ColumnKind): string {
	if (HEADER_SUFFIX.test(name)) return name;
	switch (kind) {
		case "levels":
			return `${name}(${DEFAULT_LEVELS})`;
		case "number":
			return `${name}(#)`;
		case "time":
			return `${name}(time)`;
		case "duration":
			return `${name}(dur)`;
		default:
			return name;
	}
}

const isModeWord = (s: string): boolean => MODES.some((m) => m.id === s.trim().toLowerCase());

const modeOf = (head0: string): TrackerMode => {
	const s = head0.trim().toLowerCase();
	return s === "locked" || s === "limited" ? s : "unlocked";
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

const toIso = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const todayIso = (): string => toIso(new Date());

function parseDate(raw: string): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const date = new Date(y, mo - 1, d);
	if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
	return date;
}

function shiftDate(raw: string | undefined, days: number): string {
	const parsed = raw ? parseDate(raw) : null;
	const d = parsed ?? new Date();
	if (parsed) d.setDate(d.getDate() + days);
	return toIso(d);
}

function missingDaysToToday(rows: TrackerRow[]): string[] {
	const today = todayIso();
	if (rows.length === 0) return [today];
	const last = parseDate(rows[rows.length - 1].date);
	if (!last) return [];
	const out: string[] = [];
	const d = new Date(last);
	d.setDate(d.getDate() + 1);
	while (toIso(d) <= today) {
		out.push(toIso(d));
		if (out.length > MAX_FILL_DAYS) return [];
		d.setDate(d.getDate() + 1);
	}
	return out;
}

function move<T>(a: T[], from: number, to: number): void {
	a.splice(to, 0, ...a.splice(from, 1));
}

function buildModel(head: string[], body: string[][]): TrackerModel {
	const columns = head.slice(1);
	return {
		head0: head[0],
		columns,
		rows: body.map((cells) => ({
			date: cells[0] ?? "",
			cells: columns.map((_, i) => cells[i + 1] ?? ""),
		})),
	};
}

function parseCsv(lines: string[]): TrackerModel | null {
	const ls = lines.filter((l) => l.trim());
	if (ls.length === 0) return null;
	const split = (l: string): string[] => l.split(",").map((c) => c.trim());
	return buildModel(split(ls[0]), ls.slice(1).map(split));
}

function splitTableRow(line: string): string[] {
	let t = line.trim();
	if (t.startsWith("|")) t = t.slice(1);
	if (t.endsWith("|")) t = t.slice(0, -1);
	return t.split("|").map((c) => c.trim());
}

function parseTableLines(lines: string[]): TrackerModel | null {
	const ls = lines.filter((l) => l.trim());
	if (ls.length < 2) return null;
	const model = buildModel(splitTableRow(ls[0]), ls.slice(2).map(splitTableRow));
	return isModeWord(model.head0) ? model : null;
}

function modelFromTableEl(table: HTMLElement): TrackerModel | null {
	const headRow = table.querySelector("thead tr");
	if (!headRow) return null;
	const text = (el: Element): string => (el.textContent ?? "").trim();
	const head = Array.from(headRow.children).map(text);
	if (!head.length || !isModeWord(head[0])) return null;
	const body = Array.from(table.querySelectorAll("tbody tr")).map((tr) => Array.from(tr.children).map(text));
	return buildModel(head, body);
}

function serializeModel(m: TrackerModel, kind: BlockKind): string[] {
	const sym = SYMBOLS[kind];
	const cellsOf = (r: TrackerRow): string[] =>
		m.columns.map((col, i) => {
			const { max, kind: colKind } = parseColumn(col);
			if (isTextKind(colKind)) return cleanValue(colKind, r.cells[i] ?? "");
			const level = levelOf(r.cells[i], max, colKind);
			if (colKind === "check") return level > 0 ? sym.on : sym.off;
			return String(level);
		});
	if (kind === "code") {
		return [[m.head0, ...m.columns].join(","), ...m.rows.map((r) => [r.date, ...cellsOf(r)].join(","))];
	}
	const row = (cells: string[]): string => `| ${cells.join(" | ")} |`;
	const head = [m.head0, ...m.columns];
	return [row(head), row(head.map(() => "---")), ...m.rows.map((r) => row([r.date, ...cellsOf(r)]))];
}


type GraphKind = "number" | "time" | "duration";

const isGraphKind = (k: ColumnKind): k is GraphKind => k === "number" || k === "time" || k === "duration";

interface GraphPoint {
	iso: string;
	day: number;
	value: number;
}

interface GraphSeries {
	name: string;
	kind: ColumnKind;
	points: GraphPoint[];
}

const GRAPH_STEPS_NUMBER = [1, 2, 5, 10, 20, 50];
const GRAPH_STEPS_MINUTES = [5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720];

function findTrackers(text: string): TrackerModel[] {
	const lines = text.split(/\r?\n/);
	const out: TrackerModel[] = [];
	let i = 0;
	while (i < lines.length) {
		const fence = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)/.exec(lines[i]);
		if (fence) {
			const mark = fence[1][0];
			let end = i + 1;
			while (end < lines.length && !(lines[end].trim().length >= 3 && lines[end].trim().split("").every((c) => c === mark))) end++;
			if (fence[2] === "tracker") {
				const model = parseCsv(lines.slice(i + 1, end));
				if (model) out.push(model);
			}
			i = end + 1;
			continue;
		}
		if (lines[i].includes("|")) {
			let end = i;
			while (end < lines.length && lines[end].includes("|")) end++;
			const model = parseTableLines(lines.slice(i, end));
			if (model) out.push(model);
			i = end;
			continue;
		}
		i++;
	}
	return out;
}

function graphValue(kind: GraphKind, raw: string): number | null {
	if (kind === "number") {
		const s = raw.trim();
		return /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : null;
	}
	const v = parseValue(kind, raw);
	if (!v) return null;
	if (kind === "duration") return Number(v);
	const [h, m] = v.split(":").map(Number);
	return h * 60 + m;
}

function findSeries(text: string, wanted: string): GraphSeries | null {
	const want = wanted.trim().toLowerCase();
	for (const model of findTrackers(text)) {
		const idx = model.columns.findIndex((c) => c.trim().toLowerCase() === want || parseColumn(c).name.trim().toLowerCase() === want);
		if (idx < 0) continue;
		const { name, kind } = parseColumn(model.columns[idx]);
		if (!isGraphKind(kind)) return { name, kind, points: [] };

		const byDate = new Map<string, number>();
		model.rows.forEach((row) => {
			const date = parseDate(row.date);
			const value = date ? graphValue(kind, row.cells[idx] ?? "") : null;
			if (date && value !== null) byDate.set(toIso(date), value);
		});
		const isos = Array.from(byDate.keys()).sort();
		const first = isos.length ? (parseDate(isos[0]) as Date) : new Date();
		const points = isos.map((iso) => ({
			iso,
			day: Math.round(((parseDate(iso) as Date).getTime() - first.getTime()) / 86400000),
			value: byDate.get(iso) as number,
		}));
		return { name, kind, points };
	}
	return null;
}

interface PieColumn {
	name: string;
	kind: ColumnKind;
	max: number;
	cells: string[];
}

function findColumn(text: string, wanted: string): PieColumn | null {
	const want = wanted.trim().toLowerCase();
	for (const model of findTrackers(text)) {
		const idx = model.columns.findIndex((c) => c.trim().toLowerCase() === want || parseColumn(c).name.trim().toLowerCase() === want);
		if (idx < 0) continue;
		const { name, kind, max } = parseColumn(model.columns[idx]);
		const cells = model.rows.filter((r) => parseDate(r.date)).map((r) => r.cells[idx] ?? "");
		return { name, kind, max, cells };
	}
	return null;
}

interface HeatColumn {
	name: string;
	kind: ColumnKind;
	max: number;
	values: Map<string, number>;
}

function findHeat(text: string, wanted: string): HeatColumn | null {
	const want = wanted.trim().toLowerCase();
	for (const model of findTrackers(text)) {
		const idx = model.columns.findIndex((c) => c.trim().toLowerCase() === want || parseColumn(c).name.trim().toLowerCase() === want);
		if (idx < 0) continue;
		const { name, kind, max } = parseColumn(model.columns[idx]);
		const values = new Map<string, number>();
		if (kind === "check" || kind === "levels" || kind === "number") {
			model.rows.forEach((row) => {
				const date = parseDate(row.date);
				if (!date) return;
				const raw = row.cells[idx] ?? "";
				values.set(toIso(date), kind === "number" ? (graphValue("number", raw) ?? 0) : levelOf(raw, max, kind));
			});
		}
		return { name, kind, max, values };
	}
	return null;
}

interface PieSlice {
	label: string;
	count: number;
	empty?: boolean;
}

function pieSlices(col: PieColumn): PieSlice[] {
	const { kind, max, cells } = col;
	const out: PieSlice[] = [];
	if (kind === "check") {
		const on = cells.filter((c) => levelOf(c, 1, "check") > 0).length;
		out.push({ label: "Checked", count: on }, { label: "Unchecked", count: cells.length - on, empty: true });
	} else if (kind === "levels") {
		const counts = new Array<number>(max + 1).fill(0);
		cells.forEach((c) => counts[levelOf(c, max, "levels")]++);
		for (let l = 1; l <= max; l++) out.push({ label: `Level ${l}`, count: counts[l] });
		out.push({ label: "Empty", count: counts[0], empty: true });
	} else {
		const values: number[] = [];
		let missing = 0;
		cells.forEach((c) => {
			const v = graphValue(kind, c);
			if (v === null) missing++;
			else values.push(v);
		});
		const label = (v: number): string => (kind === "number" ? String(v) : kind === "time" ? formatClock(v) : formatDuration(v, false));
		const counts = new Map<number, number>();
		values.forEach((v) => counts.set(v, (counts.get(v) ?? 0) + 1));
		Array.from(counts.keys())
			.sort((a, b) => a - b)
			.forEach((v) => out.push({ label: label(v), count: counts.get(v) ?? 0 }));
		out.push({ label: "Not logged", count: missing, empty: true });
	}
	return out.filter((p) => p.count > 0);
}

function timeOrigin(minutes: number[]): number {
	const s = Array.from(new Set(minutes)).sort((a, b) => a - b);
	if (s.length < 2) return 0;
	let best = 0;
	let bestGap = -1;
	s.forEach((m, i) => {
		const gap = (s[(i + 1) % s.length] - m + 1440) % 1440;
		if (gap > bestGap) {
			bestGap = gap;
			best = i;
		}
	});
	return s[(best + 1) % s.length];
}

function niceAxis(lo: number, hi: number, steps: number[]): { from: number; to: number; ticks: number[] } {
	const step = steps.find((s) => (hi - lo) / s <= 4) ?? steps[steps.length - 1];
	const from = Math.floor(lo / step) * step;
	let to = Math.ceil(hi / step) * step;
	if (to === from) to += step;
	const ticks: number[] = [];
	for (let t = from; t <= to; t += step) ticks.push(t);
	return { from, to, ticks };
}

function formatClock(minutes: number): string {
	const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
	return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

function titleWithCheck(app: App, item: MenuItem, title: string, active: boolean): MenuItem {
	item.setTitle(title);
	if (!active) return item;
	const nativeMenus = (app.vault as unknown as { getConfig?: (key: string) => unknown }).getConfig?.("nativeMenus") === true;
	const parts = item as MenuItem & { titleEl?: HTMLElement; dom?: HTMLElement };
	const host = nativeMenus ? null : (parts.titleEl ?? parts.dom?.querySelector<HTMLElement>(".menu-item-title"));
	if (host) setIcon(host.createSpan({ cls: "adt-menu-check" }), "check");
	else item.setTitle(`${title}  \u2714`);
	return item;
}

interface BlockRef {
	ctx: MarkdownPostProcessorContext;
	section: HTMLElement;
	kind: BlockKind;
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private message: string,
		private action: string,
		private onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText(this.action).onClick(() => {
					this.close();
					this.onConfirm();
				});
				b.buttonEl.addClass("mod-warning");
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export default class DailyTrackerPlugin extends Plugin {
	settings: DailyTrackerSettings = { ...DEFAULT_SETTINGS };
	private autoFilling = new Set<string>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyAppearance();
		this.addSettingTab(new DailyTrackerSettingTab(this.app, this));

		this.addCommand({
			id: "insert-tracker",
			name: "Insert tracker",
			editorCallback: (editor: Editor) => this.insertSnippet(editor, ["```tracker", `unlocked,Habit`, `${todayIso()},`, "```"], 3),
		});
		this.addCommand({
			id: "insert-graph",
			name: "Insert graph",
			editorCallback: (editor: Editor) => this.insertSnippet(editor, ["```tracker-graph", "", "```"], 1),
		});
		this.addCommand({
			id: "insert-heatmap",
			name: "Insert heatmap",
			editorCallback: (editor: Editor) => this.insertSnippet(editor, ["```tracker-heatmap", "", "```"], 1),
		});
		this.addCommand({
			id: "insert-pie-chart",
			name: "Insert pie chart",
			editorCallback: (editor: Editor) => this.insertSnippet(editor, ["```tracker-pie", "", "```"], 1),
		});

		this.addRibbonIcon("calendar-check", "Insert tracker", () => {
			const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
			if (!editor) {
				new Notice("Open a note in edit mode to insert a tracker.");
				return;
			}
			this.insertSnippet(editor, ["```tracker", "unlocked,Habit", `${todayIso()},`, "```"], 3);
		});

		this.registerMarkdownCodeBlockProcessor("tracker", (source, el, ctx) => {
			if (!this.settings.snippetTrackers) {
				el.createEl("pre").createEl("code", { text: source });
				return;
			}
			const model = parseCsv(source.split(/\r?\n/));
			if (!model) {
				el.createDiv({
					cls: "adt-tracker-error",
					text: "Tracker needs a header row, e.g. unlocked,Gym,Water(4)",
				});
				return;
			}
			this.renderTracker(model, el, { ctx, section: el, kind: "code" });
		});

		this.registerMarkdownPostProcessor((el, ctx) => {
			if (!this.settings.tableTrackers) return;
			el.findAll("table").forEach((table) => {
				if (table.closest(".adt-tracker")) return;
				const model = modelFromTableEl(table);
				if (!model) return;
				const host = createDiv();
				table.replaceWith(host);
				this.renderTracker(model, host, { ctx, section: el, kind: "table" });
			});
		});

		this.registerMarkdownCodeBlockProcessor("tracker-graph", (source, el, ctx) => this.renderGraph(source, el, ctx, "graph"));
		this.registerMarkdownCodeBlockProcessor("tracker-pie", (source, el, ctx) => this.renderGraph(source, el, ctx, "pie"));
		this.registerMarkdownCodeBlockProcessor("tracker-heatmap", (source, el, ctx) => this.renderGraph(source, el, ctx, "heatmap"));
	}

	onunload(): void {
		const style = document.body.style;
		style.removeProperty("--adt-cell-size");
		style.removeProperty("--adt-hgap");
		style.removeProperty("--adt-vgap");
		style.removeProperty("--adt-text-size");
		style.removeProperty("--adt-gap-scale");
		style.removeProperty("--adt-margin-top");
		style.removeProperty("--adt-margin-bottom");
		document.body.classList.remove("adt-sticky-vertical");
		HIGHLIGHT_STYLES.forEach((w) => document.body.classList.remove(`adt-weekend-${w}`, `adt-today-${w}`));
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<DailyTrackerSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
		const legacy: { boldWeekends?: boolean; weekendStyle?: HighlightStyle; showYear?: boolean } | null = data;
		if (legacy?.boldWeekends === false && legacy.weekendStyle === undefined) this.settings.weekendStyle = "none";
		if (legacy?.showYear === false && data?.dateParts === undefined) this.settings.dateParts = "month-day";
		if ((this.settings.monthHeadings as string) === "spacer") this.settings.monthHeadings = "gap";
		if (this.settings.orientation !== "horizontal") this.settings.orientation = "vertical";
		if ((data as { showGraphLabels?: boolean } | null)?.showGraphLabels === false && data?.graphHeader === undefined) this.settings.graphHeader = "none";
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	applyAppearance(): void {
		const style = document.body.style;
		style.setProperty("--adt-cell-size", `${this.settings.cellSize}px`);
		style.setProperty("--adt-hgap", `${this.settings.gapHorizontal}px`);
		style.setProperty("--adt-vgap", `${this.settings.gapVertical}px`);
		style.setProperty("--adt-text-size", `${this.settings.textSize}px`);
		style.setProperty("--adt-margin-top", `${this.settings.marginTop}px`);
		style.setProperty("--adt-margin-bottom", `${this.settings.marginBottom}px`);
		style.setProperty("--adt-gap-scale", String(this.settings.gapSize / 100));
		document.body.classList.toggle("adt-sticky-vertical", this.settings.stickyLabelsVertical);
		HIGHLIGHT_STYLES.forEach((w) => {
			document.body.classList.toggle(`adt-weekend-${w}`, this.settings.weekendStyle === w);
			document.body.classList.toggle(`adt-today-${w}`, this.settings.todayStyle === w);
		});
	}

	refresh(): void {
		this.applyAppearance();
		this.rerenderNote();
	}

	private rerenderNote(path?: string): void {
		this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && (!path || view.file?.path === path)) {
				view.previewMode.rerender(true);
			}
		});
	}

	private formatDate(raw: string): string {
		const { dateFormat, dateSeparator, dateParts, romanMonths } = this.settings;
		const date = parseDate(raw);
		if (!date) return raw;
		const part = {
			y: String(date.getFullYear()),
			m: romanMonths ? ROMAN_MONTHS[date.getMonth()] : pad2(date.getMonth() + 1),
			d: pad2(date.getDate()),
		};
		const order: ("y" | "m" | "d")[] = dateFormat === "mdy" ? ["m", "d", "y"] : dateFormat === "ymd" ? ["y", "m", "d"] : ["d", "m", "y"];
		return order
			.filter((k) => k === "d" || (k === "m" && dateParts !== "day") || (k === "y" && dateParts === "full"))
			.map((k) => part[k])
			.join(dateSeparator);
	}

	private formatMonth(d: Date): string {
		const name = new Intl.DateTimeFormat(moment.locale(), { month: "long" }).format(d);
		const label = name.charAt(0).toLocaleUpperCase(moment.locale()) + name.slice(1);
		return this.settings.monthHeadings === "month-year" ? `${label} ${d.getFullYear()}` : label;
	}


	private async editBlock(
		ref: BlockRef,
		fn: (model: TrackerModel) => boolean,
		convertTo?: BlockKind,
		silent = false,
	): Promise<boolean> {
		const { ctx, section, kind } = ref;
		const info = ctx.getSectionInfo(section);
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!info || !(file instanceof TFile)) {
			if (!silent) new Notice("Could not update tracker.");
			return false;
		}

		let updated = false;
		await this.app.vault.process(file, (text) => {
			const nl = text.includes("\r\n") ? "\r\n" : "\n";
			const lines = text.split(/\r?\n/);
			const first = lines[info.lineStart] ?? "";

			let model: TrackerModel | null;
			if (kind === "code") {
				if (!/^\s*(```|~~~)\s*tracker/.test(first)) return text;
				model = parseCsv(lines.slice(info.lineStart + 1, info.lineEnd));
			} else {
				if (!first.includes("|")) return text;
				model = parseTableLines(lines.slice(info.lineStart, info.lineEnd + 1));
			}
			if (!model || !fn(model)) return text;

			const outKind = convertTo ?? kind;
			const body = serializeModel(model, outKind);
			let out: string[];
			if (outKind === "table") out = body;
			else if (kind === "code") out = [first, ...body, lines[info.lineEnd]];
			else out = ["```tracker", ...body, "```"];

			lines.splice(info.lineStart, info.lineEnd - info.lineStart + 1, ...out);
			updated = true;
			return lines.join(nl);
		});

		if (!updated && !silent) new Notice("Tracker changed in the note. Please try again.");
		return updated;
	}

	private insertSnippet(editor: Editor, block: string[], cursorLine: number): void {
		const cursor = editor.getCursor();
		const before = editor.getLine(cursor.line).slice(0, cursor.ch).trim() === "" ? "" : "\n";
		editor.replaceRange(`${before}${block.join("\n")}\n`, cursor);
		const startLine = cursor.line + (before ? 1 : 0);
		const target = block[cursorLine] ?? "";
		editor.setCursor({ line: startLine + cursorLine, ch: target.length });
	}

	private async insertChart(ref: BlockRef, columnName: string, style: "graph" | "pie" | "heatmap"): Promise<void> {
		const info = ref.ctx.getSectionInfo(ref.section);
		const file = this.app.vault.getAbstractFileByPath(ref.ctx.sourcePath);
		if (!info || !(file instanceof TFile)) {
			new Notice("Could not add the chart.");
			return;
		}
		const name = parseColumn(columnName).name;
		await this.app.vault.process(file, (text) => {
			const nl = text.includes("\r\n") ? "\r\n" : "\n";
			const lines = text.split(/\r?\n/);
			const block = ["", "```" + (style === "pie" ? "tracker-pie" : style === "heatmap" ? "tracker-heatmap" : "tracker-graph"), name, "```"];
			if ((lines[info.lineEnd + 1] ?? "").trim() !== "") block.push("");
			lines.splice(info.lineEnd + 1, 0, ...block);
			return lines.join(nl);
		});
	}

	private async editAndRerender(
		ref: BlockRef,
		fn: (model: TrackerModel) => boolean,
		convertTo?: BlockKind,
	): Promise<void> {
		if (await this.editBlock(ref, fn, convertTo)) this.rerenderNote(ref.ctx.sourcePath);
	}

	private fillDays(m: TrackerModel): boolean {
		const days = missingDaysToToday(m.rows);
		if (days.length === 0) return false;
		days.forEach((date) => m.rows.push({ date, cells: m.columns.map(() => "") }));
		return true;
	}

	private autoFill(ref: BlockRef, rows: TrackerRow[], mode: TrackerMode): void {
		const path = ref.ctx.sourcePath;
		if (!this.settings.autoAddDays || mode === "locked") return;
		if (missingDaysToToday(rows).length === 0 || this.autoFilling.has(path)) return;
		this.autoFilling.add(path);
		window.setTimeout(() => {
			void this.editBlock(ref, (m) => (this.settings.allUnlocked || modeOf(m.head0) !== "locked") && this.fillDays(m), undefined, true)
				.then((ok) => {
					this.autoFilling.delete(path);
					if (ok) this.rerenderNote(path);
				})
				.catch(() => this.autoFilling.delete(path));
		}, 250);
	}

	private moveColumn(ref: BlockRef, name: string, from: number, to: number): void {
		void this.editAndRerender(ref, (m) => {
			if (m.columns[from] !== name || to < 0 || to >= m.columns.length) return false;
			move(m.columns, from, to);
			m.rows.forEach((r) => move(r.cells, from, to));
			return true;
		});
	}


	private async renderGraph(
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext,
		style: "graph" | "pie" | "heatmap",
	): Promise<void> {
		if (!this.settings.chartSnippets) {
			el.createEl("pre").createEl("code", { text: source });
			return;
		}
		const items: { name: string; link: string | null }[] = [];
		let stickyLink: string | null = null;
		source
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean)
			.forEach((line) => {
				const m = /^(.*?)\s*\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]\s*$/.exec(line);
				if (!m) items.push({ name: line, link: stickyLink });
				else if (!m[1]) stickyLink = m[2].trim();
				else items.push({ name: m[1], link: m[2].trim() });
			});
		if (items.length === 0) {
			el.createDiv({ cls: "adt-tracker-error", text: "Graph needs a column name, e.g. Sleep, or Sleep [[Note name]]" });
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) {
			el.createDiv({ cls: "adt-tracker-error", text: "Could not read the note." });
			return;
		}

		const watched = new Set<string>([ctx.sourcePath]);
		let run = 0;
		const draw = async (): Promise<void> => {
			const id = ++run;
			const texts = new Map<string, string>();
			const resolved = items.map((item) => {
				const target = item.link ? this.app.metadataCache.getFirstLinkpathDest(item.link, ctx.sourcePath) : file;
				return { item, target };
			});
			watched.clear();
			watched.add(ctx.sourcePath);
			for (const { target } of resolved) {
				if (!target) continue;
				watched.add(target.path);
				if (!texts.has(target.path)) texts.set(target.path, await this.app.vault.read(target));
			}
			if (id !== run) return;
			el.empty();
			const wrap = el.createDiv({ cls: "adt-graphs" });
			resolved.forEach(({ item, target }) => {
				if (!target) {
					wrap.createDiv({ cls: "adt-graph" }).createDiv({ cls: "adt-tracker-error", text: `No note named "${item.link}".` });
					return;
				}
				const text = texts.get(target.path) ?? "";
				if (style === "pie") this.drawPie(wrap, item.name, findColumn(text, item.name));
				else if (style === "heatmap") this.drawHeatmap(wrap, item.name, findHeat(text, item.name));
				else this.drawSeries(wrap, item.name, findSeries(text, item.name));
			});
		};

		const child = new MarkdownRenderChild(el);
		child.registerEvent(
			this.app.metadataCache.on("changed", (changed) => {
				if (watched.has(changed.path)) void draw();
			}),
		);
		ctx.addChild(child);
		await draw();
	}

	private drawPie(host: HTMLElement, query: string, col: PieColumn | null): void {
		const box = host.createDiv({ cls: "adt-graph adt-pie" });
		if (!col) {
			box.createDiv({ cls: "adt-tracker-error", text: `No column named "${query}" in this note.` });
			return;
		}
		if (this.settings.graphHeader !== "none") box.createDiv({ cls: "adt-graph-title", text: col.name });
		const slices = pieSlices(col);
		const total = slices.reduce((a, p) => a + p.count, 0);
		if (total === 0) {
			box.createDiv({ cls: "adt-graph-stats", text: "No data yet." });
			return;
		}
		if (this.settings.graphHeader === "name-days") box.createDiv({ cls: "adt-graph-stats", text: `${total} ${total === 1 ? "day" : "days"}` });

		const body = box.createDiv({ cls: "adt-pie-body" });
		const R = 80;
		const svg = body.createSvg("svg", {
			cls: "adt-pie-svg",
			attr: { viewBox: `${-R - 2} ${-R - 2} ${2 * R + 4} ${2 * R + 4}`, role: "img", "aria-label": `${col.name} as a pie chart` },
		});
		const colour = (p: PieSlice, i: number): string =>
			p.empty ? "var(--background-modifier-border-hover)" : `var(--adt-pie-${i % 8})`;

		let angle = -Math.PI / 2;
		slices.forEach((p, i) => {
			const sweep = (2 * Math.PI * p.count) / total;
			const tip = `${p.label}: ${p.count} (${Math.round((100 * p.count) / total)}%)`;
			let shape: SVGElement;
			if (slices.length === 1) {
				shape = svg.createSvg("circle", { cls: "adt-pie-slice", attr: { cx: 0, cy: 0, r: R } });
			} else {
				const x1 = R * Math.cos(angle);
				const y1 = R * Math.sin(angle);
				const x2 = R * Math.cos(angle + sweep);
				const y2 = R * Math.sin(angle + sweep);
				shape = svg.createSvg("path", {
					cls: "adt-pie-slice",
					attr: { d: `M0 0 L${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z` },
				});
			}
			shape.setAttr("style", `fill: ${colour(p, i)}`);
			shape.createSvg("title").textContent = tip;
			angle += sweep;
		});

		const legend = body.createDiv({ cls: "adt-pie-legend" });
		slices.forEach((p, i) => {
			const row = legend.createDiv({ cls: "adt-pie-row" });
			row.createSpan({ cls: "adt-pie-swatch" }).setAttr("style", `background: ${colour(p, i)}`);
			row.createSpan({ cls: "adt-pie-label", text: p.label });
			row.createSpan({ cls: "adt-pie-count", text: `${p.count} \u00B7 ${Math.round((100 * p.count) / total)}%` });
		});
	}

	private drawHeatmap(host: HTMLElement, query: string, col: HeatColumn | null): void {
		const box = host.createDiv({ cls: "adt-graph adt-heat" });
		box.toggleClass("is-number", col?.kind === "number");
		if (!col) {
			box.createDiv({ cls: "adt-tracker-error", text: `No column named "${query}" in this note.` });
			return;
		}
		if (this.settings.graphHeader !== "none") box.createDiv({ cls: "adt-graph-title", text: col.name });
		if (col.kind !== "check" && col.kind !== "levels" && col.kind !== "number") {
			box.createDiv({ cls: "adt-tracker-error", text: "Heatmaps work with checkbox, level and number columns." });
			return;
		}
		const isos = Array.from(col.values.keys()).sort();
		if (isos.length === 0) {
			box.createDiv({ cls: "adt-graph-stats", text: "No data yet." });
			return;
		}
		const active = Array.from(col.values.values()).filter((v) => v > 0).length;
		if (this.settings.graphHeader === "name-days") box.createDiv({ cls: "adt-graph-stats", text: `${active} ${active === 1 ? "day" : "days"} active` });

		const maxValue = col.kind === "number" ? Math.max(1, ...Array.from(col.values.values())) : col.max;
		const strength = (v: number): number => {
			if (v <= 0) return 0;
			let step: number;
			let steps: number;
			if (col.kind === "number") {
				steps = 4;
				step = Math.min(4, Math.ceil((4 * v) / maxValue));
			} else {
				steps = col.max;
				step = Math.min(steps, v);
			}
			return steps <= 1 ? 100 : Math.round(30 + (70 * (step - 1)) / (steps - 1));
		};

		const weekday = (d: Date): number => (d.getDay() + 6) % 7;
		const first = parseDate(isos[0]) as Date;
		const last = parseDate(isos[isos.length - 1]) as Date;
		const start = new Date(first);
		start.setDate(start.getDate() - weekday(first));
		const weeks = Math.floor(Math.round((last.getTime() - start.getTime()) / 86400000) / 7) + 1;

		const scroll = box.createDiv({ cls: "adt-heat-scroll" });
		const grid = scroll.createDiv({ cls: "adt-heat-grid" });
		grid.style.gridTemplateColumns = `auto repeat(${weeks}, var(--adt-heat-size))`;

		const labels: { week: number; month: Date }[] = [{ week: 0, month: first }];
		for (let w = 1; w < weeks; w++) {
			for (let r = 0; r < 7; r++) {
				const d = new Date(start);
				d.setDate(d.getDate() + w * 7 + r);
				if (d.getDate() === 1) labels.push({ week: w, month: d });
			}
		}
		if (labels.length > 1 && labels[1].week < 3) labels.shift();
		labels.forEach(({ week, month }) => {
			const el = grid.createDiv({ cls: "adt-heat-month", text: month.toLocaleString(undefined, { month: "short" }) });
			el.style.gridColumn = String(week + 2);
		});

		["Mon", "", "Wed", "", "Fri", "", ""].forEach((text, r) => {
			if (!text) return;
			const el = grid.createDiv({ cls: "adt-heat-weekday", text });
			el.style.gridRow = String(r + 2);
		});

		const firstIso = isos[0];
		const lastIso = isos[isos.length - 1];
		for (let w = 0; w < weeks; w++) {
			for (let r = 0; r < 7; r++) {
				const d = new Date(start);
				d.setDate(d.getDate() + w * 7 + r);
				const iso = toIso(d);
				if (iso < firstIso || iso > lastIso) continue;
				const v = col.values.get(iso) ?? 0;
				const cell = grid.createDiv({ cls: "adt-heat-cell" });
				cell.style.gridColumn = String(w + 2);
				cell.style.gridRow = String(r + 2);
				if (col.kind === "number") {
					if (v > 0) cell.setText(String(v));
				} else {
					const pct = strength(v);
					if (pct > 0) {
						cell.addClass("is-on");
						cell.style.setProperty("--adt-heat-level", String(pct));
					}
				}
				cell.setAttr("title", `${this.formatDate(iso)}${v > 0 && col.kind !== "check" ? `: ${v}` : ""}`);
			}
		}

		if (col.kind === "levels") {
			const legend = box.createDiv({ cls: "adt-heat-legend" });
			legend.createSpan({ text: "Less" });
			[0, 30, 55, 80, 100].forEach((pct) => {
				const sw = legend.createDiv({ cls: "adt-heat-cell" });
				if (pct > 0) {
					sw.addClass("is-on");
					sw.style.setProperty("--adt-heat-level", String(pct));
				}
			});
			legend.createSpan({ text: "More" });
		}

		window.requestAnimationFrame(() => {
			scroll.scrollLeft = scroll.scrollWidth;
		});
	}

	private drawSeries(host: HTMLElement, query: string, series: GraphSeries | null): void {
		const box = host.createDiv({ cls: "adt-graph" });
		if (!series) {
			box.createDiv({ cls: "adt-tracker-error", text: `No column named "${query}" in this note.` });
			return;
		}
		if (this.settings.graphHeader !== "none") box.createDiv({ cls: "adt-graph-title", text: series.name });
		const kind = series.kind;
		if (!isGraphKind(kind)) {
			box.createDiv({ cls: "adt-tracker-error", text: "Graphs work with number, time and duration columns." });
			return;
		}
		const pts = series.points;
		if (pts.length === 0) {
			box.createDiv({ cls: "adt-graph-stats", text: "No data yet." });
			return;
		}

		const origin = kind === "time" ? timeOrigin(pts.map((p) => p.value)) : 0;
		const valueOf = (p: GraphPoint): number => (kind === "time" ? origin + ((p.value - origin + 1440) % 1440) : p.value);
		const vs = pts.map(valueOf);
		const axis = niceAxis(kind === "time" ? Math.min(...vs) : 0, Math.max(...vs), kind === "number" ? GRAPH_STEPS_NUMBER : GRAPH_STEPS_MINUTES);

		const showValue = (v: number): string => {
			if (kind === "number") return String(Math.round(v * 10) / 10);
			if (kind === "time") return formatClock(v);
			return v === 0 ? "0" : formatDuration(Math.round(v), false);
		};

		if (this.settings.graphHeader === "name-days") {
			box.createDiv({
				cls: "adt-graph-stats",
				text: `${pts.length} ${pts.length === 1 ? "day" : "days"} logged`,
			});
		}

		const W = 640;
		const H = 220;
		const left = 52;
		const right = 16;
		const top = 12;
		const bottom = 28;
		const plotW = W - left - right;
		const plotH = H - top - bottom;
		const span = pts[pts.length - 1].day;
		const x = (day: number): number => left + (span === 0 ? plotW / 2 : (plotW * day) / span);
		const y = (v: number): number => top + plotH * (1 - (v - axis.from) / (axis.to - axis.from));

		const svg = box.createSvg("svg", {
			cls: "adt-graph-svg",
			attr: { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${series.name} over time` },
		});

		axis.ticks.forEach((t) => {
			svg.createSvg("line", { cls: "adt-graph-grid", attr: { x1: left, x2: W - right, y1: y(t), y2: y(t) } });
			const tick = svg.createSvg("text", {
				cls: "adt-graph-label",
				attr: { x: left - 8, y: y(t) + 4, "text-anchor": "end" },
			});
			tick.textContent = showValue(t);
		});

		const first = parseDate(pts[0].iso) as Date;
		const labels = span === 0 ? 1 : Math.min(span + 1, 5);
		for (let k = 0; k < labels; k++) {
			const day = labels === 1 ? 0 : Math.round((span * k) / (labels - 1));
			const date = new Date(first);
			date.setDate(date.getDate() + day);
			const dateLabel = svg.createSvg("text", {
				cls: "adt-graph-label",
				attr: {
					x: x(day),
					y: H - 8,
					"text-anchor": labels === 1 ? "middle" : k === 0 ? "start" : k === labels - 1 ? "end" : "middle",
				},
			});
			dateLabel.textContent = this.formatDate(toIso(date));
		}

		let segment: string[] = [];
		const flush = (): void => {
			if (segment.length > 1) svg.createSvg("path", { cls: "adt-graph-line", attr: { d: segment.join(" ") } });
			segment = [];
		};
		pts.forEach((p, i) => {
			if (i > 0 && p.day - pts[i - 1].day !== 1) flush();
			segment.push(`${segment.length ? "L" : "M"}${x(p.day).toFixed(1)} ${y(vs[i]).toFixed(1)}`);
		});
		flush();

		pts.forEach((p, i) => {
			const dot = svg.createSvg("circle", { cls: "adt-graph-dot", attr: { cx: x(p.day), cy: y(vs[i]), r: 3 } });
			dot.createSvg("title").textContent = `${this.formatDate(p.iso)}: ${showValue(p.value)}`;
		});
	}


	private renderTracker(model: TrackerModel, host: HTMLElement, ref: BlockRef): void {
		const { columns, rows } = model;
		const mode: TrackerMode = this.settings.allUnlocked ? "unlocked" : modeOf(model.head0);
		const horizontal = this.settings.orientation === "horizontal";
		const headings = this.settings.monthHeadings;
		const today = todayIso();
		const oldest = new Date();
		oldest.setDate(oldest.getDate() - (LIMITED_DAYS[this.settings.limitedRange] - 1));
		const oldestEditable = toIso(oldest);

		this.autoFill(ref, rows, mode);

		const kinds = columns.map((c) => parseColumn(c).kind);
		const trackOf = (k: ColumnKind): string => (isTextKind(k) ? "var(--adt-wide-size)" : "var(--adt-cell-size)");

		const days: DayInfo[] = [];
		let lastMonth = "";
		rows.forEach((row) => {
			const date = parseDate(row.date);
			const iso = date ? toIso(date) : null;
			let monthStart: Date | null = null;
			let spaced = false;
			if (headings !== "none" && date) {
				const key = `${date.getFullYear()}-${date.getMonth()}`;
				if (key !== lastMonth) {
					spaced = lastMonth !== "";
					lastMonth = key;
					monthStart = date;
				}
			}
			days.push({
				date,
				iso,
				monthStart,
				spaced,
				canEdit: mode === "unlocked" || (mode === "limited" && iso !== null && iso >= oldestEditable && iso <= today),
			});
		});

		const gapped = (i: number): boolean => days[i].spaced && (horizontal || headings === "gap");
		const gapClass = horizontal ? "adt-gap-left" : "adt-gap-top";

		if (horizontal) host.addClass("adt-tracker-host");
		const grid = host.createDiv({ cls: "adt-tracker" });
		grid.addClass(`is-${mode}`);
		if (horizontal) grid.addClass("is-horizontal");

		if (!horizontal) {
			window.requestAnimationFrame(() => {
				let el: HTMLElement | null = grid.parentElement;
				while (el) {
					const cs = getComputedStyle(el);
					if (/(auto|scroll)/.test(cs.overflowY)) {
						grid.style.setProperty("--adt-sticky-pad", cs.paddingTop);
						return;
					}
					el = el.parentElement;
				}
			});
		}

		const setTemplate = (extra?: ColumnKind): void => {
			if (horizontal) return;
			const tracks = kinds.map(trackOf);
			if (extra) tracks.push(trackOf(extra));
			grid.style.gridTemplateColumns = ["auto", ...tracks].join(" ");
		};
		if (horizontal) {
			const track = (d: DayInfo): string =>
				d.spaced ? "calc(var(--adt-cell-size) + var(--adt-month-gap))" : "var(--adt-cell-size)";
			grid.style.gridTemplateColumns = ["auto", ...days.map(track)].join(" ");
		} else {
			setTemplate();
		}


		const heads: HTMLElement[] = [];
		const buildHead = (colIdx: number): HTMLElement => {
			const head = grid.createDiv({ cls: "adt-tracker-head" });
			head.dataset.col = String(colIdx);
			if (isTextKind(kinds[colIdx]) && !horizontal) head.addClass("is-wide");
			head.createSpan({ text: parseColumn(columns[colIdx]).name });
			heads.push(head);
			return head;
		};

		const buildDate = (rowIdx: number): HTMLElement => {
			const info = days[rowIdx];
			const dateEl = grid.createDiv({ cls: "adt-tracker-date" });
			const text = this.formatDate(rows[rowIdx].date);
			if (horizontal) {
				dateEl.createSpan({ text });
				dateEl.toggleClass("is-flat", this.settings.dateParts === "day");
			} else {
				dateEl.setText(text);
			}
			if (gapped(rowIdx)) dateEl.addClass(gapClass);
			dateEl.toggleClass("is-today", info.iso === today);
			const day = info.date?.getDay();
			dateEl.toggleClass("is-weekend", day === 0 || day === 6);
			return dateEl;
		};

		const buildTextCell = (
			cell: HTMLElement,
			rowIdx: number,
			colIdx: number,
			colName: string,
			label: string,
			kind: "time" | "duration",
		): HTMLElement => {
			const row = rows[rowIdx];
			cell.setAttr("role", "button");
			cell.addClass("is-value");
			cell.addClass(horizontal ? "is-compact" : "is-wide");
			let value = cleanValue(kind, row.cells[colIdx] ?? "");

			const full = (v: string): string => (kind === "time" ? v : formatDuration(Number(v), true));
			const short = (v: string): string => {
				if (kind === "time") return horizontal ? v.slice(0, 2) : v;
				return horizontal ? compactHours(Number(v)) : formatDuration(Number(v), false);
			};
			const paint = (): void => {
				cell.empty();
				cell.setAttr("aria-label", value ? `${row.date} ${label}: ${full(value)}` : `${row.date} ${label}`);
				cell.setAttr("title", value ? `${label}: ${full(value)}` : label);
				if (value) cell.setText(short(value));
			};
			paint();

			if (!days[rowIdx].canEdit) {
				cell.addClass("is-readonly");
				cell.setAttr("aria-disabled", "true");
				return cell;
			}
			cell.setAttr("tabindex", "0");

			const save = async (next: string): Promise<void> => {
				const ok = await this.editBlock(ref, (m) => {
					const r = m.rows[rowIdx];
					if (!r || r.date !== row.date || m.columns[colIdx] !== colName) return false;
					while (r.cells.length < m.columns.length) r.cells.push("");
					r.cells[colIdx] = next;
					return true;
				});
				if (ok) value = next;
				paint();
			};

			let editing = false;
			const edit = (): void => {
				if (editing) return;
				editing = true;
				cell.addClass("is-editing");
				cell.empty();
				const input = cell.createEl("input", { cls: "adt-tracker-number", type: "text" });
				input.inputMode = kind === "time" ? "numeric" : "text";
				input.maxLength = 9;
				input.placeholder = kind === "time" ? "hh:mm" : "1h30";
				input.value = !value ? "" : kind === "time" ? value : formatDuration(Number(value), false).replace(/ /g, "");
				input.setAttr("aria-label", `${row.date} ${label}`);
				let done = false;
				const finish = (apply: boolean): void => {
					if (done) return;
					done = true;
					editing = false;
					cell.removeClass("is-editing");
					if (!apply) {
						paint();
						return;
					}
					const next = parseValue(kind, input.value);
					if (next === null) {
						new Notice(
							kind === "time"
								? `Could not read \u201C${input.value.trim()}\u201D as a time. Try 7:30 or 0730.`
								: `Could not read \u201C${input.value.trim()}\u201D as a duration. Try 1h30, 1:30 or 90.`,
						);
						paint();
					} else if (next !== value) void save(next);
					else paint();
				};
				input.addEventListener("keydown", (e: KeyboardEvent) => {
					e.stopPropagation();
					if (e.key === "Enter") {
						e.preventDefault();
						finish(true);
						cell.focus();
					} else if (e.key === "Escape") {
						e.preventDefault();
						finish(false);
						cell.focus();
					}
				});
				input.addEventListener("blur", () => finish(true));
				input.addEventListener("click", (e: MouseEvent) => e.stopPropagation());
				input.focus();
				input.select();
			};

			cell.addEventListener("click", edit);
			cell.addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.target !== cell) return;
				if (e.key === " " || e.key === "Enter") {
					e.preventDefault();
					edit();
				}
			});
			return cell;
		};

		const buildCell = (rowIdx: number, colIdx: number): HTMLElement => {
			const row = rows[rowIdx];
			const colName = columns[colIdx];
			const cell = grid.createDiv({ cls: "adt-tracker-cell" });
			cell.dataset.col = String(colIdx);
			if (gapped(rowIdx)) cell.addClass(gapClass);
			const { name: label, max, kind: colKind } = parseColumn(colName);
			if (isTextKind(colKind)) return buildTextCell(cell, rowIdx, colIdx, colName, label, colKind);
			cell.setAttr("role", colKind === "check" ? "checkbox" : "button");
			if (colKind === "number") cell.addClass("is-value", "is-number");

			const paint = (level: number): void => {
				const on = level > 0;
				cell.toggleClass("is-checked", on);
				cell.empty();
				if (colKind === "number") {
					cell.toggleClass("is-checked", false);
					cell.setAttr("aria-label", `${row.date} ${label}: ${level}`);
					cell.setAttr("title", `${label}: ${level}`);
					if (on) cell.setText(String(level));
					return;
				}
				if (colKind === "check") {
					cell.setAttr("aria-checked", String(on));
					cell.setAttr("aria-label", `${row.date} ${label}`);
					cell.removeAttribute("title");
					if (on) setIcon(cell, "check");
					return;
				}
				const strength = Math.round((100 * level) / max);
				cell.style.setProperty("--adt-level", String(strength));
				cell.setAttr("aria-label", `${row.date} ${label}: ${level} of ${max}`);
				cell.setAttr("title", `${label}: ${level}/${max}`);
			};

			let state = levelOf(row.cells[colIdx], max, colKind);
			paint(state);

			if (!days[rowIdx].canEdit) {
				cell.addClass("is-readonly");
				cell.setAttr("aria-disabled", "true");
				return cell;
			}

			cell.setAttr("tabindex", "0");
			const save = async (next: number): Promise<void> => {
				const ok = await this.editBlock(ref, (m) => {
					const r = m.rows[rowIdx];
					if (!r || r.date !== row.date || m.columns[colIdx] !== colName) return false;
					while (r.cells.length < m.columns.length) r.cells.push("");
					r.cells[colIdx] = String(next);
					return true;
				});
				if (ok) {
					state = next;
					paint(state);
				}
			};
			const toggle = (step: 1 | -1): Promise<void> => save((state + step + max + 1) % (max + 1));

			let editing = false;
			const edit = (): void => {
				if (editing) return;
				editing = true;
				cell.addClass("is-editing");
				cell.empty();
				const input = cell.createEl("input", { cls: "adt-tracker-number", type: "text" });
				input.inputMode = "numeric";
				input.maxLength = String(MAX_NUMBER).length;
				input.value = state > 0 ? String(state) : "";
				input.setAttr("aria-label", `${row.date} ${label}`);
				let done = false;
				const finish = (apply: boolean): void => {
					if (done) return;
					done = true;
					editing = false;
					cell.removeClass("is-editing");
					const typed = input.value.replace(/\D/g, "");
					const next = typed ? Math.min(Number(typed), max) : 0;
					if (apply && next !== state) void save(next);
					else paint(state);
				};
				input.addEventListener("input", () => {
					input.value = input.value.replace(/\D/g, "");
				});
				input.addEventListener("keydown", (e: KeyboardEvent) => {
					e.stopPropagation();
					if (e.key === "Enter") {
						e.preventDefault();
						finish(true);
						cell.focus();
					} else if (e.key === "Escape") {
						e.preventDefault();
						finish(false);
						cell.focus();
					}
				});
				input.addEventListener("blur", () => finish(true));
				input.addEventListener("click", (e: MouseEvent) => e.stopPropagation());
				input.focus();
				input.select();
			};

			cell.addEventListener("click", (e: MouseEvent) => {
				if (colKind === "number") edit();
				else void toggle(e.shiftKey ? -1 : 1);
			});
			cell.addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.target !== cell) return;
				if (e.key === " " || e.key === "Enter") {
					e.preventDefault();
					if (colKind === "number") edit();
					else void toggle(e.shiftKey ? -1 : 1);
				}
			});
			return cell;
		};


		let headAnchor: HTMLElement | null = null;
		const rowAnchors: HTMLElement[] = [];
		const gapRows = new Set<number>();

		if (horizontal) {
			if ((headings === "month" || headings === "month-year") && days.length > 0) {
				const spans: { label: string; span: number; spaced: boolean }[] = [];
				days.forEach((info) => {
					if (info.monthStart || spans.length === 0) {
						const show = info.monthStart !== null && info.spaced;
						spans.push({ label: show && info.monthStart ? this.formatMonth(info.monthStart) : "", span: 0, spaced: info.spaced });
					}
					spans[spans.length - 1].span++;
				});
				grid.createDiv({ cls: "adt-tracker-corner" });
				spans.forEach(({ label, span, spaced }) => {
					const heading = grid.createDiv({ cls: "adt-tracker-month", text: label });
					heading.style.gridColumn = `span ${span}`;
					if (this.settings.monthAlign !== "center") heading.addClass("is-far-left");
					if (spaced) heading.addClass("adt-gap-left");
				});
			}

			grid.createDiv({ cls: "adt-tracker-corner" });
			rows.forEach((_, rowIdx) => buildDate(rowIdx));
			columns.forEach((_, colIdx) => {
				buildHead(colIdx);
				rows.forEach((__, rowIdx) => buildCell(rowIdx, colIdx));
			});
		} else {
			headAnchor = grid.createDiv({ cls: "adt-tracker-corner" });
			columns.forEach((_, colIdx) => {
				headAnchor = buildHead(colIdx);
			});

			rows.forEach((_, rowIdx) => {
				const info = days[rowIdx];
				if (info.monthStart && headings !== "gap" && info.spaced) {
					const align = this.settings.monthAlign === "left" && columns.length === 0 ? "far-left" : this.settings.monthAlign;
					const heading = grid.createDiv({ cls: "adt-tracker-month", text: this.formatMonth(info.monthStart) });
					heading.addClass(`is-${align}`);
					if (info.spaced) heading.addClass("adt-gap-top");
				}
				if (gapped(rowIdx)) gapRows.add(rowIdx);
				let anchor: HTMLElement = buildDate(rowIdx);
				columns.forEach((__, colIdx) => {
					anchor = buildCell(rowIdx, colIdx);
				});
				rowAnchors.push(anchor);
			});
		}


		let pending: { head: HTMLElement; cells: HTMLElement[] } | null = null;

		const cancelNewColumn = (): void => {
			if (!pending) return;
			pending.head.remove();
			pending.cells.forEach((c) => c.remove());
			pending = null;
			setTemplate();
		};

		const beginNewColumn = (kind: ColumnKind = "check"): void => {
			if (pending) {
				pending.head.querySelector<HTMLElement>("span")?.focus();
				return;
			}
			setTemplate(kind);

			const head = createDiv({ cls: "adt-tracker-head is-new" });
			if (isTextKind(kind) && !horizontal) head.addClass("is-wide");
			const input = head.createSpan({ cls: "adt-tracker-newname" });
			input.contentEditable = "plaintext-only";
			if (input.contentEditable !== "plaintext-only") input.contentEditable = "true";
			input.dataset.placeholder = COLUMN_TYPES.find((t) => t.kind === kind)?.hint ?? "Name";
			input.setAttr("title", "Name = checkbox \u00b7 Name(5) = shades \u00b7 Name(#) = number \u00b7 Name(time) \u00b7 Name(dur)");

			let cells: HTMLElement[];
			if (horizontal) {
				grid.append(head);
				cells = rows.map((_, i) => {
					const c = createDiv({ cls: "adt-tracker-cell is-placeholder" });
					if (isTextKind(kind) && !horizontal) c.addClass("is-wide");
					if (gapped(i)) c.addClass(gapClass);
					grid.append(c);
					return c;
				});
			} else {
				headAnchor?.after(head);
				cells = rowAnchors.map((anchor, i) => {
					const c = createDiv({ cls: "adt-tracker-cell is-placeholder" });
					if (isTextKind(kind) && !horizontal) c.addClass("is-wide");
					if (gapRows.has(i)) c.addClass("adt-gap-top");
					anchor.after(c);
					return c;
				});
			}
			pending = { head, cells };

			let done = false;
			const commit = (): void => {
				if (done) return;
				done = true;
				const name = (input.textContent ?? "").replace(/[,|\r\n]+/g, " ").trim();
				if (!name) {
					cancelNewColumn();
					return;
				}
				void this.editBlock(ref, (m) => {
					m.columns.push(headerFor(name, kind));
					m.rows.forEach((r) => {
						while (r.cells.length < m.columns.length) r.cells.push("");
					});
					return true;
				}).then((ok) => {
					if (ok) this.rerenderNote(ref.ctx.sourcePath);
					else cancelNewColumn();
				});
			};

			input.addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.key === "Enter") {
					e.preventDefault();
					commit();
				} else if (e.key === "Escape") {
					e.preventDefault();
					done = true;
					cancelNewColumn();
				}
			});
			input.addEventListener("blur", commit);
			window.setTimeout(() => input.focus(), 50);
		};


		const beginRename = (colIdx: number): void => {
			const span = heads[colIdx]?.querySelector<HTMLElement>("span");
			const oldName = columns[colIdx];
			if (!span || oldName === undefined || span.hasClass("adt-tracker-newname")) return;
			const shownName = parseColumn(oldName).name;

			span.setText(oldName);
			span.addClass("adt-tracker-newname");
			span.contentEditable = "plaintext-only";
			if (span.contentEditable !== "plaintext-only") span.contentEditable = "true";

			let done = false;
			const finish = (): void => {
				span.removeEventListener("blur", commit);
				span.contentEditable = "false";
				span.removeClass("adt-tracker-newname");
			};
			const cancel = (): void => {
				done = true;
				span.setText(shownName);
				finish();
			};
			const commit = (): void => {
				if (done) return;
				done = true;
				const name = (span.textContent ?? "").replace(/[,|\r\n]+/g, " ").trim();
				if (!name || name === oldName) {
					span.setText(shownName);
					finish();
					return;
				}
				finish();
				void this.editBlock(ref, (m) => {
					if (m.columns[colIdx] !== oldName) return false;
					m.columns[colIdx] = name;
					return true;
				}).then((ok) => {
					if (ok) this.rerenderNote(ref.ctx.sourcePath);
					else span.setText(shownName);
				});
			};

			span.addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.key === "Enter") {
					e.preventDefault();
					commit();
				} else if (e.key === "Escape") {
					e.preventDefault();
					cancel();
				}
			});
			span.addEventListener("blur", commit);
			window.setTimeout(() => {
				span.focus();
				const range = document.createRange();
				range.selectNodeContents(span);
				const sel = window.getSelection();
				sel?.removeAllRanges();
				sel?.addRange(range);
			}, 50);
		};


		let dragFrom: number | null = null;
		const enableDrag = (head: HTMLElement, colIdx: number): void => {
			head.draggable = true;
			head.addEventListener("dragstart", (e: DragEvent) => {
				if (head.querySelector(".adt-tracker-newname")) {
					e.preventDefault();
					return;
				}
				dragFrom = colIdx;
				e.dataTransfer?.setData("text/plain", columns[colIdx]);
				head.addClass("is-dragging");
			});
			head.addEventListener("dragend", () => {
				dragFrom = null;
				head.removeClass("is-dragging");
			});
			head.addEventListener("dragover", (e: DragEvent) => {
				if (dragFrom === null || dragFrom === colIdx) return;
				e.preventDefault();
				head.dataset.drop = dragFrom < colIdx ? "after" : "before";
			});
			head.addEventListener("dragleave", (e: DragEvent) => {
				if (!head.contains(e.relatedTarget as Node | null)) delete head.dataset.drop;
			});
			head.addEventListener("drop", (e: DragEvent) => {
				e.preventDefault();
				delete head.dataset.drop;
				if (dragFrom !== null && dragFrom !== colIdx) this.moveColumn(ref, columns[dragFrom], dragFrom, colIdx);
			});
		};
		if (mode !== "locked") heads.forEach(enableDrag);


		host.addEventListener("contextmenu", (evt: MouseEvent) => {
			evt.preventDefault();
			const target = (evt.target as HTMLElement).closest<HTMLElement>("[data-col]");
			const index = target?.dataset.col !== undefined ? Number(target.dataset.col) : null;
			const column = index !== null ? { name: columns[index], index, count: columns.length } : null;
			const canFill = missingDaysToToday(rows).length > 0;
			this.showMenu(evt, ref, mode, horizontal, column, canFill, beginNewColumn, beginRename);
		});
	}

	private showMenu(
		evt: MouseEvent,
		ref: BlockRef,
		mode: TrackerMode,
		horizontal: boolean,
		column: { name: string; index: number; count: number } | null,
		canFill: boolean,
		beginNewColumn: (kind: ColumnKind) => void,
		beginRename: (colIdx: number) => void,
	): void {
		const menu = new Menu();
		(menu as Menu & { dom?: HTMLElement }).dom?.addClass("adt-menu");
		const noun = horizontal ? "row" : "column";
		const useSub = canSubmenu();

		if (mode !== "locked") {
			menu.addItem((item) =>
				item
					.setTitle("Add next day")
					.setIcon(horizontal ? "arrow-right-to-line" : "arrow-down-to-line")
					.onClick(() =>
						void this.editAndRerender(ref, (m) => {
							const last = m.rows[m.rows.length - 1];
							const date = shiftDate(last?.date, 1);
							m.rows.push({ date, cells: m.columns.map(() => "") });
							return true;
						}),
					),
			);
			if (canFill) {
				menu.addItem((item) =>
					item
						.setTitle("Fill to today")
						.setIcon("calendar-plus")
						.onClick(() => void this.editAndRerender(ref, (m) => this.fillDays(m))),
				);
			}
			menu.addItem((item) =>
				item
					.setTitle("Add previous day")
					.setIcon(horizontal ? "arrow-left-to-line" : "arrow-up-to-line")
					.onClick(() =>
						void this.editAndRerender(ref, (m) => {
							const first = m.rows[0];
							const date = shiftDate(first?.date, -1);
							m.rows.unshift({ date, cells: m.columns.map(() => "") });
							return true;
						}),
					),
			);
			if (useSub) {
				menu.addItem((item) => {
					item.setTitle(`Add ${noun}`).setIcon("plus");
					const sub = (item as SubmenuItem).setSubmenu();
					COLUMN_TYPES.forEach((t) =>
						sub.addItem((i) => i.setTitle(t.label).setIcon(t.icon).onClick(() => beginNewColumn(t.kind))),
					);
				});
			} else {
				COLUMN_TYPES.forEach((t) =>
					menu.addItem((item) =>
						item
							.setTitle(`Add ${t.label.toLowerCase()} ${noun}`)
							.setIcon(t.icon)
							.onClick(() => beginNewColumn(t.kind)),
					),
				);
			}
			menu.addSeparator();

			(
				[
					{ id: "code", label: "Code", icon: "code-2" },
					{ id: "table", label: "Table", icon: "table" },
				] as { id: BlockKind; label: string; icon: string }[]
			).forEach(({ id, label, icon }) => {
				const active = id === ref.kind;
				menu.addItem((item) =>
					titleWithCheck(this.app, item, label, active)
						.setIcon(icon)
						.setDisabled(active)
						.onClick(() => void this.editAndRerender(ref, () => true, id)),
				);
			});
			if (!this.settings.allUnlocked) menu.addSeparator();
		}

		if (!this.settings.allUnlocked) MODES.forEach(({ id, label, icon }) => {
			const active = id === mode;
			menu.addItem((item) =>
				titleWithCheck(this.app, item, label, active)
					.setIcon(icon)
					.setDisabled(active)
					.onClick(() =>
						void this.editAndRerender(ref, (m) => {
							m.head0 = id;
							return true;
						}),
					),
			);
		});

		if (column && this.settings.chartSnippets) {
			const chartName = column.name;
			const chartKind = parseColumn(chartName).kind;
			menu.addSeparator();
			const options: { label: string; icon: string; style: "graph" | "pie" | "heatmap"; show: boolean }[] = [
				{ label: "Pie chart", icon: "pie-chart", style: "pie", show: true },
				{ label: "Graph", icon: "line-chart", style: "graph", show: isGraphKind(chartKind) },
				{ label: "Heatmap", icon: "calendar-days", style: "heatmap", show: chartKind === "check" || chartKind === "levels" || chartKind === "number" },
			];
			if (useSub) {
				menu.addItem((item) => {
					item.setTitle("Create graph").setIcon("bar-chart-2");
					const sub = (item as SubmenuItem).setSubmenu();
					options
						.filter((o) => o.show)
						.forEach((o) =>
							sub.addItem((i) => i.setTitle(o.label).setIcon(o.icon).onClick(() => void this.insertChart(ref, chartName, o.style))),
						);
				});
			} else {
				options
					.filter((o) => o.show)
					.forEach((o) =>
						menu.addItem((item) =>
							item.setTitle(`Create ${o.label.toLowerCase()}`).setIcon(o.icon).onClick(() => void this.insertChart(ref, chartName, o.style)),
						),
					);
			}
		}

		if (mode !== "locked" && column) {
			const { name, index, count } = column;
			const label = parseColumn(name).name;
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle(`Rename ${noun} \u201C${label}\u201D`)
					.setIcon("pencil")
					.onClick(() => beginRename(index)),
			);
			menu.addItem((item) =>
				item
					.setTitle(horizontal ? "Move row up" : "Move column left")
					.setIcon(horizontal ? "arrow-up" : "arrow-left")
					.setDisabled(index === 0)
					.onClick(() => this.moveColumn(ref, name, index, index - 1)),
			);
			menu.addItem((item) =>
				item
					.setTitle(horizontal ? "Move row down" : "Move column right")
					.setIcon(horizontal ? "arrow-down" : "arrow-right")
					.setDisabled(index === count - 1)
					.onClick(() => this.moveColumn(ref, name, index, index + 1)),
			);
			menu.addItem((item) => {
				item
					.setTitle(`Delete ${noun} \u201C${label}\u201D`)
					.setIcon("trash-2")
					.onClick(() =>
						new ConfirmModal(
							this.app,
							`Delete ${noun} \u201C${label}\u201D?`,
							"Its checks will be removed from every day. This can't be undone.",
							"Delete",
							() =>
								void this.editAndRerender(ref, (m) => {
									if (m.columns[index] !== name) return false;
									m.columns.splice(index, 1);
									m.rows.forEach((r) => r.cells.splice(index, 1));
									return true;
								}),
						).open(),
					);
				(item as MenuItem & { dom?: HTMLElement }).dom?.addClass("adt-menu-danger");
			});
		}

		menu.showAtMouseEvent(evt);

		const dom = (menu as Menu & { dom?: HTMLElement }).dom;
		if (dom) dom.style.setProperty("--adt-menu-pad", getComputedStyle(dom).paddingLeft || "0px");
	}
}

class DailyTrackerSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: DailyTrackerPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		containerEl.empty();

		const commit = async (): Promise<void> => {
			await this.plugin.saveSettings();
			this.plugin.refresh();
		};

		const group = (name: string): HTMLElement => {
			const heading = new Setting(containerEl).setName(name).setHeading();
			heading.settingEl.addClass("adt-settings-section");
			return containerEl.createDiv({ cls: "adt-settings-card" });
		};
		const divider = (card: HTMLElement): void => {
			card.createEl("hr", { cls: "adt-settings-divider" });
		};
		const slider = (
			card: HTMLElement,
			name: string,
			key: "cellSize" | "gapHorizontal" | "gapVertical" | "textSize" | "marginTop" | "marginBottom",
			min: number,
			max: number,
			step: number,
		): void => {
			new Setting(card).setName(name).addSlider((s) =>
				s
					.setLimits(min, max, step)
					.setValue(settings[key])
					.onChange((value) => {
						settings[key] = value;
						void commit();
					}),
			);
		};

		const main = group("Advanced Daily Tracker");

		new Setting(main).setName("Turn snippets into interactive trackers").addToggle((toggle) =>
			toggle.setValue(settings.snippetTrackers).onChange((value) => {
				settings.snippetTrackers = value;
				void commit();
			}),
		);
		divider(main);
		new Setting(main).setName("Turn tables into interactive trackers").addToggle((toggle) =>
			toggle.setValue(settings.tableTrackers).onChange((value) => {
				settings.tableTrackers = value;
				void commit();
			}),
		);
		divider(main);
		new Setting(main).setName("Show graphs and charts").addToggle((toggle) =>
			toggle.setValue(settings.chartSnippets).onChange((value) => {
				settings.chartSnippets = value;
				void commit();
			}),
		);

		const behaviour = group("Behaviour");

		new Setting(behaviour)
			.setName("All trackers fully editable")
			.setDesc("Off: pick locked, limited or unlocked for each tracker by right-clicking it.")
			.addToggle((toggle) =>
				toggle.setValue(settings.allUnlocked).onChange((value) => {
					settings.allUnlocked = value;
					void commit();
				}),
			);

		divider(behaviour);
		new Setting(behaviour).setName("Editable days in limited mode").addDropdown((dropdown) =>
			dropdown
				.addOption("today", "Today only")
				.addOption("two", "Today and yesterday")
				.addOption("week", "Last 7 days")
				.setValue(settings.limitedRange)
				.onChange((value) => {
					settings.limitedRange = value as LimitedRange;
					void commit();
				}),
		);

		divider(behaviour);
		new Setting(behaviour)
			.setName("Automatically add missing days to limited and unlocked trackers")
			.addToggle((toggle) =>
				toggle.setValue(settings.autoAddDays).onChange((value) => {
					settings.autoAddDays = value;
					void commit();
				}),
			);

		const appearance = group("Appearance");

		new Setting(appearance)
			.setName("Tracker orientation")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("vertical", "Vertical")
					.addOption("horizontal", "Horizontal")
					.setValue(settings.orientation)
					.onChange((value) => {
						settings.orientation = value as Orientation;
						void commit();
					}),
			);
		divider(appearance);
		slider(appearance, "Size of cells", "cellSize", 12, 48, 1);
		divider(appearance);
		slider(appearance, "Gap between categories", "gapHorizontal", 0, 60, 1);
		divider(appearance);
		slider(appearance, "Gap between days", "gapVertical", 0, 60, 1);
		divider(appearance);
		slider(appearance, "Text size", "textSize", 9, 24, 1);
		divider(appearance);
		slider(appearance, "Space above trackers and charts", "marginTop", 0, 80, 1);
		divider(appearance);
		slider(appearance, "Space below trackers and charts", "marginBottom", 0, 80, 1);
		divider(appearance);
		new Setting(appearance)
			.setName("Graph and chart information")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("none", "Don't show")
					.addOption("name", "Name")
					.addOption("name-days", "Name and days")
					.setValue(settings.graphHeader)
					.onChange((value) => {
						settings.graphHeader = value as GraphHeader;
						void commit();
					}),
			);
		divider(appearance);
		new Setting(appearance)
			.setName("Sticky labels in vertical layout")
			.addToggle((toggle) =>
				toggle.setValue(settings.stickyLabelsVertical).onChange((value) => {
					settings.stickyLabelsVertical = value;
					void commit();
				}),
			);

		const info = group("Dates");

		new Setting(info).setName("Date length").addDropdown((dropdown) =>
			dropdown
				.addOption("full", "Full date")
				.addOption("month-day", "Month and day")
				.addOption("day", "Day only")
				.setValue(settings.dateParts)
				.onChange((value) => {
					settings.dateParts = value as DateParts;
					void commit();
				}),
		);
		divider(info);
		new Setting(info).setName("Displayed date format").addDropdown((dropdown) =>
			dropdown
				.addOption("dmy", "Little endian dd/mm/yyyy")
				.addOption("mdy", "Middle endian mm/dd/yyyy")
				.addOption("ymd", "Big endian yyyy-mm-dd")
				.setValue(settings.dateFormat)
				.onChange((value) => {
					settings.dateFormat = value as DateFormat;
					void commit();
				}),
		);
		divider(info);
		new Setting(info).setName("Separator").addDropdown((dropdown) =>
			dropdown
				.addOption(".", ".")
				.addOption("/", "/")
				.addOption("-", "-")
				.addOption(" ", "\u00A0")
				.setValue(settings.dateSeparator)
				.onChange((value) => {
					settings.dateSeparator = value as DateSeparator;
					void commit();
				}),
		);
		divider(info);
		new Setting(info).setName("Roman numeral months").addToggle((toggle) =>
			toggle.setValue(settings.romanMonths).onChange((value) => {
				settings.romanMonths = value;
				void commit();
			}),
		);

		const highlight = (name: string, key: "weekendStyle" | "todayStyle"): void => {
			divider(info);
			new Setting(info).setName(name).addDropdown((dropdown) =>
				dropdown
					.addOption("none", "None")
					.addOption("bold", "Bold")
					.addOption("italic", "Italic")
					.addOption("underline", "Underline")
					.addOption("accent", "Accent color")
					.setValue(settings[key])
					.onChange((value) => {
						settings[key] = value as HighlightStyle;
						void commit();
					}),
			);
		};
		highlight("Highlight today", "todayStyle");
		highlight("Highlight weekends", "weekendStyle");
		divider(info);
		const monthSetting = new Setting(info).setName("Month headings");
		const addedControls = (add: () => void): HTMLElement[] => {
			const before = new Set(Array.from(monthSetting.controlEl.children));
			add();
			return Array.from(monthSetting.controlEl.children).filter((c) => !before.has(c)) as HTMLElement[];
		};
		const syncControls = (): void => {
			const mh = settings.monthHeadings;
			gapControls.forEach((el) => el.toggleClass("adt-setting-off", mh === "none"));
			alignControls.forEach((el) => el.toggleClass("adt-setting-off", mh !== "month" && mh !== "month-year"));
		};

		const gapControls = addedControls(() =>
			monthSetting.addSlider((slider) =>
				slider
					.setLimits(0, 100, 5)
					.setValue(settings.gapSize)
					.onChange((value) => {
						settings.gapSize = value;
						void commit();
					}),
			),
		);
		monthSetting.addDropdown((dropdown) =>
			dropdown
				.addOption("none", "None")
				.addOption("gap", "Gap")
				.addOption("month", "Month")
				.addOption("month-year", "Month, year")
				.setValue(settings.monthHeadings)
				.onChange((value) => {
					settings.monthHeadings = value as MonthHeadings;
					syncControls();
					void commit();
				}),
		);
		const alignControls = addedControls(() =>
			monthSetting.addDropdown((dropdown) =>
				dropdown
					.addOption("far-left", "Far left")
					.addOption("left", "Left")
					.addOption("center", "Center")
					.setValue(settings.monthAlign)
					.onChange((value) => {
						settings.monthAlign = value as MonthAlign;
						void commit();
					}),
			),
		);
		syncControls();

		const support = group("Support");

		const email = "contact@kgniewek.com";
		new Setting(support)
			.setName("Contact")
			.setDesc("Found a bug or have a suggestion? Get in touch.")
			.addButton((button) => {
				button.setButtonText(email).onClick(async () => {
					try {
						await navigator.clipboard.writeText(email);
						new Notice(`${email} copied`);
					} catch {
						new Notice(`Could not copy. Email: ${email}`);
					}
				});
				setIcon(button.buttonEl.createSpan({ cls: "adt-link-icon" }), "copy");
			});
		divider(support);

		new Setting(support)
			.setName("Buy me a coffee")
			.setDesc("If you enjoy this plugin, you can support its development.")
			.addButton((button) => {
				button.setButtonText("Buy me a coffee").onClick(() => {
					window.open("https://buymeacoffee.com/kgniewek");
				});
				setIcon(button.buttonEl.createSpan({ cls: "adt-link-icon" }), "arrow-up-right");
			});
		divider(support);

		new Setting(support)
			.setName("Advanced YouTube Features")
			.setDesc("Turn YouTube links into thumbnail galleries and watch videos in a floating player.")
			.addButton((button) => {
				button.setButtonText("View plugin").onClick(() => {
					window.open("obsidian://show-plugin?id=advanced-youtube-features");
				});
				setIcon(button.buttonEl.createSpan({ cls: "adt-link-icon" }), "puzzle");
			});
		divider(support);

		new Setting(support)
			.setName("Advanced Web Link Features")
			.setDesc("Turn links into detailed cards with previews and open sites in a floating browser.")
			.addButton((button) => {
				button.setButtonText("View plugin").onClick(() => {
					window.open("obsidian://show-plugin?id=advanced-web-link-features");
				});
				setIcon(button.buttonEl.createSpan({ cls: "adt-link-icon" }), "puzzle");
			});
	}
}
