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
		const RECONNECT_POLL_MS = 1500;
		const RECONNECT_TRIES = 40;

		function PowerRow() {
			const [pending, setPending] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const [target, setTarget] = React.useState(null);
			/** Set once a command was accepted: the service is going away, so lock the row. */
			const [finished, setFinished] = React.useState(false);
			/** The pid being replaced; the new one answering means the restart landed. */
			const [awaitingPid, setAwaitingPid] = React.useState(null);

			React.useEffect(() => {
				let alive = true;
				requestWithin(INFO_URL, undefined).then((value) => {
					if (!alive) return;
					if (value !== null && value !== undefined && typeof value === 'object' && value.ok === true) {
						setTarget({ pid: String(value.pid), port: value.port, command: String(value.command) });
					} else {
						setTarget({ pid: '', port: null, command: '' });
					}
				});
				return () => { alive = false; };
			}, []);

			/**
			 * Poll until a different process answers, then reload. `pid` is the
			 * process that accepted the command: the old one may still answer for
			 * a moment, and reloading into it would land on a socket that is about
			 * to close.
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
							try { window.location.reload(); } catch (error) { /* reload refused: leave the row as it is */ }
							return;
						}
						tries += 1;
						if (tries > RECONNECT_TRIES) {
							setNotice({ kind: 'err', text: '服務尚未回應，請手動重新整理頁面。' });
							setFinished(false);
							setAwaitingPid(null);
							return;
						}
						timer = setTimeout(poll, RECONNECT_POLL_MS);
					});
				};

				timer = setTimeout(poll, RECONNECT_POLL_MS);
				return () => { alive = false; if (timer !== null) clearTimeout(timer); };
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
				actions = [React.createElement('button', {
					key: 'waiting',
					className: 'dshpw-btn dshpw-busy',
					disabled: true,
					'aria-busy': 'true',
				}, [spinner(), '重新連線中…'])];
			} else if (pending === null) {
				actions = ['restart', 'shutdown'].map((action) => React.createElement('button', {
					key: action,
					className: action === 'shutdown' ? 'dshpw-btn dshpw-danger' : 'dshpw-btn',
					disabled: busy || finished,
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
			const desc = notice !== null ? notice.text : idle;
			const hover = target !== null && target.pid !== ''
				? 'PID ' + target.pid + ' — ' + target.command
				: undefined;

			const descClass = notice === null
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
