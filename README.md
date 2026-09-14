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

**Browser 半**（`lib/client.js`）在 `settings.general.item` 註冊一列，透過 `fetch` 呼叫上面兩條路由。

**為什麼要另開一個脫離的 helper**：這個外掛就跑在它必須殺掉的那個行程裡。若用執行階段管理的子行程，SIGTERM 觸發的 teardown 會把 helper 一起收掉，就沒有東西能把服務重新拉起來了。因此：

1. 以 `/bin/sh -c` 啟動一個 launcher，它用 `$PPID` 認出 DSH 行程；
2. launcher 用 `perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV'` 在**新 session** 啟動 worker（沒有 `perl` 時退回 `nohup`）；
3. worker 等 1 秒（讓 HTTP 回應先回到瀏覽器）→ `SIGTERM` → 最多等 20 秒 → 必要時 `SIGKILL`；
4. 只有 `restart` 會繼續：從 `lsof` 取回原本的 node 執行檔與工作目錄，用**原本的指令**重新啟動，輸出附加寫入 `${DSH_HOME:-~/.dsh}/dsh-web.log`。

## 安全

- `shutdown` 只會送出終止訊號，不會重新啟動；要恢復必須手動啟動服務。
- worker 在動手前會確認目標行程的指令列包含 `dsh`，否則直接退出（`exit 2`），不會誤殺其他行程。
- `action` 只接受 `restart` 與 `shutdown` 兩個字串，其餘一律 `400`。
- 重新啟動會沿用**原本**的啟動指令與工作目錄，不是猜測出來的新指令。

## 疑難排解

| 症狀 | 檢查 |
| --- | --- |
| 設定 → 通用設置 沒有那一列 | 「設定 → 外掛」的 dsh-power 開關是否被關掉；或重整頁面 |
| 按鈕顯示「無法讀取行程資訊」 | `ps` 是否可執行（在沙箱中啟動的 DSH 會被限制），以及 `subprocess` 服務是否存在 |
| 關閉後回不來 | 這是預期行為；請手動啟動服務，或改用「重新啟動」 |
| 重新啟動後沒回來 | 看 `${DSH_HOME:-~/.dsh}/dsh-web.log` |

## 授權

MIT
