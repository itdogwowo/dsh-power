# dsh-power

DSH Web 的**服務電源**外掛。在「設定 → 通用設置」加一列，提供**重新啟動**與**關閉**整個 DSH 服務行程的按鈕；並可在「設定 → 外掛」用一鍵開關獨立啟停。

```
DSH 服務                                                   [重新啟動]  [關閉]
PID 67489
```

（滑過 `PID` 會顯示即將操作的完整啟動指令。）

---

## 安裝

```sh
dsh plugin --profile web add /Users/user/Documents/code/git/dsh-power
```

或到「設定 → 外掛」用安裝介面加入這個路徑。安裝後 profile 的 `dsh.profile.bundles` 會多一項 `dsh-power`，**重啟一次服務**讓這個 bundle 生效。

若只是本機連結（不經 pnpm），等價的手動做法：

```jsonc
// ~/.dsh/profiles/web/package.json
"dependencies": { "dsh-power": "link:/Users/user/Documents/code/git/dsh-power" },
"dsh": { "profile": { "bundles": [ /* …, */ "dsh-power" ] } }
```

```sh
ln -sfn /Users/user/Documents/code/git/dsh-power ~/.dsh/profiles/web/node_modules/dsh-power
```

## 卸載

```sh
dsh plugin --profile web remove dsh-power
```

或從「設定 → 外掛」移除。這會同時移除 `package.json` 的 dependency、`dsh.profile.bundles` 的項目與 lockfile 記錄，`設定 → 通用設置` 的那一列隨之消失。

一個已知小尾巴：以 `link:` 安裝時 pnpm 不會刪掉 `node_modules/dsh-power` 這個 symlink。少了它不影響開機（已無任何地方引用），但要清乾淨請手動移除：

```sh
rm -f ~/.dsh/profiles/web/node_modules/dsh-power
```

## 啟用 / 停用（一鍵開關）

「設定 → 外掛」清單中的 **dsh-power** 有一個開關。背後機制：外掛管理器讀取本套件自己的 `cordis.patch.yml`（取得 row id `dsh-power`），再到 profile 的 `cordis.patch.yml` 寫入對應的 `disabled:` override。因為 profile 使用 `patchReload: live`，切換**即時生效**，不用重啟：

- 關閉 → 設定 → 通用設置 的那一列立刻消失
- 開啟 → 立刻回來

手動等價寫法（在 profile 的 `cordis.patch.yml`）：

```yaml
- id: dsh-power
  name: dsh-power
  disabled: true
```

## 需求

- **macOS 為主**：重啟邏輯使用 `ps`、`lsof`（必要時用 `perl` 開新 session）。Linux 上的 `ps`/`lsof` 也相容，但未實測。
- DSH `>= 0.1.5-rc.1`。
- 一定要有 `subprocess` 服務（`@deepseek-ai/dsh-base` 已提供）；沒有時 `/api/dsh-power/info` 會回報「此環境沒有 subprocess 服務」，按鈕不會動作。

## 運作原理

**Host 半**（`lib/index.js`）註冊兩條同源路由：

| 路由 | 用途 |
| --- | --- |
| `GET /api/dsh-power/info` | 回報目前 DSH 行程的 `pid` 與完整啟動指令 |
| `POST /api/dsh-power/action` | `{"action":"restart"}` 或 `{"action":"shutdown"}` |

**Browser 半**（`lib/client.js`）在 `settings.general.item` 註冊一列，透過 `fetch` 呼叫上面兩條路由。重啟被接受後它會切成「重新連線中」，輪詢 `/api/dsh-power/info`，直到**回報的 PID 與被取代的那個不同**才重新整理頁面——所以不會在舊 socket 將死時白刷一次，也不需要你去找新的啟動 token（瀏覽器 cookie 由 credentials 裡的密鑰簽章，壽命 30 天，跨重啟有效）。

**為什麼要另開一個脫離的 worker**：這個外掛就跑在它必須殺掉的那個行程裡，若用執行階段管理的子行程，DSH 退出時的清理會把 worker 一起收掉。因此 host 半用 `bash -c 'set -m; { exec node lib/restart.cjs <config>; } &'` 讓 worker 進入**獨立行程群組**，DSH 清理不到它。

**worker（`lib/restart.cjs`）以「port」而不是「pid」為準**，這是重啟可靠與否的關鍵：

1. 等 1.5 秒，讓 HTTP 回應先回到瀏覽器；
2. 對佔用該 port 的行程送 `SIGTERM`，等不到就 `SIGKILL`；**任何指令列不含 `dsh` 的佔用者一律不殺**；
3. 確認 port 真的空出來（最多 15 秒）。若仍被非 dsh 行程佔著就**放棄並記錄**，而不是硬啟動——否則「port 有人在聽」會被誤判為啟動成功；
4. 以 host 半在**還活著時**捕獲的 `process.execPath` + `process.argv` + `process.cwd()` 啟動新行程（不依賴 `PATH`、不從將死行程猜指令）；
5. 驗證新行程真的在監聽（最多 30 秒），失敗就清理後重試，最多 3 次。

port 由請求的 `Host` header 取得，所以在非預設埠啟動的服務也會重啟在**同一個埠**。新行程一律加上 `--no-open`：`dsh web` 預設會開啟一個瀏覽器分頁，若照原樣重啟，每重啟一次就多一個分頁；而那些分頁各自認證在開啟它的那個行程上，下一次重啟後就會停在「請重新連接」，看起來像服務壞了。使用者手上的頁面本來就會自己重連，不需要再開新分頁。

> 重啟流程的設計參考自 [shaoyi1991/dsh-restart-web](https://github.com/shaoyi1991/dsh-restart-web)：以獨立 process group 逃離 DSH 清理、以及「殺 port」而非「殺 pid」。本外掛在其之上補了啟動驗證與重試、非 dsh 佔用者的拒絕、`shutdown`、以及自動重連。

## 安全

- `shutdown` 只會送出終止訊號，不會重新啟動；要恢復必須手動啟動服務。
- worker 只會殺「自己記錄的目標」或「指令列含 `dsh`」的 port 佔用者，其餘一律拒絕並記錄。
- `action` 只接受 `restart` 與 `shutdown` 兩個字串，其餘一律 `400`。
- 重新啟動沿用**原本**的啟動指令、參數與工作目錄，不是猜測出來的新指令。
- 日誌寫入失敗不會影響重啟（log 打不開時 worker 照常執行）。

## 疑難排解

| 症狀 | 檢查 |
| --- | --- |
| 設定 → 通用設置 沒有那一列 | 「設定 → 外掛」的 dsh-power 開關是否被關掉；或重整頁面 |
| 按鈕顯示「無法讀取行程資訊」 | `ps` 是否可執行（在沙箱中啟動的 DSH 會被限制），以及 `subprocess` 服務是否存在。重啟本身不依賴 `ps` |
| 關閉後回不來 | 這是預期行為；請手動啟動服務，或改用「重新啟動」 |
| 重新啟動後頁面沒回來 | 看 `${DSH_HOME:-~/.dsh}/dsh-web.log`：`dsh-power:` 開頭是 worker 的紀錄，`dsh web: http://…` 是新行程的啟動輸出 |
| worker 記錄 `aborting: port … is still held` | 該埠被非 dsh 行程佔用，外掛刻意不殺它；請自行處理佔用者 |

## 授權

MIT
