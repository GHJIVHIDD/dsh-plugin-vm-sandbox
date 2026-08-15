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

			const act = React.useCallback((action, name) => {
				setBusy((b) => Object.assign({}, b, { [name]: action }));
				api(action, { name, session: sessionId }).then(
					() => {
						setBusy((b) => { const n = Object.assign({}, b); delete n[name]; return n; });
						setConfirmDel(null);
						api("list", { session: sessionId }).then(
							(res) => { setData(res); setError(null); },
							(err) => setError(String((err && err.message) || err)),
						);
					},
					(err) => {
						setBusy((b) => { const n = Object.assign({}, b); delete n[name]; return n; });
						setError(String((err && err.message) || err));
					},
				);
			}, [sessionId]);

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

			const renderDetail = (m) => {
				if (expanded !== m.name) return null;
				const d = details[m.name];
				const err = detailErr[m.name];
				if (err) return React.createElement("div", { className: "vmsb-detail" }, React.createElement("div", { className: "vmsb-error" }, err));
				if (!d) return React.createElement("div", { className: "vmsb-detail" }, React.createElement("div", { className: "vmsb-muted" }, "加载中…"));
				const img = d.image || {};
				const cfg = d.config || {};
				const lim = d.limits || {};
				const cell = (k, v, extra) => React.createElement("span", { className: "vmsb-detail-cell", key: k },
					React.createElement("span", { className: "vmsb-detail-k" }, k),
					React.createElement("span", { className: "vmsb-detail-v" + (extra || "") }, v == null || v === "" ? "—" : String(v)));
				return React.createElement("div", { className: "vmsb-detail" },
					React.createElement("div", { className: "vmsb-detail-grid" },
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
					),
				);
			};

			const machines = data ? data.machines : null;
			const own = data ? data.own : null;
			const runningCount = machines ? machines.filter((m) => m.state === "running").length : 0;

			const rows = machines === null ? null : machines.length === 0
				? React.createElement("div", { className: "vmsb-muted" }, "当前没有 OrbStack 虚拟机。会话智能体可通过 vm_exec / vm_create 创建沙箱。")
				: React.createElement("div", { className: "vmsb-list" }, machines.map((m) => {
					const isOwn = m.ownedByThis || (own && own.name === m.name);
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
							isOwn ? React.createElement("span", { className: "vmsb-own-tag" }, "本会话") : null,
							React.createElement("span", { className: "vmsb-actions" },
								m.state !== "running"
									? React.createElement("button", { className: "vmsb-btn", disabled: !!busyName, onClick: (e) => { stop(e); act("start", m.name); } }, busyName === "start" ? "启动中…" : "启动")
									: React.createElement("button", { className: "vmsb-btn", disabled: !!busyName, onClick: (e) => { stop(e); act("sleep", m.name); } }, busyName === "sleep" ? "休眠中…" : "休眠"),
								(!m.owner || isOwn)
									? React.createElement("button", { className: "vmsb-btn vmsb-danger", disabled: !!busyName, onClick: (e) => { stop(e); onDelete(m.name); } },
										busyName === "delete" ? "删除中…" : (confirmDel === m.name ? "确认删除?" : "删除"))
									: null,
							),
						),
						renderDetail(m),
					);
				}));

			return React.createElement("div", { className: "vmsb-panel" },
				React.createElement("div", { className: "vmsb-head" },
					React.createElement("span", { className: "vmsb-title" }, "虚拟机沙箱 (OrbStack)"),
					React.createElement("span", { className: "vmsb-count" }, machines === null ? "" : "共 " + machines.length + " 台 · 运行 " + runningCount),
					React.createElement("button", { className: "vmsb-btn", onClick: () => api("list", { session: sessionId }).then(
						(res) => { setData(res); setError(null); },
						(err) => setError(String((err && err.message) || err)),
					) }, "刷新"),
				),
				error ? React.createElement("div", { className: "vmsb-error" }, error) : null,
				machines === null ? React.createElement("div", { className: "vmsb-muted" }, "加载中…") : rows,
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
