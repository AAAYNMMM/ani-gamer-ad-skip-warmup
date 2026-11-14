# 巴哈動畫瘋 廣告跳過 + 下一集預熱

一個 Tampermonkey 使用者腳本，用於 [巴哈姆特動畫瘋](https://ani.gamer.com.tw/)。核心功能：

- **本集去廣告**：開頭廣告自動看完 25 秒（靜音），到點自動跳過、直接進入正片。
- **下一集預熱**：本集播放到「剩餘 8 分鐘」時，後台自動替「下一集」過掉廣告，點下一集即無廣告直接播放。

> **巴哈動畫瘋 去廣告 / 跳過廣告 / 免廣告 / 擋廣告** — 巴哈姆特動畫瘋廣告跳過腳本。
> Bahamut Ani-Gamer (ani.gamer.com.tw) **ad skipper / skip ads / adblock** userscript for Tampermonkey.

## English Summary

**Bahamut Ani-Gamer (ani.gamer.com.tw) ad skipper userscript.**

A Tampermonkey userscript for Bahamut Ani-Gamer that:
- **Auto-skips the 25-second pre-roll ad** (muted, no clicks needed).
- **Auto-dismisses age-rating overlays** (12/15/18), hiding them entirely.
- **Pre-warms the next episode**: 8 minutes before the current episode ends, it quietly completes the next episode's ad handshake in the background — so the next episode starts **with no ad at all**. This is the unique feature: other scripts still make you wait 25s on *every* episode.
- **Never opens the paid/VIP page** (a common bug in naive "click skip" scripts).

Why other scripts still show ads: the 25-second ad requirement is **enforced server-side** (`token.php` only returns `time==1` after a real 25s handshake). A frontend script cannot shorten it for the current episode — but it *can* pre-complete the handshake for the next episode while you watch, which is exactly what this script does.

> 中文说明见下。本腳本獨有「下一集預熱」，其他動畫瘋去廣告腳本每集仍需等 25 秒。

---

## 快速搜尋關鍵字 / Keywords

若你是從搜尋引擎或 AI 找到這裡，這頁對應以下需求：

| 你想找 | 本專案 |
|---|---|
| 動畫瘋去廣告 / 動畫瘋跳廣告 / 動畫瘋免廣告 | ✅ 本集 25 秒自動跳過 |
| 動畫瘋 30 秒廣告好煩 / 廣告太長 | ✅ 靜音 + 自動跳過，0 操作 |
| 巴哈姆特 動畫瘋 擋廣告 / 阻擋廣告 | ✅ 不載入廣告、不誤觸付費頁 |
| 動畫瘋 用戶腳本 / userscript / 油猴腳本 / Tampermonkey | ✅ 直接安裝 |
| 動畫瘋 廣告 跳過 腳本 / 免看廣告 | ✅ 支援下一集預熱（連播無廣告） |
| 動畫瘋 年齡分級 驗證 很煩 / 每次都要點同意 | ✅ 自動隱藏分級遮罩 |
| bahamut anime ad skip / ad blocker / no ads | ✅ |
| 動畫瘋 廣告 提速 / 加速 / 快轉 | ⚠️ 服務端硬性 25 秒，無法縮短（見下方原理） |
| 動畫瘋 破解 / 免費 VIP / 無限看 | ❌ 本專案不做破解，只用官方廣告流程避讓 |

---

## 運作原理

### 廣告驗證是「服務端按設備+集數記錄」的

動畫瘋的廣告驗證由**服務端按 `(deviceid, 集數 sn)` 記錄**：`token.php` 回傳 `time==1` 代表「這台設備、這一集」的廣告已通過。因此，只要用播放器**同一個 deviceid** 對「下一集」走完廣告流程，服務端就會把下一集標記為已看廣告，等你切過去時直接放正片。

### 關鍵門檻：服務端 25 秒

非 VIP 帳號要拿到影片流，必須滿足服務端 **25 秒**的廣告觀看門檻（低於 25 秒，`token.php` 不會返回 `time==1`，正片無法載入）。這是服務端硬性校驗，前端無法縮短。

### 關鍵障礙：服務端「一設備一視頻」鎖

動畫瘋對每個 deviceid 設有 **「同時間內僅提供播放一部影片」** 的設備鎖。若在看第 1 集時，直接對第 2 集發起廣告計數，會撞鎖被拒絕。

因此預熱前必須先**釋放設備鎖**（參考 [miyouzi/aniGamerPlus](https://github.com/miyouzi/aniGamerPlus) 的流程）。

---

## 完整運行邏輯

### 1. 捕獲 deviceid

腳本攔截 `fetch` / `XHR`，從以下兩處捕獲播放器真實使用的 deviceid（保證與播放器 100% 一致）：

- `GET /ajax/getdeviceid.php` 的響應 `{ deviceid }`
- 播放器載正片前必發的 `token.php?sn=..&device=..` 請求參數

### 2. 本集去廣告（25 秒自動完成）

- 攔截 `player.adHandler().play()`，捕獲廣告生命週期與 `onComplete` 回調。
- 攔截 `animeAd` / `nativeAd` 插件：把倒數參數鎖到 25 秒、壓制 `error`（防止回退 Google Ads）、`end` 時觸發完結。
- 廣告期間強制靜音；滿足 25 秒後自動發送 `videoCastcishu.php?...&ad=end`，再調用 `onComplete()` 載入正片。

### 3. 片尾觸發預熱（剩 8 分鐘）

- 輪詢 + `seeked` / `timeupdate` 事件監聽（拖進度條立即觸發，方便續看與測試）。
- 觸發條件：**正片播放中、時長 >10 分鐘（排除 30 秒廣告）、剩餘 ≤8 分鐘**。
- 兼容 HLS 串流的 `duration === Infinity`：回退用 `seekable.end()` 與 `player.duration()` 取得總時長。

### 4. 後台預熱下一集（無設備鎖干擾設計）

```
1. token.php?sn=<下一集>&device=..        # 檢查是否 VIP / 已通過
   ├─ VIP 或 time==1 → 直接結束（無需預熱）
   └─ 否則繼續 ↓
2. videoCastcishu.php?sn=<下一集>&s=<adSid> # 直接開始廣告計時（不預先調 checklock/videoStart，不搶當前集播放鎖）
3. 等待 26 秒（>25s 門檻）
4. videoCastcishu.php?...&ad=end          # 結束廣告
5. token.php 查詢 → time==1 則「預熱成功」（全程零觸鎖）
   └─ 僅當未通過時，才短暫釋放當前集鎖 → 補發 videoStart.php → 立即將播放鎖交還當前集
```

> **為何預熱不能預先調 `checklock.php` / `videoStart.php`？**
> 官方播放器（`anime_player.js`）中，`checklock.php` 與 `videoStart` 是**正片開始播放時登記「正在觀看該集」的佔鎖介面**，並非廣告介面；而正在播放的當前集每 60 秒會透過 `elapse.php?sn=<當前集>` 校驗設備鎖。若預熱對下一集調用 `checklock.php` 或只對下一集 `unlock.php` 而不把鎖交還當前集，當前集下一次 `elapse.php` 心跳就會收到 `state=4`（「本服務同時間內僅提供播放一部影片！」）並觸發 `animeMask().showError` 銷毀播放器。
>
> 本腳本採用四層防鎖干擾機制：
> 1. **純廣告握手優先**：預熱預設只走 `token.php` + `videoCastcishu.php`（與官方廣告階段完全一致），不碰 `checklock.php` / `videoStart.php`。
> 2. **借鎖必還當前集**：一旦後端回傳鎖衝突或需補發 `videoStart.php`，會先解開**當前集**與下一集鎖，完成後立即透過 `checklock.php?sn=<當前集>` 將設備鎖交還給正在播放的當前集。
> 3. **攔截 `elapse.php` 與 `animeMask().showError` 自癒**：若當前集 `elapse.php` 心跳或 `video_src.php` 因瞬態鎖衝突返回異常（如 `state=4`），自動在後台重新為當前集取回設備鎖並放行響應，絕不讓播放器彈出錯誤遮罩或 `dispose()` 中斷播放。
> 4. **切集與卸載自動退鎖**：SPA 切集、`pagehide` / `beforeunload` 離開頁面前自動以 `keepalive` 發送 `unlock.php` 釋放上一集鎖，並用 `sessionEpoch` 中止舊集未完成的異步預熱，確保無廣告秒進下一集時不撞鎖。

預熱成功後，`S.warming`（頁面內 Set）記錄該集，防止重複預熱。

---

## 安裝

> **一鍵安裝**（需先裝好 Tampermonkey）：點此 → [**安裝腳本**](https://raw.githubusercontent.com/AAAYNMMM/ani-gamer-ad-skip-warmup/master/ani-gamer-ad-skip-warmup.user.js)

1. 安裝 [Tampermonkey](https://www.tampermonkey.net/)。
2. 開啟 [ani-gamer-ad-skip-warmup.user.js](./ani-gamer-ad-skip-warmup.user.js)，點擊 **Raw**，Tampermonkey 會自動彈出安裝頁面。
3. 點「安裝」，刷新任一集動畫頁面即生效。

也可手動：Tampermonkey 儀表板 → 「+」新增腳本 → 貼上檔案內容 → 儲存。

---

## 行為說明

| 功能 | 說明 |
| --- | --- |
| 本集去廣告 | 開頭廣告自動倒數 25 秒、靜音，到點自動跳過進正片 |
| 廣告靜音判斷 | 用播放器自己加/刪的 `vjs-*-ad-playing` 類名判斷廣告（含 `vjs-ad-playing` / `vjs-anigamer-ad-playing` / `vjs-anigamer-m3u8-ad-playing` 等全變體）；**不用「跳過按鈕存在」判斷**（按鈕可能殘留，會誤靜音正片） |
| 尊重手動靜音 | 只恢復「腳本自動靜的音」；你自己按的靜音不會被正片播放覆蓋 |
| 跳過按鈕安全點擊 | **只在倒數歸零（按鈕 `.enable` / 文字「點此跳過廣告」）時才點**；倒數中點擊會觸發官方的 `window.open(animePay.php)` 付費頁 |
| 年齡分級確認 | 用真實結構精確命中（`.video-cover-ncc` + `#adult`「同意」按鈕）直接隱藏遮罩並放行；另保留文本/容器語義兩層兜底，覆蓋 12/15/18 各級 |
| 下一集預熱 | 本集剩 8 分鐘時，後台以純廣告握手替下一集過廣告，不搶佔當前集播放鎖 |
| 設備鎖防干擾與自癒 | 預熱不預調 `checklock`；借鎖必還當前集；攔截 `elapse.php` (`state=4`)、`video_src.php` 與 `animeMask().showError` 自動恢復當前集鎖，防止「同時間僅能播放一部影片」中斷播放；切集/離頁 `keepalive` 自動退鎖 |
| 拖進度條 | 支援拖到片尾快速測試 / 續看，`seeked` 立即觸發檢查 |
| 切集武裝 | 切集後先等新集 `currentTime` 回到開頭（<60s）才恢復預熱判斷，避免用上一集殘留進度誤觸發 |
| 防重複 | 頁面內 `warming` Set 防止重複預熱同一集 |
| 切集偵測 | URL 的 `sn` 變化時自動重置預熱狀態（相容播放器「下一集」按鈕） |

---

## 限制

- 僅適用於**非 VIP** 帳號（VIP 本身無廣告，腳本自動跳過預熱）。
- 需在**台灣 IP** 環境（動畫瘋有地區限制）。
- 預熱只能讓「下一集」無廣告，**無法免除當下這集的廣告**（服務端 25 秒門檻決定）。
- 若看一集停頓超過設備鎖有效期，可能需重新預熱（服務端機制，非腳本可控制）。

## 測試環境

- Chrome / Edge + Tampermonkey
- Windows

## 致謝

廣告流程端點、25 秒門檻、設備鎖釋放流程參考 [miyouzi/aniGamerPlus](https://github.com/miyouzi/aniGamerPlus)。

## License

MIT
