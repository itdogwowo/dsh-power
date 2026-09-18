# macOS 驗證交接單

這份文件是給**下一個接手的人（或 AI）**用的：說明 `dsh-power` 還有哪些東西**只在 Windows 上驗證過、macOS 尚未驗證**，以及要怎麼驗、預期看到什麼。

寫這份的原因：這個外掛的原始開發平台是 macOS，但最近一輪修正（尤其是**埠的來源**）是在 Windows 上做的。**macOS 的路徑在那之後沒有重跑過。**

---

## 0. 先讀這段：一個會咬人的陷阱

**`npm test` 的第一支測試會關掉你正在用的 DSH。**

`test/product-check.mjs` 會把 host 半掛在一個假的 ctx 上。在**非 Windows** 上它會走 POSIX 分支沒問題；但這個套件本身有破壞性歷史——它曾經在 Windows 上走到 harness 的 `ctx.appExit` 而把宿主行程關掉。

目前已加了三道防護（同一支檔案內）：

| 防護 | 位置 | 作用 |
| --- | --- | --- |
| fake ctx **不提供** `appExit` | 兩個 fake ctx | 讓「請 app 退出」變成 no-op |
| `guardedGet()` | 約 line 260 | 一旦有人問 `appExit` 就 **FAIL 並說明原因**，不是安靜回 undefined |
| worker spawn **直接拒絕** | 約 line 283 `WORKER_REFUSED` | 讓 action route 在「啟動 worker」那一步就 throw，永遠到不了破壞性的後半段 |

**所以現在跑 `npm test` 是安全的**，而且第 3 道防護讓「啟動真 worker」這件事在測試中根本做不到。但請**仍然先預期它可能出錯**：測試前先記下你服務的 pid，測試後對一次。

```sh
# 測試前
lsof -nP -iTCP:3080 -sTCP:LISTEN        # 記下 pid
# 跑測試
npm test
# 測試後：pid 應該一樣
```

---

## 1. 現況：哪些驗過、哪些沒驗

### 已在 Windows 實機驗證（有 log 與 pid 為證）

- 真的重啟：舊行程消失、**新行程接管同一個埠**、`pid` 換人（`41836` 類型的前後對照）
- 真的關閉：埠釋放、不重啟
- **拒絕**非 dsh 的埠佔用者（不殺、不假裝成功、記 log）
- 外掛在真實 DSH 開機時**確實掛載**、路由認證後回應、未知 action 回 400
- 埠保真：在 **3093** 與 **3098** 兩個非預設埠都驗過「重啟後仍在同一個埠」
- `netstat` 解析（含中文 Windows 的「偵聽」、TIME_WAIT 不算 listener）
- PowerShell → `netstat` 後備順序；`Get-CimInstance` → `wmic` 後備順序
- `isDshCommand` 對 Windows 路徑大小寫不敏感

### 只在 macOS／Linux 才會執行到，**尚未驗證**

- `lsof -nP -ti tcp:<port> -sTCP:LISTEN`（找埠的佔用者）
- `ps -p <pid> -o command=`（讀指令列）
- `bash -c 'set -m; { exec node lib/restart.cjs <payload>; } &'`（worker 進入獨立行程群組）
- `subprocess.spawn(...)`（POSIX 的 worker 啟動路徑）
- **埠保真在 macOS 上重跑**（本輪修正的重點）

### 需要真機、無法用假 exec 取代的部分

`lsof`／`ps` 是否真的存在、`set -m` 是否真的讓 worker 逃過 DSH 的退出清理——這兩件事的答案只在真機上。

---

## 2. 建議的測試順序

### 第 0 步（不必用 mac，先做這個最有價值）

把 `lsof`／`ps`／`bash` 的探測也改成**可注入平台**，像 `lib/platform.cjs` 現在對 Windows 做的那樣（`listenersOf({ platform, port, exec })`）。做完之後，macOS 分支的**解析與後備順序**就能在任何平台上測，覆蓋率會大幅提升。

> 現況：`listenersOf` 與 `commandOf` **已經接受 `platform` 與 `exec` 參數**，所以主要缺的是「針對 posix 分支補測試」，而不是重構。

### 第 1 步：兩套測試（真機）

```sh
cd <這個 repo>
npm test
# 或分開跑
node test/product-check.mjs
node test/worker-check.mjs
```

**預期**：兩套都 `ALL CHECKS PASSED`。

`worker-check` 是關鍵的一支——它會在自己的暫存目錄裡真的起一個替身服務、真的殺掉、真的重啟，**不會碰你正在跑的 DSH**。

### 第 2 步：埠保真（真機，本輪修正的重點）

用**非預設埠**啟動：

```sh
dsh web --port 3099
```

開 `http://127.0.0.1:3099/`，在「設定 → 通用設置」按 **重新啟動**。

**預期**：
- 頁面自動重連、回來
- 那一列的 PID **變成新的**
- 顯示的埠仍是 **3099**（不是 3080）
- log 一行 `service is listening on 3099 again`

```sh
tail -f "${DSH_HOME:-$HOME/.dsh}/dsh-web.log" | grep dsh-power
```

**這是本輪唯一新增的功能行為，請務必做這一項。**

### 第 3 步：`set -m` 真的有效嗎（真機，核心假設）

這是 macOS 路徑最關鍵、也最容易隨 DSH 改版壞掉的假設：worker 必須活得過它所重啟的那個行程的退出清理。

做法：按重啟，然後看 log 是否**完整**。

```
worker start: action=restart port=…
port … is free
attempt 1: started pid …
service is listening on … again
```

如果 log 停在 `worker start` 之後就沒有了，代表 worker 被 DSH 的退出清理一起收掉了——`set -m`（或 DSH 的清理方式）變了。

### 第 4 步：`--port 0`（真選用）

```sh
dsh web --port 0
```

DSH 啟動時會印出含埠的 URL，從那裡讀出**實際拿到的埠**。按重啟，確認新行程**釘在同一個埠**上。

這正是 host 半改用 `webServer.port` 而不是 `Host` header 的理由之一。

### 第 5 步：UI 兩顆按鈕（最貼近使用者，但**不能取代**上面幾步）

在「設定 → 通用設置」：

- **重新啟動** → 頁面自己回來、PID 換新
- **關閉** → 服務結束（**預期行為**：要手動再開）

---

## 3. UI 兩顆按鈕 vs 完整驗證：差在哪

兩顆按鈕是**最重要的一項**（完整 profile、真實環境），但它有兩個盲點：

| 只按按鈕驗不到的 | 為什麼 | 要怎麼驗 |
| --- | --- | --- |
| 非預設埠是否保真 | 你的實例跑在預設 3080，看不出「有沒有跟著埠走」 | 第 2 步：`--port 3099` |
| worker 是否活得過退出清理 | 成功時你不會看到 log；失敗時服務直接消失 | 第 3 步：看 log 是否完整 |
| `--port 0` | 需要特別啟動 | 第 4 步 |

所以：**兩顆按鈕 = 必要但不充分**。它在「功能有沒有壞」這件事上是最強的證據；在「非預設埠」與「內部假設」上則看不到。

---

## 4. 已知的機器相依性（不是 bug，但會讓人誤判）

### Windows：`Get-NetTCPConnection` 可能整個壞掉

實測遇過 `MSFT_NetTCPConnection` CIM 類別未註冊：

```
Get-NetTCPConnection : CIM 資源 ROOT/StandardCimv2/MSFT_NetTCPConnection 沒有找到相關的 CIM 類別
```

**症狀**：每個探測都要先等 PowerShell 失敗（約 1.3 秒）才落到 `netstat`，重啟整體多花幾秒。**功能不受影響**，靠 `netstat` 後備接住。

**修法**：`winmgmt /verifyrepository`，或在「Windows 功能」中修復 WMI。

### POSIX：`lsof` 被限制時會安靜地回「沒有 listener」

`listenersOf` 只在 `platform === 'win32'` 時分支，其餘一律走 `lsof`。若 `lsof` 不存在或被沙箱阻擋，它會 catch 後回傳空陣列——看起來像「埠是空的」。

**這是刻意設計的**：worker 另有 `tcpAnswers()` 做 TCP 交叉查證，判斷「起來了」時兩個證據都算、判斷「空了」時兩個都要通過。所以被封鎖的環境不會對著健康的服務重試三次。**但這條後備在真機上沒驗過**，值得在 macOS 上特別留意。

### 反向代理／埠轉發

舊版本從 `Host` header 取埠：請求從 `localhost:8080` 進來、服務握著 `3080` 時，worker 會去等一個只有代理持有的埠，把它判定為「非 dsh 佔用者」而拒絕，**重啟永遠不會成功**。

**現在已修**：以 socket 自己的埠（`webServer.port`）為準，`Host` 只當 server 還沒 listen 時的後備。

### 重啟後第一次開啟出現「HTTP ERROR 404」

**症狀**：按重啟 → 頁面自動導向 `http://127.0.0.1:3080/` → 瀏覽器顯示 `HTTP ERROR 404`；**手動重新整理就好了**。只在第一次發生。

**原因**：新行程會**先**回應本外掛自己的 `/api/dsh-power/info`（plugin tree 較早掛載），**之後**才掛上應用程式的 `/`。client 的輪詢看到新 pid 就立刻導向 `/`，於是落在一個「在聽、但還沒有 `/` 這條路由」的伺服器上。

**為什麼是 404 而不是 401**：未認證的 `/` 由 auth fence 回答，正常是 **401**。出現 **404** 就代表連 fence 都還沒掛上——這個區別正是判斷依據。

**現在已修**（`lib/client.js`）：導向前先問 `/` 是否真的在服務（`pageIsServed()`）。任何回應都算準備好，**除了 404 與 5xx**；401 **刻意算準備好**，因為那是「這頁的 cookie 屬於剛剛死掉的那個行程」的正確答案，該出現的是應用程式自己的登入畫面。等待有 20 秒上限，逾時會明說「服務已重新啟動，但頁面還沒準備好」，不會無聲卡住。

**macOS 上也要確認這一點**：若在 mac 上按重啟後看到 404，就是這個修沒生效（或 DSH 的掛載順序變了）。

---

## 5. 相關檔案

| 檔案 | 用途 |
| --- | --- |
| `lib/index.js` | host 半：路由、`portOf(req, bound)`、`pinnedToPort(args, bound)`、`boundPort()` |
| `lib/restart.cjs` | worker：殺埠、等待、啟動、驗證、重試 |
| `lib/platform.cjs` | 平台探測（`listenersOf` / `commandOf`，**已可注入 platform 與 exec**） |
| `lib/client.js` | 瀏覽器半：那一列 UI、重連輪詢 |
| `test/product-check.mjs` | 封裝形狀、平台工具、host 半（假 ctx）、browser 半（假 DOM） |
| `test/worker-check.mjs` | **真的跑 worker**：重啟／關閉／拒絕非 dsh 佔用者 |
| `.verify/restart-check.mjs` | 拋棄式 DSH 實例上的端到端重啟（**只在 3098，不碰 3080**） |
| `.verify/boot-check.mjs` | 拋棄式 DSH 開機，確認外掛真的掛上、路由回應 |
| `.verify/power-verify.mjs` | 重啟／關閉／拒絕外來佔用者（stand-in 服務） |
| `.verify/inspect-check.mjs` | **不執行**、只靜態檢查測試套件的完整性 |

### 拋棄式實例是什麼

`.verify/` 那幾支會在 `$TMPDIR` 下建一個自己的 `DSH_HOME`、用自己的埠（3098／3099 等）、載入同一份外掛，然後測完自己殺掉、自己刪掉。**完全不碰你在跑的 DSH**。這是唯一能安全測試「按重啟」的方法，因為這個外掛的工作就是殺掉它自己所在的行程。

### ⚠️ 跑之前：DSH 在哪由 `.verify/dsh-paths.mjs` 自己找（2026-09-18 改）

`acceptance` / `boot` / `bundle` / `restart` 這四支原本各自**寫死**了某一台
Windows 機器上 npx 快取的完整路徑。那有兩個後果：

1. 那串路徑**夾帶使用者名稱**——而這個 repo 是公開的。
2. **在 macOS 上它們會直接找不到 DSH**，也就是說這份交接單原本**沒辦法照著做**。

現在改成由 `.verify/dsh-paths.mjs` 解析：先看環境變數，再依序找 npx 快取
（Windows 的 `%LOCALAPPDATA%\npm-cache\_npx`、macOS/Linux 的 `~/.npm/_npx`）、
npm 全域（`%APPDATA%\npm\node_modules`、`/opt/homebrew/lib/node_modules`、
`/usr/local/lib/node_modules`），找不到就**丟錯並告訴你怎麼給**。

有兩個 DSH 同時存在時，它挑「`bin.js` 最近被改過」的那一個。要指定就用：

```sh
DSH_BIN=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js node .verify/boot-check.mjs
```

> 這一條在 Windows 上實測過：`bundle-check` / `boot-check` / `restart-check` /
> `acceptance-check` **四支全部 PASSED**，而且都挑到正確的那一包 DSH。
> macOS 上還沒跑過——那正是這份交接單要你做的事。

---

## 6. 完成標準

- [ ] `npm test` 兩套都 `ALL CHECKS PASSED`（macOS 真機）
- [ ] `dsh web --port 3099` 按重啟 → 回到 **3099**，PID 換新
- [ ] 重啟後的 log **四行齊全**（worker start → port free → started pid → listening again）
- [ ] `--port 0` 按重啟 → 釘在實際拿到的埠
- [ ] 「設定 → 通用設置」兩顆按鈕行為正確（重啟會回來、關閉會結束）
- [ ] （建議）第 0 步：補上 posix 分支的單元測試，讓 macOS 路徑也有平台無關的覆蓋
