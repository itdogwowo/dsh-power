/**
 * dsh-power — browser half.
 *
 * Contributes one preference row to Settings → General (`settings.general.item`):
 * the live DSH process facts plus restart / shutdown buttons. The row draws its
 * own internals, following the shipped General rows (row / rowText / title /
 * desc / selector), because that slot projects no label and passes no props.
 *
 * After the host accepts a restart, the row switches to reconnecting and polls
 * its own info route until a *different* pid answers — the browser cookie is
 * signed by a credential that outlives the process, so a plain reload lands
 * authenticated and the user never has to find the new launch token.
 */
window.__ModuleLoader__.load({
	id: 'dsh-power',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const React = require('react');

		const INFO_URL = '/api/dsh-power/info';
		const ACTION_URL = '/api/dsh-power/action';
		const REPORT_URL = '/api/dsh-power/report';

		const CSS = [
			'.dshpw-row { border-bottom: 0.5px solid var(--dsw-alias-border-l2); align-items: center; gap: 8px; padding: 16px 0; display: flex; }',
			'.dshpw-text { flex-direction: column; flex: 1; gap: 4px; min-width: 0; padding-right: 48px; display: flex; }',
			'.dshpw-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 400; line-height: 22px; }',
			'.dshpw-desc { color: var(--dsw-alias-label-tertiary); font-size: 12px; font-weight: 400; line-height: 18px; word-break: break-all; }',
			'.dshpw-desc-ok { color: var(--dsw-alias-state-success-primary); }',
			'.dshpw-desc-err { color: var(--dsw-alias-state-error-primary); }',
			'.dshpw-actions { align-items: center; gap: 8px; flex: none; display: inline-flex; }',
			'.dshpw-btn { background: var(--dsw-alias-bg-module-platform); height: 36px; font: inherit; color: var(--dsw-alias-label-primary); cursor: pointer; border: none; border-radius: 18px; align-items: center; gap: 12px; padding: 0 14px; font-size: 14px; line-height: 22px; display: inline-flex; }',
			'.dshpw-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
			'.dshpw-btn:disabled { cursor: default; opacity: 0.5; }',
			'.dshpw-danger { color: var(--dsw-alias-state-error-primary); }',
			'.dshpw-spinner { flex: none; animation: dshpw-spin 0.8s linear infinite; }',
			'@keyframes dshpw-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
			'.dshpw-btn.dshpw-busy:disabled { opacity: 1; cursor: progress; }',
			'@media (prefers-reduced-motion: reduce) { .dshpw-spinner { animation-duration: 2.4s; } }',
			'.dshpw-ask { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
		].join('\n');

		/** Read one JSON route; never rejects, so a dead server still settles the UI. */
		const request = (url, body) => fetch(url, body === undefined ? undefined : {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}).then(
			(response) => response.json().then((value) => value, () => null),
			() => null,
		);

		/**
		 * Tell the host half what this page sees. The connection state and this
		 * page's own errors are only observable from inside the browser, and
		 * "it keeps asking me to reconnect" cannot be diagnosed from the server
		 * side alone.
		 */
		const report = (payload) => {
			try {
				fetch(REPORT_URL, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload),
				}).then(() => undefined, () => undefined);
			} catch (error) { /* diagnostics must never break the row */ }
		};

		/** Best-effort short text for one error-ish value. */
		const describe = (value) => {
			try {
				if (value === null || value === undefined) return '';
				if (typeof value === 'string') return value.slice(0, 300);
				if (typeof value === 'object' && typeof value.message === 'string') return value.message.slice(0, 300);
				return String(value).slice(0, 300);
			} catch (error) {
				return '(unprintable)';
			}
		};

		/**
		 * Draw the busy indicator as an SVG arc. A border-radius ring would be
		 * reshaped by this app's `corner-shape` rules; a real circle is not.
		 */
		const spinner = () => React.createElement('svg', {
			key: 'spinner',
			className: 'dshpw-spinner',
			viewBox: '0 0 16 16',
			width: 14,
			height: 14,
			'aria-hidden': 'true',
		}, React.createElement('circle', {
			cx: 8,
			cy: 8,
			r: 6.5,
			fill: 'none',
			stroke: 'currentColor',
			strokeWidth: 2,
			strokeLinecap: 'round',
			strokeDasharray: '10 31',
		}));

		/** Bound one request: a row stuck on 處理中… forever is not reassuring. */
		const REQUEST_TIMEOUT_MS = 10000;
		const requestWithin = (url, body) => Promise.race([
			request(url, body),
			new Promise((resolve) => { setTimeout(() => resolve(undefined), REQUEST_TIMEOUT_MS); }),
		]);

		/** Reconnect budget: a restart normally answers well inside this. */
		const RECONNECT_POLL_MS = 1000;
		const RECONNECT_TRIES = 90;

		/**
		 * Leave for a clean, cookie-authenticated URL. `replace` rather than
		 * `reload`, because the current URL may still carry the previous
		 * process's launch token — a token that is worthless now.
		 */
		const goHome = () => {
			try {
				const origin = window.location.origin;
				if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
					window.location.replace(origin + '/');
					return;
				}
			} catch (error) { /* fall through to reload */ }
			try { window.location.reload(); } catch (error) { /* nothing else this row can do */ }
		};

		function PowerRow() {
			const [pending, setPending] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const [target, setTarget] = React.useState(null);
			/** Set once a command was accepted: the service is going away, so lock the row. */
			const [finished, setFinished] = React.useState(false);
			/** The pid being replaced; the new one answering means the restart landed. */
			const [awaitingPid, setAwaitingPid] = React.useState(null);
			/** Automatic recovery gave up; the row then offers the manual way out. */
			const [needsRefresh, setNeedsRefresh] = React.useState(false);
			/** null = unknown; false = this page's origin carries no usable session. */
			const [sessionOk, setSessionOk] = React.useState(null);

			/**
			 * Ask the application root whether this page is authenticated. The
			 * index answers 200 for a valid browser cookie and 401 without one, and
			 * the cookie is bound to the host:port that minted it — so a tab opened
			 * on `localhost:3080` while the server printed `127.0.0.1:3080` is a
			 * permanently dead page, where every reload and every reconnect fails.
			 * Surfacing that here is the difference between a puzzle and a hint.
			 */
			React.useEffect(() => {
				let alive = true;
				fetch('/', { method: 'GET', cache: 'no-store', headers: { accept: 'text/html' } }).then(
					(response) => { if (alive) setSessionOk(response.status !== 401); },
					() => { if (alive) setSessionOk(null); },
				);
				return () => { alive = false; };
			}, []);

			React.useEffect(() => {
				let alive = true;
				requestWithin(INFO_URL, undefined).then((value) => {
					if (!alive) return;
					if (value !== null && value !== undefined && typeof value === 'object' && value.ok === true) {
						setTarget({ pid: String(value.pid), port: value.port, command: String(value.command), logPath: value.logPath });
					} else {
						setTarget({ pid: '', port: null, command: '' });
					}
				});
				return () => { alive = false; };
			}, []);

			/**
			 * Poll until a different process answers, then leave for a clean URL.
			 * `pid` is the process that accepted the command: the old one may still
			 * answer for a moment, and reloading into it would land on a socket
			 * that is about to close.
			 *
			 * Two things make this survive real browsers: the poll re-runs the
			 * moment the tab becomes visible again (a hidden tab has its timers
			 * throttled to as little as once a minute), and giving up is not a
			 * dead end — the row keeps a manual refresh button.
			 */
			React.useEffect(() => {
				if (awaitingPid === null) return undefined;
				let alive = true;
				let tries = 0;
				let timer = null;

				const poll = () => {
					if (!alive) return;
					requestWithin(INFO_URL, undefined).then((value) => {
						if (!alive) return;
						const ready = value !== null && value !== undefined
							&& typeof value === 'object' && value.ok === true
							&& String(value.pid) !== awaitingPid;
						if (ready) {
							goHome();
							return;
						}
						tries += 1;
						if (tries > RECONNECT_TRIES) {
							setNotice({ kind: 'err', text: '服務尚未回應，請按「立即重新整理」。' });
							setFinished(false);
							setNeedsRefresh(true);
							setAwaitingPid(null);
							return;
						}
						timer = setTimeout(poll, RECONNECT_POLL_MS);
					});
				};

				// A hidden tab throttles timers hard; re-check the moment it is shown.
				const onVisible = () => {
					if (window.document.visibilityState !== 'visible') return;
					if (timer !== null) clearTimeout(timer);
					tries = 0;
					poll();
				};

				timer = setTimeout(poll, RECONNECT_POLL_MS);
				try { window.document.addEventListener('visibilitychange', onVisible); } catch (error) { /* no document: rely on the timer */ }
				return () => {
					alive = false;
					if (timer !== null) clearTimeout(timer);
					try { window.document.removeEventListener('visibilitychange', onVisible); } catch (error) { /* ignore */ }
				};
			}, [awaitingPid]);

			const run = (action) => {
				setBusy(true);
				requestWithin(ACTION_URL, { action: action }).then((value) => {
					setBusy(false);
					setPending(null);
					if (value !== null && value !== undefined && typeof value === 'object' && value.ok === true) {
						setFinished(true);
						if (action === 'restart') {
							setNotice({ kind: 'ok', text: '服務正在重新啟動，恢復後這個頁面會自動重新整理。' });
							setAwaitingPid(value.pid === null || value.pid === undefined ? '' : String(value.pid));
						} else {
							setNotice({ kind: 'ok', text: '已送出關閉指令，服務將結束，需要手動再次啟動。' });
						}
					} else if (value === undefined) {
						setNotice({ kind: 'err', text: '操作失敗：服務沒有回應（可能正在重新啟動）。請重新整理頁面再試。' });
					} else {
						setNotice({ kind: 'err', text: '操作失敗：' + String((value && value.message) || '連不到服務——這個頁面可能還連在已結束的行程上，請重新整理頁面。') });
					}
				});
			};

			const label = (action) => (action === 'restart' ? '重新啟動' : '關閉');
			const ask = (action) => (action === 'restart' ? '確定要重新啟動？' : '確定要關閉服務？');

			let actions;
			if (awaitingPid !== null) {
				actions = [
					React.createElement('button', {
						key: 'waiting',
						className: 'dshpw-btn dshpw-busy',
						disabled: true,
						'aria-busy': 'true',
					}, [spinner(), '重新連線中…']),
					// The escape hatch: automatic recovery is a convenience, never the only way back.
					React.createElement('button', {
						key: 'refresh',
						className: 'dshpw-btn',
						onClick: goHome,
					}, '立即重新整理'),
				];
			} else if (needsRefresh) {
				actions = [React.createElement('button', {
					key: 'refresh',
					className: 'dshpw-btn',
					onClick: goHome,
				}, '立即重新整理')];
			} else if (pending === null) {
				actions = ['restart', 'shutdown'].map((action) => React.createElement('button', {
					key: action,
					className: action === 'shutdown' ? 'dshpw-btn dshpw-danger' : 'dshpw-btn',
					disabled: busy || finished || sessionOk === false,
					title: sessionOk === false ? '這個頁面沒有有效登入，重啟後不會自動回來' : undefined,
					onClick: () => { setNotice(null); setPending(action); },
				}, label(action)));
			} else {
				actions = [
					React.createElement('span', { key: 'ask', className: 'dshpw-ask' }, ask(pending)),
					React.createElement('button', {
						key: 'yes',
						className: (pending === 'shutdown' ? 'dshpw-btn dshpw-danger' : 'dshpw-btn') + (busy ? ' dshpw-busy' : ''),
						disabled: busy,
						'aria-busy': busy ? 'true' : 'false',
						onClick: () => run(pending),
					}, busy ? [spinner(), '處理中…'] : '確認'),
					// No cancel while a command is in flight: it could only hide the outcome.
					busy ? null : React.createElement('button', {
						key: 'no',
						className: 'dshpw-btn',
						onClick: () => setPending(null),
					}, '取消'),
				];
			}

			/** Idle copy stays one short line; the full command line lives only in the hover title. */
			const idle = target === null
				? ''
				: target.pid === ''
					? '服務未連線（請重新整理頁面）'
					: 'PID ' + target.pid + (target.port === null || target.port === undefined ? '' : ' · 127.0.0.1:' + target.port);
			/** Outranks action feedback: nothing here works until the page is authenticated. */
			const sessionWarning = sessionOk === false
				? '此頁面沒有有效登入；請用 DSH 啟動時印出的網址（含 ?token=）重新開啟'
					+ (target !== null && typeof target.logPath === 'string' ? '，或看 ' + target.logPath + ' 的 dsh-power 行' : '')
				: null;
			const desc = sessionWarning !== null ? sessionWarning : (notice !== null ? notice.text : idle);
			const hover = target !== null && target.pid !== ''
				? 'PID ' + target.pid + ' — ' + target.command
				: undefined;

			const descClass = sessionWarning !== null
				? 'dshpw-desc dshpw-desc-err'
				: notice === null
					? 'dshpw-desc'
					: (notice.kind === 'ok' ? 'dshpw-desc dshpw-desc-ok' : 'dshpw-desc dshpw-desc-err');

			const text = [React.createElement('div', { key: 'title', className: 'dshpw-title' }, 'DSH 服務')];
			if (desc !== '') text.push(React.createElement('div', { key: 'desc', className: descClass, title: hover }, desc));

			return React.createElement('div', { className: 'dshpw-row' }, [
				React.createElement('div', { key: 'text', className: 'dshpw-text' }, text),
				React.createElement('div', { key: 'actions', className: 'dshpw-actions' }, actions),
			]);
		}

		const inject = ['slots'];

		function apply(ctx) {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-power';
			tag.textContent = CSS;
			document.head.appendChild(tag);
			ctx.effect(() => () => { tag.remove(); }, 'dsh-power: styles');

			// --- browser-side diagnostics -------------------------------------
			// The connection state and this page's own errors exist nowhere the
			// host can read them, so the page reports them to its own host half.
			report({
				kind: 'mount',
				origin: describe(window.location && window.location.origin),
				href: describe(window.location && window.location.href),
				online: typeof window.navigator === 'object' && window.navigator !== null ? window.navigator.onLine : null,
			});

			const connection = ctx.get('connection');
			if (connection !== undefined && connection !== null
				&& connection.state !== undefined && connection.state !== null
				&& typeof connection.state.subscribe === 'function') {
				const readState = () => {
					try { return String(connection.state.getSnapshot()); } catch (error) { return 'unknown'; }
				};
				report({ kind: 'connection', state: readState() });
				ctx.effect(() => connection.state.subscribe(() => {
					report({ kind: 'connection', state: readState() });
				}), 'dsh-power: connection diagnostics');
			} else {
				report({ kind: 'connection', state: 'unavailable' });
			}

			const onError = (event) => report({
				kind: 'error',
				message: describe(event && event.message),
				source: describe(event && event.filename),
				line: event && event.lineno,
			});
			const onRejection = (event) => report({ kind: 'rejection', reason: describe(event && event.reason) });
			window.addEventListener('error', onError);
			window.addEventListener('unhandledrejection', onRejection);
			ctx.effect(() => () => {
				window.removeEventListener('error', onError);
				window.removeEventListener('unhandledrejection', onRejection);
			}, 'dsh-power: error diagnostics');

			ctx.slots.inject('settings.general.item', () => ctx.slots.register(
				{ name: 'settings.general.item', id: 'service-power', order: 30 },
				PowerRow,
			));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
