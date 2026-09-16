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

（Windows 上把路徑換成 `C:\Users\user\Documents\code\git\dsh-power`；profile 目錄在 `%USERPROFILE%\.dsh\profiles\web`。）

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

- **macOS**：實測平台（`lsof` 找埠的佔用者、`ps` 讀指令列，`bash` 的 `set -m` 讓 worker 脫離 DSH 的清理）。
- **Linux**：同一組工具，未實測。
- **Windows 10/11**：支援。埠的佔用者以 PowerShell（內建 5.1+）的 `Get-NetTCPConnection` 讀取、`netstat` 為後備；行程指令列以 `Get-CimInstance` 讀取、`wmic` 為後備；worker 以 `child_process.spawn(..., { detached: true })` 啟動（見〈Windows 上的差異〉）。**這條路徑有單元測試覆蓋，但尚未在 Windows 實機上跑過。**
- DSH `>= 0.1.5-rc.1`。
- POSIX 上一定要有 `subprocess` 服務（`@deepseek-ai/dsh-base` 已提供），worker 才起得來；沒有時重啟／關閉會回報「此環境沒有 subprocess 服務」。Windows 不需要它。

## 運作原理

**Host 半**（`lib/index.js`）註冊兩條同源路由：

| 路由 | 用途 |
| --- | --- |
| `GET /api/dsh-power/info` | 回報目前 DSH 行程的 `pid` 與完整啟動指令 |
| `POST /api/dsh-power/action` | `{"action":"restart"}` 或 `{"action":"shutdown"}` |

**Browser 半**（`lib/client.js`）在 `settings.general.item` 註冊一列，透過 `fetch` 呼叫上面兩條路由。重啟被接受後它會切成「重新連線中」，輪詢 `/api/dsh-power/info`，直到**回報的 PID 與被取代的那個不同**才重新整理頁面——所以不會在舊 socket 將死時白刷一次，也不需要你去找新的啟動 token（瀏覽器 cookie 由 credentials 裡的密鑰簽章，壽命 30 天，跨重啟有效）。

**為什麼要另開一個脫離的 worker**：這個外掛就跑在它必須殺掉的那個行程裡，若用執行階段管理的子行程，DSH 退出時的清理會把 worker 一起收掉。因此 POSIX 上 host 半用 `bash -c 'set -m; { exec node lib/restart.cjs <config>; } &'` 讓 worker 進入**獨立行程群組**，DSH 清理不到它；Windows 上的做法不同，理由見下一節。

**worker（`lib/restart.cjs`）以「port」而不是「pid」為準**，這是重啟可靠與否的關鍵：

1. 等 1.5 秒，讓 HTTP 回應先回到瀏覽器（這段等待會在目標行程提早消失時立刻結束）；
2. 對佔用該 port 的行程送 `SIGTERM`，等不到就 `SIGKILL`（Windows 上兩者都是 `TerminateProcess`，見下）；**任何指令列看不出是 DSH 的佔用者一律不殺**；
3. 確認 port 真的空出來（最多 15 秒）。若仍被非 dsh 行程佔著就**放棄並記錄**，而不是硬啟動——否則「port 有人在聽」會被誤判為啟動成功；
4. 以 host 半在**還活著時**捕獲的 `process.execPath` + `process.execArgv` + `process.argv` + `process.cwd()` 啟動新行程（不依賴 `PATH`、不從將死行程猜指令；`--inspect` 系列不重播，否則新行程會停在等除錯器）；
5. 驗證新行程真的在監聽（最多 30 秒），失敗就清理後重試，最多 3 次。

port 由請求的 `Host` header 取得，所以在非預設埠啟動的服務也會重啟在**同一個埠**。新行程一律加上 `--no-open`：`dsh web` 預設會開啟一個瀏覽器分頁，若照原樣重啟，每重啟一次就多一個分頁；而那些分頁各自認證在開啟它的那個行程上，下一次重啟後就會停在「請重新連接」，看起來像服務壞了。使用者手上的頁面本來就會自己重連，不需要再開新分頁。

## Windows 上的差異

四件事在 Windows 必須換做法，這就是「支援 Windows」的全部內容：

1. **worker 不經過 `subprocess` 服務啟動**。harness 的 subprocess 服務在 Windows 會把每個子行程放進一個帶 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Win32 Job Object（由它自己的 runner 持有），所以照 POSIX 那樣啟動的 worker 會跟著它要重啟的那個行程一起被收掉。host 半改用 `child_process.spawn(..., { detached: true, windowsHide: true, stdio: 同一個日誌檔 })`——那在 Job 之外，活得過服務結束；worker 的 stdout/stderr 直接接到日誌檔，因此它在寫下第一行之前就崩潰也看得到。
2. **Windows 沒有訊號**。Node 把 `SIGTERM`、`SIGKILL` 一律實作成 `TerminateProcess`，所以「先禮後兵」在那裡不存在。Job 內的子行程會跟著死，ConPTY 終端機那種不在 Job 內的就可能變成孤兒——因此 host 半在**回應送出之後**（`res` 的 `finish`，再等 250ms）呼叫 harness 自己的 `ctx.appExit`，讓整個樹走和平常 SIGTERM 相同的 dispose 路徑，自己管的子行程一併收掉；worker 只在寬限期（Windows 給 2.5 秒）過後才硬殺當後備。
3. **埠的佔用者與指令列要換工具讀**。`Get-NetTCPConnection -State Listen`（PowerShell 5.1+ 內建）優先，`netstat -ano -p TCP` 後備；`netstat` 的狀態字是**在地化**的（中文 Windows 印「偵聽」），所以解析只看欄位：本機位址以 `:port` 結尾、外部位址以 `:0` 結尾——傾聽中的 socket 沒有對端，因此 TIME_WAIT／ESTABLISHED 的殘留連線不會被誤認成傾聽者。指令列用 `Get-CimInstance Win32_Process`（`wmic` 在新版 Windows 已被移除，只當後備）。PowerShell 一律以 `-EncodedCommand`（UTF-16LE base64）呼叫，不必和 cmd.exe 的引號規則搏鬥；每個探測都帶 `windowsHide`，免得每 250ms 閃一次黑窗。
4. **多一道 TCP 查證**。PowerShell 與 netstat 都可能被公司政策封掉，那時「查不到佔用者」並不等於「服務沒在跑」。worker 另外用一條 TCP 連線判斷服務是否真的在聽：判斷「起來了」時兩個證據都算，判斷「空了」時兩個都要通過，所以在被封鎖的環境也不會對著健康的服務重試三次。同理，Windows 上「埠已經空了」也算「行程已經停了」的證據——`TerminateProcess` 之後只要還有別的行程握著 handle，那個 pid 仍會被 `OpenProcess` 看到。


> 重啟流程的設計參考自 [shaoyi1991/dsh-restart-web](https://github.com/shaoyi1991/dsh-restart-web)：以獨立 process group 逃離 DSH 清理、以及「殺 port」而非「殺 pid」。本外掛在其之上補了啟動驗證與重試、非 dsh 佔用者的拒絕、`shutdown`、以及自動重連。

## 安全

- `shutdown` 只會停掉行程，不會重新啟動；要恢復必須手動啟動服務。
- worker 只會殺「自己記錄的目標」或「指令列看得出是 DSH」的 port 佔用者（`dsh`／`deepseek-harness`／`@deepseek-ai`，不分大小寫），其餘一律拒絕並記錄。
- `action` 只接受 `restart` 與 `shutdown` 兩個字串，其餘一律 `400`。
- 重新啟動沿用**原本**的啟動指令、參數與工作目錄，不是猜測出來的新指令。
- 日誌寫入失敗不會影響重啟（log 打不開時 worker 照常執行）。

## 疑難排解

| 症狀 | 檢查 |
| --- | --- |
| 設定 → 通用設置 沒有那一列 | 「設定 → 外掛」的 dsh-power 開關是否被關掉；或重整頁面 |
| 那一列說「服務未連線（請重新整理頁面）」 | 頁面連不到 `/api/dsh-power/info`（外掛被停用、或這個頁面本身已經失效）；先重整頁面 |
| POSIX 上按鈕說「此環境沒有 subprocess 服務」 | 這個環境缺少 `subprocess`（`@deepseek-ai/dsh-base` 才會提供）；Windows 不需要它 |
| 滑過 PID 看到的指令列和平常打的不一樣 | POSIX 上那是 `ps` 的原文；讀不到時（沙箱、Windows）改用 host 半自己拼的 `execPath + argv`，PID 一律正確 |
| 關閉後回不來 | 這是預期行為；請手動啟動服務，或改用「重新啟動」 |
| 重新啟動後頁面沒回來 | 看 `${DSH_HOME:-~/.dsh}/dsh-web.log`：`dsh-power:` 開頭是 worker 的紀錄，`dsh web: http://…` 是新行程的啟動輸出 |
| worker 記錄 `aborting: port … is still held` | 該埠被非 dsh 行程佔用（或佔用者查不出來），外掛刻意不殺它；請自行處理佔用者 |
| Windows：worker 記錄 `refusing pid …: not a dsh process` | 佔用該埠的行程指令列裡沒有 `dsh`／`deepseek-harness`／`@deepseek-ai`，外掛拒絕殺它。若那其實是 DSH（例如自訂啟動腳本），請用「關閉」手動處理 |
| Windows：重啟後殘留終端機行程 | `ctx.appExit` 那條優雅關閉路徑沒走到（例如 DSH 版本沒有這個服務），只剩下硬殺，ConPTY 終端機不在 Job 內就會留下來；手動結束即可 |
| Windows：黑窗一閃一閃 | 不該發生——所有探測都帶 `windowsHide`。若真的看到，請回報是哪個指令 |
| 那一列說「瀏覽器回報離線」但系統明明有網路 | 瀏覽器的 `navigator.onLine` 卡住了（DSH 在離線時會暫停重連）。外掛會在本地服務有回應時自動覆寫它；若覆寫失敗，重啟瀏覽器 |

## 測試

```sh
npm test                      # 兩套都跑
node test/product-check.mjs   # 封裝形狀、平台工具、host 半（假 ctx）、browser 半（假 DOM）
node test/worker-check.mjs    # 真的跑 worker：重啟／關閉／拒絕非 dsh 佔用者
```

`worker-check` 會在自己的暫存目錄裡起一個替身服務、挑一個空埠來操作，不會碰你正在跑的 DSH。Windows 分支沒有實機，是靠 `product-check` 的單元測試（PowerShell 腳本、`netstat` 解析、後備順序）與靜態檢查覆蓋的。

## 致謝

這個外掛能收斂到現在的樣子，靠的是別人的程式碼與觀察。實際的貢獻如下：

**設計起點：[shaoyi1991/dsh-restart-web](https://github.com/shaoyi1991/dsh-restart-web)**
重啟流程的兩個關鍵想法來自這裡——以獨立 process group 逃離 DSH 的退出清理（`set -m`）、以及「殺 port 而非殺 pid」。本外掛保留這兩點，並在其上補了啟動驗證與重試、非 dsh 佔用者的拒絕、`shutdown`、前端自動重連，以及不分頁的重新啟動。

**DSH 自身的套件**（作為行為依據與介面來源，非程式碼引用）：

- `@deepseek-ai/dsh-client-connection` — cookie 綁定 authority（`cookieName`）、簽章密鑰存於 credentials（30 天，跨重啟有效）、以及「offline 時暫停自動重連」的 `setNetworkAvailable`。最後一項是這個外掛之所以需要修離線旗標的原因。
- `@deepseek-ai/dsh-client-ui-settings-general` — `settings.general.item` 那列的樣式（`rowText` / `title` / `desc` / `selector` 的字級、間距、token）是照它對齊的；它同時也是「連接異常，點擊立即重連」指示器的出處，把症狀定位到連線層。
- `@deepseek-ai/dsh-client-modules` — `dsh.client` 與 `exports["./client"]` 的載入契約、`nearestPackage` 的解析規則，以及 browser bundle 必須以 `window.__ModuleLoader__.load({ id, factory })` 註冊。
- `@deepseek-ai/dsh-host-webserver` — `webServer.register` 的路由語意（exact 路由先於 `/api` prefix 命中）。
- `@deepseek-ai/dsh-cordis-host-runner` — 動態外掛的沙盒形狀（`ctx` 只在 `apply` 內、`process` 不可用），這決定了本外掛後來改寫成真正的 profile bundle 而非動態外掛。
- `@deepseek-ai/dsh-subprocess-local`／`@deepseek-ai/dsh-win32-process` — Windows 支援的兩個關鍵事實來自它們的實作：harness 啟的每個子行程都活在一個帶 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object 裡（所以 worker 不能走 `subprocess`），以及 harness 退出時會對自己的子行程做 `taskkill /T /F` 等級的清理。
- `@deepseek-ai/dsh-cmdline` — `ctx.appExit` 這個「請求整個樹有界退出」的服務，是 Windows 上沒有訊號可送時的優雅關閉入口。

**社群外掛包 `dsh-web` / `@linxin666/*`**
外掛管理器如何讀寫 profile 的 patch 層、如何以 row id 將套件對應到可切換的列並寫入 `disabled` 覆寫，是照它的實作推導出來的；它的 bundle-guard 註解（「同時以 bundle 與 patch row 掛載會在下一次開機死於重複路由」）讓我們避開了那個地雷。

**Atlassian SourceTree**
本外掛的 commit 是透過它隨附的憑證仲介 `/Applications/SourceTree.app/Contents/Resources/bin/git-credential-sourcetree` 推送的——由它出面提供憑證，而不是去讀它的 keychain。

**使用者的第一手觀察**
這個外掛的每一次修正都源自實際使用回報：重啟後按鈕失效、第二次重啟回到舊症狀、`Cmd+R` 多出「連接異常」、以及**「不斷重啟會不斷新增分頁」**——最後這一項直接促成了 `--no-open`，也解釋了先前反覆出現的「不穩定」。

## 授權

MIT
