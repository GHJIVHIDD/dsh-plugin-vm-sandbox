window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-plugin-vm-sandbox",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		// ── styles ─────────────────────────────────────────────────────────────
		const CSS = `
.vmsb-panel { padding: 12px 16px 20px; font-size: 13px; color: var(--dsw-alias-label-primary, inherit); }
.vmsb-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; gap: 8px; }
.vmsb-title { font-weight: 600; }
.vmsb-count { color: var(--dsw-alias-label-secondary, #8d8d8d); font-size: 12px; margin-right: auto; }
.vmsb-btn { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, inherit); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3)); border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; margin-left: 6px; }
.vmsb-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.18)); }
.vmsb-btn:disabled { opacity: .5; cursor: default; }
.vmsb-danger { color: var(--dsw-alias-state-error-primary, #e5484d); border-color: var(--dsw-alias-state-error-primary, #e5484d); }
.vmsb-error { color: var(--dsw-alias-state-error-primary, #e5484d); margin-bottom: 8px; }
.vmsb-muted { color: var(--dsw-alias-label-secondary, #8d8d8d); padding: 24px 0; text-align: center; }
.vmsb-list { display: flex; flex-direction: column; gap: 8px; }
.vmsb-item { display: flex; flex-direction: column; }
.vmsb-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, transparent); cursor: pointer; transition: background .12s ease; }
.vmsb-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.09)); }
.vmsb-row-own { border-color: var(--dsw-alias-brand-primary, #6e8cff); }
.vmsb-row-open { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.vmsb-chev { color: var(--dsw-alias-label-secondary, #8d8d8d); font-size: 10px; width: 12px; flex: none; transition: transform .15s ease; }
.vmsb-row-open .vmsb-chev { transform: rotate(90deg); }
.vmsb-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.vmsb-dot-run { background: var(--dsw-alias-state-success-primary, #30a46c); }
.vmsb-dot-sleep { background: var(--dsw-alias-state-warn-primary, #f5a524); }
.vmsb-dot-stop { background: var(--dsw-alias-label-secondary, #8d8d8d); }
.vmsb-name { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.vmsb-meta { color: var(--dsw-alias-label-secondary, #8d8d8d); }
.vmsb-state-run { color: var(--dsw-alias-state-success-primary, #30a46c); }
.vmsb-state-sleep { color: var(--dsw-alias-state-warn-primary, #f5a524); }
.vmsb-state-stop { color: var(--dsw-alias-label-secondary, #8d8d8d); }
.vmsb-owner { color: var(--dsw-alias-label-secondary, #8d8d8d); margin-left: auto; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vmsb-own-tag { font-size: 11px; color: var(--dsw-alias-brand-primary, #6e8cff); border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; }
.vmsb-actions { display: flex; }
.vmsb-detail { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); border-top: none; border-radius: 0 0 8px 8px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06)); }
.vmsb-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px 20px; font-size: 11.5px; line-height: 1.55; }
.vmsb-detail-cell { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.vmsb-detail-k { color: var(--dsw-alias-label-secondary, #8d8d8d); width: 72px; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vmsb-detail-v { word-break: break-all; min-width: 0; }
.vmsb-shell { margin-top: 10px; border-top: 1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,.25)); padding-top: 8px; }
.vmsb-shell-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.vmsb-shell-title { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; color: var(--dsw-alias-label-primary, inherit); }
.vmsb-shell-live { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-secondary, #8d8d8d); font-size: 11px; white-space: nowrap; }
.vmsb-shell-live .vmsb-live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-secondary, #8d8d8d); animation: vmsb-pulse 1.6s ease-in-out infinite; }
@keyframes vmsb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
.vmsb-shell-list { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow-y: auto; overscroll-behavior: contain; }
.vmsb-shell-row { flex: none; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); border-left: 3px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, transparent); padding: 7px 10px 8px; box-sizing: border-box; min-width: 0; }
.vmsb-shell-row[data-status=running] { border-left-color: var(--dsw-alias-border-l2, rgba(128,128,128,.35)); }
.vmsb-shell-row[data-open="1"] .vmsb-shell-chev { transform: rotate(90deg); }
.vmsb-shell-headline { display: flex; align-items: center; gap: 7px; min-width: 0; cursor: pointer; }
.vmsb-shell-chev { flex: none; width: 12px; font-size: 10px; line-height: 16px; color: var(--dsw-alias-label-secondary, #8d8d8d); text-align: center; transition: transform .12s ease; }
.vmsb-shell-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-secondary, #8d8d8d); flex: none; }
.vmsb-shell-dot.running { animation: vmsb-pulse 1.1s ease-in-out infinite; }
.vmsb-shell-cmd { flex: 1 1 auto; min-width: 0; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary, inherit); white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere; }
.vmsb-shell-time { flex: none; color: var(--dsw-alias-label-secondary, #8d8d8d); font-size: 10.5px; line-height: 16px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.vmsb-shell-dur { flex: none; color: var(--dsw-alias-label-secondary, #8d8d8d); font-size: 10.5px; line-height: 16px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.vmsb-shell-status { flex: none; color: var(--dsw-alias-label-secondary, #8d8d8d); font-size: 10.5px; line-height: 16px; padding: 0 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); white-space: nowrap; }
.vmsb-shell-running { margin-top: 6px; color: var(--dsw-alias-label-secondary, #8d8d8d); font-size: 11.5px; line-height: 17px; display: flex; align-items: center; gap: 6px; }
.vmsb-shell-running::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-label-secondary, #8d8d8d); animation: vmsb-pulse 1.1s ease-in-out infinite; flex: none; }
.vmsb-shell-out { margin: 6px 0 0; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); border-radius: 6px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); color: var(--dsw-alias-label-secondary, #8d8d8d); font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 11.5px; line-height: 18px; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; max-height: 220px; overflow-y: auto; overscroll-behavior: contain; }
.vmsb-shell-empty { color: var(--dsw-alias-label-secondary, #8d8d8d); font-size: 11.5px; line-height: 18px; padding: 8px 0; text-align: center; }
`;

		// ── helpers ────────────────────────────────────────────────────────────
		function api(path, params) {
			let url = "/vmsb-api/" + path;
			if (params) {
				const keys = Object.keys(params);
				if (keys.length > 0) {
					url += "?" + keys.map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k])).join("&");
				}
			}
			return fetch(url, { cache: "no-store" })
				.then((r) => r.json().catch(() => ({ ok: false, error: "HTTP " + r.status })))
				.then((j) => {
					if (!j || j.ok === false) throw new Error((j && j.error) || "请求失败");
					return j;
				});
		}
		// 变更类面板请求:S1 加固后副作用接口改走 POST,并回传按 session 绑定的 CSRF token
		// (token 由 GET /vmsb-api/token 下发;跨源页面读不到响应体,故可防 CSRF)
		const __vmsbTokens = {};
		function __vmsbToken(session) {
			if (__vmsbTokens[session]) return Promise.resolve(__vmsbTokens[session]);
			return api("token", { session: session || "" }).then(
				(r) => { const t = (r && r.token) || ""; __vmsbTokens[session] = t; return t; },
				() => { __vmsbTokens[session] = ""; return ""; },
			);
		}
		function apiPost(path, body) {
			const session = (body && body.session) || "";
			const send = (tok) => fetch("/vmsb-api/" + path, {
				method: "POST",
				cache: "no-store",
				headers: Object.assign({ "Content-Type": "application/json" }, tok ? { "X-VMSB-Token": tok } : {}),
				body: JSON.stringify(body || {}),
			})
				.then((r) => r.json().catch(() => ({ ok: false, error: "HTTP " + r.status })))
				.then((j) => {
					if (!j || j.ok === false) throw new Error((j && j.error) || "请求失败");
					return j;
				});
			return __vmsbToken(session).then(send);
		}
		function download(name, text) {
			const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		}

		const STATE_LABEL = {
			running: "运行中",
			sleeping: "休眠中",
			stopped: "已停止",
			starting: "启动中",
		};
		const DOT_CLASS = {
			running: "vmsb-dot-run",
			sleeping: "vmsb-dot-sleep",
			stopped: "vmsb-dot-stop",
			starting: "vmsb-dot-sleep",
		};
		const STATE_TEXT_CLASS = {
			running: " vmsb-state-run",
			sleeping: " vmsb-state-sleep",
			stopped: " vmsb-state-stop",
			starting: " vmsb-state-sleep",
		};

		function fmtBytes(n) {
			if (n == null) return "—";
			if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
			if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
			return n + " B";
		}
		function fmtMib(n) {
			if (!n || n === "0") return "默认";
			const gb = Number(n) / 1024;
			return gb >= 1 ? gb.toFixed(1) + " GB" : n + " MiB";
		}
		function fmtCpu(n) { return !n || n === "0" ? "默认" : n + " 核"; }
		function fmtBool(v) { return v ? "是" : "否"; }

		function formatTime(ms) {
			if (!ms) return "—";
			const d = new Date(ms);
			const p = (n) => String(n).padStart(2, "0");
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
		}
		function formatDur(ms) {
			if (ms === null || ms === undefined) return "";
			if (ms < 1000) return ms + "ms";
			const s = ms / 1000;
			if (s < 60) return s.toFixed(1) + "s";
			const m = Math.floor(s / 60);
			return m + "m " + String(Math.round(s % 60)).padStart(2, "0") + "s";
		}
		function shellStatusText(entry) {
			if (entry.status === "running") return "运行中";
			if (entry.status === "bad" || entry.status === "error") {
				if (entry.exitCode !== null && entry.exitCode !== 0) return "退出码 " + entry.exitCode;
				return "失败";
			}
			return "成功";
		}

		// ── shell row ──────────────────────────────────────────────────────────
		function ShellRow(props) {
			const entry = props.entry;
			const [open, setOpen] = React.useState(false);
			const canExpand = entry.status !== "running";
			const durationMs = entry.durationMs != null ? entry.durationMs : (entry.endTime && entry.startTime ? entry.endTime - entry.startTime : null);
			const toggle = () => { if (canExpand) setOpen(!open); };
			const onKeyDown = (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					toggle();
				}
			};
			const children = [
				React.createElement("div", {
					className: "vmsb-shell-headline",
					role: "button",
					tabIndex: 0,
					"aria-expanded": open ? "true" : "false",
					onClick: toggle,
					onKeyDown: onKeyDown,
					title: canExpand ? (open ? "点击收起输出" : "点击展开输出") : undefined,
				},
					React.createElement("span", { className: "vmsb-shell-chev" }, "▸"),
					React.createElement("span", { className: "vmsb-shell-dot" + (entry.status === "running" ? " running" : "") }),
					React.createElement("code", { className: "vmsb-shell-cmd" }, "$ " + entry.command),
					React.createElement("span", { className: "vmsb-shell-time" }, formatTime(entry.startTime)),
					durationMs !== null && durationMs !== undefined && React.createElement("span", { className: "vmsb-shell-dur" }, formatDur(durationMs)),
					React.createElement("span", { className: "vmsb-shell-status" }, shellStatusText(entry)),
				),
			];
			if (entry.status === "running") {
				children.push(React.createElement("div", { className: "vmsb-shell-running" }, "命令执行中，完成后将显示结果…"));
			} else if (open) {
				const output = [];
				if (entry.stdout) output.push(entry.stdout);
				if (entry.stderr) output.push(entry.stderr);
				children.push(React.createElement("pre", { className: "vmsb-shell-out" }, output.length > 0 ? output.join("\n") : "(无输出)"));
			}
			return React.createElement("div", { className: "vmsb-shell-row", "data-status": entry.status, "data-open": open ? "1" : "0" }, ...children);
		}

		// ── view ───────────────────────────────────────────────────────────────
		function VMView(props) {
			const sessionId = props.sessionId;
			const [data, setData] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState({});
			const [confirmDel, setConfirmDel] = React.useState(null);
			const [expanded, setExpanded] = React.useState(null);
			const [details, setDetails] = React.useState({});
			const [detailErr, setDetailErr] = React.useState({});
			const [shells, setShells] = React.useState({});
			const [shellErr, setShellErr] = React.useState({});
			const [creating, setCreating] = React.useState(null);
			// 正在创建的机器(宿主立即返回名字,实际建机约 1-3 分钟):[{ machine, distro, since }]
			const [pending, setPending] = React.useState([]);
const [tab, setTab] = React.useState("vms");
			const [snaps, setSnaps] = React.useState(null);
			const [jobRows, setJobRows] = React.useState(null);
			const [audits, setAudits] = React.useState(null);
			const [meta, setMeta] = React.useState(null);
const [auditFilter, setAuditFilter] = React.useState({ machine: "", operation: "" });
			const loadTab = React.useCallback((t) => {
				setTab(t);
				setError(null);
				if (t === "snap") {
					api("snapshots", { session: sessionId }).then((r) => setSnaps(r.snapshots || []), (e) => setError(String((e && e.message) || e)));
				} else if (t === "jobs") {
					api("jobs", { session: sessionId }).then((r) => setJobRows(r.jobs || []), (e) => setError(String((e && e.message) || e)));
				} else if (t === "audit") {
					api("audit", { session: sessionId, limit: 200 }).then((r) => setAudits(r.entries || []), (e) => setError(String((e && e.message) || e)));
				} else if (t === "meta") {
					Promise.all([
						api("services", { session: sessionId }),
						api("cron", { session: sessionId }),
						api("templates", {}),
						api("policy", { session: sessionId }),
					]).then(async ([svc, cron, tpl, pol]) => {
						const machines = svc.machines || [];
						const metrics = {};
						const net = {};
						const shares = {};
						await Promise.allSettled(machines.slice(0, 5).map(async (m) => {
							try {
								const r = await api("metrics", { machine: m.name, limit: 30 });
								metrics[m.name] = r.metrics || [];
							} catch (e) { /* ignore */ }
						}));
						await Promise.allSettled(machines.map(async (m) => {
							try {
								const r = await api("network", { machine: m.name });
								if (r && r.ok) net[m.name] = r.policy || {};
							} catch (e) { /* ignore */ }
						}));
						await Promise.allSettled(machines.map(async (m) => {
							try {
								const r = await api("share", { machine: m.name });
								if (r && r.ok) shares[m.name] = r.sharedWith || [];
							} catch (e) { /* ignore */ }
						}));
						setMeta({ svc: machines, cron: cron.jobs || [], tpl: tpl.templates || [], pol: pol.policy, metrics, net, shares });
					}, (e) => setError(String((e && e.message) || e)));
				}
			}, [sessionId]);

			const refreshList = React.useCallback(() => {
				api("list", { session: sessionId }).then(
					(res) => { setData(res); setError(null); },
					(err) => setError(String((err && err.message) || err)),
				);
			}, [sessionId]);

			React.useEffect(() => {
				let stopped = false;
				let timerId = null;
				const refresh = () => {
					api("list", { session: sessionId }).then(
						(res) => { if (!stopped) { setData(res); setError(null); } },
						(err) => { if (!stopped) setError(String((err && err.message) || err)); },
					);
				};
				refresh();
				timerId = window.setInterval(refresh, 8000);
				return () => { stopped = true; if (timerId !== null) window.clearInterval(timerId); };
			}, [sessionId]);

			React.useEffect(() => {
				if (!expanded) return;
				let stopped = false;
				let timerId = null;
				const refresh = () => {
					api("shell", { name: expanded, session: sessionId }).then(
						(res) => {
							if (stopped) return;
							setShells((s) => Object.assign({}, s, { [expanded]: res.entries || [] }));
							setShellErr((e) => { const n = Object.assign({}, e); delete n[expanded]; return n; });
						},
						(err) => {
							if (stopped) return;
							setShellErr((e) => Object.assign({}, e, { [expanded]: String((err && err.message) || err) }));
						},
					);
				};
				refresh();
				timerId = window.setInterval(refresh, 2000);
				return () => { stopped = true; if (timerId !== null) window.clearInterval(timerId); };
			}, [expanded, sessionId]);

			const act = React.useCallback((action, name) => {
				setBusy((b) => Object.assign({}, b, { [name]: action }));
				apiPost(action, { name, session: sessionId }).then(
					() => {
						setBusy((b) => { const n = Object.assign({}, b); delete n[name]; return n; });
						setConfirmDel(null);
						refreshList();
					},
					(err) => {
						setBusy((b) => { const n = Object.assign({}, b); delete n[name]; return n; });
						setError(String((err && err.message) || err));
					},
				);
			}, [sessionId, refreshList]);

			// A3: 支持模板/附加参数的创建(onCreateOpts);默认按钮复用
			const onCreateOpts = React.useCallback((distroHint, opts) => {
				const o = opts || {};
				const distro = o.distro || distroHint || "debian";
				const label = o.label || distro;
				setCreating(label);
				apiPost("create", Object.assign({ session: sessionId, distro }, o.payload || {})).then(
					(res) => {
						setCreating(null);
						if (res && res.machine) {
							setPending((p) => {
								const now = Date.now();
								const next = p.filter((x) => x.machine !== res.machine && now - x.since < 10 * 60 * 1000);
								next.push({ machine: res.machine, distro: res.distro || distro, since: now });
								return next;
							});
						}
						refreshList();
					},
					(err) => { setCreating(null); setError(String((err && err.message) || err)); },
				);
			}, [sessionId, refreshList]);
			const onCreate = ((distro) => onCreateOpts(distro, {}));

			const onDelete = React.useCallback((name) => {
				if (confirmDel === name) {
					act("delete", name);
				} else {
					setConfirmDel(name);
					window.setTimeout(() => setConfirmDel((c) => (c === name ? null : c)), 3000);
				}
			}, [confirmDel, act]);

			const toggle = React.useCallback((name) => {
				if (expanded === name) {
					setExpanded(null);
					return;
				}
				setExpanded(name);
				if (!details[name] && !detailErr[name]) {
					api("info", { name, session: sessionId }).then(
						(res) => setDetails((d) => Object.assign({}, d, { [name]: res })),
						(err) => setDetailErr((e) => Object.assign({}, e, { [name]: String((err && err.message) || err) })),
					);
				}
			}, [expanded, details, detailErr, sessionId]);

			const stop = (e) => { if (e && e.stopPropagation) e.stopPropagation(); };

			const renderShell = (m) => {
				const entries = shells[m.name];
				const err = shellErr[m.name];
				const head = React.createElement("div", { className: "vmsb-shell-head" },
					React.createElement("span", { className: "vmsb-shell-title" }, "Shell 实时记录"),
					React.createElement("span", { className: "vmsb-shell-live" },
						React.createElement("span", { className: "vmsb-live-dot" }),
						"实时"));
				let body;
				if (err) {
					body = React.createElement("div", { className: "vmsb-shell-empty" }, err);
				} else if (entries === undefined) {
					body = React.createElement("div", { className: "vmsb-shell-empty" }, "加载中…");
				} else if (entries.length === 0) {
					body = React.createElement("div", { className: "vmsb-shell-empty" }, "暂无 shell 命令记录");
				} else {
					body = React.createElement("div", { className: "vmsb-shell-list" },
						entries.map((entry) => React.createElement(ShellRow, { key: entry.id, entry: entry })));
				}
				return React.createElement("div", { className: "vmsb-shell" }, head, body);
			};

			const renderDetail = (m) => {
				if (expanded !== m.name) return null;
				const d = details[m.name];
				const err = detailErr[m.name];
				const children = [];
				if (err) {
					children.push(React.createElement("div", { className: "vmsb-error" }, err));
				} else if (!d) {
					children.push(React.createElement("div", { className: "vmsb-muted" }, "加载中…"));
				} else {
					const img = d.image || {};
					const cfg = d.config || {};
					const lim = d.limits || {};
					const cell = (k, v, extra) => React.createElement("span", { className: "vmsb-detail-cell", key: k },
						React.createElement("span", { className: "vmsb-detail-k" }, k),
						React.createElement("span", { className: "vmsb-detail-v" + (extra || "") }, v == null || v === "" ? "—" : String(v)));
					children.push(React.createElement("div", { className: "vmsb-detail-grid" },
						cell("机器 ID", d.id),
						cell("状态", d.state ? (STATE_LABEL[d.state] || d.state) : "—", STATE_TEXT_CLASS[d.state] || ""),
						cell("名称", d.name),
						cell("归属", d.owner ? (d.owner.title || d.owner.sessionId) : "未归属"),
						cell("发行版", img.distro),
						cell("版本", img.version),
						cell("架构", img.arch),
						cell("变体", img.variant),
						cell("默认用户", cfg.default_username),
						cell("隔离模式", cfg.isolated == null ? "—" : fmtBool(cfg.isolated)),
						cell("网络隔离", cfg.isolate_network == null ? "—" : fmtBool(cfg.isolate_network)),
						cell("SSH Agent", cfg.forward_ssh_agent == null ? "—" : (cfg.forward_ssh_agent ? "转发" : "关闭")),
						cell("HTTP 端口", cfg.http_port || "—"),
						cell("HTTPS 端口", cfg.https_port || "—"),
						cell("CPU 限额", fmtCpu(lim.cpu)),
						cell("内存限额", fmtMib(lim.memory_mib)),
						cell("磁盘限额", lim.disk_bytes && lim.disk_bytes !== "0" ? fmtBytes(Number(lim.disk_bytes)) : "默认"),
						cell("磁盘用量", fmtBytes(d.diskSizeBytes)),
						cell("IPv4", d.ip4),
						cell("IPv6", d.ip6),
					));
				}
				children.push(renderShell(m));
				return React.createElement("div", { className: "vmsb-detail" }, ...children);
			};

			const machines = data ? data.machines : null;
			const own = data ? data.own : null;
			// v0.0.3 host 返回 own 为数组;旧版宿主返回单条对象或 null,按空数组处理,保持兼容
			const ownList = Array.isArray(own) ? own : [];
			const ownNames = new Set(ownList.map((o) => o.name));
			// 仅当宿主为 v0.0.3+(返回 cap 字段)时才显示新建等新能力,避免旧宿主 404
			const canCreate = !!(data && typeof data.cap === "number");
			const runningCount = machines ? machines.filter((m) => m.state === "running").length : 0;
			const machineNames = new Set(machines ? machines.map((m) => m.name) : []);
			const pendingRows = (pending || []).filter((p) => !machineNames.has(p.machine) && Date.now() - p.since < 10 * 60 * 1000);

			// A6: 按归属分组(本会话 / 共享给我 / 其他会话)
			const isOwnByM = (m) => m.ownedByThis || ownNames.has(m.name);
			const isSharedToMe = (m) => Array.isArray(m.sharedWith) && m.sharedWith.some((s) => s.sessionId === sessionId);
			const groupOfM = (m) => (isOwnByM(m) ? "本会话" : isSharedToMe(m) ? "共享给我" : "其他会话");
			const machineItem = (m) => {
				const isOwn = isOwnByM(m);
				const busyName = busy[m.name];
				const isOpen = expanded === m.name;
				return React.createElement("div", { key: m.name, className: "vmsb-item" },
					React.createElement("div", { className: "vmsb-row" + (isOwn ? " vmsb-row-own" : "") + (isOpen ? " vmsb-row-open" : ""), onClick: () => toggle(m.name) },
						React.createElement("span", { className: "vmsb-chev" }, "▸"),
						React.createElement("span", { className: "vmsb-dot " + (DOT_CLASS[m.state] || "vmsb-dot-stop") }),
						React.createElement("span", { className: "vmsb-name" }, m.name),
						React.createElement("span", { className: "vmsb-meta" }, (m.distro || "?") + (m.version ? " " + m.version : "")),
						React.createElement("span", { className: "vmsb-state " + (STATE_TEXT_CLASS[m.state] || "").trim() }, STATE_LABEL[m.state] || m.state),
						React.createElement("span", { className: "vmsb-owner" }, m.owner ? (m.owner.title || m.owner.sessionId) : "未归属"),
						m.kind === "snapshot" ? React.createElement("span", { className: "vmsb-own-tag" }, "快照") : null,
						isOwn ? React.createElement("span", { className: "vmsb-own-tag" }, "本会话") : (isSharedToMe(m) ? React.createElement("span", { className: "vmsb-own-tag" }, "共享给我") : null),
						React.createElement("span", { className: "vmsb-actions" },
							m.state !== "running"
								? React.createElement("button", { className: "vmsb-btn", disabled: !!busyName, onClick: (e) => { stop(e); act("start", m.name); } }, busyName === "start" ? "启动中…" : "启动")
								: React.createElement("button", { className: "vmsb-btn", disabled: !!busyName, onClick: (e) => { stop(e); act("sleep", m.name); } }, busyName === "sleep" ? "休眠中…" : "休眠"),
							m.state === "running"
								? React.createElement("button", { className: "vmsb-btn", disabled: !!busyName, onClick: (e) => { stop(e); act("restart", m.name); } }, busyName === "restart" ? "重启中…" : "重启")
								: null,
							(!m.owner || isOwn)
								? React.createElement("button", { className: "vmsb-btn vmsb-danger", disabled: !!busyName, onClick: (e) => { stop(e); onDelete(m.name); } },
									busyName === "delete" ? "删除中…" : (confirmDel === m.name ? "确认删除?" : "删除"))
								: null,
						),
					),
					renderDetail(m),
				);
			};
			const pendingItems = pendingRows.map((p) => React.createElement("div", { key: "pending-" + p.machine, className: "vmsb-item" },
				React.createElement("div", { className: "vmsb-row" },
					React.createElement("span", { className: "vmsb-chev" }, "▸"),
					React.createElement("span", { className: "vmsb-dot vmsb-dot-sleep" }),
					React.createElement("span", { className: "vmsb-name" }, p.machine),
					React.createElement("span", { className: "vmsb-meta" }, p.distro),
					React.createElement("span", { className: "vmsb-state vmsb-state-sleep" }, "创建中…"),
					React.createElement("span", { className: "vmsb-owner" }, "约 1-3 分钟"),
				),
			));
			const grouped = (machines || []).reduce((acc, m) => { const t = groupOfM(m); (acc[t] = acc[t] || []).push(m); return acc; }, {});
			const groupOrder = ["本会话", "共享给我", "其他会话"];
			const rows = machines === null ? null : machines.length === 0 && pendingRows.length === 0
				? React.createElement("div", { className: "vmsb-muted" }, "当前没有 OrbStack 虚拟机。可新建(debian/alpine),点上方「快速开始」选场景一键创建,或由会话智能体通过 vm_exec / vm_create 创建沙箱。")
				: React.createElement("div", { className: "vmsb-list" },
					groupOrder.flatMap((t) => {
						const g = grouped[t] || [];
						if (g.length === 0) return [];
						return [React.createElement("div", { key: "gl-" + t, className: "vmsb-muted", style: { margin: "6px 0 2px", textAlign: "left" } }, t + " · " + g.length), ...g.map(machineItem)];
					}),
					...pendingItems,
				);
const panelButton = (onClick, label, danger) => React.createElement("button", { className: "vmsb-btn" + (danger ? " vmsb-danger" : ""), onClick, style: { marginLeft: 6 } }, label);
			const renderTab = () => {
				if (tab === "vms") return rows;
				if (tab === "snap") {
					if (!snaps) return React.createElement("div", { className: "vmsb-muted" }, "加载中…");
					const defaultMachine = data && data.own && data.own[0] ? data.own[0].name : "";
					const createSnap = () => { if (!defaultMachine) return; apiPost("snapshot", { action: "create", machine: defaultMachine, session: sessionId }).then(() => loadTab("snap"), (e) => setError(String((e && e.message) || e))); };
					return React.createElement("div", null,
						React.createElement("div", { style: { marginBottom: 8 } },
							panelButton(createSnap, defaultMachine ? "为 " + defaultMachine + " 新建快照" : "无本会话虚拟机可快照"),
							panelButton(() => loadTab("snap"), "刷新"),
						),
						React.createElement("div", { className: "vmsb-list" }, (snaps || []).map((s) => React.createElement("div", { key: s.name, className: "vmsb-item" },
							React.createElement("div", { className: "vmsb-row" },
								React.createElement("span", { className: "vmsb-name" }, s.name),
								React.createElement("span", { className: "vmsb-meta" }, "来自 " + (s.source || "?")),
								React.createElement("span", { className: "vmsb-owner" }, formatTime(s.createdAt)),
								panelButton(() => { apiPost("snapshot", { action: "restore", snapshot: s.name, session: sessionId }).then(refreshList, (e) => setError(String((e && e.message) || e))); }, "恢复"),
								panelButton(() => { apiPost("snapshot", { action: "delete", snapshot: s.name, session: sessionId }).then(() => { loadTab("snap"); }, (e) => setError(String((e && e.message) || e))); }, "删除", true),
							),
						))),
						snaps.length === 0 ? React.createElement("div", { className: "vmsb-muted" }, "暂无快照。") : null,
					);
				}
				if (tab === "jobs") {
					if (!jobRows) return React.createElement("div", { className: "vmsb-muted" }, "加载中…");
					if (jobRows.length === 0) return React.createElement("div", { className: "vmsb-muted" }, "暂无后台任务。");
					const reloadJobs = () => api("jobs", { session: sessionId }).then((r) => setJobRows(r.jobs || []), (e) => setError(String((e && e.message) || e)));
					return React.createElement("div", null,
						React.createElement("div", { style: { marginBottom: 8 } }, panelButton(reloadJobs, "刷新")),
						React.createElement("div", { className: "vmsb-list" }, jobRows.map((j) => React.createElement("div", { key: j.id, className: "vmsb-item" },
							React.createElement("div", { className: "vmsb-row" },
								React.createElement("span", { className: "vmsb-name" }, j.id),
								React.createElement("span", { className: "vmsb-meta" }, (j.machine || "") + " · " + (j.status || "")),
								React.createElement("span", { className: "vmsb-owner" }, (j.command || "").slice(0, 60)),
								j.status === "running"
									? panelButton(() => { apiPost("job", { action: "stop", id: j.id, session: sessionId }).then(reloadJobs, (e) => setError(String((e && e.message) || e))); }, "停止", true)
									: null,
								panelButton(() => { api("job", { action: "output", id: j.id, session: sessionId }).then((r) => setError(String(JSON.stringify(r.log || "")).slice(0, 500)), (e) => setError(String((e && e.message) || e))); }, "日志"),
							),
						))),
					);
				}
				if (tab === "audit") {
					if (!audits) return React.createElement("div", { className: "vmsb-muted" }, "加载中…");
					if (audits.length === 0) return React.createElement("div", { className: "vmsb-muted" }, "暂无审计记录。");
					const applyFilter = () => {
						const params = { session: sessionId, limit: 200 };
						if (auditFilter.machine) params.machine = auditFilter.machine;
						if (auditFilter.operation) params.operation = auditFilter.operation;
						api("audit", params).then((r) => setAudits(r.entries || []), (e) => setError(String((e && e.message) || e)));
					};
					const input = (key, ph) => React.createElement("input", { placeholder: ph, value: auditFilter[key], onChange: (e) => setAuditFilter(Object.assign({}, auditFilter, { [key]: e.target.value })), style: { marginRight: 6, padding: "3px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))", background: "transparent", color: "inherit", fontSize: 12 } });
					const toCSV = () => download("vmsb-audit.csv", "ts,operation,machine,sessionId,ok,error\n" + audits.map((a) => [a.ts, a.operation, a.machine, a.sessionId, a.ok ? 1 : 0, (a.error || "").replace(/,/g, " ")].join(",")).join("\n"));
					const toJSON = () => download("vmsb-audit.json", JSON.stringify(audits, null, 2));
					return React.createElement("div", null,
						React.createElement("div", { style: { marginBottom: 8 } },
							input("machine", "过滤机器"),
							input("operation", "过滤操作"),
							panelButton(applyFilter, "筛选"),
							panelButton(toCSV, "导出 CSV"),
							panelButton(toJSON, "导出 JSON"),
						),
						React.createElement("div", { className: "vmsb-list" }, audits.map((a) => React.createElement("div", { key: a.id, className: "vmsb-item" },
							React.createElement("div", { className: "vmsb-row" },
								React.createElement("span", { className: "vmsb-name" }, a.operation || ""),
								React.createElement("span", { className: "vmsb-meta" }, (a.machine || "—") + " · " + (a.ok ? "成功" : "失败")),
								React.createElement("span", { className: "vmsb-owner" }, formatTime(a.ts) + " · " + (a.sessionId || "")),
							),
						))),
					);
				}
				if (tab === "meta") {
					if (!meta) return React.createElement("div", { className: "vmsb-muted" }, "加载中…");
					const items = [
						"策略: " + JSON.stringify(meta.pol || {}),
						"模板: " + (meta.tpl || []).map((t) => t.name).join(", ") || "无",
						"定时任务: " + (meta.cron || []).length + " 个",
						"服务: " + (meta.svc || []).map((m) => (m.name || "") + "@" + (m.ip4 || "?")).join("  ") || "无",
					];
					const metricBars = Object.entries(meta.metrics || {}).map(([name, list]) => {
						const mem = (list || []).map((p) => p.memory && p.memory.totalBytes ? 1 - (p.memory.availableBytes / p.memory.totalBytes) : 0);
						return React.createElement("div", { key: name, className: "vmsb-item" },
							React.createElement("div", { className: "vmsb-row" }, React.createElement("span", { className: "vmsb-name" }, name), React.createElement("span", { className: "vmsb-meta" }, "内存使用率")),
							React.createElement("div", { style: { display: "flex", alignItems: "flex-end", gap: 2, height: 40, padding: "4px 8px" } },
								mem.slice(-30).map((v, i) => React.createElement("div", { key: i, style: { width: 6, height: Math.max(2, Math.round(v * 40)), background: "var(--dsw-alias-brand-primary, #6e8cff)" } }))),
						);
					});
					const reloadMeta = () => loadTab("meta");
					const netRows = (meta.svc || []).map((m) => {
						const p = (meta.net || {})[m.name] || {};
						const sh = (meta.shares || {})[m.name] || [];
						const owned = data && data.own && data.own.some((o) => o.name === m.name);
						const toggle = (key) => apiPost("network", { session: sessionId, machine: m.name, [key]: p[key] === false ? 1 : 0 }).then(reloadMeta, (e) => setError(String((e && e.message) || e)));
						const removeShare = (sid) => apiPost("share", { action: "remove", machine: m.name, session_target: sid, session: sessionId }).then(reloadMeta, (e) => setError(String((e && e.message) || e)));
						const addShare = () => {
							const sid = window.prompt("目标会话 ID");
							if (!sid) return;
							const mode = window.prompt("权限模式(exec/manage)", "exec");
							apiPost("share", { action: "add", machine: m.name, session_target: sid, mode: mode || "exec", session: sessionId }).then(reloadMeta, (e) => setError(String((e && e.message) || e)));
						};
						return React.createElement("div", { key: "net-" + m.name, className: "vmsb-item" },
							React.createElement("div", { className: "vmsb-row" },
								React.createElement("span", { className: "vmsb-name" }, m.name),
								React.createElement("span", { className: "vmsb-meta" }, "公网:" + (p.publicAccess === false ? "关" : "开") + " · 内网:" + (p.internalAccess === false ? "关" : "开")),
								React.createElement("span", { className: "vmsb-owner" }, "共享:" + (sh.map((s) => s.sessionId + "(" + s.mode + ")").join(",") || "无")),
								panelButton(() => toggle("public_access"), p.publicAccess === false ? "开公网" : "关公网"),
								panelButton(() => toggle("internal_access"), p.internalAccess === false ? "开内网" : "关内网"),
								owned ? panelButton(addShare, "添加共享") : null,
								owned ? sh.map((s) => panelButton(() => removeShare(s.sessionId), "移除 " + s.sessionId.slice(0, 8), true)) : [],
							),
						);
					});
					return React.createElement("div", { className: "vmsb-list" },
						items.map((t, i) => React.createElement("div", { key: i, className: "vmsb-item" }, React.createElement("div", { className: "vmsb-row" }, React.createElement("span", { className: "vmsb-meta" }, t)))),
						netRows.length ? React.createElement("div", { key: "netheader", className: "vmsb-item" }, React.createElement("div", { className: "vmsb-row" }, React.createElement("span", { className: "vmsb-meta" }, "网络开关"))) : null,
						...netRows,
						metricBars.length ? React.createElement("div", { key: "metrics", className: "vmsb-item" }, React.createElement("div", { className: "vmsb-row" }, React.createElement("span", { className: "vmsb-meta" }, "指标趋势(内存使用率)"))) : null,
						...metricBars,
					);
				}
				return rows;
			};

			// A5: 配额一眼可见 + A3 快速开始场景
			const quota = data && data.quota;
			const qcell = (k, used, total) => {
				const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
				return React.createElement("span", { key: k, style: { display: "inline-flex", alignItems: "center", gap: 6 } },
					k,
					React.createElement("span", { style: { width: 46, height: 6, background: "rgba(128,128,128,.25)", borderRadius: 3, display: "inline-block", overflow: "hidden" } },
						React.createElement("span", { style: { display: "block", height: "100%", width: pct + "%", background: "var(--dsw-alias-brand-primary,#6e8cff)" } })),
					used + "/" + total);
			};
			const quotaBar = quota ? React.createElement("div", { style: { display: "flex", gap: 14, margin: "2px 0 8px", fontSize: 11.5, color: "var(--dsw-alias-label-secondary,#8d8d8d)", flexWrap: "wrap" } },
				qcell("机器", quota.machines || 0, quota.maxMachines || 0),
				quota.cpuQuota
					? qcell("CPU", quota.cpus || 0, quota.cpuQuota)
					: React.createElement("span", { key: "cpu", style: {} }, "CPU " + (quota.cpus || 0) + " 核"),
				quota.memoryQuotaMiB
					? qcell("内存", Math.round((quota.memoryMiB || 0) / 1024), Math.round(quota.memoryQuotaMiB / 1024))
					: React.createElement("span", { key: "mem", style: {} }, "内存 " + ((quota.memoryMiB || 0) / 1024).toFixed(1) + " GB"),
				data && data.queueCount ? React.createElement("span", { key: "q", style: { color: "var(--dsw-alias-state-warn-primary,#f5a524)" } }, "排队 " + data.queueCount + " 个创建请求") : null,
			) : null;
			const scenarios = [
				{ label: "基础 Debian", distro: "debian" },
				{ label: "基础 Alpine", distro: "alpine" },
				{ label: "Python 分析", distro: "debian", template: "data" },
				{ label: "Node 服务", distro: "debian", template: "node" },
				{ label: "Web 脚手架", distro: "debian", template: "webapp" },
				{ label: "Docker in VM", distro: "debian", template: "docker" },
			];
			const quickRow = canCreate ? React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 10, flexWrap: "wrap" } },
				React.createElement("span", { className: "vmsb-muted", style: { padding: 0 } }, "快速开始:"),
				scenarios.map((s) => React.createElement("button", { key: s.label, className: "vmsb-btn", disabled: !!creating, onClick: () => onCreateOpts(s.distro, { label: s.label, payload: s.template ? { template: s.template } : {} }) }, creating === s.label ? "创建中…" : s.label)),
			) : null;

			return React.createElement("div", { className: "vmsb-panel" },
				React.createElement("div", { className: "vmsb-head" },
					React.createElement("span", { className: "vmsb-title" }, "虚拟机沙箱 (OrbStack)"),
					React.createElement("span", { className: "vmsb-count" }, machines === null ? "" : "共 " + machines.length + " 台 · 运行 " + runningCount + (data && data.cap ? " · 上限 " + data.cap : "") + (ownList.length ? " · 本会话 " + ownList.length + " 台" : "") + (data && data.queueCount ? " · 排队 " + data.queueCount : "")),
					canCreate
						? React.createElement("button", { className: "vmsb-btn", disabled: !!creating, onClick: () => onCreate("debian") }, creating === "debian" ? "创建中…" : "＋ Debian")
						: null,
					canCreate
						? React.createElement("button", { className: "vmsb-btn", disabled: !!creating, onClick: () => onCreate("alpine") }, creating === "alpine" ? "创建中…" : "＋ Alpine")
						: null,
					React.createElement("button", { className: "vmsb-btn", onClick: refreshList }, "刷新"),
				),
				quotaBar,
				React.createElement("div", { className: "vmsb-tabs", style: { display: "flex", gap: 6, marginBottom: 10 } },
					[["vms", "虚拟机"], ["snap", "快照"], ["jobs", "任务"], ["audit", "审计"], ["meta", "网络/共享"]].map(([k, label]) =>
						React.createElement("button", { key: k, className: "vmsb-btn", style: tab === k ? { background: "var(--dsw-alias-bg-layer-1, rgba(110,140,255,.18))" } : undefined, onClick: () => loadTab(k) }, label)),
				),
				quickRow,
				error ? React.createElement("div", { className: "vmsb-error" }, error) : null,
				tab === "vms" ? (machines === null ? React.createElement("div", { className: "vmsb-muted" }, "加载中…") : rows) : renderTab(),
			);
		}

		// ── plugin entry ────────────────────────────────────────────────────────
		const inject = ["slots"];

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			const style = document.createElement("style");
			style.dataset.plugin = "@deepseek-ai/dsh-plugin-vm-sandbox";
			style.dataset.pluginCss = "@deepseek-ai/dsh-plugin-vm-sandbox/styles";
			style.textContent = CSS;
			ctx.effect(() => {
				document.head.appendChild(style);
				return () => {
					style.remove();
				};
			}, "vmsb: styles");
			slots.inject("conversation.view", () => slots.register(
				{ name: "conversation.view", id: "vm", order: 12, label: () => "虚拟机" },
				VMView
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
