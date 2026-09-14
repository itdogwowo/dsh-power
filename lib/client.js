/**
 * dsh-power — browser half.
 *
 * Contributes one preference row to Settings → General (`settings.general.item`):
 * the live DSH process facts plus restart / shutdown buttons. The row draws its
 * own internals, following the shipped General rows (row / rowText / title /
 * desc / selector), because that slot projects no label and passes no props.
 *
 * It talks to its own host half over the two same-origin routes that half
 * registers; no Remote service and no shared state are involved.
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

		function PowerRow() {
			const [pending, setPending] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const [target, setTarget] = React.useState(null);

			React.useEffect(() => {
				let alive = true;
				request(INFO_URL, undefined).then((value) => {
					if (!alive) return;
					if (value !== null && typeof value === 'object' && value.ok === true) {
						setTarget({ pid: String(value.pid), command: String(value.command) });
					} else {
						setTarget({ pid: '', command: '' });
					}
				});
				return () => { alive = false; };
			}, []);

			const run = (action) => {
				setBusy(true);
				request(ACTION_URL, { action: action }).then((value) => {
					setBusy(false);
					setPending(null);
					if (value !== null && typeof value === 'object' && value.ok === true) {
						setNotice({
							kind: 'ok',
							text: action === 'restart'
								? '已送出重新啟動指令，服務重啟後請重新整理頁面。'
								: '已送出關閉指令，服務將結束，需要手動再次啟動。',
						});
					} else {
						setNotice({ kind: 'err', text: '操作失敗：' + String((value && value.message) || '服務沒有回應。') });
					}
				});
			};

			const label = (action) => (action === 'restart' ? '重新啟動' : '關閉');
			const ask = (action) => (action === 'restart' ? '確定要重新啟動？' : '確定要關閉服務？');

			const actions = pending === null
				? ['restart', 'shutdown'].map((action) => React.createElement('button', {
					key: action,
					className: action === 'shutdown' ? 'dshpw-btn dshpw-danger' : 'dshpw-btn',
					disabled: busy,
					onClick: () => { setNotice(null); setPending(action); },
				}, label(action)))
				: [
					React.createElement('span', { key: 'ask', className: 'dshpw-ask' }, ask(pending)),
					React.createElement('button', {
						key: 'yes',
						className: pending === 'shutdown' ? 'dshpw-btn dshpw-danger' : 'dshpw-btn',
						disabled: busy,
						onClick: () => run(pending),
					}, busy ? '處理中…' : '確認'),
					React.createElement('button', {
						key: 'no',
						className: 'dshpw-btn',
						disabled: busy,
						onClick: () => setPending(null),
					}, '取消'),
				];

			/** Idle copy stays one short line; the full command line lives only in the hover title. */
			const idle = target === null
				? ''
				: target.pid === ''
					? '無法讀取行程資訊'
					: 'PID ' + target.pid;
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
